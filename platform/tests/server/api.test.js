// End-to-end API flow over a real ephemeral server (CONTRACT §5, §7, §8).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { startTestServer, setupToken, Client } from './helpers.js';
import { totp, base32Decode } from '../../server/lib/totp.js';
import { canonicalJson } from '../../server/lib/crypto.js';

let srv;
const ADMIN = { email: 'owner@clinic.test', name: 'Olivia Owner', password: 'Violet-Harbor-Lantern-42' };
const PW = 'Quartz-Meadow-Falcon-77';
const PATIENT = { firstName: 'Guadalupe', lastName: 'López Ñúñez', dob: '1980-05-17', sex: 'female', phone: '+1 555 0100', email: 'g.lopez@example.com', address: '1 Main St', notes: 'Allergic to latex' };
const admin = () => state.admin;
const state = {};
const rawDb = () => new DatabaseSync(srv.cfg.dbPath);
const LOGO = 'data:image/png;base64,' + Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]).toString('base64');
const PNG = 'data:image/png;base64,' + Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]).toString('base64');

before(async () => { srv = await startTestServer(); });
after(async () => { await srv?.close(); });

const securityHeaders = (h) => {
  assert.match(h.get('content-security-policy'), /default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'.*frame-ancestors 'none'; base-uri 'none'; form-action 'self'/);
  assert.equal(h.get('x-content-type-options'), 'nosniff');
  assert.equal(h.get('referrer-policy'), 'no-referrer');
  assert.equal(h.get('cross-origin-opener-policy'), 'same-origin');
  assert.ok(h.get('permissions-policy'));
  assert.ok(h.get('x-request-id'));
};

test('health + security headers on API responses', async () => {
  const c = new Client(srv.url);
  const r = await c.get('/api/v1/health');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { status: 'ok', version: '1.0.0', catalogVersion: 'fixture-2' });
  securityHeaders(r.headers);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  const nf = await c.get('/api/v1/nope');
  assert.equal(nf.status, 404);
  assert.equal(nf.json.error.code, 'NOT_FOUND');
  securityHeaders(nf.headers);
  const m = await c.req('DELETE', '/api/v1/health');
  assert.equal(m.status, 405);
});

