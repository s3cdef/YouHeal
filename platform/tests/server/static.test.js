// Static file server: MIME types, caching, SPA fallback, security headers, path traversal.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { startTestServer, tmpDir } from './helpers.js';

let srv;
before(async () => { srv = await startTestServer(); });
after(async () => { await srv?.close(); });

/** Raw request so the path is sent exactly as written (fetch would normalize it). */
function raw(p, { method = 'GET', headers = {} } = {}) {
  const u = new URL(srv.url);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: u.port, method, path: p, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

const assertSecurityHeaders = (h) => {
  assert.match(h['content-security-policy'], /^default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:;/);
  assert.match(h['content-security-policy'], /frame-ancestors 'none'/);
  assert.equal(h['x-content-type-options'], 'nosniff');
  assert.equal(h['referrer-policy'], 'no-referrer');
  assert.equal(h['cross-origin-opener-policy'], 'same-origin');
  assert.ok(h['permissions-policy']);
  assert.equal(h['strict-transport-security'], undefined, 'no HSTS over plain HTTP');
};

test('index.html: html MIME, no-cache, ETag, security headers', async () => {
  const r = await raw('/');
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-type'], 'text/html; charset=utf-8');
  assert.equal(r.headers['cache-control'], 'no-cache');
  assert.match(r.headers.etag, /^W\/"/);
  assertSecurityHeaders(r.headers);
  const r304 = await raw('/', { headers: { 'if-none-match': r.headers.etag } });
  assert.equal(r304.status, 304);
  assertSecurityHeaders(r304.headers);
});

test('MIME types for assets', async () => {
  const cases = {
    '/js/app.js': 'text/javascript; charset=utf-8', '/js/mod.mjs': 'text/javascript; charset=utf-8', '/data.json': 'application/json; charset=utf-8',
    '/icon.svg': 'image/svg+xml', '/font.woff2': 'font/woff2', '/body.glb': 'model/gltf-binary',
  };
  for (const [p, type] of Object.entries(cases)) {
    const r = await raw(p);
    assert.equal(r.status, 200, p);
    assert.equal(r.headers['content-type'], type, p);
    assert.match(r.headers['cache-control'], /max-age=\d+/);
    assertSecurityHeaders(r.headers);
  }
  assert.equal((await raw('/js/app.js', { method: 'HEAD' })).body, '');
});

test('SPA fallback only for HTML navigations', async () => {
  const nav = await raw('/patients/123', { headers: { accept: 'text/html,application/xhtml+xml' } });
  assert.equal(nav.status, 200);
  assert.match(nav.body, /YOU HEAL/);
  assert.equal((await raw('/patients/123', { headers: { accept: 'application/json' } })).status, 404);
  assert.equal((await raw('/missing.js', { headers: { accept: 'text/html' } })).status, 404);
  const api = await raw('/api/v1/unknown', { headers: { accept: 'text/html' } });
  assert.equal(api.status, 404);
  assert.match(api.headers['content-type'], /application\/json/);
  assert.equal((await raw('/', { method: 'POST' })).status, 405);
});

test('path traversal and hidden files are rejected', async () => {
  const attempts = ['/../package.json', '/..%2fpackage.json', '/%2e%2e/%2e%2e/package.json', '/js/../../package.json', '/js/%2e%2e/%2e%2e/server/index.js',
    '/js/..%5c..%5cpackage.json', '/%2e%2e%2f%2e%2e%2fpackage.json', '/.env', '/js/%00.js', '/..', '//etc/passwd', '/%252e%252e/package.json'];
  for (const p of attempts) {
    const r = await raw(p, { headers: { accept: 'text/html' } });
    // either refused, or (extension-less navigation) answered with the SPA shell — never the target file
    assert.ok(r.status !== 200 || r.body.includes('<title>YOU HEAL</title>'), `${p} must not be served (got ${r.status})`);
    assert.ok(!r.body.includes('youheal-clinical') && !r.body.includes('SECRET=') && !r.body.includes('root:'), `${p} leaked content`);
    assertSecurityHeaders(r.headers);
  }
});

test('symlinks escaping the web root are not followed', async () => {
  const outside = path.join(tmpDir(), 'secret.txt');
  fs.writeFileSync(outside, 'TOP-SECRET');
  try { fs.symlinkSync(outside, path.join(srv.cfg.webDir, 'link.txt')); } catch { return; }
  const r = await raw('/link.txt');
  assert.equal(r.status, 404);
  assert.ok(!r.body.includes('TOP-SECRET'));
});
