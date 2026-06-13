#!/usr/bin/env node
/**
 * Comments smoke test.
 *
 * Verifies the deployed public contract without posting data:
 * health JSON, API metadata JSON, browser-friendly HTML landing page,
 * and a post-specific count endpoint.
 *
 * Uses only Node 22+ built-ins.
 */
'use strict';

const assert = require('node:assert/strict');

const baseUrl = (process.argv[2] || process.env.COMMENTS_URL || 'https://wesley.thesisko.com/comments').replace(/\/+$/, '');
const samplePost = process.argv[3] || process.env.COMMENTS_SMOKE_POST || 'day-1-reports-from-the-frontline';

async function fetchChecked(path, options = {}) {
  const res = await fetch(`${baseUrl}${path}`, options);
  const text = await res.text();
  assert.equal(res.status, options.expectedStatus || 200, `${path} returned ${res.status}: ${text.slice(0, 120)}`);
  return { res, text };
}

function parseJson(path, text) {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`${path} returned non-JSON: ${text.slice(0, 120)}`);
  }
}

async function main() {
  const health = parseJson('/health', (await fetchChecked('/health')).text);
  assert.equal(health.ok, true, 'health reports ok=true');
  assert.equal(health.service, 'comments', 'health identifies comments service');
  assert.equal(health.storage?.readable, true, 'health reports storage readable');
  assert.equal(health.storage?.writable, true, 'health reports storage writable');

  const meta = parseJson('/', (await fetchChecked('/')).text);
  assert.equal(meta.ok, true, 'API root reports ok=true');
  assert.equal(meta.service, 'comments', 'API root identifies comments service');
  assert.ok(meta.endpoints['GET /comments/?post=<slug>'], 'API root documents post listing endpoint');

  const landing = await fetchChecked('/', { headers: { accept: 'text/html' } });
  assert.match(landing.text, /<title>Comments API — Wesley<\/title>/, 'HTML landing has expected title');
  assert.match(landing.text, /Self-hosted blog comment service/, 'HTML landing describes service');

  const count = parseJson('/count', (await fetchChecked(`/count?post=${encodeURIComponent(samplePost)}`)).text);
  assert.equal(typeof count.count, 'number', 'count endpoint returns numeric count');
  console.log(`ok comments smoke ${baseUrl} version=${health.version} sample=${samplePost} count=${count.count}`);
}

main().catch((err) => {
  console.error(`not ok comments smoke ${baseUrl}`);
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