test('first-run setup, login, MFA enrollment gate, CSRF, TOTP re-login, recovery codes', async () => {
  const c = new Client(srv.url);
  assert.deepEqual((await c.get('/api/v1/setup/status')).json, { needsSetup: true, tokenRequired: true });
  const weak = await c.post('/api/v1/setup', { setupToken: setupToken(srv), org: { name: 'Clinic' }, admin: { ...ADMIN, password: 'password1234' } });
  assert.equal(weak.status, 400);
  assert.equal(weak.json.error.code, 'VALIDATION');
  assert.ok(weak.json.error.fields['admin.password']);
  const bad = await c.post('/api/v1/setup', { setupToken: setupToken(srv), org: { name: 'Clinic' }, admin: ADMIN, extra: 1 });
  assert.equal(bad.status, 400, 'unknown fields rejected');
  const ok = await c.post('/api/v1/setup', { setupToken: setupToken(srv), org: { name: 'Sunrise Biomagnetism Clinic' }, admin: ADMIN });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json, { ok: true });
  assert.equal((await c.post('/api/v1/setup', { org: { name: 'X' }, admin: ADMIN })).json.error.code, 'ALREADY_SETUP');
  assert.deepEqual((await c.get('/api/v1/setup/status')).json, { needsSetup: false, tokenRequired: true });

  const wrong = await c.post('/api/v1/auth/login', { email: ADMIN.email, password: 'nope-nope-nope' });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.json.error.code, 'INVALID_CREDENTIALS');

  const ctype = await c.req('POST', '/api/v1/auth/login', { rawBody: 'email=a', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  assert.equal(ctype.status, 415, 'JSON only');

  const login = await c.post('/api/v1/auth/login', { email: ADMIN.email.toUpperCase(), password: ADMIN.password });
  assert.equal(login.status, 200);
  assert.equal(login.json.user.role, 'admin');
  assert.equal(login.json.mfaEnrollmentRequired, true);
  assert.ok(login.json.csrfToken);
  const cookie = login.setCookies.find((x) => x.startsWith('yh_sid='));
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Path=\//);
  assert.doesNotMatch(cookie, /Secure/, 'no Secure flag over plain HTTP');

  const me = await c.get('/api/v1/auth/me');
  assert.equal(me.json.mfaEnrollmentRequired, true);
  assert.equal(me.json.org.name, 'Sunrise Biomagnetism Clinic');
  assert.deepEqual(me.json.org.polarity, { negative: '#2563EB', positive: '#DC2626' });

  const gated = await c.get('/api/v1/patients');
  assert.equal(gated.status, 403);
  assert.equal(gated.json.error.code, 'MFA_ENROLLMENT_REQUIRED');
  assert.equal((await c.get('/api/v1/users')).json.error.code, 'MFA_ENROLLMENT_REQUIRED');

  const noCsrf = await c.post('/api/v1/auth/mfa/setup', undefined, { csrf: false });
  assert.equal(noCsrf.status, 403);
  assert.equal(noCsrf.json.error.code, 'CSRF');
  const badCsrf = await c.req('POST', '/api/v1/auth/mfa/setup', { csrf: false, headers: { 'x-csrf-token': 'forged' } });
  assert.equal(badCsrf.json.error.code, 'CSRF');

  const setup = await c.post('/api/v1/auth/mfa/setup');
  assert.equal(setup.status, 200);
  assert.match(setup.json.secret, /^[A-Z2-7]{32}$/);
  assert.match(setup.json.otpauthUrl, /^otpauth:\/\/totp\//);
  const secret = base32Decode(setup.json.secret);
  assert.equal((await c.post('/api/v1/auth/mfa/enable', { code: '000000' === totp(secret) ? '111111' : '000000' })).status, 400);
  const enable = await c.post('/api/v1/auth/mfa/enable', { code: totp(secret) });
  assert.equal(enable.status, 200);
  assert.equal(enable.json.recoveryCodes.length, 10);
  assert.match(enable.json.recoveryCodes[0], /^[a-z0-9]{5}-[a-z0-9]{5}$/);

  assert.equal((await c.post('/api/v1/auth/logout')).status, 200);
  assert.equal((await c.get('/api/v1/auth/me')).status, 401);

  const needMfa = await c.post('/api/v1/auth/login', { email: ADMIN.email, password: ADMIN.password });
  assert.equal(needMfa.status, 401);
  assert.equal(needMfa.json.error.code, 'MFA_REQUIRED');
  const code = totp(secret, { time: Date.now() + 30_000 });
  const relog = await c.post('/api/v1/auth/login', { email: ADMIN.email, password: ADMIN.password, totp: code });
  assert.equal(relog.status, 200);
  assert.equal(relog.json.mfaEnrollmentRequired, false);
  assert.equal(relog.json.user.mfaEnabled, true);
  const sessCookie = c.cookie;

  // replayed TOTP is refused
  const other = new Client(srv.url);
  const replay = await other.post('/api/v1/auth/login', { email: ADMIN.email, password: ADMIN.password, totp: code });
  assert.equal(replay.status, 401);
  assert.equal(replay.json.error.code, 'MFA_INVALID');
  // recovery code works once
  const rc = enable.json.recoveryCodes[0];
  assert.equal((await other.post('/api/v1/auth/login', { email: ADMIN.email, password: ADMIN.password, totp: rc })).status, 200);
  assert.equal((await new Client(srv.url).post('/api/v1/auth/login', { email: ADMIN.email, password: ADMIN.password, totp: rc })).status, 401);
  assert.equal((await other.get('/api/v1/auth/me')).json.user.recoveryCodesRemaining, 9);

  // session rotation on login: the old cookie presented with a new login is invalidated
  const rotate = new Client(srv.url);
  rotate.cookie = sessCookie;
  const before = await rotate.get('/api/v1/auth/me');
  assert.equal(before.status, 200);
  const rc2 = enable.json.recoveryCodes[1];
  await rotate.post('/api/v1/auth/login', { email: ADMIN.email, password: ADMIN.password, totp: rc2 });
  assert.notEqual(rotate.cookie, sessCookie);
  const stale = new Client(srv.url); stale.cookie = sessCookie;
  assert.equal((await stale.get('/api/v1/auth/me')).status, 401);
  state.admin = rotate;
  state.recovery = enable.json.recoveryCodes.slice(2);
});

test('admin creates staff accounts', async () => {
  const a = admin();
  for (const [role, email] of [['practitioner', 'doc@clinic.test'], ['assistant', 'desk@clinic.test'], ['auditor', 'audit@clinic.test']]) {
    const r = await a.post('/api/v1/users', { email, name: `${role} user`, role, password: PW });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    assert.equal(r.json.user.role, role);
    const c = new Client(srv.url);
    const l = await c.post('/api/v1/auth/login', { email, password: PW });
    assert.equal(l.status, 200);
    assert.equal(l.json.mfaEnrollmentRequired, false);
    state[role] = c;
  }
  const dup = await a.post('/api/v1/users', { email: 'doc@clinic.test', name: 'x', role: 'assistant', password: PW });
  assert.equal(dup.status, 409);
  const gen = await a.post('/api/v1/users', { email: 'temp@clinic.test', name: 'Temp', role: 'assistant' });
  assert.ok(gen.json.temporaryPassword);
  const t = new Client(srv.url);
  const tl = await t.post('/api/v1/auth/login', { email: 'temp@clinic.test', password: gen.json.temporaryPassword });
  assert.equal(tl.json.passwordChangeRequired, true);
  assert.equal((await t.get('/api/v1/patients')).json.error.code, 'PASSWORD_CHANGE_REQUIRED');
  assert.equal((await t.post('/api/v1/auth/password', { current: gen.json.temporaryPassword, next: 'Copper-Willow-Sparrow-19' })).status, 200);
  assert.equal((await t.get('/api/v1/patients')).status, 200);
  assert.equal((await state.practitioner.get('/api/v1/users')).status, 403, 'users is admin-only');
  const list = await a.get('/api/v1/users');
  assert.equal(list.json.total, 5);
  const org = await a.patch('/api/v1/org', { phone: '+1 555 0199', reportFooter: 'Sunrise Clinic · Lic. 123' });
  assert.equal(org.status, 200);
  assert.equal(org.json.phone, '+1 555 0199');
  assert.equal((await state.practitioner.patch('/api/v1/org', { phone: '1' })).status, 403);
  // logo: raster only, signature-checked, <= 200 KB
  const svg = 'data:image/svg+xml;base64,' + Buffer.from('<svg onload="alert(1)"/>').toString('base64');
  assert.equal((await a.patch('/api/v1/org', { logo: svg })).status, 400, 'no SVG');
  assert.equal((await a.patch('/api/v1/org', { logo: 'data:image/jpeg;base64,' + LOGO.split(',')[1] })).status, 400, 'magic mismatch');
  const huge = 'data:image/png;base64,' + Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(201 * 1024)]).toString('base64');
  assert.equal((await a.patch('/api/v1/org', { logo: huge })).status, 400, 'too big');
  assert.equal((await a.patch('/api/v1/org', { logo: LOGO })).json.logo, LOGO);
  assert.equal((await state.practitioner.get('/api/v1/org')).json.logo, LOGO);
  const meOrg = (await state.practitioner.get('/api/v1/auth/me')).json.org;
  assert.equal(meOrg.hasLogo, true);
  assert.equal('logo' in meOrg, false, '/auth/me stays small');
  // auditor: minimal user list only
  const minimal = await state.auditor.get('/api/v1/users?minimal=1');
  assert.equal(minimal.status, 200);
  assert.deepEqual(Object.keys(minimal.json.items[0]).sort(), ['id', 'name']);
  assert.equal(minimal.json.total, 5);
  assert.equal((await state.auditor.get('/api/v1/users')).status, 403);
  assert.equal((await state.assistant.get('/api/v1/users?minimal=1')).status, 403);
});

