// Regression tests for the round-3 security assessment (F-01 … F-20). Each test reproduces the
// assessor's PoC (scratchpad/secreview/poc_*.mjs) and asserts the fixed behavior.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { startTestServer, setupToken, Client, tmpDir, silent } from './helpers.js';
import { totp, base32Decode } from '../../server/lib/totp.js';
import { loadConfig } from '../../server/lib/config.js';
import { startServer } from '../../server/index.js';
import { ipBucketKey } from '../../server/lib/http.js';
import { loadKeyring } from '../../server/lib/keys.js';
import { openDb, migrate, listMigrations, MIGRATIONS_DIR } from '../../server/lib/db.js';
import { Keyring, generateMasterKey, hashPassword, uuid, sha256hex } from '../../server/lib/crypto.js';
import { storeRecoveryCodes, consumeRecoveryCode, generateRecoveryCodes } from '../../server/lib/auth.js';
import { MAGIC, decryptBackup, restoreBackup, writeBackupFile } from '../../server/lib/backup.js';
import { createAudit, anchorMac, readAnchorLog, dbAnchorMac } from '../../server/lib/audit.js';
import { jsonShapeError } from '../../server/lib/validate.js';

const ADMIN = { email: 'admin@a.test', name: 'Alice Admin', password: 'Violet-Harbor-Lantern-42' };
const PW = 'Correct-Horse-9-Battery';

/** Raw HTTP(S) request: lets tests set Host / repeated Cookie headers exactly (fetch would not). */
function raw(url, method, p, { headers = {}, body } = {}) {
  const u = new URL(url);
  const data = body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body));
  const h = { ...headers };
  if (data !== null) { h['content-type'] ??= 'application/json'; h['content-length'] = Buffer.byteLength(data); }
  const mod = u.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const r = mod.request({ host: u.hostname, port: u.port, method, path: p, headers: h, agent: false, rejectUnauthorized: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
        resolve({ status: res.statusCode, headers: res.headers, json, text });
      });
    });
    r.on('error', reject);
    if (data !== null) r.write(data);
    r.end();
  });
}

async function bootstrap(overrides = {}) {
  const srv = await startTestServer({ YH_DEV_INSECURE_NO_MFA: '1', ...overrides });
  const admin = new Client(srv.url);
  const s = await admin.post('/api/v1/setup', { setupToken: setupToken(srv), org: { name: 'Org A' }, admin: ADMIN });
  assert.equal(s.status, 200, JSON.stringify(s.json));
  assert.equal((await admin.post('/api/v1/auth/login', { email: ADMIN.email, password: ADMIN.password })).status, 200);
  return { srv, admin };
}
async function mkUser(admin, email, role, name = `${role} ${email.split('@')[0]}`) {
  const r = await admin.post('/api/v1/users', { email, name, role, password: PW });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return r.json.user;
}
async function loginAs(srv, email, password = PW, extra = {}) {
  const c = new Client(srv.url);
  const r = await c.post('/api/v1/auth/login', { email, password, ...extra });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return c;
}
const rawDb = (srv) => { const d = new DatabaseSync(srv.cfg.dbPath); d.exec('PRAGMA busy_timeout = 5000'); return d; };
const histogram = (rs) => rs.reduce((h, r) => { h[r.status] = (h[r.status] || 0) + 1; return h; }, {});

test('F-01 lockout holds under 25 concurrent wrong passwords; per-account bucket bounds guesses; IPv6 /64 buckets', async () => {
  const { srv, admin } = await bootstrap();
  try {
    await mkUser(admin, 'prac@a.test', 'practitioner');
    const rs = await Promise.all(Array.from({ length: 25 }, (_, i) => new Client(srv.url).post('/api/v1/auth/login', { email: 'prac@a.test', password: `wrong-guess-${i}-xx` })));
    const h = histogram(rs);
    assert.ok((h[401] || 0) <= 5, `at most 5 passwords evaluated, got ${JSON.stringify(h)}`);
    assert.equal((h[401] || 0) + (h[429] || 0) + (h[423] || 0), 25);
    const d = rawDb(srv);
    const u = d.prepare("SELECT failed_attempts, locked_until FROM users WHERE email = 'prac@a.test'").get();
    d.close();
    assert.equal(u.failed_attempts, 5, 'atomic increments: no lost updates');
    assert.ok(Date.parse(u.locked_until) > Date.now());
    const ok = await new Client(srv.url).post('/api/v1/auth/login', { email: 'prac@a.test', password: PW });
    assert.equal(ok.status, 423, 'lockout held');
    assert.equal(ok.json.error.code, 'ACCOUNT_LOCKED');
  } finally { await srv.close(); }
  assert.equal(ipBucketKey('2001:db8:1:2:aaaa::1'), ipBucketKey('2001:db8:1:2:ffff:ffff:ffff:ffff'));
  assert.notEqual(ipBucketKey('2001:db8:1:2::1'), ipBucketKey('2001:db8:1:3::1'));
  assert.equal(ipBucketKey('::ffff:192.0.2.7'), '192.0.2.7');
});

