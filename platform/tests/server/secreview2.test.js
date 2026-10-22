// Regression tests for the round-4 re-test (NEW-1 … NEW-9 and residuals of F-04/F-10/F-16).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { startTestServer, setupToken, Client, tmpDir, silent } from './helpers.js';
import { totp, base32Decode } from '../../server/lib/totp.js';
import { loadConfig } from '../../server/lib/config.js';
import { createLogger } from '../../server/lib/log.js';
import { startServer } from '../../server/index.js';
import { openDb, migrate } from '../../server/lib/db.js';
import { Keyring, generateMasterKey, sha256hex } from '../../server/lib/crypto.js';
import { createAudit } from '../../server/lib/audit.js';
import { ensureSetupToken } from '../../server/routes/setup.js';
import { DatabaseSync } from 'node:sqlite';

const ADMIN = { email: 'admin@a.test', name: 'Alice Admin', password: 'Violet-Harbor-Lantern-42' };
const PW = 'Correct-Horse-9-Battery';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function bootstrap(overrides = {}) {
  const srv = await startTestServer({ YH_DEV_INSECURE_NO_MFA: '1', ...overrides });
  const admin = new Client(srv.url);
  await admin.post('/api/v1/setup', { setupToken: setupToken(srv), org: { name: 'Org A' }, admin: ADMIN });
  assert.equal((await admin.post('/api/v1/auth/login', { email: ADMIN.email, password: ADMIN.password })).status, 200);
  return { srv, admin };
}
async function user(srv, admin, email, role = 'practitioner') {
  assert.equal((await admin.post('/api/v1/users', { email, name: `User ${email[0]}`, role, password: PW })).status, 201);
  const c = new Client(srv.url);
  assert.equal((await c.post('/api/v1/auth/login', { email, password: PW })).status, 200);
  return c;
}
function openIdle(port, n) {
  return Promise.all(Array.from({ length: n }, () => new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1', () => resolve(s));
    s.data = '';
    s.on('data', (d) => { s.data += d; });
    s.on('close', () => { s.gone = true; });
    s.on('error', () => {});
  })));
}

test('NEW-1 idle zero-byte sockets are reaped by the first-byte timeout; over-cap clients get a 503', async () => {
  const srv = await startTestServer({ YH_FIRST_BYTE_MS: '300', YH_MAX_CONN_PER_IP: '64' });
  try {
    assert.equal(srv.server.requestTimeout, 30_000);
    assert.equal(srv.server.keepAliveTimeout, 5_000);
    const port = Number(new URL(srv.url).port);
    const socks = await openIdle(port, 70);
    await sleep(100);
    const refused = socks.filter((s) => s.data.startsWith('HTTP/1.1 503'));
    assert.equal(refused.length, 6, 'over-cap connections get a polite 503');
    assert.match(refused[0].data, /Retry-After: \d+/);
    await sleep(700);
    assert.equal(socks.filter((s) => !s.gone).length, 0, 'idle sockets reaped after the first-byte timeout');
    const r = await new Client(srv.url).get('/api/v1/health');
    assert.equal(r.status, 200, 'a fresh client is served');
    // a slow-but-valid client (request within the timeout) is not affected
    const ok = await new Promise((resolve) => {
      const s = net.connect(port, '127.0.0.1', async () => { await sleep(100); s.write('GET /api/v1/health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'); });
      let buf = ''; s.on('data', (d) => { buf += d; }); s.on('close', () => resolve(buf));
    });
    assert.match(ok, /^HTTP\/1\.1 200/);
  } finally { await srv.close(); }
});

test('NEW-1 trusted proxy peers are exempt from the per-IP cap', async () => {
  const srv = await startTestServer({ YH_FIRST_BYTE_MS: '300', YH_MAX_CONN_PER_IP: '4', YH_TRUST_PROXY: '1' });
  try {
    const socks = await openIdle(Number(new URL(srv.url).port), 10);
    await sleep(100);
    assert.equal(socks.filter((s) => s.data.includes('503')).length, 0, 'loopback proxy peer not capped');
    await sleep(500);
    assert.equal(socks.filter((s) => !s.gone).length, 0, 'but still reaped when idle');
  } finally { await srv.close(); }
});

