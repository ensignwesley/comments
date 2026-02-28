'use strict';

/**
 * Comments server for wesley.thesisko.com
 * Pure Node.js built-ins — zero npm dependencies
 *
 * GET  /comments/?post=<slug>         → JSON array of comments
 * POST /comments/                     → submit a comment
 * DELETE /comments/<id>?token=<tok>   → admin: delete by ID
 * GET  /comments/admin?token=<tok>    → admin: list all comments
 */

const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const url    = require('url');

// ── Config ──────────────────────────────────────────────────────────────
const PORT     = 3004;
const DATA_DIR = path.join(__dirname, 'data');
const CFG_FILE = path.join(__dirname, 'config.json');
const ALLOWED_ORIGIN = 'https://wesley.thesisko.com';

const RATE_WINDOW_MS = 10 * 60 * 1000; // 10 min
const RATE_MAX       = 2;              // max comments per window per IP
const MAX_NAME       = 80;
const MAX_CONTENT    = 2000;
const MAX_SLUG       = 120;

// ── Load / create config ─────────────────────────────────────────────────
let cfg;
if (fs.existsSync(CFG_FILE)) {
  cfg = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8'));
} else {
  cfg = { adminToken: crypto.randomBytes(32).toString('hex') };
  fs.writeFileSync(CFG_FILE, JSON.stringify(cfg, null, 2));
  console.log('Config created. Admin token:', cfg.adminToken);
}

fs.mkdirSync(DATA_DIR, { recursive: true });

// ── Rate limiter ─────────────────────────────────────────────────────────
const rateLimits = new Map(); // ip → [timestamp, ...]

function checkRate(ip) {
  const now   = Date.now();
  const times = (rateLimits.get(ip) || []).filter(t => now - t < RATE_WINDOW_MS);
  if (times.length >= RATE_MAX) return false;
  times.push(now);
  rateLimits.set(ip, times);
  return true;
}

// Prune old entries every 30 min to avoid unbounded growth
setInterval(() => {
  const now = Date.now();
  for (const [ip, times] of rateLimits) {
    const fresh = times.filter(t => now - t < RATE_WINDOW_MS);
    if (fresh.length === 0) rateLimits.delete(ip);
    else                    rateLimits.set(ip, fresh);
  }
}, 30 * 60 * 1000);

// ── Webhook notification ─────────────────────────────────────────────────
function notifyNewComment(slug, comment) {
  const webhookUrl = cfg.webhookUrl;
  if (!webhookUrl) return;
  const payload = JSON.stringify({
    event:   'new_comment',
    post:    slug,
    name:    comment.name,
    preview: comment.content.slice(0, 120),
    ts:      comment.ts,
    url:     `https://wesley.thesisko.com/posts/${slug}/#comments`,
  });
  try {
    const u = new URL(webhookUrl);
    const mod = u.protocol === 'https:' ? require('https') : require('http');
    const req = mod.request({
      hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, r => r.resume());
    req.on('error', e => console.error('[comment] webhook error:', e.message));
    req.setTimeout(8000, () => req.destroy());
    req.write(payload);
    req.end();
  } catch (e) {
    console.error('[comment] webhook dispatch failed:', e.message);
  }
}

// ── Storage helpers ──────────────────────────────────────────────────────
function safeSlug(raw) {
  // allow only alphanumeric + hyphen, strip everything else
  return (raw || '').replace(/[^a-z0-9-]/gi, '').toLowerCase().slice(0, MAX_SLUG);
}

function dataFile(slug) {
  return path.join(DATA_DIR, slug + '.json');
}

function loadComments(slug) {
  const f = dataFile(slug);
  if (!fs.existsSync(f)) return [];
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return []; }
}

function saveComments(slug, comments) {
  fs.writeFileSync(dataFile(slug), JSON.stringify(comments, null, 2));
}

function allComments() {
  const result = [];
  for (const file of fs.readdirSync(DATA_DIR)) {
    if (!file.endsWith('.json')) continue;
    const slug = file.slice(0, -5);
    for (const c of loadComments(slug)) result.push({ ...c, post: slug });
  }
  return result.sort((a, b) => b.ts - a.ts);
}

// ── HTML helpers ─────────────────────────────────────────────────────────
function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