test('F-02 TOTP replay and recovery-code reuse are refused under concurrency (guarded UPDATEs)', async () => {
  const { srv, admin } = await bootstrap();
  try {
    await mkUser(admin, 'mfa@a.test', 'practitioner');
    const c = await loginAs(srv, 'mfa@a.test');
    const secret = base32Decode((await c.post('/api/v1/auth/mfa/setup')).json.secret);
    const codes = (await c.post('/api/v1/auth/mfa/enable', { code: totp(secret) })).json.recoveryCodes;
    const d = rawDb(srv);
    assert.equal(d.prepare('SELECT COUNT(*) AS n FROM user_recovery_codes WHERE used_at IS NULL').get().n, 10);
    assert.equal(d.prepare("SELECT recovery_codes FROM users WHERE email = 'mfa@a.test'").get().recovery_codes, null);
    d.close();
    const login = (code) => new Client(srv.url).post('/api/v1/auth/login', { email: 'mfa@a.test', password: PW, totp: code });

    const code = totp(secret, { time: Date.now() + 30_000 });
    const same = await Promise.all([login(code), login(code), login(code)]);
    assert.equal(same.filter((r) => r.status === 200).length, 1, `one TOTP use only: ${JSON.stringify(histogram(same))}`);
    assert.notEqual((await login(code)).status, 200);

    const rc = await Promise.all([login(codes[0]), login(codes[0]), login(codes[0])]);
    assert.equal(rc.filter((r) => r.status === 200).length, 1, 'recovery code consumed once');

    const [x1, x2] = await Promise.all([login(codes[1]), login(codes[2])]);
    assert.equal(x1.status, 200);
    assert.equal(x2.status, 200);
    const after = new Client(srv.url); after.cookie = x2.setCookies.find((c) => c.startsWith('yh_sid=')).split(';')[0];
    assert.equal((await after.get('/api/v1/auth/me')).json.user.recoveryCodesRemaining, 7, 'no lost update');
    assert.notEqual((await login(codes[1])).status, 200);
    assert.notEqual((await login(codes[2])).status, 200);
  } finally { await srv.close(); }
});

test('F-04 setup: refused through a proxy, requires the one-time 0600 token, which is deleted afterwards', async () => {
  const srv = await startTestServer();
  try {
    const tokenFile = path.join(srv.dataDir, 'setup-token');
    assert.ok(fs.existsSync(tokenFile));
    if (process.platform !== 'win32') assert.equal(fs.statSync(tokenFile).mode & 0o777, 0o600);
    const c = new Client(srv.url);
    assert.deepEqual((await c.get('/api/v1/setup/status')).json, { needsSetup: true, tokenRequired: true });
    const body = { setupToken: setupToken(srv), org: { name: 'Attacker Clinic' }, admin: ADMIN };
    for (const hdr of [{ 'x-forwarded-for': '127.0.0.1' }, { forwarded: 'for=127.0.0.1' }, { 'x-real-ip': '127.0.0.1' }]) {
      const r = await c.req('POST', '/api/v1/setup', { body, headers: hdr });
      assert.equal(r.status, 403);
      assert.equal(r.json.error.code, 'SETUP_LOCAL_ONLY');
    }
    const none = await c.post('/api/v1/setup', { ...body, setupToken: undefined });
    assert.equal(none.json.error.code, 'SETUP_TOKEN_INVALID');
    assert.equal((await c.post('/api/v1/setup', { ...body, setupToken: 'guess' })).json.error.code, 'SETUP_TOKEN_INVALID');
    assert.equal((await c.post('/api/v1/setup', body)).status, 200);
    assert.equal(fs.existsSync(tokenFile), false, 'token removed after setup');
  } finally { await srv.close(); }
});

