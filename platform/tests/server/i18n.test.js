// Language packs (CONTRACT §9): composition, staleness, overrides, coverage, API, report locale + hashing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { startTestServer, setupToken, Client, tmpDir, FIXTURES, copyFixtures } from './helpers.js';
import { openDb, migrate } from '../../server/lib/db.js';
import { loadCatalog } from '../../server/catalog/load.js';
import { createCatalogService } from '../../server/routes/catalog.js';
import { srcHash } from '../../server/i18n/packs.js';
import { canonicalJson } from '../../server/lib/crypto.js';

const PACKS = path.join(FIXTURES, 'i18n');
const ADMIN = { email: 'admin@a.test', name: 'Alice Admin', password: 'Violet-Harbor-Lantern-42' };
const PW = 'Correct-Horse-9-Battery';
const freshDb = () => { const db = openDb(path.join(tmpDir(), 'i.sqlite')); migrate(db); return db; };
const copyPacks = () => {
  const cat = copyFixtures();
  const packs = path.join(tmpDir(), 'packs');
  fs.cpSync(PACKS, packs, { recursive: true });
  return { cat, packs };
};

test('mirror composition: fresh, machine, stale and missing entries; unknown keys warn; coverage reported', () => {
  const db = freshDb();
  const r = loadCatalog(db, { dir: FIXTURES, i18nDir: PACKS });
  assert.ok(r.warnings.some((w) => /unknown key "pairs\/pb-404\/name"/.test(w)));
  assert.equal(r.coverage.en.stale, 1);
  assert.ok(r.coverage.en.missing >= 1 && r.coverage.en.machine === 1);
  const c = createCatalogService(db).get();
  assert.deepEqual(c.points.get('timo').name, { es: 'Timo', en: 'Thymus gland' }, 'fresh machine translation composed');
  assert.deepEqual(c.pairs.get('pb-001').name, { es: 'Timo – Recto', en: 'Thymus – Rectum' });
  assert.deepEqual(c.pairs.get('pb-030').name, { es: 'Píloro – Hígado' }, 'stale entry omitted → UI falls back to es');
  assert.deepEqual(c.symptoms.get('tos').name, { es: 'Tos' }, 'missing entry removes the untracked file value');
  assert.equal(db.get("SELECT COUNT(*) AS n FROM i18n_strings WHERE locale = 'es'").n, 69);
  assert.deepEqual(db.all('SELECT locale, role FROM i18n_packs ORDER BY locale').map((x) => `${x.locale}:${x.role}`), ['en:mirror', 'es:baseline']);
  // pack hashes participate in the unchanged-skip check
  assert.equal(loadCatalog(db, { dir: FIXTURES, i18nDir: PACKS }).skipped, true);
  assert.equal(loadCatalog(db, { dir: FIXTURES }).skipped, false, 'removing packs changes the fingerprint');
  db.close();
});

test('baseline change makes the mirror entry stale automatically', () => {
  const { cat, packs } = copyPacks();
  const p = path.join(cat, 'points.json');
  const pts = JSON.parse(fs.readFileSync(p, 'utf8'));
  pts.find((x) => x.id === 'timo').name.es = 'Timo (glándula)';
  fs.writeFileSync(p, JSON.stringify(pts));
  fs.rmSync(path.join(cat, 'manifest.json'));
  const db = freshDb();
  const r = loadCatalog(db, { dir: cat, i18nDir: packs });
  assert.equal(r.coverage.en.stale, 2);
  assert.ok(r.warnings.some((w) => /baseline entries differ from the catalog/.test(w)));
  assert.deepEqual(createCatalogService(db).get().points.get('timo').name, { es: 'Timo (glándula)' });
  db.close();
});