test('NEW-3 step-up re-authentication failures count toward lockout (finalize, password, MFA)', async () => {
  const { srv, admin } = await bootstrap();
  try {
    // finalize
    const p = await user(srv, admin, 'p@a.test');
    const pt = (await p.post('/api/v1/patients', { firstName: 'A', lastName: 'B', dob: '1990-01-01' })).json;
    await p.post(`/api/v1/patients/${pt.id}/consents`, { signatureName: 'A B' });
    const sid = (await p.post(`/api/v1/patients/${pt.id}/sessions`, { methodology: 'biomagnetism' })).json.id;
    for (let i = 0; i < 5; i++) assert.equal((await p.post(`/api/v1/sessions/${sid}/finalize`, { password: `wrong-${i}-xxxxxxxx` })).json.error.code, 'REAUTH_FAILED');
    const locked = await p.post(`/api/v1/sessions/${sid}/finalize`, { password: PW });
    assert.equal(locked.status, 423, 'locked: even the right password is refused');
    assert.equal((await new Client(srv.url).post('/api/v1/auth/login', { email: 'p@a.test', password: PW })).status, 423, 'login locked too');

    // password change
    const q = await user(srv, admin, 'q@a.test');
    for (let i = 0; i < 5; i++) assert.equal((await q.post('/api/v1/auth/password', { current: `nope-${i}-xxxxxxxx`, next: 'Brand-New-Password-77' })).status, 400);
    assert.equal((await q.post('/api/v1/auth/password', { current: PW, next: 'Brand-New-Password-77' })).status, 423);

    // MFA enable (bad codes) and disable (bad password)
    const m = await user(srv, admin, 'm@a.test');
    const secret = base32Decode((await m.post('/api/v1/auth/mfa/setup')).json.secret);
    const wrong = totp(secret) === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) assert.equal((await m.post('/api/v1/auth/mfa/enable', { code: wrong })).status, 400);
    assert.equal((await m.post('/api/v1/auth/mfa/enable', { code: totp(secret) })).status, 423);

    const d = await user(srv, admin, 'd@a.test');
    const s2 = base32Decode((await d.post('/api/v1/auth/mfa/setup')).json.secret);
    const codes = (await d.post('/api/v1/auth/mfa/enable', { code: totp(s2) })).json.recoveryCodes;
    for (let i = 0; i < 5; i++) assert.equal((await d.post('/api/v1/auth/mfa/disable', { password: `bad-${i}-xxxxxxxx`, code: codes[0] })).status, 403);
    assert.equal((await d.post('/api/v1/auth/mfa/disable', { password: PW, code: codes[0] })).status, 423);
    const db = new DatabaseSync(srv.cfg.dbPath);
    assert.ok(db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'auth.reauth.failure'").get().n >= 20);
    db.close();
  } finally { await srv.close(); }
});

test('NEW-2 trusted-proxy list: blank = loopback default; catch-all CIDRs warn', () => {
  const d = tmpDir();
  assert.deepEqual(loadConfig({ YH_DATA_DIR: d, YH_TRUSTED_PROXIES: '' }).trustedProxies, ['127.0.0.1', '::1']);
  assert.deepEqual(loadConfig({ YH_DATA_DIR: d, YH_TRUST_PROXY: '1', YH_TRUSTED_PROXIES: ' , ' }).trustedProxies, ['127.0.0.1', '::1']);
  assert.ok(loadConfig({ YH_DATA_DIR: d, YH_TRUST_PROXY: '1', YH_TRUSTED_PROXIES: '0.0.0.0/0' }).warnings.some((w) => /0\.0\.0\.0\/0/.test(w)));
  assert.ok(loadConfig({ YH_DATA_DIR: d, YH_TRUST_PROXY: '1', YH_TRUSTED_PROXIES: '::/0' }).warnings.some((w) => /::\/0/.test(w)));
});

test('NEW-4 rejected Host values are logged (rate-limited, truncated); missing allow-list warns at startup', async () => {
  const lines = [];
  const log = createLogger({ level: 'warn', stream: { write: (s) => lines.push(s) } });
  const dataDir = tmpDir();
  const cfg = loadConfig({ YH_DATA_DIR: dataDir, YH_PORT: '0', YH_CATALOG_DIR: path.join(dataDir, 'none'), YH_WEB_DIR: dataDir });
  const srv = await startServer(cfg, { log });
  try {
    const port = new URL(srv.url).port;
    const send = (host) => new Promise((resolve) => {
      const s = net.connect(Number(port), '127.0.0.1', () => s.write(`GET /api/v1/health HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`));
      let b = ''; s.on('data', (x) => { b += x; }); s.on('close', () => resolve(b));
    });
    const long = `${'x'.repeat(150)}.example`;
    for (const h of ['evil.example', 'evil.example', long]) assert.match(await send(h), /^HTTP\/1\.1 421/);
    const hostLines = lines.filter((l) => l.includes('rejected request for a Host'));
    assert.equal(hostLines.filter((l) => l.includes('"host":"evil.example"')).length, 1, 'once per minute per host');
    const longLine = hostLines.map((l) => JSON.parse(l)).find((l) => l.host.startsWith('xxx'));
    assert.equal(longLine.host.length, 100, 'truncated');
  } finally { await srv.close(); }
  const c = loadConfig({ YH_DATA_DIR: tmpDir(), YH_HOST: '0.0.0.0', YH_ALLOW_INSECURE_HTTP: '1' });
  assert.ok(c.warnings.some((w) => /YH_ALLOWED_HOSTS nor YH_PUBLIC_ORIGIN/.test(w)));
  assert.equal(loadConfig({ YH_DATA_DIR: tmpDir(), YH_HOST: '0.0.0.0', YH_ALLOW_INSECURE_HTTP: '1', YH_ALLOWED_HOSTS: 'clinic.lan' }).warnings.length, 0);
});

