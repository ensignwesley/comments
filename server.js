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
    return json(res, 200, allComments());
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