test('patients: CSRF/Origin enforcement, encryption at rest, blind-index search, RBAC', async () => {
  const doc = state.practitioner;
  const noCsrf = await doc.post('/api/v1/patients', PATIENT, { csrf: false });
  assert.equal(noCsrf.status, 403);
  assert.equal(noCsrf.json.error.code, 'CSRF');
  const evil = await doc.req('POST', '/api/v1/patients', { body: PATIENT, headers: { origin: 'http://evil.example' } });
  assert.equal(evil.status, 403);
  assert.equal(evil.json.error.code, 'BAD_ORIGIN');
  const sameOrigin = await doc.req('POST', '/api/v1/patients', { body: { ...PATIENT, lastName: 'Origin-Check' }, headers: { origin: srv.url } });
  assert.equal(sameOrigin.status, 201);

  const invalid = await doc.post('/api/v1/patients', { ...PATIENT, dob: '2999-01-01', email: 'nope' });
  assert.equal(invalid.status, 400);
  assert.ok(invalid.json.error.fields.dob && invalid.json.error.fields.email);

  const created = await doc.post('/api/v1/patients', PATIENT);
  assert.equal(created.status, 201);
  assert.match(created.json.mrn, /^YH-\d{6}$/);
  assert.equal(created.json.lastName, PATIENT.lastName);
  state.patientId = created.json.id;
  state.mrn = created.json.mrn;

  // ciphertext at rest
  const db = rawDb();
  const row = db.prepare('SELECT * FROM patients WHERE id = ?').get(state.patientId);
  for (const col of ['first_name_enc', 'last_name_enc', 'dob_enc', 'phone_enc', 'email_enc', 'address_enc', 'notes_enc', 'mrn_enc', 'sex_enc']) {
    assert.match(row[col], /^v1:[0-9a-f]{16}:/, `${col} encrypted`);
  }
  const dump = JSON.stringify(row);
  for (const v of ['Guadalupe', 'López', 'Lopez', '1980-05-17', 'latex', 'g.lopez']) assert.ok(!dump.includes(v), `${v} not in plaintext`);
  db.close();
  for (const f of [srv.cfg.dbPath, `${srv.cfg.dbPath}-wal`]) {
    if (fs.existsSync(f)) assert.ok(!fs.readFileSync(f).includes('Guadalupe'), `plaintext name absent from ${f}`);
  }

  const dupMrn = await doc.post('/api/v1/patients', { ...PATIENT, mrn: state.mrn });
  assert.equal(dupMrn.status, 409);

  const search = (b) => doc.post('/api/v1/patients/search', b);
  const byName = await search({ q: 'lopez nunez' });
  assert.equal(byName.json.total, 1, 'accent/case-insensitive exact match');
  assert.equal(byName.json.items[0].id, state.patientId);
  assert.equal((await search({ q: state.mrn.toLowerCase() })).json.items[0].id, state.patientId);
  assert.equal((await search({ q: 'lopez' })).json.total, 0, 'exact match only — no partial leakage');
  const letter = await search({ q: 'L' });
  assert.deepEqual(letter.json.items.map((p) => p.id), [state.patientId]);
  assert.equal((await search({ dob: '1980-05-17' })).json.total, 2);
  const page = await doc.get('/api/v1/patients?limit=1&offset=0');
  assert.equal(page.json.items.length, 1);
  assert.equal(page.json.total, 2);

  const one = await doc.get(`/api/v1/patients/${state.patientId}`);
  assert.equal(one.json.notes, PATIENT.notes);
  assert.equal(one.json.latestConsent, null);
  const patched = await doc.patch(`/api/v1/patients/${state.patientId}`, { phone: '+1 555 0111' });
  assert.equal(patched.json.phone, '+1 555 0111');
  assert.equal((await doc.get('/api/v1/patients/not-a-uuid')).status, 400);
  assert.equal((await doc.get(`/api/v1/patients/${crypto.randomUUID()}`)).status, 404);

  // RBAC
  const desk = state.assistant;
  assert.equal((await desk.get('/api/v1/patients')).status, 200, 'assistant: patient directory');
  assert.equal((await desk.post('/api/v1/patients', { ...PATIENT, firstName: 'Ana', lastName: 'Front' })).status, 201, 'assistant: create');
  const aud = state.auditor;
  const audList = await aud.get('/api/v1/patients');
  assert.equal(audList.status, 403, 'auditor: no patient directory');
  assert.equal(audList.json.error.code, 'FORBIDDEN');
  assert.equal((await aud.get(`/api/v1/patients/${state.patientId}`)).status, 403);
  assert.equal((await aud.post('/api/v1/patients', PATIENT)).status, 403);
  assert.equal((await aud.get(`/api/v1/patients/${state.patientId}/sessions`)).status, 403);
});