test('strict pack validation: bad srcHash / status / role are errors', () => {
  const { cat, packs } = copyPacks();
  const f = path.join(packs, 'en', 'catalog.json');
  const en = JSON.parse(fs.readFileSync(f, 'utf8'));
  en['points/recto/name'] = { text: 'Rectum', srcHash: 'XYZ', status: 'curated' };
  en['points/higado/name'] = { text: 'Liver', srcHash: en['points/higado/name'].srcHash, status: 'approved' };
  fs.writeFileSync(f, JSON.stringify(en));
  const db = freshDb();
  assert.throws(() => loadCatalog(db, { dir: cat, i18nDir: packs }), (e) => e.errors.some((x) => /srcHash must be 16/.test(x)) && e.errors.some((x) => /status must be one of/.test(x)));
  db.close();
});

async function bootstrap() {
  const srv = await startTestServer({ YH_DEV_INSECURE_NO_MFA: '1', YH_I18N_DIR: PACKS });
  const admin = new Client(srv.url);
  await admin.post('/api/v1/setup', { setupToken: setupToken(srv), org: { name: 'Org' }, admin: ADMIN });
  await admin.post('/api/v1/auth/login', { email: ADMIN.email, password: ADMIN.password });
  return { srv, admin };
}

test('public pack endpoints work before login (rate-limited/Host-checked pipeline), UI falls back to en, ETag', async () => {
  const { srv } = await bootstrap();
  try {
    const anon = new Client(srv.url);
    const list = await anon.get('/api/v1/i18n/packs');
    assert.equal(list.status, 200);
    const en = list.json.items.find((p) => p.locale === 'en');
    assert.equal(en.nativeName, 'English');
    assert.equal(en.coverage.stale, 1);
    assert.equal(list.json.items[0].locale, 'es');
    const ui = await anon.get('/api/v1/i18n/packs/es/ui');
    assert.equal(ui.json.app.hello, 'Hola');
    assert.equal(ui.json.only.en, 'English only', 'missing keys fall back to en');
    const etag = ui.headers.get('etag');
    assert.equal((await anon.req('GET', '/api/v1/i18n/packs/es/ui', { headers: { 'if-none-match': etag } })).status, 304);
    assert.equal((await anon.get('/api/v1/i18n/packs/xx/ui')).status, 404);
    assert.equal((await anon.get('/api/v1/i18n/packs/en/coverage')).status, 401, 'admin endpoints need auth');
    const port = new URL(srv.url).port;
    const misdirected = await new Promise((resolve) => {
      http.get({ host: '127.0.0.1', port, path: '/api/v1/i18n/packs', headers: { host: 'rebind.example' }, agent: false }, (r) => { r.resume(); resolve(r.statusCode); });
    });
    assert.equal(misdirected, 421, 'Host-checked like every API route');
  } finally { await srv.close(); }
});