test('F-04 residual: the setup token value is never logged outside loopback dev', () => {
  const capture = () => { const lines = []; return { lines, log: createLogger({ level: 'info', stream: { write: (s) => lines.push(s) } }) }; };
  const db = openDb(path.join(tmpDir(), 's.sqlite')); migrate(db);
  const prevEnv = process.env.NODE_ENV;
  try {
    const remote = loadConfig({ YH_DATA_DIR: tmpDir(), YH_HOST: '0.0.0.0', YH_ALLOW_INSECURE_HTTP: '1' });
    const a = capture();
    const t1 = ensureSetupToken(remote, db, a.log);
    assert.ok(!a.lines.join('').includes(t1), 'non-loopback: value not logged');
    assert.ok(a.lines.join('').includes('first-run setup token written to'));

    const local = loadConfig({ YH_DATA_DIR: tmpDir() });
    process.env.NODE_ENV = 'production';
    const b = capture();
    const t2 = ensureSetupToken(local, db, b.log);
    assert.ok(!b.lines.join('').includes(t2), 'production: value not logged');
    delete process.env.NODE_ENV;
    const c = capture();
    const t3 = ensureSetupToken(local, db, c.log);
    assert.equal(t3, t2, 'idempotent');
    assert.ok(c.lines.join('').includes(t3), 'loopback dev convenience prints it');
  } finally { if (prevEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prevEnv; db.close(); }
});

test('F-16 residual: verify fails when the external anchor log is missing or behind the recorded export point', () => {
  const dir = tmpDir();
  const db = openDb(path.join(dir, 'a.sqlite')); migrate(db);
  const kr = new Keyring(generateMasterKey());
  const anchorFile = path.join(dir, 'audit-anchor.log');
  const audit = createAudit(db, kr, silent, { anchorFile, anchorEvery: 5 });
  for (let i = 0; i < 12; i++) audit.append({ action: 'test.event', detail: { i } });
  assert.equal(db.get('SELECT exported_id FROM audit_anchor').exported_id, 10);
  assert.equal(audit.verify().ok, true);
  // rows inside a rolled-back transaction are never exported
  try { db.tx(() => { for (let i = 0; i < 3; i++) audit.append({ action: 'x' }); throw new Error('rollback'); }); } catch { /* expected */ }
  assert.equal(audit.verify().ok, true, 'no phantom anchor lines for rolled-back rows');
  const full = fs.readFileSync(anchorFile, 'utf8');
  fs.writeFileSync(anchorFile, full.split('\n').slice(0, 1).join('\n') + '\n'); // keep only the row-5 line
  assert.match(audit.verify().reason, /anchor log behind DB/);
  fs.rmSync(anchorFile);
  assert.equal(audit.verify().reason, 'anchor log missing');
  fs.writeFileSync(anchorFile, full);
  assert.equal(audit.verify().ok, true);
  db.close();
});

test('F-10 residual: legacy recovery codes flag regeneration; POST /auth/mfa/recovery-codes replaces all codes', async () => {
  const { srv, admin } = await bootstrap();
  try {
    const m = await user(srv, admin, 'r@a.test');
    const secret = base32Decode((await m.post('/api/v1/auth/mfa/setup')).json.secret);
    const codes = (await m.post('/api/v1/auth/mfa/enable', { code: totp(secret) })).json.recoveryCodes;
    assert.equal((await m.get('/api/v1/auth/me')).json.recoveryCodesRegenerationRequired, false);
    const db = new DatabaseSync(srv.cfg.dbPath);
    const uid = db.prepare("SELECT id FROM users WHERE email = 'r@a.test'").get().id;
    db.prepare('INSERT INTO user_recovery_codes (user_id, code_hash, key_id, used_at, created_at) VALUES (?,?,NULL,NULL,?)')
      .run(uid, sha256hex('youheal-recovery|aaaaabbbbb'), new Date().toISOString());
    db.close();
    assert.equal((await m.get('/api/v1/auth/me')).json.recoveryCodesRegenerationRequired, true);
    assert.equal((await m.post('/api/v1/auth/mfa/recovery-codes', { password: 'wrong-password-xx', code: codes[0] })).status, 403);
    const r = await m.post('/api/v1/auth/mfa/recovery-codes', { password: PW, code: totp(secret, { time: Date.now() + 30_000 }) });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.recoveryCodes.length, 10);
    const me = (await m.get('/api/v1/auth/me')).json;
    assert.equal(me.recoveryCodesRegenerationRequired, false);
    assert.equal(me.user.recoveryCodesRemaining, 10);
    const login = (code) => new Client(srv.url).post('/api/v1/auth/login', { email: 'r@a.test', password: PW, totp: code });
    assert.equal((await login('aaaaa-bbbbb')).status, 401, 'legacy code invalidated');
    assert.equal((await login(codes[1])).status, 401, 'old keyed codes invalidated');
    assert.equal((await login(r.json.recoveryCodes[0])).status, 200);
  } finally { await srv.close(); }
});