test('consent, session, findings, report, finalize, immutability, amend', async () => {
  const doc = state.practitioner, desk = state.assistant, pid = state.patientId;
  const noConsent = await doc.post(`/api/v1/patients/${pid}/sessions`, { methodology: 'biomagnetism' });
  assert.equal(noConsent.status, 409);
  assert.equal(noConsent.json.error.code, 'CONSENT_REQUIRED');

  const badCi = await desk.post(`/api/v1/patients/${pid}/consents`, { type: 'intake', signatureName: 'G L', contraindications: { absolute: ['rel-01'] } });
  assert.equal(badCi.status, 400);
  const consent = await desk.post(`/api/v1/patients/${pid}/consents`, {
    type: 'intake', answers: { q1: 'yes', pregnant: false }, contraindications: { relative: ['rel-01'], absolute: [] },
    signatureName: 'Guadalupe López', signedAt: new Date().toISOString(),
  });
  assert.equal(consent.status, 201);
  assert.equal(consent.json.consent.hasRelative, true);
  assert.equal(consent.json.warnings[0].code, 'RELATIVE_CONTRAINDICATION');
  assert.equal((await doc.get(`/api/v1/patients/${pid}/consents`)).json.total, 1);

  assert.equal((await desk.post(`/api/v1/patients/${pid}/sessions`, { methodology: 'biomagnetism' })).status, 403, 'assistant cannot start sessions');
  const unknown = await doc.post(`/api/v1/patients/${pid}/sessions`, { methodology: 'biomagnetism', symptoms: ['nope'] });
  assert.equal(unknown.status, 400);
  const sess = await doc.post(`/api/v1/patients/${pid}/sessions`, {
    methodology: 'biomagnetism', protocolIds: ['top10-gastrointestinal'], chiefComplaint: 'Heartburn after meals', symptoms: ['acidez', 'fatiga'], vitals: { bp: '120/80', hr: 72 },
  });
  assert.equal(sess.status, 201, JSON.stringify(sess.json));
  const sid = sess.json.id;
  state.sessionId = sid;
  assert.equal(sess.json.status, 'draft');
  assert.equal(sess.json.followUpDate, new Date(Date.parse(sess.json.sessionDate) + 7 * 864e5).toISOString().slice(0, 10));
  const db = rawDb();
  assert.match(db.prepare('SELECT chief_complaint_enc FROM scan_sessions WHERE id = ?').get(sid).chief_complaint_enc, /^v1:/);
  db.close();

  // findings
  const f1 = await doc.post(`/api/v1/sessions/${sid}/findings`, { pairId: 'pb-030', status: 'impacted', phenomena: ['infiltrate'], dwellMinutes: 15, notes: 'strong response' });
  assert.equal(f1.status, 201, JSON.stringify(f1.json));
  assert.equal(f1.json.impactSide, 'R', 'side defaults from catalog pair');
  assert.deepEqual(f1.json.qualifiers, { tracking: [], impact: ['INF'] });
  const f2 = await doc.post(`/api/v1/sessions/${sid}/findings`, { trackingPoint: 'timo', impactPoint: 'recto', trackingSide: 'C', impactSide: 'C', status: 'found' });
  assert.equal(f2.json.pairId, 'pb-001', 'points resolved to a catalog pair');
  const f3 = await doc.post(`/api/v1/sessions/${sid}/findings`, { pairId: 'pb-212', trackingSide: 'R', impactSide: 'L' });
  assert.equal(f3.status, 201);
  assert.equal((await doc.post(`/api/v1/sessions/${sid}/findings`, { pairId: 'pb-999' })).status, 400);
  assert.equal((await doc.post(`/api/v1/sessions/${sid}/findings`, { pairId: 'pb-001', trackingPoint: 'higado' })).status, 400);
  assert.equal((await doc.post(`/api/v1/sessions/${sid}/findings`, { pairId: 'pb-001', phenomena: ['bogus'] })).status, 400);
  const assistantFinding = await desk.post(`/api/v1/sessions/${sid}/findings`, { pairId: 'pb-001' });
  assert.equal(assistantFinding.status, 403, 'assistant cannot add findings');
  assert.equal((await desk.get(`/api/v1/sessions/${sid}`)).status, 403, 'assistant cannot read clinical detail');
  assert.equal((await desk.get(`/api/v1/patients/${pid}/sessions`)).json.total, 1, 'assistant sees session summaries');
  const upd = await doc.patch(`/api/v1/sessions/${sid}/findings/${f2.json.id}`, { status: 'cleared', dwellMinutes: 20 });
  assert.equal(upd.json.status, 'cleared');
  assert.equal((await doc.del(`/api/v1/sessions/${sid}/findings/${f3.json.id}`)).status, 200);
  assert.equal((await doc.patch(`/api/v1/sessions/${sid}`, { notes: 'Patient relaxed' })).json.notes, 'Patient relaxed');
  const img = await doc.put(`/api/v1/sessions/${sid}/report/images`, { front: PNG, back: PNG });
  assert.equal(img.status, 200);
  assert.equal((await doc.put(`/api/v1/sessions/${sid}/report/images`, { front: 'data:image/png;base64,AAAA' })).status, 400, 'magic bytes checked');

  // draft report
  const draft = await doc.get(`/api/v1/sessions/${sid}/report`);
  assert.equal(draft.status, 200);
  assert.equal(draft.json.status, 'DRAFT');
  assert.equal(draft.json.hash, null);
  assert.equal(draft.json.title, 'Biomagnetic Pair Scan Report');
  assert.equal(draft.json.patient.fullName, 'Guadalupe López Ñúñez');
  assert.equal(draft.json.patient.age >= 46, true);
  assert.equal(draft.json.findings.length, 2);
  const pb030 = draft.json.findings.find((f) => f.pairId === 'pb-030');
  assert.equal(pb030.tracking.name.en, 'Pylorus');
  assert.equal(pb030.impact.polarity, 'positive');
  assert.deepEqual(pb030.relatedTo.map((r) => r.entity), ['helicobacter-pylori']);
  assert.deepEqual(pb030.ratings, { F: 3, P: 3, R: 2 });
  assert.deepEqual(draft.json.groups.map((g) => g.category).sort(), ['bacteria', 'virus']);
  assert.match(draft.json.disclaimer.en, /complementary, non-diagnostic observations/);
  assert.equal(draft.json.followUp.date, sess.json.followUpDate);
  assert.equal(draft.json.session.protocols[0].name.en, 'Top 10 Gastrointestinal');
  assert.equal(draft.json.bodyMap.images.front, PNG);
  assert.ok(draft.json.bodyMap.magnets.some((m) => m.pointId === 'piloro' && m.polarity === 'negative'));
  assert.ok(draft.json.recommendations.pairSpecific.some((r) => r.pairId === 'pb-030'));
  assert.deepEqual(draft.json.generalRecommendations.map((r) => r.id), ['general-short', 'sti', 'good-eating'], 'only sections relevant to found pairs');
  assert.deepEqual(draft.json.recommendations.general.map((r) => r.id), ['general-short', 'sti', 'good-eating']);
  const short = draft.json.generalRecommendations[0];
  assert.equal(short.summary.es, '1. Cambiar cepillo de dientes');
  assert.ok(short.body.es && short.title.en);
  assert.deepEqual(draft.json.generalRecommendations.find((r) => r.id === 'sti').matchedBy[0].pairIds, ['pb-001']);
  assert.equal(draft.json.org.logo, LOGO, 'org logo in report');

  // scanState: encrypted, round-trips, bounded
  const scanState = { checklist: { 'pb-010': 'negative', 'pb-030': 'found' }, cursor: 2, activeProtocols: ['top10-gastrointestinal'], directed: 'left knee pain' };
  assert.deepEqual((await doc.patch(`/api/v1/sessions/${sid}`, { scanState })).json.scanState, scanState);
  assert.deepEqual((await doc.get(`/api/v1/sessions/${sid}`)).json.scanState, scanState);
  const rawS = rawDb();
  const enc = rawS.prepare('SELECT scan_state_enc FROM scan_sessions WHERE id = ?').get(sid).scan_state_enc;
  rawS.close();
  assert.match(enc, /^v1:/);
  assert.ok(!enc.includes('knee'));
  assert.equal((await doc.patch(`/api/v1/sessions/${sid}`, { scanState: { blob: 'x'.repeat(70 * 1024) } })).status, 400);
  assert.equal((await doc.patch(`/api/v1/sessions/${sid}`, { scanState: [1] })).status, 400);
  assert.equal(draft.json.attestation, null);

  // finalize
  assert.equal((await desk.post(`/api/v1/sessions/${sid}/finalize`, { signatureName: 'x', password: PW })).status, 403);
  const fin = await doc.post(`/api/v1/sessions/${sid}/finalize`, { signatureName: 'Practitioner  USER', password: PW });
  assert.equal(fin.status, 200, JSON.stringify(fin.json));
  assert.match(fin.json.sha256, /^[0-9a-f]{64}$/);
  assert.equal(fin.json.status, 'final');
  state.sha = fin.json.sha256;
  const rep = await doc.get(`/api/v1/sessions/${sid}/report`);
  assert.equal(rep.json.status, 'FINAL');
  assert.equal(rep.json.integrity, 'verified');
  assert.equal(rep.json.hash.sha256, fin.json.sha256);
  assert.equal(rep.json.hash.short, fin.json.sha256.slice(0, 16));
  assert.equal(rep.json.attestation.signatureName, 'practitioner user', 'signature bound to the signer account');
  const { hash, integrity, supersededBy, ...snapshot } = rep.json;
  assert.equal(crypto.createHash('sha256').update(canonicalJson(snapshot)).digest('hex'), fin.json.sha256, 'hash = sha256(canonical JSON)');
  assert.equal(rep.json.bodyMap.images.front, PNG, 'images uploaded before finalize are inside the hashed snapshot');
  assert.equal(rep.json.bodyMap.images.back, PNG);
  const again = await doc.get(`/api/v1/sessions/${sid}/report`);
  assert.equal(again.json.generatedAt, rep.json.generatedAt, 'immutable snapshot');

  // mutations after finalize are rejected
  for (const r of [
    await doc.post(`/api/v1/sessions/${sid}/findings`, { pairId: 'pb-001' }),
    await doc.patch(`/api/v1/sessions/${sid}/findings/${f1.json.id}`, { status: 'cleared' }),
    await doc.del(`/api/v1/sessions/${sid}/findings/${f1.json.id}`),
    await doc.patch(`/api/v1/sessions/${sid}`, { notes: 'late edit' }),
    await doc.patch(`/api/v1/sessions/${sid}`, { scanState: { cursor: 9 } }),
    await doc.put(`/api/v1/sessions/${sid}/report/images`, { front: PNG }),
    await doc.post(`/api/v1/sessions/${sid}/finalize`, { password: PW }),
  ]) {
    assert.equal(r.status, 409);
    assert.equal(r.json.error.code, 'SESSION_LOCKED');
  }
  const raw = rawDb();
  assert.throws(() => raw.prepare("UPDATE findings SET status = 'found' WHERE session_id = ?").run(sid), /immutable/);
  assert.throws(() => raw.prepare("UPDATE scan_sessions SET report_sha256 = 'x' WHERE id = ?").run(sid), /immutable/);
  raw.close();

  // auditor may read the report
  const audRep = await state.auditor.get(`/api/v1/sessions/${sid}/report`);
  assert.equal(audRep.status, 200);
  assert.equal(audRep.json.hash.sha256, state.sha);
  assert.equal((await state.auditor.get(`/api/v1/sessions/${sid}`)).status, 403);

  // amend
  assert.equal((await doc.post(`/api/v1/sessions/${sid}/amend`, {})).status, 400);
  const am = await doc.post(`/api/v1/sessions/${sid}/amend`, { reason: 'Corrected dwell time' });
  assert.equal(am.status, 201, JSON.stringify(am.json));
  assert.equal(am.json.revision, 2);
  assert.equal(am.json.parentId, sid);
  assert.equal(am.json.status, 'draft');
  assert.equal(am.json.findings.length, 2);
  assert.equal(am.json.amendReason, 'Corrected dwell time');
  assert.equal((await doc.post(`/api/v1/sessions/${sid}/amend`, { reason: 'twice' })).json.error.code, 'AMENDMENT_IN_PROGRESS');
  await doc.patch(`/api/v1/sessions/${am.json.id}/findings/${am.json.findings[0].id}`, { dwellMinutes: 25 });
  const fin2 = await doc.post(`/api/v1/sessions/${am.json.id}/finalize`, { password: PW });
  assert.equal(fin2.json.status, 'amended');
  const rep2 = await doc.get(`/api/v1/sessions/${am.json.id}/report`);
  assert.equal(rep2.json.status, 'AMENDED');
  assert.equal(rep2.json.amendment.parentSha256, state.sha);
  const orig = await doc.get(`/api/v1/sessions/${sid}/report`);
  assert.equal(orig.json.status, 'FINAL');
  assert.equal(orig.json.hash.sha256, state.sha, 'original kept intact');
  assert.equal(orig.json.supersededBy, am.json.id);
  assert.equal((await doc.post(`/api/v1/sessions/${sid}/amend`, { reason: 'stale' })).json.error.code, 'ALREADY_SUPERSEDED');
  const list = await doc.get(`/api/v1/patients/${pid}/sessions`);
  assert.equal(list.json.total, 2);
});