test('F-05 Host header allow-list (DNS rebinding) → 421; YH_ALLOWED_HOSTS and own hostname accepted', async () => {
  const srv = await startTestServer({ YH_ALLOWED_HOSTS: 'clinic.local' });
  try {
    const port = new URL(srv.url).port;
    const body = { setupToken: setupToken(srv), org: { name: 'X' }, admin: ADMIN };
    const rebind = await raw(srv.url, 'POST', '/api/v1/setup/', { body, headers: { host: `rebind.attacker.example:${port}`, origin: `http://rebind.attacker.example:${port}`, 'sec-fetch-site': 'same-origin' } });
    assert.equal(rebind.status, 421);
    assert.equal(rebind.json.error.code, 'MISDIRECTED_REQUEST');
    assert.equal((await raw(srv.url, 'GET', '/api/v1/health', { headers: { host: 'evil.example' } })).status, 421);
    const noHost = await new Promise((resolve) => {
      const sock = net.connect(Number(port), '127.0.0.1', () => sock.write('GET /api/v1/health HTTP/1.0\r\n\r\n'));
      let buf = ''; sock.on('data', (d) => { buf += d; }); sock.on('end', () => resolve(buf)); sock.on('error', () => resolve(buf));
    });
    assert.match(noHost, /^HTTP\/1\.[01] 421/, 'HTTP/1.0 request without Host');
    for (const host of [`clinic.local:${port}`, `localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]) {
      assert.equal((await raw(srv.url, 'GET', '/api/v1/health', { headers: { host } })).status, 200, host);
    }
  } finally { await srv.close(); }
  const cfg = loadConfig({ YH_DATA_DIR: tmpDir(), YH_HOST: '0.0.0.0', YH_ALLOW_INSECURE_HTTP: '1' });
  assert.ok(cfg.allowedHosts.has(os.hostname().toLowerCase()));
  assert.equal(loadConfig({ YH_DATA_DIR: tmpDir() }).allowedHosts.has(os.hostname().toLowerCase()), os.hostname() === 'localhost');
});

test('F-06 concurrent cross-demotion of the last two admins leaves one admin (in-tx recount + trigger)', async () => {
  const { srv, admin } = await bootstrap();
  try {
    const me = (await admin.get('/api/v1/auth/me')).json.user;
    const a2 = await mkUser(admin, 'adm2@a.test', 'admin', 'Second Admin');
    const b = await loginAs(srv, 'adm2@a.test');
    const [x, y] = await Promise.all([
      admin.patch(`/api/v1/users/${a2.id}`, { role: 'practitioner', password: 'Reset-Value-Kq81z' }),
      b.patch(`/api/v1/users/${me.id}`, { role: 'practitioner', password: 'Reset-Value-Kq81y' }),
    ]);
    assert.deepEqual([x.status, y.status].sort(), [200, 409]);
    const d = rawDb(srv);
    assert.equal(d.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1").get().n, 1);
    assert.throws(() => d.prepare("UPDATE users SET active = 0 WHERE role = 'admin'").run(), /last active admin/);
    d.close();
  } finally { await srv.close(); }
});

test('F-07 finalize: signature bound to the signer, password re-entry required', async () => {
  const { srv, admin } = await bootstrap();
  try {
    await mkUser(admin, 'prac@a.test', 'practitioner', 'Pat Practitioner');
    await mkUser(admin, 'prac2@a.test', 'practitioner', 'Paul Second');
    const p = await loginAs(srv, 'prac@a.test');
    const q = await loginAs(srv, 'prac2@a.test');
    const pt = (await p.post('/api/v1/patients', { firstName: 'R', lastName: 'Q', dob: '1990-01-01' })).json;
    await p.post(`/api/v1/patients/${pt.id}/consents`, { signatureName: 'R Q' });
    const sid = (await p.post(`/api/v1/patients/${pt.id}/sessions`, { methodology: 'biomagnetism' })).json.id;
    const forged = await q.post(`/api/v1/sessions/${sid}/finalize`, { signatureName: 'Pat Practitioner, MD', password: PW });
    assert.equal(forged.status, 422);
    assert.equal(forged.json.error.code, 'SIGNATURE_MISMATCH');
    assert.equal((await q.post(`/api/v1/sessions/${sid}/finalize`, { signatureName: 'Paul Second' })).status, 400, 'password required');
    const bad = await q.post(`/api/v1/sessions/${sid}/finalize`, { password: 'not-my-password' });
    assert.equal(bad.status, 403);
    assert.equal(bad.json.error.code, 'REAUTH_FAILED');
    const ok = await q.post(`/api/v1/sessions/${sid}/finalize`, { signatureName: '  paul  SECOND ', password: PW });
    assert.equal(ok.status, 200);
    const rep = await p.get(`/api/v1/sessions/${sid}/report`);
    assert.equal(rep.json.attestation.signatureName, 'Paul Second');
    assert.equal(rep.json.attestation.finalizedBy.name, 'Paul Second');
  } finally { await srv.close(); }
});

test('F-08 POST /patients/search (no PHI in URLs); GET with q/dob → 410 Gone, plain listing kept', async () => {
  const { srv, admin } = await bootstrap();
  try {
    const pt = (await admin.post('/api/v1/patients', { firstName: 'Ana', lastName: 'Núñez', dob: '1980-02-03' })).json;
    const r = await admin.post('/api/v1/patients/search', { q: 'nunez' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.items.map((x) => x.id), [pt.id]);
    assert.equal((await admin.post('/api/v1/patients/search', { dob: '1980-02-03' })).json.total, 1);
    assert.equal((await admin.post('/api/v1/patients/search', { q: 'x', bogus: 1 })).status, 400);
    assert.equal((await admin.post('/api/v1/patients/search', { q: 'nunez' }, { csrf: false })).status, 403, 'CSRF still applies');
    for (const qs of ['q=nunez', 'dob=1980-02-03', 'q=']) {
      const g = await admin.get(`/api/v1/patients?${qs}`);
      assert.equal(g.status, 410, qs);
      assert.equal(g.json.error.code, 'GONE');
    }
    assert.equal((await admin.get('/api/v1/patients?limit=10')).json.total, 1, 'listing without PHI params still allowed');
  } finally { await srv.close(); }
});

test('F-09 X-Forwarded-For honored only from YH_TRUSTED_PROXIES peers', async () => {
  const srv = await startTestServer({ YH_TRUST_PROXY: '1', YH_TRUSTED_PROXIES: '10.9.9.9', YH_RATE_AUTH_BURST: '3', YH_RATE_AUTH_PER_MIN: '1' });
  try {
    const statuses = [];
    for (let i = 0; i < 5; i++) {
      const r = await new Client(srv.url).req('POST', '/api/v1/auth/login', { body: { email: `x${i}@y.test`, password: 'whatever-12345' }, headers: { 'x-forwarded-for': `203.0.113.${i}` } });
      statuses.push(r.status);
    }
    assert.deepEqual(statuses, [401, 401, 401, 429, 429], 'rotating XFF from an untrusted peer does not mint new buckets');
  } finally { await srv.close(); }
  assert.throws(() => loadConfig({ YH_DATA_DIR: tmpDir(), YH_TRUSTED_PROXIES: 'not-an-ip' }), /YH_TRUSTED_PROXIES/);
});

test('F-10 recovery codes: HMAC with a dedicated subkey + key id; valid across rotation; legacy rows migrate', () => {
  const dir = tmpDir();
  // a DB at schema 002 with a legacy JSON recovery-code list, then migration 003
  const old = path.join(dir, 'm'); fs.mkdirSync(old);
  for (const m of listMigrations().filter((x) => x.version < '003')) fs.copyFileSync(path.join(MIGRATIONS_DIR, m.name), path.join(old, m.name));
  const db = openDb(path.join(dir, 'r.sqlite'));
  migrate(db, { dir: old });
  const ts = new Date().toISOString();
  db.run('INSERT INTO orgs (id, name, created_at, updated_at) VALUES (?,?,?,?)', 'o', 'O', ts, ts);
  const legacy = (c) => sha256hex(`youheal-recovery|${c.replace(/-/g, '')}`);
  db.run(`INSERT INTO users (id, org_id, email, name, role, password_hash, mfa_enabled, recovery_codes, created_at, updated_at)
    VALUES ('u','o','u@x.test','U','practitioner','x',1,?,?,?)`, JSON.stringify([{ h: legacy('aaaaa-bbbbb'), used: null }, { h: legacy('ccccc-ddddd'), used: ts }]), ts, ts);
  migrate(db);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM user_recovery_codes').n, 2);
  const oldMaster = generateMasterKey();
  const oldRing = new Keyring(oldMaster);
  assert.ok(consumeRecoveryCode(db, oldRing, 'u', 'aaaaa-bbbbb'), 'legacy code still works once');
  assert.equal(consumeRecoveryCode(db, oldRing, 'u', 'ccccc-ddddd'), null, 'used legacy code stays used');

  const codes = generateRecoveryCodes(3);
  storeRecoveryCodes(db, oldRing, 'u', codes);
  const row = db.get('SELECT code_hash, key_id FROM user_recovery_codes LIMIT 1');
  assert.equal(row.key_id, oldRing.keyId);
  assert.notEqual(row.code_hash, legacy(codes[0]));
  const rotated = new Keyring(generateMasterKey(), [oldMaster]);
  assert.deepEqual(consumeRecoveryCode(db, rotated, 'u', codes[0]), { remaining: 2 }, 'valid after rotation via the retired key');
  assert.equal(consumeRecoveryCode(db, new Keyring(generateMasterKey()), 'u', codes[1]), null, 'retired key required');
  db.close();
});

test('F-11 tenancy: org-less audit rows hidden, neutral email conflict, org-scoped verify count', async () => {
  const { srv, admin } = await bootstrap();
  try {
    const d = rawDb(srv);
    const ts = new Date().toISOString();
    const orgB = uuid();
    d.prepare('INSERT INTO orgs (id, name, profile, created_at, updated_at) VALUES (?,?,?,?,?)').run(orgB, 'Org B', '{}', ts, ts);
    d.prepare(`INSERT INTO users (id, org_id, email, name, role, password_hash, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)`)
      .run(uuid(), orgB, 'adminb@b.test', 'B Admin', 'admin', await hashPassword(PW), ts, ts);
    d.close();
    const b = await loginAs(srv, 'adminb@b.test');
    const probes = [];
    for (const email of [ADMIN.email, 'adminb@b.test']) probes.push(await b.post('/api/v1/users', { email, name: 'Probe', role: 'auditor', password: 'Zq8-vellum-Orchid-41' }));
    for (const r of probes) { assert.equal(r.status, 409); assert.deepEqual([r.json.error.code, r.json.error.message], ['USER_CREATE_FAILED', 'Could not create user']); }
    await new Client(srv.url).post('/api/v1/auth/login', { email: 'ceo@a.test', password: 'whatever-password-1' });
    for (const c of [admin, b]) {
      const items = (await c.get('/api/v1/audit?limit=500')).json.items;
      assert.equal(items.filter((i) => i.orgId === null).length, 0, 'pre-login rows are platform-only');
    }
    const vb = (await b.get('/api/v1/audit/verify')).json;
    const va = (await admin.get('/api/v1/audit/verify')).json;
    assert.equal(vb.ok, true);
    const d2 = rawDb(srv);
    const countB = d2.prepare('SELECT COUNT(*) AS n FROM audit_log WHERE org_id = ?').get(orgB).n;
    const total = d2.prepare('SELECT COUNT(*) AS n FROM audit_log').get().n;
    d2.close();
    assert.ok(vb.checked <= countB && vb.checked < total, 'org B sees only its own row count');
    assert.ok(va.checked < total);
  } finally { await srv.close(); }
});

test('F-12 auditors read only final/amended reports; reads audited as report.read.auditor', async () => {
  const { srv, admin } = await bootstrap();
  try {
    await mkUser(admin, 'aud@a.test', 'auditor');
    const aud = await loginAs(srv, 'aud@a.test');
    const pt = (await admin.post('/api/v1/patients', { firstName: 'D', lastName: 'E', dob: '1990-01-01' })).json;
    await admin.post(`/api/v1/patients/${pt.id}/consents`, { signatureName: 'D E' });
    const sid = (await admin.post(`/api/v1/patients/${pt.id}/sessions`, { methodology: 'biomagnetism', chiefComplaint: 'secret draft' })).json.id;
    const draft = await aud.get(`/api/v1/sessions/${sid}/report`);
    assert.equal(draft.status, 403);
    assert.ok(!JSON.stringify(draft.json).includes('secret draft'));
    await admin.post(`/api/v1/sessions/${sid}/finalize`, { password: ADMIN.password });
    assert.equal((await aud.get(`/api/v1/sessions/${sid}/report`)).status, 200);
    const d = rawDb(srv);
    assert.equal(d.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'report.read.auditor' AND target_id = ?").get(sid).n, 1);
    d.close();
  } finally { await srv.close(); }
});

test('F-13 huge arrays and deep nesting are rejected with 400, not 500', async () => {
  const { srv, admin } = await bootstrap();
  try {
    const pt = (await admin.post('/api/v1/patients', { firstName: 'J', lastName: 'K', dob: '1990-01-01' })).json;
    const big = '{"signatureName":"x","answers":{"a":[' + Array(400000).fill('0').join(',') + ']}}';
    const r1 = await admin.req('POST', `/api/v1/patients/${pt.id}/consents`, { rawBody: big, headers: { 'content-type': 'application/json' } });
    assert.equal(r1.status, 400);
    const deep = '{"signatureName":"x","answers":' + '{"a":'.repeat(50000) + '1' + '}'.repeat(50000) + '}';
    const r2 = await admin.req('POST', `/api/v1/patients/${pt.id}/consents`, { rawBody: deep, headers: { 'content-type': 'application/json' } });
    assert.equal(r2.status, 400);
    const proto = await admin.req('POST', `/api/v1/patients/${pt.id}/consents`, { rawBody: '{"signatureName":"x","answers":{"a":{"constructor":{"prototype":{"p":1}}}}}', headers: { 'content-type': 'application/json' } });
    assert.equal(proto.status, 400);
    assert.equal((await admin.get('/api/v1/health')).status, 200, 'server still healthy');
  } finally { await srv.close(); }
  let deep = 1; for (let i = 0; i < 100000; i++) deep = { a: deep };
  assert.equal(jsonShapeError(deep, { maxDepth: 5 }), 'is nested too deeply', 'iterative walk: no stack overflow');
});

test('F-14 disabling MFA destroys the user\'s other sessions', async () => {
  const { srv, admin } = await bootstrap();
  try {
    await mkUser(admin, 'm@a.test', 'practitioner');
    const s1 = await loginAs(srv, 'm@a.test');
    const secret = base32Decode((await s1.post('/api/v1/auth/mfa/setup')).json.secret);
    const codes = (await s1.post('/api/v1/auth/mfa/enable', { code: totp(secret) })).json.recoveryCodes;
    const s2 = await loginAs(srv, 'm@a.test', PW, { totp: totp(secret, { time: Date.now() + 30_000 }) });
    assert.equal((await s2.get('/api/v1/auth/me')).status, 200);
    const dis = await s1.post('/api/v1/auth/mfa/disable', { password: PW, code: codes[0] });
    assert.equal(dis.status, 200, JSON.stringify(dis.json));
    assert.equal((await s2.get('/api/v1/auth/me')).status, 401, 'other session revoked');
    assert.equal((await s1.get('/api/v1/auth/me')).status, 200, 'current session kept');
  } finally { await srv.close(); }
});

test('F-15 backup: tag verified before any plaintext is written; decompression capped at the header byte count', async () => {
  const { srv } = await bootstrap();
  const { keyring } = loadKeyring(srv.cfg, silent, { allowGenerate: false });
  await srv.close();
  const dir = tmpDir();
  const db = openDb(srv.cfg.dbPath);
  const file = path.join(dir, 'b.yhbak');
  await writeBackupFile(db, keyring, file, { tmpDir: dir });
  db.close();
  const buf = fs.readFileSync(file);
  const tampered = path.join(dir, 't.yhbak');
  const t = Buffer.from(buf); t[buf.indexOf('\n') + 1] ^= 0x01; fs.writeFileSync(tampered, t);
  const out = path.join(dir, 'out.sqlite');
  await assert.rejects(decryptBackup(tampered, keyring, out), /authentication failed/);
  assert.equal(fs.existsSync(out), false, 'no plaintext output for an unauthenticated file');

  // a correctly authenticated file whose gzip expands beyond its declared size (bomb) is refused
  const bomb = zlib.gzipSync(Buffer.alloc(5 * 1024 * 1024));
  const iv = crypto.randomBytes(12);
  const header = Buffer.from(`${MAGIC}${JSON.stringify({ v: 1, alg: 'aes-256-gcm', compression: 'gzip', keyId: keyring.keyId, iv: iv.toString('base64'), createdAt: new Date().toISOString(), schema: '003', bytes: 1024 })}\n`);
  const c = crypto.createCipheriv('aes-256-gcm', keyring.current.backup, iv);
  c.setAAD(header);
  const ct = Buffer.concat([c.update(bomb), c.final()]);
  const bombFile = path.join(dir, 'bomb.yhbak');
  fs.writeFileSync(bombFile, Buffer.concat([header, ct, c.getAuthTag()]));
  await assert.rejects(decryptBackup(bombFile, keyring, out), /exceeds/);
  assert.equal(fs.existsSync(out), false);
});

test('F-16 restore is audited in the restored chain; external anchor log detects tail truncation', async () => {
  const { srv, admin } = await bootstrap();
  const anchorFile = srv.cfg.auditAnchorFile;
  try {
    for (let i = 0; i < 110; i++) await admin.post('/api/v1/patients/search', { q: `n${i}` });
    assert.ok(readAnchorLog(anchorFile).some((a) => a.id === 100), 'head exported every 100 rows');
  } finally { await srv.close(); }
  const { keyring } = loadKeyring(srv.cfg, silent, { allowGenerate: false });
  const lines = readAnchorLog(anchorFile);
  assert.ok(lines.at(-1).id > 100, 'head exported on shutdown');

  // attacker with DB + key access truncates the tail and re-signs the in-DB anchor: the external log still catches it
  const db = openDb(srv.cfg.dbPath);
  const audit = createAudit(db, keyring, silent, { anchorFile });
  assert.equal(audit.verify().ok, true);
  db.exec('DROP TRIGGER audit_log_no_delete');
  db.run('DELETE FROM audit_log WHERE id > 90');
  const r90 = db.get('SELECT hash FROM audit_log WHERE id = 90');
  const ex = db.get('SELECT exported_id, exported_hash FROM audit_anchor WHERE id = 1');
  db.run('UPDATE audit_anchor SET last_id = 90, last_hash = ?, mac = ? WHERE id = 1', r90.hash, dbAnchorMac(keyring, 90, r90.hash, ex.exported_id, ex.exported_hash));
  const v = audit.verify();
  assert.equal(v.ok, false);
  assert.match(v.reason, /truncated/);
  db.close();

  // restore writes a backup.restore row (with the source file hash) into the restored DB and restarts the anchor log
  const s2 = await bootstrap();
  const backup = (await s2.admin.get('/api/v1/admin/backup')).buf;
  const { keyring: k2 } = loadKeyring(s2.srv.cfg, silent, { allowGenerate: false });
  await s2.srv.close();
  const bfile = path.join(tmpDir(), 'x.yhbak');
  fs.writeFileSync(bfile, backup);
  const res = await restoreBackup(bfile, k2, s2.srv.cfg.dbPath, { anchorFile: s2.srv.cfg.auditAnchorFile });
  const rdb = openDb(s2.srv.cfg.dbPath);
  const row = rdb.get("SELECT * FROM audit_log WHERE action = 'backup.restore'");
  assert.ok(row);
  assert.equal(JSON.parse(row.detail).sourceSha256, crypto.createHash('sha256').update(backup).digest('hex'));
  assert.equal(res.sourceSha256, JSON.parse(row.detail).sourceSha256);
  assert.equal(createAudit(rdb, k2, silent, { anchorFile: s2.srv.cfg.auditAnchorFile }).verify().ok, true);
  rdb.close();
});

test('F-17 __Host- session cookie over TLS; wrong-name and duplicated cookies are ignored', async (t) => {
  const d = tmpDir();
  const cert = path.join(d, 'cert.pem'), key = path.join(d, 'key.pem');
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
  } catch { t.skip('openssl not available'); return; }
  const srv = await startTestServer({ YH_TLS_CERT: cert, YH_TLS_KEY: key, YH_DEV_INSECURE_NO_MFA: '1' });
  try {
    const port = new URL(srv.url).port;
    const host = `localhost:${port}`;
    await raw(srv.url, 'POST', '/api/v1/setup', { headers: { host }, body: { setupToken: setupToken(srv), org: { name: 'TLS' }, admin: ADMIN } });
    const l = await raw(srv.url, 'POST', '/api/v1/auth/login', { headers: { host }, body: { email: ADMIN.email, password: ADMIN.password } });
    assert.equal(l.status, 200);
    const sc = l.headers['set-cookie'].find((c) => c.startsWith('__Host-yh_sid='));
    assert.ok(sc, 'cookie uses the __Host- prefix');
    assert.match(sc, /; Secure/);
    assert.match(sc, /Path=\//);
    assert.doesNotMatch(sc, /Domain=/i);
    const tok = /^__Host-yh_sid=([^;]+)/.exec(sc)[1];
    assert.equal((await raw(srv.url, 'GET', '/api/v1/auth/me', { headers: { host, cookie: `__Host-yh_sid=${tok}` } })).status, 200);
    assert.equal((await raw(srv.url, 'GET', '/api/v1/auth/me', { headers: { host, cookie: `yh_sid=${tok}` } })).status, 401, 'non-prefixed name ignored over TLS');
    assert.equal((await raw(srv.url, 'GET', '/api/v1/auth/me', { headers: { host, cookie: `__Host-yh_sid=${tok}; __Host-yh_sid=attacker` } })).status, 401, 'duplicates refused');
  } finally { await srv.close(); }
  const { srv: plain, admin } = await bootstrap();
  try {
    const good = admin.cookie;
    assert.equal((await raw(plain.url, 'GET', '/api/v1/auth/me', { headers: { cookie: `${good}; yh_sid=tossed` } })).status, 401);
    assert.equal((await raw(plain.url, 'GET', '/api/v1/auth/me', { headers: { cookie: good } })).status, 200);
  } finally { await plain.close(); }
});

test('F-19 shadow lockouts for unknown accounts persist across restarts', async () => {
  const srv = await startTestServer();
  const cfg = srv.cfg;
  try {
    for (let i = 0; i < 5; i++) assert.equal((await new Client(srv.url).post('/api/v1/auth/login', { email: 'ghost@a.test', password: 'x-123456789012' })).status, 401);
  } finally { await srv.close(); }
  const again = await startServer(cfg, { log: silent });
  try {
    const r = await new Client(again.url).post('/api/v1/auth/login', { email: 'ghost@a.test', password: 'x-123456789012' });
    assert.equal(r.status, 423);
    const d = new DatabaseSync(cfg.dbPath);
    const row = d.prepare('SELECT key_hash FROM auth_ghost_lockouts').get();
    d.close();
    assert.ok(row && !row.key_hash.includes('ghost'), 'stored as a keyed hash, not the email');
  } finally { await again.close(); }
});

test('F-20 connection caps: per-client concurrent limit and maxConnections', async () => {
  const srv = await startTestServer({ YH_MAX_CONN_PER_IP: '3', YH_MAX_CONNECTIONS: '50' });
  try {
    assert.ok(srv.server.maxConnections >= 50, 'hard backstop above the polite cap');
    assert.equal(srv.server.headersTimeout, 15_000);
    const port = Number(new URL(srv.url).port);
    const socks = await Promise.all(Array.from({ length: 5 }, () => new Promise((resolve) => {
      const s = net.connect(port, '127.0.0.1', () => resolve(s));
      s.data = ''; s.on('data', (d) => { s.data += d; });
      s.on('close', () => { s.gone = true; });
      s.on('error', () => {});
    })));
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(socks.filter((s) => s.gone).length, 2, 'connections beyond the per-IP cap are closed');
    assert.equal(socks.filter((s) => s.data.startsWith('HTTP/1.1 503')).length, 2, '…with a 503, not a silent reset');
    socks.forEach((s) => s.destroy());
  } finally { await srv.close(); }
});