test('overrides: CSRF + admin only, audited without text, survive reload, go stale with the baseline; coverage/search/export', async () => {
  const { srv, admin } = await bootstrap();
  try {
    await admin.post('/api/v1/users', { email: 'doc@a.test', name: 'Doc', role: 'practitioner', password: PW });
    const doc = new Client(srv.url);
    await doc.post('/api/v1/auth/login', { email: 'doc@a.test', password: PW });
    const body = { locale: 'en', key: 'pairs/pb-030/name', text: 'ZZQ Pylorus – Liver' };
    assert.equal((await admin.put('/api/v1/i18n/strings', body, { csrf: false })).json.error.code, 'CSRF');
    assert.equal((await admin.req('DELETE', '/api/v1/i18n/strings', { body, csrf: false })).json.error.code, 'CSRF');
    assert.equal((await doc.put('/api/v1/i18n/strings', body)).status, 403);
    assert.equal((await admin.put('/api/v1/i18n/strings', { ...body, locale: 'es' })).status, 400, 'baseline cannot be overridden');
    assert.equal((await admin.put('/api/v1/i18n/strings', { ...body, key: 'pairs/pb-999/name' })).status, 404);

    const cov0 = (await admin.get('/api/v1/i18n/packs/en/coverage')).json;
    assert.equal(cov0.byStatus.stale, 1);
    assert.deepEqual(cov0.stale[0], { key: 'pairs/pb-030/name', baseline: 'Píloro – Hígado', text: 'Pylorus – Liver (outdated)' });
    assert.ok(cov0.missingTotal >= 1);

    const put = await admin.put('/api/v1/i18n/strings', body);
    assert.equal(put.status, 200);
    assert.equal(put.json.item.status, 'reviewed');
    assert.deepEqual((await doc.get('/api/v1/catalog/pairs/pb-030')).json.name, { es: 'Píloro – Hígado', en: 'ZZQ Pylorus – Liver' }, 'live immediately');
    assert.equal((await admin.get('/api/v1/i18n/packs/en/coverage')).json.byStatus.stale, 0);
    const found = await admin.get('/api/v1/i18n/strings?locale=en&q=zzq');
    assert.equal(found.json.total, 1);
    assert.equal(found.json.items[0].override, true);
    assert.equal((await admin.get('/api/v1/i18n/strings?locale=en&status=missing')).json.total, cov0.missingTotal);

    const exp = await admin.get('/api/v1/i18n/packs/en/export');
    assert.match(exp.headers.get('content-disposition'), /attachment/);
    assert.deepEqual(exp.json['pairs/pb-030/name'], { text: 'ZZQ Pylorus – Liver', srcHash: srcHash('Píloro – Hígado'), status: 'reviewed' });
    assert.equal(exp.json['symptoms/tos/name'].text, null);

    const db = new DatabaseSync(srv.cfg.dbPath);
    const auditRows = JSON.stringify(db.prepare("SELECT * FROM audit_log WHERE action LIKE 'i18n.%'").all());
    db.close();
    assert.match(auditRows, /i18n\.string\.update/);
    assert.ok(!auditRows.includes('ZZQ') && !auditRows.includes('Pylorus'), 'no translation text in the audit log');

    // reload (forced) keeps the override
    loadCatalog(srv.db, { dir: FIXTURES, i18nDir: PACKS, force: true });
    assert.equal((await doc.get('/api/v1/catalog/pairs/pb-030')).json.name.en, 'ZZQ Pylorus – Liver', 'override survives reload');

    // baseline change → override stale → omitted
    const { cat, packs } = copyPacks();
    const pf = path.join(cat, 'pairs.json');
    const pairs = JSON.parse(fs.readFileSync(pf, 'utf8'));
    pairs.find((x) => x.id === 'pb-030').name.es = 'Píloro – Hígado (lóbulo)';
    fs.writeFileSync(pf, JSON.stringify(pairs));
    fs.rmSync(path.join(cat, 'manifest.json'));
    loadCatalog(srv.db, { dir: cat, i18nDir: packs });
    assert.deepEqual((await doc.get('/api/v1/catalog/pairs/pb-030')).json.name, { es: 'Píloro – Hígado (lóbulo)' });
    assert.equal((await admin.get('/api/v1/i18n/packs/en/coverage')).json.staleOverrides, 1);
    loadCatalog(srv.db, { dir: FIXTURES, i18nDir: PACKS });

    const del = await admin.req('DELETE', '/api/v1/i18n/strings', { body: { locale: 'en', key: 'pairs/pb-030/name' } });
    assert.equal(del.status, 200);
    assert.equal(del.json.item.status, 'stale', 'reverted to pack text (stale)');
    assert.equal((await admin.req('DELETE', '/api/v1/i18n/strings', { body: { locale: 'en', key: 'pairs/pb-030/name' } })).status, 404);
  } finally { await srv.close(); }
});