test('cross-patient session list, patient summaries', async () => {
  const doc = state.practitioner;
  const countList = () => { const d = rawDb(); const n = d.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'session.list'").get().n; d.close(); return n; };
  const before = countList();
  const all = await doc.get('/api/v1/sessions');
  assert.equal(all.status, 200);
  assert.equal(countList(), before + 1, 'exactly one audit row per list call');
  assert.equal(all.json.total, 2);
  const it = all.json.items.find((x) => x.id === state.sessionId);
  assert.equal(it.patientName, 'Guadalupe López Ñúñez');
  assert.equal(it.patient.mrn, state.mrn);
  assert.equal(it.chiefComplaint, 'Heartburn after meals');
  assert.equal(it.findingsCount, 2);
  assert.equal(it.status, 'final');
  assert.ok(it.startedAt && it.finalizedAt && it.followUpDate);
  assert.equal((await doc.get('/api/v1/sessions?status=amended')).json.total, 1);
  assert.equal((await doc.get('/api/v1/sessions?status=final,amended&latest=1')).json.total, 1, 'latest excludes superseded');
  assert.equal((await doc.get(`/api/v1/sessions?followUpTo=${it.followUpDate}`)).json.total, 2);
  assert.equal((await doc.get('/api/v1/sessions?followUpTo=2000-01-01')).json.total, 0);
  const today = new Date().toISOString().slice(0, 10);
  assert.equal((await doc.get(`/api/v1/sessions?from=${today}&to=${today}`)).json.total, 2);
  assert.equal((await doc.get('/api/v1/sessions?to=2000-01-01')).json.total, 0);
  assert.equal((await doc.get(`/api/v1/sessions?patientId=${state.patientId}&limit=1`)).json.items.length, 1);
  assert.equal((await doc.get('/api/v1/sessions?status=bogus')).status, 400);
  assert.equal((await doc.get('/api/v1/sessions?from=yesterday')).status, 400);
  const d = rawDb();
  const row = d.prepare("SELECT detail FROM audit_log WHERE action = 'session.list' ORDER BY id DESC LIMIT 1").get();
  d.close();
  assert.match(row.detail, /"filters"/);
  assert.ok(!row.detail.includes('Guadalupe') && !row.detail.includes('Heartburn'));

  const desk = await state.assistant.get('/api/v1/sessions');
  assert.equal(desk.status, 200);
  assert.equal(desk.json.items[0].patientName, 'Guadalupe López Ñúñez');
  assert.equal('chiefComplaint' in desk.json.items[0], false, 'assistant: summary only');
  assert.equal((await state.auditor.get('/api/v1/sessions')).status, 403);

  const ps = await doc.get(`/api/v1/patients/${state.patientId}/sessions`);
  assert.equal(ps.json.items[0].chiefComplaint, 'Heartburn after meals');
  assert.equal(ps.json.items[0].findingsCount, 2);
  const plist = await doc.post('/api/v1/patients/search', { q: 'L' });
  assert.equal(plist.json.items[0].sessionCount, 1, 'superseded revisions not counted');
  assert.equal(plist.json.items[0].lastSessionDate, it.startedAt);
  const sug = await doc.post('/api/v1/catalog/suggest', { symptoms: ['acidez'] });
  assert.equal(sug.json.items[0].score01, 1);
  assert.ok(sug.json.items[1].score01 > 0 && sug.json.items[1].score01 < 1);
});

test('catalog endpoints', async () => {
  const c = state.assistant;
  const pts = await c.get('/api/v1/catalog/points');
  assert.equal(pts.json.total, 12);
  assert.deepEqual(pts.json.items.find((p) => p.id === 'timo').pos, { x: 0, y: 1.33, z: 0.1 });
  assert.equal((await c.get('/api/v1/catalog/regions')).json.total, 7);
  assert.equal((await c.get('/api/v1/catalog/manifest')).json.version, 'fixture-2');
  assert.deepEqual((await c.get('/api/v1/catalog/pairs?category=bacteria')).json.items.map((p) => p.id), ['pb-010', 'pb-030', 'cx-rinon--vejiga']);
  assert.deepEqual((await c.get('/api/v1/catalog/pairs?level=2')).json.items.map((p) => p.id), ['pb-212']);
  assert.deepEqual((await c.get('/api/v1/catalog/pairs?point=higado')).json.items.map((p) => p.id), ['pb-030']);
  assert.deepEqual((await c.get('/api/v1/catalog/pairs?system=respiratory')).json.items.map((p) => p.id), ['pb-212']);
  assert.equal((await c.get('/api/v1/catalog/pairs?protocol=basic-detox')).json.total, 2);
  assert.equal((await c.get('/api/v1/catalog/pairs?q=timo')).json.items[0].id, 'pb-001');
  assert.equal((await c.get('/api/v1/catalog/pairs?category=nope')).status, 400);
  const pair = await c.get('/api/v1/catalog/pairs/pb-001');
  assert.equal(pair.json.relations[0].name.en, 'HIV');
  assert.equal(pair.json.sourceInfo.license_status, 'internal-use');
  assert.equal((await c.get('/api/v1/catalog/pairs/pb-404')).status, 404);
  const pp = await c.get('/api/v1/catalog/points/supraespinoso/pairs');
  assert.equal(pp.json.items[0].role, 'both');
  assert.equal((await c.get('/api/v1/catalog/entities?kind=pathogen')).json.total, 3);
  assert.ok((await c.get('/api/v1/catalog/entities/e-coli')).json.pairs.length >= 2);
  const prot = await c.get('/api/v1/catalog/protocols/top10-gastrointestinal');
  assert.equal(prot.json.pairs.length, 4);
  assert.equal((await c.get('/api/v1/catalog/symptoms?system=gastrointestinal')).json.total, 2);
  const sug = await c.post('/api/v1/catalog/suggest', { symptoms: ['acidez'], text: 'nausea' });
  assert.equal(sug.status, 200);
  assert.equal(sug.json.items[0].pairId, 'pb-030');
  assert.ok(sug.json.items[0].matched.length >= 2);
  const s = await c.get('/api/v1/catalog/search?q=higado');
  assert.ok(s.json.items.some((x) => x.kind === 'point' && x.id === 'higado'));
  assert.equal((await c.get('/api/v1/catalog/contraindications')).json.total, 2);
  assert.equal((await c.get('/api/v1/catalog/glossary')).json.total, 3);
  assert.equal((await c.get('/api/v1/catalog/recommendations')).json.total, 6);
  assert.equal((await new Client(srv.url).get('/api/v1/catalog/points')).status, 401, 'catalog requires auth');
});

test('lockout after 5 failures (and for unknown accounts), admin unlock', async () => {
  const a = admin();
  await a.post('/api/v1/users', { email: 'lock@clinic.test', name: 'Lock Test', role: 'practitioner', password: PW });
  const c = new Client(srv.url);
  for (let i = 0; i < 5; i++) {
    const r = await c.post('/api/v1/auth/login', { email: 'lock@clinic.test', password: `wrong-password-${i}` });
    assert.equal(r.status, 401);
  }
  const locked = await c.post('/api/v1/auth/login', { email: 'lock@clinic.test', password: PW });
  assert.equal(locked.status, 423, 'correct password refused while locked');
  assert.equal(locked.json.error.code, 'ACCOUNT_LOCKED');
  const users = (await a.get('/api/v1/users')).json.items;
  const u = users.find((x) => x.email === 'lock@clinic.test');
  assert.equal(u.locked, true);
  assert.equal((await a.patch(`/api/v1/users/${u.id}`, { unlock: true })).json.user.locked, false);
  assert.equal((await c.post('/api/v1/auth/login', { email: 'lock@clinic.test', password: PW })).status, 200);

  const g = new Client(srv.url);
  for (let i = 0; i < 5; i++) assert.equal((await g.post('/api/v1/auth/login', { email: 'ghost@clinic.test', password: 'whatever-123456' })).status, 401);
  assert.equal((await g.post('/api/v1/auth/login', { email: 'ghost@clinic.test', password: 'whatever-123456' })).status, 423, 'unknown accounts lock the same way');
});

test('idle session timeout and last-admin protection', async () => {
  const c = new Client(srv.url);
  await c.post('/api/v1/auth/login', { email: 'doc@clinic.test', password: PW });
  assert.equal((await c.get('/api/v1/auth/me')).status, 200);
  const db = rawDb();
  db.prepare('UPDATE user_sessions SET last_seen_at = ? WHERE user_id = (SELECT id FROM users WHERE email = ?)').run(new Date(Date.now() - 16 * 60_000).toISOString(), 'doc@clinic.test');
  db.close();
  const r = await c.get('/api/v1/auth/me');
  assert.equal(r.status, 401);
  assert.equal(r.json.error.code, 'SESSION_EXPIRED');
  state.practitioner = c;
  await c.post('/api/v1/auth/login', { email: 'doc@clinic.test', password: PW });

  const a = admin();
  const me = (await a.get('/api/v1/auth/me')).json.user;
  const demote = await a.patch(`/api/v1/users/${me.id}`, { role: 'practitioner' });
  assert.equal(demote.status, 409);
  assert.equal(demote.json.error.code, 'LAST_ADMIN');
});

test('audit log: events recorded without PHI, chain verifies, tampering detected', async () => {
  const a = admin();
  const log = await a.get('/api/v1/audit?limit=500');
  assert.equal(log.status, 200);
  const actions = new Set(log.json.items.map((i) => i.action));
  for (const act of ['setup.complete', 'auth.login.success', 'auth.login.failure', 'auth.lockout', 'auth.mfa.enable', 'patient.create', 'patient.read',
    'patient.search', 'consent.create', 'session.create', 'finding.create', 'session.finalize', 'session.amend', 'report.read']) {
    assert.ok(actions.has(act), `audit has ${act}`);
  }
  const fin = log.json.items.find((i) => i.action === 'session.finalize');
  assert.ok(fin.actor && fin.ip && fin.requestId && fin.targetType === 'session' && fin.targetId);
  const db = rawDb();
  const all = JSON.stringify(db.prepare('SELECT * FROM audit_log').all());
  db.close();
  for (const phi of ['Guadalupe', 'López', '1980-05-17', 'latex', 'Heartburn', PW, ADMIN.password]) assert.ok(!all.includes(phi), `audit must not contain ${phi}`);
  assert.equal((await a.get('/api/v1/audit?action=auth.*&limit=5')).json.items.every((i) => i.action.startsWith('auth.')), true);
  assert.equal((await state.auditor.get('/api/v1/audit')).status, 200);
  assert.equal((await state.practitioner.get('/api/v1/audit')).status, 403);

  const ok = await state.auditor.get('/api/v1/audit/verify');
  assert.equal(ok.json.ok, true);
  assert.ok(ok.json.checked > 50);

  const raw = rawDb();
  raw.exec('DROP TRIGGER audit_log_no_update');
  raw.prepare("UPDATE audit_log SET detail = '{\"forged\":true}' WHERE id = 3").run();
  raw.close();
  const incremental = await a.get('/api/v1/audit/verify');
  assert.equal(incremental.json.mode, 'incremental', 'default walks only rows after the MAC\'d checkpoint');
  assert.equal((await state.auditor.get('/api/v1/audit/verify?full=1')).status, 403, 'full re-verification is admin-only');
  const bad = await a.get('/api/v1/audit/verify?full=1');
  assert.equal(bad.json.ok, false, 'full verification detects edits behind the checkpoint');
  assert.equal(bad.json.brokenAt, 3);
});

test('logout clears the session', async () => {
  const c = state.assistant;
  assert.equal((await c.post('/api/v1/auth/logout')).status, 200);
  assert.equal((await c.get('/api/v1/patients')).status, 401);
});
