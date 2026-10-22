// Performance pass: compression (BREACH-safe allow-list), reference-data ETags, incremental audit
// verification, warm-start fast path, index-backed session lists.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { startTestServer, setupToken, Client, tmpDir, FIXTURES, copyFixtures, silent } from './helpers.js';
import { openDb, migrate } from '../../server/lib/db.js';
import { loadCatalog } from '../../server/catalog/load.js';
import { createAudit } from '../../server/lib/audit.js';
import { reencryptAll } from '../../server/lib/rotate.js';
import { Keyring, generateMasterKey } from '../../server/lib/crypto.js';
import { negotiate, ByteLru } from '../../server/lib/compress.js';

const ADMIN = { email: 'admin@a.test', name: 'Alice Admin', password: 'Violet-Harbor-Lantern-42' };

/** Raw GET that does NOT auto-decompress, so encodings and wire sizes are observable. */
function get(url, p, headers = {}) {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    http.get({ host: u.hostname, port: u.port, path: p, headers, agent: false }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}
const decode = (r) => {
  const enc = r.headers['content-encoding'];
  const b = enc === 'br' ? zlib.brotliDecompressSync(r.body) : enc === 'gzip' ? zlib.gunzipSync(r.body) : r.body;
  return JSON.parse(b.toString('utf8'));
};

async function bootstrap(env = {}) {
  const srv = await startTestServer({ YH_DEV_INSECURE_NO_MFA: '1', ...env });
  const admin = new Client(srv.url);
  await admin.post('/api/v1/setup', { setupToken: setupToken(srv), org: { name: 'Org' }, admin: ADMIN });
  await admin.post('/api/v1/auth/login', { email: ADMIN.email, password: ADMIN.password });
  return { srv, admin };
}

test('Accept-Encoding negotiation and byte-bounded LRU', () => {
  assert.equal(negotiate('gzip, deflate, br'), 'br');
  assert.equal(negotiate('br;q=0, gzip'), 'gzip');
  assert.equal(negotiate('identity'), null);
  assert.equal(negotiate(''), null);
  assert.equal(negotiate('*'), 'br');
  const lru = new ByteLru(100);
  lru.set('a', Buffer.alloc(20)); lru.set('b', Buffer.alloc(20)); lru.get('a');
  for (let i = 0; i < 5; i++) lru.set(`x${i}`, Buffer.alloc(20));
  assert.ok(lru.bytes <= 100);
  assert.ok(lru.get('a') === undefined || lru.get('b') === undefined);
});

test('compression only on the public reference-data allow-list (BREACH); Vary; size threshold', async () => {
  const { srv, admin } = await bootstrap();
  try {
    const cookie = admin.cookie;
    const pairs = await get(srv.url, '/api/v1/catalog/pairs', { cookie, 'accept-encoding': 'gzip, br' });
    assert.equal(pairs.status, 200);
    assert.equal(pairs.headers['content-encoding'], 'br');
    assert.match(pairs.headers.vary, /Accept-Encoding/);
    assert.equal(decode(pairs).total, 6);
    const plain = await get(srv.url, '/api/v1/catalog/pairs', { cookie });
    assert.equal(plain.headers['content-encoding'], undefined);
    assert.ok(pairs.body.length < plain.body.length / 2, 'smaller on the wire');
    assert.equal((await get(srv.url, '/api/v1/catalog/pairs', { cookie, 'accept-encoding': 'gzip' })).headers['content-encoding'], 'gzip');
    assert.equal((await get(srv.url, '/api/v1/catalog/regions', { cookie, 'accept-encoding': 'br' })).headers['content-encoding'], undefined, '< 1 KB stays identity');
    // never compressed: CSRF-token bearing and PHI responses
    for (let i = 0; i < 3; i++) await admin.post('/api/v1/patients', { firstName: 'N'.repeat(90), lastName: 'Long'.repeat(20), dob: '1990-01-01', notes: 'x'.repeat(2000) });
    for (const p of ['/api/v1/auth/me', '/api/v1/patients', '/api/v1/sessions', '/api/v1/audit?limit=200', '/api/v1/org']) {
      const r = await get(srv.url, p, { cookie, 'accept-encoding': 'br, gzip' });
      assert.equal(r.status, 200, p);
      assert.equal(r.headers['content-encoding'], undefined, `${p} must never be compressed`);
    }
    const me = await get(srv.url, '/api/v1/auth/me', { cookie, 'accept-encoding': 'br' });
    assert.ok(me.body.length > 0 && JSON.parse(me.body).csrfToken);
    // static assets: precompressed variant with its own ETag
    fs.writeFileSync(path.join(srv.cfg.webDir, 'big.js'), `export const x = ${JSON.stringify('y'.repeat(20000))};\n`);
    const js = await get(srv.url, '/big.js', { 'accept-encoding': 'br' });
    assert.equal(js.headers['content-encoding'], 'br');
    assert.match(js.headers.etag, /-br"$/);
    assert.equal(zlib.brotliDecompressSync(js.body).length, fs.statSync(path.join(srv.cfg.webDir, 'big.js')).size);
    assert.equal((await get(srv.url, '/big.js', { 'accept-encoding': 'br', 'if-none-match': js.headers.etag })).status, 304);
    assert.equal((await get(srv.url, '/big.js')).headers['content-encoding'], undefined);
  } finally { await srv.close(); }
});

test('reference-data ETag: 304 after auth, changes with overrides / catalog reload', async () => {
  const PACKS = path.join(FIXTURES, 'i18n');
  const { srv, admin } = await bootstrap({ YH_I18N_DIR: PACKS });
  try {
    const cookie = admin.cookie;
    const a = await get(srv.url, '/api/v1/catalog/pairs/pb-030', { cookie });
    assert.equal(a.status, 200);
    assert.match(a.headers.etag, /^"[0-9a-f]{32}"$/);
    assert.equal(a.headers['cache-control'], 'private, no-cache');
    assert.equal((await get(srv.url, '/api/v1/catalog/pairs/pb-030', { cookie, 'if-none-match': a.headers.etag })).status, 304);
    assert.equal((await get(srv.url, '/api/v1/catalog/pairs/pb-030', { 'if-none-match': a.headers.etag })).status, 401, 'still auth-gated');
    const q1 = await get(srv.url, '/api/v1/catalog/pairs?level=1&category=virus', { cookie });
    const q2 = await get(srv.url, '/api/v1/catalog/pairs?category=virus&level=1', { cookie });
    assert.equal(q1.headers.etag, q2.headers.etag, 'normalized query');
    await admin.put('/api/v1/i18n/strings', { locale: 'en', key: 'pairs/pb-030/name', text: 'Pylorus – Liver (rev)' });
    const b = await get(srv.url, '/api/v1/catalog/pairs/pb-030', { cookie, 'if-none-match': a.headers.etag });
    assert.equal(b.status, 200, 'override bumps the version');
    assert.equal(JSON.parse(b.body).name.en, 'Pylorus – Liver (rev)');
    const ui = await get(srv.url, '/api/v1/i18n/packs/en/ui', {});
    assert.equal((await get(srv.url, '/api/v1/i18n/packs/en/ui', { 'if-none-match': ui.headers.etag })).status, 304);
  } finally { await srv.close(); }
});

test('incremental audit verification: walks only new rows; checkpoint row/MAC tamper detected; full=1 finds older edits; survives key rotation', () => {
  const db = openDb(path.join(tmpDir(), 'a.sqlite')); migrate(db);
  let kr = new Keyring(generateMasterKey());
  let audit = createAudit(db, kr, silent);
  for (let i = 0; i < 200; i++) audit.append({ action: 'test.event', detail: { i } });
  assert.equal(audit.verify({ full: false }).mode, 'full', 'no checkpoint yet → full walk');
  for (let i = 0; i < 5; i++) audit.append({ action: 'test.event' });
  const inc = audit.verify({ full: false });
  assert.deepEqual([inc.ok, inc.mode, inc.walked, inc.checked], [true, 'incremental', 5, 205]);

  // key rotation re-MACs the checkpoint
  const { newRing } = reencryptAll(db, kr, generateMasterKey());
  kr = newRing; audit = createAudit(db, kr, silent);
  assert.equal(audit.verify({ full: false }).ok, true);

  db.exec('DROP TRIGGER audit_log_no_update');
  db.run(`UPDATE audit_log SET detail = '{"forged":1}' WHERE id = 10`);
  assert.equal(audit.verify({ full: false }).ok, true, 'rows behind the checkpoint are not re-walked by default');
  const full = audit.verify({ full: true });
  assert.deepEqual([full.ok, full.brokenAt], [false, 10]);
  db.run(`UPDATE audit_log SET detail = '{"i":9}' WHERE id = 10`);
  assert.equal(audit.verify({ full: true }).ok, true);

  const cp = db.get('SELECT verified_id FROM audit_anchor').verified_id;
  db.run(`UPDATE audit_log SET detail = '{"forged":2}' WHERE id = ?`, cp);
  const r = audit.verify({ full: false });
  assert.deepEqual([r.ok, r.reason], [false, 'checkpoint row was altered']);
  db.run(`UPDATE audit_log SET detail = NULL WHERE id = ?`, cp);
  db.run('UPDATE audit_anchor SET verified_id = 3');
  assert.match(audit.verify({ full: false }).reason, /checkpoint signature invalid/);
  db.close();
});

test('warm restart skips catalog + pack reads via file stats; a changed file falls back to hashing', () => {
  const dir = copyFixtures();
  const packs = path.join(tmpDir(), 'packs'); fs.cpSync(path.join(FIXTURES, 'i18n'), packs, { recursive: true });
  const db = openDb(path.join(tmpDir(), 'w.sqlite')); migrate(db);
  assert.equal(loadCatalog(db, { dir, i18nDir: packs }).skipped, false);
  const warm = loadCatalog(db, { dir, i18nDir: packs });
  assert.deepEqual([warm.skipped, warm.fast], [true, true]);
  const f = path.join(packs, 'en', 'ui.json');
  fs.writeFileSync(f, fs.readFileSync(f)); // same content, new mtime → hash check → still skipped, stats refreshed
  const r = loadCatalog(db, { dir, i18nDir: packs });
  assert.deepEqual([r.skipped, r.fast], [true, undefined]);
  assert.equal(loadCatalog(db, { dir, i18nDir: packs }).fast, true);
  fs.writeFileSync(f, JSON.stringify({ app: { hello: 'Hi' } }));
  assert.equal(loadCatalog(db, { dir, i18nDir: packs }).skipped, false, 'content change reloads');
  assert.equal(db.get('PRAGMA journal_mode').journal_mode, 'wal');
  db.close();
});

test('session list orderings are served from an index (no temp B-tree)', () => {
  const db = openDb(path.join(tmpDir(), 'q.sqlite')); migrate(db);
  const plan = (sql) => db.all(`EXPLAIN QUERY PLAN ${sql}`, 'o', '2030-01-01').map((r) => r.detail).join(' | ');
  const p1 = plan(`SELECT s.* FROM scan_sessions s WHERE s.org_id = ? AND s.follow_up_date IS NOT NULL AND s.follow_up_date <= ? AND s.superseded_by IS NULL
    ORDER BY s.follow_up_date ASC, s.session_date DESC LIMIT 50`);
  assert.match(p1, /scan_sessions_org_followup_order/);
  assert.doesNotMatch(p1, /TEMP B-TREE/);
  const p2 = db.all("EXPLAIN QUERY PLAN SELECT s.* FROM scan_sessions s WHERE s.org_id = ? ORDER BY s.session_date DESC, s.revision DESC LIMIT 50", 'o').map((r) => r.detail).join(' | ');
  assert.match(p2, /scan_sessions_org_date_rev/);
  assert.doesNotMatch(p2, /TEMP B-TREE/);
  db.close();
});

test('GET /sessions/:id embeds the patient demographics the scan header needs (name, sex, DOB, language)', async () => {
  const { srv, admin } = await bootstrap();
  try {
    const p = (await admin.post('/api/v1/patients', { firstName: 'Jane', lastName: 'Sample', dob: '1980-01-01', sex: 'female' })).json;
    await admin.post(`/api/v1/patients/${p.id}/consents`, { type: 'intake', answers: {}, contraindications: { relative: [], absolute: [] }, signatureName: 'Jane Sample', signedAt: new Date().toISOString() });
    const s = (await admin.post(`/api/v1/patients/${p.id}/sessions`, { methodology: 'biomagnetism', protocolIds: [], chiefComplaint: 'x', symptoms: [] })).json;
    const r = await admin.get(`/api/v1/sessions/${s.id}`);
    assert.equal(r.status, 200);
    assert.deepEqual({ firstName: r.json.patient.firstName, lastName: r.json.patient.lastName, sex: r.json.patient.sex, dob: r.json.patient.dob },
      { firstName: 'Jane', lastName: 'Sample', sex: 'female', dob: '1980-01-01' });
    assert.ok('preferredLanguage' in r.json.patient);
  } finally { await srv.close(); }
});

test('proxy origin aliases (Codespaces rewrites Origin): accepted only from a trusted proxy and same-origin fetches', async () => {
  const pub = 'https://cs-demo-8080.app.github.dev';
  const alias = 'http://localhost:8080';
  const post = (srv, headers) => new Promise((resolve, reject) => {
    const u = new URL(srv.url); const body = JSON.stringify({ email: 'nobody@x.test', password: 'wrong-password-1' });
    const r = http.request({ host: u.hostname, port: u.port, path: '/api/v1/auth/login', method: 'POST', agent: false,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), host: 'cs-demo-8080.app.github.dev', ...headers } },
    (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    r.on('error', reject); r.end(body);
  });
  const trusted = await startTestServer({ YH_TRUST_PROXY: '1', YH_PUBLIC_ORIGIN: pub, YH_ALLOWED_HOSTS: 'cs-demo-8080.app.github.dev', YH_PROXY_ORIGIN_ALIASES: `${alias}` });
  try {
    assert.equal(await post(trusted, { origin: pub }), 401, 'real public origin passes the origin check (401 = bad credentials)');
    assert.equal(await post(trusted, { origin: alias, 'sec-fetch-site': 'same-origin' }), 401, 'rewritten origin accepted from trusted proxy');
    assert.equal(await post(trusted, { origin: alias }), 401, 'no Sec-Fetch-Site (older browsers) still accepted');
    assert.equal(await post(trusted, { origin: alias, 'sec-fetch-site': 'cross-site' }), 403, 'cross-site never accepted');
    assert.equal(await post(trusted, { origin: alias, 'sec-fetch-site': 'same-site' }), 403, 'sibling-subdomain request not accepted via alias');
    assert.equal(await post(trusted, { origin: 'http://localhost:9999', 'sec-fetch-site': 'same-origin' }), 403, 'only listed aliases');
  } finally { await trusted.close(); }
  const untrusted = await startTestServer({ YH_PUBLIC_ORIGIN: pub, YH_ALLOWED_HOSTS: 'cs-demo-8080.app.github.dev', YH_PROXY_ORIGIN_ALIASES: `${alias}` });
  try {
    assert.equal(await post(untrusted, { origin: alias, 'sec-fetch-site': 'same-origin' }), 403, 'alias ignored when the peer is not a trusted proxy');
  } finally { await untrusted.close(); }
});