test('report language: preferredLanguage, finalize in reportLocale, hash covers localized text, translations leave the snapshot intact', async () => {
  const { srv, admin } = await bootstrap();
  try {
    assert.equal((await admin.post('/api/v1/patients', { firstName: 'A', lastName: 'B', dob: '1990-01-01', preferredLanguage: 'fr' })).status, 400);
    const dflt = (await admin.post('/api/v1/patients', { firstName: 'C', lastName: 'D', dob: '1990-01-01' })).json;
    assert.equal(dflt.preferredLanguage, 'en', 'defaults to the clinic default locale');
    const pt = (await admin.post('/api/v1/patients', { firstName: 'Eva', lastName: 'Ruiz', dob: '1985-03-04', preferredLanguage: 'es' })).json;
    assert.equal(pt.preferredLanguage, 'es');
    assert.equal((await admin.patch(`/api/v1/patients/${pt.id}`, { preferredLanguage: 'en' })).json.preferredLanguage, 'en');
    await admin.patch(`/api/v1/patients/${pt.id}`, { preferredLanguage: 'es' });
    await admin.post(`/api/v1/patients/${pt.id}/consents`, { signatureName: 'Eva Ruiz' });
    const sid = (await admin.post(`/api/v1/patients/${pt.id}/sessions`, { methodology: 'biomagnetism', symptoms: ['tos'] })).json.id;
    await admin.post(`/api/v1/sessions/${sid}/findings`, { pairId: 'pb-001' });
    await admin.post(`/api/v1/sessions/${sid}/findings`, { pairId: 'pb-030' });

    const draftEs = (await admin.get(`/api/v1/sessions/${sid}/report`)).json;
    assert.equal(draftEs.reportLocale, 'es', 'draft defaults to the patient language');
    assert.deepEqual(draftEs.findings[0].pair.name, { es: 'Timo – Recto' });
    assert.deepEqual(draftEs.availableLocales, ['es', 'en']);
    const draftEn = (await admin.get(`/api/v1/sessions/${sid}/report?locale=en`)).json;
    assert.deepEqual(draftEn.findings[0].pair.name, { es: 'Timo – Recto', en: 'Thymus – Rectum' });
    assert.deepEqual(draftEn.findings[1].pair.name, { es: 'Píloro – Hígado' }, 'stale → es fallback, shown and signed as such');
    assert.equal((await admin.get(`/api/v1/sessions/${sid}/report?locale=xx`)).status, 400);

    assert.equal((await admin.post(`/api/v1/sessions/${sid}/finalize`, { password: ADMIN.password, reportLocale: 'fr' })).status, 400);
    const fin = await admin.post(`/api/v1/sessions/${sid}/finalize`, { password: ADMIN.password, reportLocale: 'en' });
    assert.equal(fin.status, 200, JSON.stringify(fin.json));
    assert.equal(fin.json.reportLocale, 'en');
    const rep = (await admin.get(`/api/v1/sessions/${sid}/report`)).json;
    assert.equal(rep.reportLocale, 'en');
    assert.equal(rep.integrity, 'verified');
    assert.deepEqual(rep.findings, draftEn.findings, 'what was shown in en is what was signed');
    const { hash, integrity, supersededBy, ...snapshot } = rep;
    assert.equal(crypto.createHash('sha256').update(canonicalJson(snapshot)).digest('hex'), fin.json.sha256);

    const tr = (await admin.get(`/api/v1/sessions/${sid}/report?locale=es`)).json;
    assert.equal(tr.translationOf, 'en');
    assert.equal(tr.reportLocale, 'es');
    assert.equal(tr.hash.sha256, fin.json.sha256, 'hash refers to the signed original');
    assert.deepEqual(tr.findings[0].pair.name, { es: 'Timo – Recto' });
    // a later override does not alter the signed snapshot, but is used for translations
    await admin.put('/api/v1/i18n/strings', { locale: 'en', key: 'pairs/pb-001/name', text: 'Thymus → Rectum (rev)' });
    const again = (await admin.get(`/api/v1/sessions/${sid}/report`)).json;
    assert.equal(again.integrity, 'verified');
    assert.deepEqual(again.findings[0].pair.name, { es: 'Timo – Recto', en: 'Thymus – Rectum' });
    const db = new DatabaseSync(srv.cfg.dbPath);
    assert.equal(db.prepare('SELECT report_sha256 FROM scan_sessions WHERE id = ?').get(sid).report_sha256, fin.json.sha256);
    db.close();

    // default finalize language = patient preference
    const sid2 = (await admin.post(`/api/v1/patients/${pt.id}/sessions`, { methodology: 'biomagnetism' })).json.id;
    assert.equal((await admin.post(`/api/v1/sessions/${sid2}/finalize`, { password: ADMIN.password })).json.reportLocale, 'es');
  } finally { await srv.close(); }
});