// ── Request helpers ──────────────────────────────────────────────────────
function getBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', d => { buf += d; if (buf.length > 8192) reject(new Error('too large')); });
    req.on('end',  () => resolve(buf));
    req.on('error', reject);
  });
}

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type':  'application/json',
    'Content-Length': Buffer.byteLength(body),
    'Connection':    'close',
    'Access-Control-Allow-Origin':  ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(body);
}

function err(res, status, message) {
  json(res, status, { error: message });
}

function getIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
      || req.socket.remoteAddress
      || 'unknown';
}

// ── Server ───────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const parsed   = url.parse(req.url, true);
  const pathname = parsed.pathname.replace(/\/+$/, '') || '/';
  const query    = parsed.query;
  const method   = req.method.toUpperCase();

  // CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin':  ALLOWED_ORIGIN,
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Connection': 'close',
    });
    return res.end();
  }

  // ── GET /comments/health ───────────────────────────────────────────────
  if (method === 'GET' && pathname === '/comments/health') {
    return json(res, 200, { ok: true, service: 'comments', ts: Date.now() });
  }

  // ── GET /comments/ (or /comments) ─────────────────────────────────────
  if (method === 'GET' && (pathname === '/comments' || pathname === '')) {
    const slug = safeSlug(query.post);
    if (!slug) return err(res, 400, 'Missing post parameter');
    const comments = loadComments(slug).map(c => ({
      id:      c.id,
      name:    c.name,
      content: c.content,
      ts:      c.ts,
    }));
    return json(res, 200, comments);
  }

  // ── GET /comments/admin?token=… ────────────────────────────────────────
  if (method === 'GET' && pathname === '/comments/admin') {
    if (query.token !== cfg.adminToken) return err(res, 403, 'Forbidden');
    const accept = req.headers['accept'] || '';
    if (accept.includes('text/html')) {
      const comments = allComments();
      const rows = comments.length === 0
        ? '<p style="color:#445566;padding:2rem">No comments yet.</p>'
        : comments.map(c => `
          <div class="card">
            <div class="card-hdr">
              <span class="post-slug">${esc(c.post)}</span>
              <span class="name">${esc(c.name)}</span>
              <span class="ts">${new Date(c.ts).toISOString().replace('T',' ').slice(0,19)} UTC</span>
              <button class="del" onclick="del('${c.id}','${c.post}',this)">DELETE</button>
            </div>
            <div class="body">${esc(c.content)}</div>
          </div>`).join('\n');
      const total = comments.length;
      const posts = new Set(comments.map(c => c.post)).size;
      const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Comments Admin</title>
<style>
  :root { --bg:#000;--bg2:#0a0a0f;--amber:#FF9500;--text:#CCDDFF;--dim:#445566;--border:#1a1a2e;--red:#cc4444; }
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--bg);color:var(--text);font-family:"Helvetica Neue",Arial,sans-serif;font-size:14px;padding:2rem}
  h1{font-size:1rem;font-weight:900;letter-spacing:.3em;text-transform:uppercase;color:var(--amber);margin-bottom:.5rem}
  .stats{font-size:.65rem;letter-spacing:.2em;color:var(--dim);text-transform:uppercase;margin-bottom:2rem;padding-bottom:.75rem;border-bottom:1px solid var(--border)}
  .card{background:var(--bg2);border-left:3px solid var(--amber);padding:.75rem 1rem;margin-bottom:.75rem}
  .card-hdr{display:flex;align-items:baseline;gap:.75rem;flex-wrap:wrap;margin-bottom:.4rem}
  .post-slug{font-size:.6rem;font-weight:900;letter-spacing:.2em;text-transform:uppercase;color:var(--amber);background:rgba(255,149,0,.1);padding:1px 6px}
  .name{font-weight:700;color:var(--text)}
  .ts{font-size:.6rem;color:var(--dim);margin-left:auto;font-variant-numeric:tabular-nums}
  .body{color:rgba(204,221,255,.7);font-size:.85rem;line-height:1.5;white-space:pre-wrap;word-break:break-word}
  .del{margin-left:.5rem;background:transparent;border:1px solid var(--red);color:var(--red);padding:2px 8px;font-size:.55rem;font-weight:900;letter-spacing:.15em;text-transform:uppercase;cursor:pointer}
  .del:hover{background:var(--red);color:#000}
  .del:disabled{opacity:.4;cursor:default}
  #msg{position:fixed;top:1rem;right:1rem;padding:.5rem 1rem;font-size:.7rem;font-weight:700;letter-spacing:.15em;display:none}
  .ok{background:var(--amber);color:#000}.bad{background:var(--red);color:#fff}
</style>
</head>
<body>
<h1>Comments Admin</h1>
<div class="stats">${total} comment${total===1?'':'s'} across ${posts} post${posts===1?'':'s'}</div>
<div id="list">${rows}</div>
<div id="msg"></div>
<script>
function esc(s){const d=document.createElement('div');d.textContent=s;return d.innerHTML}
function flash(msg,ok){const el=document.getElementById('msg');el.textContent=msg;el.className=ok?'ok':'bad';el.style.display='block';setTimeout(()=>el.style.display='none',2500)}
async function del(id,post,btn){
  if(!confirm('Delete this comment?'))return;
  btn.disabled=true;
  const r=await fetch('/comments/'+id+'?token=${cfg.adminToken}',{method:'DELETE'});
  if(r.ok){btn.closest('.card').remove();flash('Deleted','ok')}
  else{flash('Error deleting comment');btn.disabled=false}
}
</script>
</body>
</html>`;
      const buf = Buffer.from(html);
      res.writeHead(200, {'Content-Type':'text/html;charset=utf-8','Content-Length':buf.length,'Connection':'close'});
      return res.end(buf);
    }
    return json(res, 200, allComments());
  }

  // ── GET /comments/count?post=<slug> ───────────────────────────────────
  if (method === 'GET' && pathname === '/comments/count') {
    const slug = safeSlug(query.post);
    if (!slug) return err(res, 400, 'Missing post parameter');
    return json(res, 200, { count: loadComments(slug).length });
  }

  // ── POST /comments/ ────────────────────────────────────────────────────
  if (method === 'POST' && (pathname === '/comments' || pathname === '')) {
    const ip = getIp(req);

    let body;
    try { body = JSON.parse(await getBody(req)); }
    catch { return err(res, 400, 'Invalid JSON'); }

    // Honeypot — bots fill in "url" field
    if (body.url && body.url.trim()) {
      return json(res, 200, { ok: true }); // silent drop
    }

    const slug    = safeSlug(body.post);
    const name    = (body.name    || '').trim().slice(0, MAX_NAME);
    const content = (body.content || '').trim().slice(0, MAX_CONTENT);

    if (!slug)    return err(res, 400, 'Missing post slug');
    if (!name)    return err(res, 400, 'Name is required');
    if (!content) return err(res, 400, 'Comment cannot be empty');

    if (!checkRate(ip)) {
      return err(res, 429, 'Too many comments — please wait a few minutes');
    }

    const comment = {
      id:      crypto.randomBytes(8).toString('hex'),
      name,
      content,
      ts:      Date.now(),
    };

    const comments = loadComments(slug);
    comments.push(comment);
    saveComments(slug, comments);

    console.log(`[comment] post=${slug} name="${name}" ip=${ip}`);
    notifyNewComment(slug, comment);
    return json(res, 201, { ok: true, id: comment.id });
  }

  // ── DELETE /comments/<id>?token=… ──────────────────────────────────────
  if (method === 'DELETE' && pathname.startsWith('/comments/')) {
    if (query.token !== cfg.adminToken) return err(res, 403, 'Forbidden');
    const targetId = pathname.slice('/comments/'.length);
    if (!targetId) return err(res, 400, 'Missing comment ID');

    let deleted = false;
    for (const file of fs.readdirSync(DATA_DIR)) {
      if (!file.endsWith('.json')) continue;
      const slug     = file.slice(0, -5);
      const comments = loadComments(slug);
      const filtered = comments.filter(c => c.id !== targetId);
      if (filtered.length < comments.length) {
        saveComments(slug, filtered);
        deleted = true;
        break;
      }
    }

    return json(res, deleted ? 200 : 404, { ok: deleted });
  }

  return err(res, 404, 'Not found');
});

server.timeout = 10000; // 10s request timeout

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Comments server listening on 127.0.0.1:${PORT}`);
  console.log(`Admin token: ${cfg.adminToken}`);
  console.log(`Data dir: ${DATA_DIR}`);
});

server.on('error', err => { console.error('Server error:', err); });
