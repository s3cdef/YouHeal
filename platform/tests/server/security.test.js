// Config fail-closed, remote setup restriction, rate limits, body limits, TLS + HSTS, dev MFA bypass.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { loadConfig } from '../../server/lib/config.js';
import { TokenBucket } from '../../server/lib/ratelimit.js';
import { clientIp } from '../../server/lib/http.js';
import { startTestServer, Client, tmpDir } from './helpers.js';

const ADMIN = { email: 'owner@clinic.test', name: 'Olivia Owner', password: 'Violet-Harbor-Lantern-42' };

test('config validates and fails closed', () => {
  const d = tmpDir();
  assert.throws(() => loadConfig({ YH_DATA_DIR: d, YH_HOST: '0.0.0.0' }), /plain HTTP/);
  assert.doesNotThrow(() => loadConfig({ YH_DATA_DIR: d, YH_HOST: '0.0.0.0', YH_TRUST_PROXY: '1' }));
  assert.throws(() => loadConfig({ YH_DATA_DIR: d, YH_TLS_CERT: '/nope.pem' }), /must be set together/);
  assert.throws(() => loadConfig({ YH_DATA_DIR: d, YH_TLS_CERT: '/nope.pem', YH_TLS_KEY: '/nope.key' }), /not found/);
  assert.throws(() => loadConfig({ YH_DATA_DIR: d, YH_PORT: 'abc' }), /integer/);
  assert.throws(() => loadConfig({ YH_DATA_DIR: d, YH_PORT: '70000' }), /between/);
  assert.throws(() => loadConfig({ YH_DATA_DIR: d, YH_DEV_INSECURE_NO_MFA: '1', YH_HOST: '10.0.0.5', YH_ALLOW_INSECURE_HTTP: '1' }), /loopback/);
  assert.throws(() => loadConfig({ YH_DATA_DIR: d, YH_LOG_LEVEL: 'loud' }), /YH_LOG_LEVEL/);
  assert.throws(() => loadConfig({ YH_DATA_DIR: d, YH_SESSION_IDLE_MIN: '0' }), /between/);
  const c = loadConfig({ YH_DATA_DIR: d });
  assert.equal(c.port, 8080);
  assert.equal(c.host, '127.0.0.1');
  assert.equal(c.sessionIdleMin, 15);
  assert.equal(c.sessionAbsHours, 12);
});

test('token bucket + client ip with trusted proxies', () => {
  let now = 0;
  const b = new TokenBucket({ capacity: 2, refillPerMin: 60, now: () => now });
  assert.equal(b.take('ip').ok, true);
  assert.equal(b.take('ip').ok, true);
  const r = b.take('ip');
  assert.equal(r.ok, false);
  assert.equal(r.retryAfter, 1);
  now += 1000;
  assert.equal(b.take('ip').ok, true);
  const req = { socket: { remoteAddress: '::ffff:127.0.0.1' }, headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.2' } };
  assert.equal(clientIp(req, 0), '127.0.0.1');
  assert.equal(clientIp(req, 1), '10.0.0.2');
  assert.equal(clientIp(req, 2), '203.0.113.9');
});

test('master key file is generated 0600 and reused', async () => {
  const srv = await startTestServer();
  try {
    const keyFile = path.join(srv.dataDir, 'keys', 'master.key');
    assert.ok(fs.existsSync(keyFile));
    if (process.platform !== 'win32') assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600);
    assert.equal(Buffer.from(fs.readFileSync(keyFile, 'utf8').trim(), 'base64').length, 32);
  } finally { await srv.close(); }
});

test('remote setup refused, auth rate limit, body size limit', async () => {
  const srv = await startTestServer({ YH_TRUST_PROXY: '1', YH_RATE_AUTH_BURST: '3', YH_RATE_AUTH_PER_MIN: '1' });
  try {
    const c = new Client(srv.url);
    const remote = await c.req('POST', '/api/v1/setup', { body: { org: { name: 'X' }, admin: ADMIN }, headers: { 'x-forwarded-for': '198.51.100.7' } });
    assert.equal(remote.status, 403);
    assert.equal(remote.json.error.code, 'SETUP_LOCAL_ONLY');
    const big = await c.req('POST', '/api/v1/auth/login', { rawBody: JSON.stringify({ email: 'a', password: 'x'.repeat(2 * 1024 * 1024) }), headers: { 'content-type': 'application/json' } });
    assert.equal(big.status, 413);
    const badJson = await c.req('POST', '/api/v1/auth/login', { rawBody: '{nope', headers: { 'content-type': 'application/json' } });
    assert.equal(badJson.status, 400);
    assert.equal(badJson.json.error.code, 'BAD_JSON');
    // the setup attempt came "from" 198.51.100.7 (trusted proxy hop) — a separate bucket
    assert.equal((await c.post('/api/v1/auth/login', { email: 'a@b.c', password: 'x' })).status, 401);
    const limited = await c.post('/api/v1/auth/login', { email: 'a@b.c', password: 'x' });
    assert.equal(limited.status, 429, 'per-IP auth bucket (3) exhausted');
    assert.equal(limited.json.error.code, 'RATE_LIMITED');
    assert.ok(Number(limited.headers.get('retry-after')) >= 1);
  } finally { await srv.close(); }
});

test('HTTPS with HSTS when a certificate is configured', async (t) => {
  const d = tmpDir();
  const cert = path.join(d, 'cert.pem'), key = path.join(d, 'key.pem');
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', key, '-out', cert,
      '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
  } catch { t.skip('openssl not available'); return; }
  const srv = await startTestServer({ YH_TLS_CERT: cert, YH_TLS_KEY: key });
  try {
    assert.match(srv.url, /^https:/);
    const res = await new Promise((resolve, reject) => {
      https.get(`${srv.url}/api/v1/health`, { rejectUnauthorized: false }, (r) => { r.resume(); r.on('end', () => resolve(r)); }).on('error', reject);
    });
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['strict-transport-security'], /max-age=\d+/);
  } finally { await srv.close(); }
});

test('dev MFA bypass only on loopback, logged loudly', async () => {
  const srv = await startTestServer({ YH_DEV_INSECURE_NO_MFA: '1' });
  try {
    const c = new Client(srv.url);
    await c.post('/api/v1/setup', { org: { name: 'Dev' }, admin: ADMIN });
    const l = await c.post('/api/v1/auth/login', { email: ADMIN.email, password: ADMIN.password });
    assert.equal(l.json.mfaEnrollmentRequired, false);
    assert.equal((await c.get('/api/v1/patients')).status, 200);
  } finally { await srv.close(); }
});
