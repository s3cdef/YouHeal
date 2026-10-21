#!/usr/bin/env node
// Mock backend for YOU HEAL Clinical web UI development.
// Serves platform/web/ statically and mocks the full CONTRACT §5 /api/v1 surface in memory.
//   node tests/web/mock-server.mjs [--port 4173] [--no-demo] [--seeded]
//   --seeded : start with clinic + admin (admin@clinic.test / correct-horse-battery, MFA off) already set up
//   --no-demo: do not create demo patients/sessions when setup completes
// Not for production. Zero dependencies (node:http / node:crypto / node:fs).
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as C from './mock-data.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(__dirname, '../../web');
const args = process.argv.slice(2);
const argVal = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const PORT = Number(process.env.PORT || argVal('--port', 4173));
const DEMO = !args.includes('--no-demo');
const LATENCY = Number(argVal('--latency', 60));

const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.glb': 'model/gltf-binary', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' };

// ---------------------------------------------------------------- state
const db = {
  org: null, users: [], sessions: new Map(), patients: [], consents: [], scanSessions: [], audit: [],
  failed: new Map(), reportImages: new Map(),
};
const id = (p) => `${p}_${crypto.randomBytes(6).toString('hex')}`;
const now = () => new Date().toISOString();
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const canon = (v) => (Array.isArray(v) ? `[${v.map(canon).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}` : JSON.stringify(v));

function hashPw(pw) { const salt = crypto.randomBytes(16); return `${salt.toString('hex')}:${crypto.scryptSync(pw, salt, 32).toString('hex')}`; }
function checkPw(pw, h) { const [s, k] = h.split(':'); return crypto.timingSafeEqual(crypto.scryptSync(pw, Buffer.from(s, 'hex'), 32), Buffer.from(k, 'hex')); }

// ---- TOTP (RFC 6238, SHA-1, 30 s, 6 digits) ----
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function b32enc(buf) { let bits = ''; for (const b of buf) bits += b.toString(2).padStart(8, '0'); let out = ''; for (let i = 0; i + 5 <= bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5), 2)]; return out; }
function b32dec(s) { let bits = ''; for (const c of s.replace(/=+$/, '')) bits += B32.indexOf(c).toString(2).padStart(5, '0'); const out = []; for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2)); return Buffer.from(out); }
export function totp(secret, step = Math.floor(Date.now() / 30000)) {
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac('sha1', b32dec(secret)).update(msg).digest();
  const o = h[h.length - 1] & 0xf;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1000000).padStart(6, '0');
}
function totpOk(secret, code) { const s = Math.floor(Date.now() / 30000); return [-1, 0, 1].some((d) => totp(secret, s + d) === String(code)); }

function audit(actor, action, target = null, extra = {}) {
  const prev = db.audit.length ? db.audit[db.audit.length - 1].hash : '0'.repeat(64);
  const row = { id: db.audit.length + 1, ts: now(), actor: actor ? { id: actor.id, name: actor.name, email: actor.email } : null, action, target, ip: '127.0.0.1', ...extra };
  row.prevHash = prev; row.hash = sha256(prev + canon({ ...row, hash: undefined }));
  db.audit.push(row);
}

// ---------------------------------------------------------------- catalog helpers
const pointsById = new Map(C.points.map((p) => [p.id, p]));
const pairsById = new Map(C.pairs.map((p) => [p.id, p]));
const entById = new Map(C.entities.map((e) => [e.id, e]));
const protoById = new Map(C.protocols.map((p) => [p.id, p]));
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const textOf = (o) => (o ? Object.values(o).join(' ') : '');

function expandProtocol(proto, seen = new Set()) {
  const out = [];
  for (const it of proto.items) {
    if (it.pair) out.push({ pairId: it.pair, via: proto.id });
    else if (it.protocol && !seen.has(it.protocol)) { seen.add(it.protocol); out.push(...expandProtocol(protoById.get(it.protocol), seen)); }
  }
  return out;
}
const protocolsContaining = (pairId) => C.protocols.filter((p) => expandProtocol(p).some((x) => x.pairId === pairId)).map((p) => ({ id: p.id, kind: p.kind, name: p.name }));
const pairSummary = (p) => ({ id: p.id, number: p.number, level: p.level, name: p.name, tracking: p.tracking, impact: p.impact, category: p.category, ratings: p.ratings,
  relations: p.relations.map((r) => ({ entity: r.entity, ordinal: r.ordinal, name: entById.get(r.entity)?.name })), systems: [...new Set(p.symptoms.map((s) => s.system))] });
function pairFull(p) {
  return { ...p, relations: p.relations.map((r) => ({ ordinal: r.ordinal, entity: entById.get(r.entity) || { id: r.entity, name: { es: r.entity } } })),
    protocols: protocolsContaining(p.id), trackingPoint: pointsById.get(p.tracking.point), impactPoint: pointsById.get(p.impact.point),
    sourceInfo: C.sources.find((s) => s.id === p.source.doc) };
}

function suggest({ symptoms = [], text = '' }) {
  const scores = new Map();
  const add = (pid, s, m) => { const e = scores.get(pid) || { pairId: pid, score: 0, matched: [] }; e.score += s; e.matched.push(m); scores.set(pid, e); };
  for (const sid of symptoms) {
    const s = C.symptoms.find((x) => x.id === sid); if (!s) continue;
    for (const pid of s.pairs) add(pid, 1, { kind: 'symptom', id: s.id, label: s.name });
  }
  const terms = norm(text).split(/[^a-z0-9]+/).filter((w) => w.length > 3);
  for (const p of C.pairs) {
    for (const term of terms) {
      const hitSym = p.symptoms.find((s) => norm(textOf(s.text)).includes(term));
      if (hitSym) add(p.id, 0.6, { kind: 'text', term, label: hitSym.text });
      const hitEnt = p.relations.find((r) => norm(textOf(entById.get(r.entity)?.name)).includes(term));
      if (hitEnt) add(p.id, 0.5, { kind: 'relation', term, label: entById.get(hitEnt.entity).name });
    }
  }
  const max = Math.max(1, ...[...scores.values()].map((x) => x.score));
  return [...scores.values()].map((x) => ({ ...x, score: Math.round((x.score / max) * 100) / 100 })).sort((a, b) => b.score - a.score).slice(0, 20);
}

// ---------------------------------------------------------------- domain helpers
const publicUser = (u) => ({ id: u.id, email: u.email, name: u.name, role: u.role, locale: u.locale, theme: u.theme, mfaEnabled: !!u.mfaEnabled, active: u.active !== false, lastLoginAt: u.lastLoginAt || null, createdAt: u.createdAt });
const patientSummary = (p) => ({ id: p.id, firstName: p.firstName, lastName: p.lastName, dob: p.dob, sex: p.sex, mrn: p.mrn });
function sessionOut(s) {
  const pt = db.patients.find((p) => p.id === s.patientId);
  const pr = db.users.find((u) => u.id === s.practitionerId);
  return { ...s, patient: pt ? patientSummary(pt) : null, practitioner: pr ? { id: pr.id, name: pr.name } : null, findingsCount: s.findings.length };
}
function nextMrn() { return `YH-${String(1000 + db.patients.length + 1)}`; }

function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
const dateOnly = (d) => { const x = new Date(d); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };

function makeFinding(pairId, status, extra = {}) {
  const p = pairsById.get(pairId);
  return { id: id('fnd'), pairId, trackingPoint: p.tracking.point, impactPoint: p.impact.point,
    trackingSide: p.tracking.side === 'RL' ? 'R' : p.tracking.side, impactSide: p.impact.side === 'RL' ? 'L' : p.impact.side,
    qualifiers: [], phenomena: [], dwellMinutes: 15, status, notes: '', createdAt: now(), updatedAt: now(), ...extra };
}

function finalizeSession(s, signatureName, user, when = new Date()) {
  s.status = s.amendOf ? 'amended' : 'final';
  s.finalizedAt = when.toISOString();
  s.signature = { name: signatureName, signedAt: s.finalizedAt, userId: user.id };
  if (!s.followUpDate) s.followUpDate = dateOnly(addDays(s.startedAt, 7));
  const snap = buildReport(s);
  delete snap.images;
  s.reportSnapshot = snap;
  s.reportHash = sha256(canon(snap));
}

function seedDemo(admin) {
  const practitioner = { id: id('usr'), email: 'lucia.herrera@clinic.test', name: 'Dr. Lucía Herrera', role: 'practitioner', locale: 'en', theme: 'system', pw: hashPw('correct-horse-battery'), mfaEnabled: false, active: true, createdAt: now() };
  const assistant = { id: id('usr'), email: 'front.desk@clinic.test', name: 'Sam Rivera', role: 'assistant', locale: 'es', theme: 'system', pw: hashPw('correct-horse-battery'), mfaEnabled: false, active: true, createdAt: now() };
  db.users.push(practitioner, assistant);
  const mk = (firstName, lastName, dob, sex, extra = {}) => {
    const p = { id: id('pat'), firstName, lastName, dob, sex, phone: '(718) 555-01' + String(10 + db.patients.length), email: `${firstName.toLowerCase()}@example.test`, address: 'Queens, NY', mrn: nextMrn(), notes: '', createdAt: now(), updatedAt: now(), ...extra };
    db.patients.push(p); return p;
  };
  const maria = mk('María', 'González', '1979-04-12', 'female');
  const james = mk('James', 'Carter', '1964-09-30', 'male');
  const ana = mk('Ana Lucía', 'Restrepo', '1991-01-22', 'female');
  const robert = mk('Robert', 'Kim', '1958-06-05', 'male');
  const consent = (p, absolute = [], relative = []) => db.consents.push({ id: id('cns'), patientId: p.id, type: 'intake', answers: { techniqueExplained: true, questionsAnswered: true, understandsScope: true, continuesMedical: true, reason: 'Fatiga y piernas pesadas' }, contraindications: { absolute, relative }, signatureName: `${p.firstName} ${p.lastName}`, signedAt: now(), createdAt: now(), createdBy: practitioner.id });
  consent(maria, [], ['rel-04']); consent(james); consent(robert); consent(ana, ['abs-01'], []);
  const mkSession = (p, daysAgo, findings, { status = 'final', chief = '', symptoms = [], protocolIds = [], follow = null } = {}) => {
    const start = addDays(new Date(), -daysAgo); start.setHours(10 - Math.min(daysAgo, 2), 15, 0, 0);
    const s = { id: id('ses'), patientId: p.id, practitionerId: practitioner.id, methodology: 'biomagnetism', protocolIds, chiefComplaint: chief, symptoms, symptomsText: '', vitals: {},
      status: 'draft', revision: 1, amendOf: null, startedAt: start.toISOString(), finalizedAt: null, followUpDate: follow, findings: findings.map(([pid, st, ex]) => makeFinding(pid, st, ex)), scanState: {}, notes: '' };
    db.scanSessions.push(s);
    if (status === 'final') finalizeSession(s, practitioner.name, practitioner, addDays(start, 0));
    return s;
  };
  mkSession(maria, 14, [['pb-231', 'cleared'], ['pb-232', 'cleared'], ['pb-234', 'impacted', { phenomena: ['infiltrate'] }]], { chief: 'Heavy legs, evening ankle swelling', symptoms: ['piernas-pesadas', 'varices'], protocolIds: ['app-19-circulacion-piernas'] });
  mkSession(maria, 7, [['pb-231', 'cleared'], ['pb-232', 'impacted'], ['pb-236', 'impacted']], { chief: 'Follow-up: leg circulation', symptoms: ['piernas-pesadas', 'calambres'], protocolIds: ['app-19-circulacion-piernas'], follow: dateOnly(new Date()) });
  mkSession(james, 1, [['pb-047', 'found', { notes: 'Marked tenderness epigastric' }], ['pb-063', 'found']], { status: 'draft', chief: 'Gastritis, bloating after meals', symptoms: ['gastritis', 'distension-abdominal'], protocolIds: ['top10-gastrointestinal'] });
  mkSession(robert, 0, [['pb-235', 'impacted', { trackingSide: 'R', impactSide: 'L', phenomena: [] }], ['pb-232', 'cleared']], { chief: 'Low-back pain radiating to right leg', symptoms: ['dolor-lumbar'], protocolIds: [] });
  mkSession(robert, 35, [['pb-235', 'cleared']], { chief: 'Low-back pain', symptoms: ['dolor-lumbar'], follow: dateOnly(addDays(new Date(), -28)) });
  audit(admin, 'demo.seed');
}

function buildReport(s) {
  const pt = db.patients.find((p) => p.id === s.patientId);
  const pr = db.users.find((u) => u.id === s.practitionerId);
  const findings = s.findings.map((f, i) => {
    const p = f.pairId ? pairsById.get(f.pairId) : null;
    return { ...f, n: i + 1,
      pair: p ? { id: p.id, number: p.number, level: p.level, name: p.name, category: p.category, ratings: p.ratings, relations: p.relations.map((r) => ({ ordinal: r.ordinal, entity: entById.get(r.entity) })), source: p.source } : null,
      trackingPoint: pointsById.get(f.trackingPoint) ? { id: f.trackingPoint, name: pointsById.get(f.trackingPoint).name } : { id: f.trackingPoint, name: { es: f.trackingPoint } },
      impactPoint: pointsById.get(f.impactPoint) ? { id: f.impactPoint, name: pointsById.get(f.impactPoint).name } : { id: f.impactPoint, name: { es: f.impactPoint } } };
  });
  return {
    reportId: `RPT-${s.startedAt.slice(0, 4)}-${s.id.slice(-6).toUpperCase()}`,
    status: s.status, revision: s.revision, amendOf: s.amendOf, amendReason: s.amendReason || null,
    hash: s.reportHash || null, generatedAt: now(),
    org: db.org,
    patient: pt ? { ...patientSummary(pt), phone: pt.phone } : null,
    practitioner: pr ? { id: pr.id, name: pr.name, email: pr.email, role: pr.role, license: pr.license || null } : null,
    session: { id: s.id, startedAt: s.startedAt, finalizedAt: s.finalizedAt, methodology: s.methodology, chiefComplaint: s.chiefComplaint,
      protocols: s.protocolIds.map((x) => protoById.get(x)).filter(Boolean).map((p) => ({ id: p.id, name: p.name, kind: p.kind })), notes: s.notes || '' },
    findings,
    symptoms: s.symptoms.map((x) => C.symptoms.find((y) => y.id === x)).filter(Boolean).map((y) => ({ id: y.id, name: y.name, system: y.system })),
    symptomsText: s.symptomsText || '',
    recommendations: {
      pairs: findings.filter((f) => f.pair).flatMap((f) => (pairsById.get(f.pairId).recommendations || []).map((text) => ({ pairId: f.pairId, pairName: f.pair.name, text }))),
      general: C.recommendations,
    },
    followUpDate: s.followUpDate || dateOnly(addDays(s.startedAt, 7)),
    signature: s.signature || null,
    disclaimer: {
      en: 'Biomagnetic Pair findings are complementary, non-diagnostic observations. They do not identify disease and do not replace evaluation, diagnosis or treatment by a licensed physician. Continue all medical indications.',
      es: 'Los hallazgos del Par Biomagnético son observaciones complementarias y no diagnósticas. No identifican enfermedades ni sustituyen la evaluación, el diagnóstico o el tratamiento por un médico con licencia. Continúe todas las indicaciones médicas.',
    },
    images: db.reportImages.get(s.id) || null,
  };
}

// ---------------------------------------------------------------- http plumbing
function send(res, status, body, headers = {}) {
  const data = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(data);
}
const err = (res, status, code, message, fields) => send(res, status, { error: { code, message, ...(fields ? { fields } : {}) } });
function readBody(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { if (!chunks.length) return resolve({}); try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new Error('bad json')); } });
  });
}
function cookies(req) { return Object.fromEntries((req.headers.cookie || '').split(/;\s*/).filter(Boolean).map((c) => { const i = c.indexOf('='); return [c.slice(0, i), decodeURIComponent(c.slice(i + 1))]; })); }
function currentSession(req) {
  const sid = cookies(req).yh_sid; if (!sid) return null;
  const s = db.sessions.get(sha256(sid)); if (!s) return null;
  if (Date.now() - s.lastSeen > 15 * 60 * 1000 || Date.now() - s.created > 12 * 3600 * 1000) { db.sessions.delete(sha256(sid)); return null; }
  s.lastSeen = Date.now();
  const user = db.users.find((u) => u.id === s.userId && u.active !== false);
  return user ? { ...s, user } : null;
}
function startSession(res, user) {
  const sid = crypto.randomBytes(32).toString('base64url');
  const csrf = crypto.randomBytes(24).toString('base64url');
  db.sessions.set(sha256(sid), { userId: user.id, csrf, created: Date.now(), lastSeen: Date.now() });
  res.setHeader('Set-Cookie', `yh_sid=${sid}; HttpOnly; SameSite=Strict; Path=/`);
  return csrf;
}

const ROLE_SETS = {
  any: ['admin', 'practitioner', 'assistant', 'auditor'],
  'practitioner+': ['admin', 'practitioner', 'assistant', 'auditor'],
  clinical: ['admin', 'practitioner'],
  intake: ['admin', 'practitioner', 'assistant'],
  admin: ['admin'],
  audit: ['admin', 'auditor'],
};

const routes = [];
const R = (method, pattern, roles, fn) => {
  const keys = []; const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; })}$`);
  routes.push({ method, re, keys, roles, fn });
};
const list = (arr, q) => { const limit = Number(q.limit || 500); const offset = Number(q.offset || 0); return { items: arr.slice(offset, offset + limit), total: arr.length }; };

// ---- public
R('GET', '/health', null, (c) => send(c.res, 200, { status: 'ok', version: '0.0.0-mock', catalogVersion: '2026.10.0-mock' }));
R('GET', '/setup/status', null, (c) => send(c.res, 200, { needsSetup: db.users.length === 0 }));
R('POST', '/setup', null, (c) => {
  if (db.users.length) return err(c.res, 409, 'ALREADY_SETUP', 'Setup already completed');
  const { org, admin } = c.body;
  const fields = {};
  if (!org?.name) fields['org.name'] = 'required';
  if (!admin?.email || !/^[^\s@]+@[^\s@]+$/.test(admin.email)) fields.email = 'Invalid email';
  if (!admin?.password || admin.password.length < 12) fields.password = 'At least 12 characters';
  if (Object.keys(fields).length) return err(c.res, 400, 'VALIDATION', 'Invalid input', fields);
  db.org = { id: id('org'), name: org.name, legalName: org.name, address: '', phone: '', email: '', website: '', license: '', reportFooter: '', polarity: { negative: '#2563EB', positive: '#DC2626' }, defaultLocale: 'en', logo: null };
  const u = { id: id('usr'), email: admin.email.toLowerCase(), name: admin.name || 'Administrator', role: 'admin', locale: 'en', theme: 'system', pw: hashPw(admin.password), mfaEnabled: false, active: true, createdAt: now() };
  db.users.push(u);
  audit(u, 'setup.complete');
  if (DEMO) seedDemo(u);
  send(c.res, 200, { ok: true });
});
R('POST', '/auth/login', null, (c) => {
  const { email = '', password = '', totp: code } = c.body;
  const u = db.users.find((x) => x.email === String(email).toLowerCase());
  const f = db.failed.get(email) || 0;
  if (f >= 5) return err(c.res, 429, 'LOCKED', 'Too many attempts. Try again in 15 minutes.');
  if (!u || u.active === false || !checkPw(password, u.pw)) { db.failed.set(email, f + 1); audit(u || null, 'auth.login.failed', email); return err(c.res, 401, 'INVALID_CREDENTIALS', 'Invalid email or password'); }
  if (u.mfaEnabled) {
    if (!code) return err(c.res, 401, 'MFA_REQUIRED', 'Enter your authenticator code');
    const rc = (u.recovery || []).findIndex((h) => h === sha256(String(code).trim().toLowerCase()));
    if (rc >= 0) u.recovery.splice(rc, 1);
    else if (!totpOk(u.mfaSecret, code)) { db.failed.set(email, f + 1); return err(c.res, 401, 'INVALID_MFA', 'Invalid code'); }
  }
  db.failed.delete(email);
  u.lastLoginAt = now();
  const csrf = startSession(c.res, u);
  audit(u, 'auth.login');
  send(c.res, 200, { user: publicUser(u), csrfToken: csrf });
});

// ---- session-bound
R('POST', '/auth/logout', 'any', (c) => { db.sessions.delete(sha256(cookies(c.req).yh_sid)); audit(c.user, 'auth.logout'); send(c.res, 200, { ok: true }, { 'Set-Cookie': 'yh_sid=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict' }); });
R('GET', '/auth/me', 'any', (c) => send(c.res, 200, { user: publicUser(c.user), org: db.org, csrfToken: c.sess.csrf }));
R('POST', '/auth/password', 'any', (c) => {
  if (!checkPw(c.body.current || '', c.user.pw)) return err(c.res, 400, 'VALIDATION', 'Current password is incorrect', { current: 'Incorrect password' });
  if (!c.body.next || c.body.next.length < 12) return err(c.res, 400, 'VALIDATION', 'Too short', { next: 'At least 12 characters' });
  c.user.pw = hashPw(c.body.next); audit(c.user, 'auth.password.change'); send(c.res, 200, { ok: true });
});
R('POST', '/auth/mfa/setup', 'any', (c) => {
  c.user.pendingSecret = b32enc(crypto.randomBytes(20));
  const label = encodeURIComponent(`YOU HEAL Clinical:${c.user.email}`);
  send(c.res, 200, { secret: c.user.pendingSecret, otpauthUrl: `otpauth://totp/${label}?secret=${c.user.pendingSecret}&issuer=${encodeURIComponent('YOU HEAL Clinical')}&algorithm=SHA1&digits=6&period=30` });
});
R('POST', '/auth/mfa/enable', 'any', (c) => {
  if (!c.user.pendingSecret || !totpOk(c.user.pendingSecret, c.body.code)) return err(c.res, 400, 'INVALID_MFA', 'Invalid code');
  c.user.mfaSecret = c.user.pendingSecret; delete c.user.pendingSecret; c.user.mfaEnabled = true;
  const codes = Array.from({ length: 10 }, () => { const h = crypto.randomBytes(5).toString('hex'); return `${h.slice(0, 5)}-${h.slice(5)}`; });
  c.user.recovery = codes.map((x) => sha256(x));
  audit(c.user, 'auth.mfa.enable');
  send(c.res, 200, { ok: true, recoveryCodes: codes });
});
R('POST', '/auth/mfa/disable', 'any', (c) => {
  if (c.user.role === 'admin') return err(c.res, 403, 'MFA_REQUIRED_FOR_ROLE', 'Administrators must keep MFA enabled');
  if (!checkPw(c.body.password || '', c.user.pw) || !totpOk(c.user.mfaSecret, c.body.code)) return err(c.res, 400, 'VALIDATION', 'Invalid password or code');
  c.user.mfaEnabled = false; delete c.user.mfaSecret; audit(c.user, 'auth.mfa.disable'); send(c.res, 200, { ok: true });
});
R('PATCH', '/auth/prefs', 'any', (c) => { if (c.body.locale) c.user.locale = c.body.locale; if (c.body.theme) c.user.theme = c.body.theme; send(c.res, 200, { ok: true, user: publicUser(c.user) }); });

R('GET', '/users', 'admin', (c) => send(c.res, 200, list(db.users.map(publicUser), c.query)));
R('POST', '/users', 'admin', (c) => {
  const { email, name, role, password } = c.body;
  if (!email || !name || !ROLE_SETS.any.includes(role)) return err(c.res, 400, 'VALIDATION', 'Invalid input', { email: !email ? 'required' : undefined, name: !name ? 'required' : undefined });
  if (db.users.some((u) => u.email === email.toLowerCase())) return err(c.res, 409, 'EMAIL_TAKEN', 'A user with this email already exists', { email: 'Already in use' });
  if (!password || password.length < 12) return err(c.res, 400, 'VALIDATION', 'Temporary password must be at least 12 characters', { password: 'At least 12 characters' });
  const u = { id: id('usr'), email: email.toLowerCase(), name, role, locale: 'en', theme: 'system', pw: hashPw(password), mfaEnabled: false, active: true, createdAt: now() };
  db.users.push(u); audit(c.user, 'user.create', u.id); send(c.res, 201, publicUser(u));
});
R('PATCH', '/users/:id', 'admin', (c) => {
  const u = db.users.find((x) => x.id === c.params.id); if (!u) return err(c.res, 404, 'NOT_FOUND', 'User not found');
  if (u.id === c.user.id && (c.body.active === false || (c.body.role && c.body.role !== 'admin'))) return err(c.res, 409, 'SELF_LOCKOUT', 'You cannot deactivate or demote yourself');
  for (const k of ['name', 'role', 'active']) if (k in c.body) u[k] = c.body[k];
  if (c.body.password) u.pw = hashPw(c.body.password);
  audit(c.user, 'user.update', u.id); send(c.res, 200, publicUser(u));
});
R('GET', '/org', 'any', (c) => send(c.res, 200, db.org));
R('PATCH', '/org', 'admin', (c) => {
  const allowed = ['name', 'legalName', 'address', 'phone', 'email', 'website', 'license', 'reportFooter', 'polarity', 'defaultLocale', 'logo'];
  if (c.body.logo && String(c.body.logo).length > 280000) return err(c.res, 400, 'VALIDATION', 'Logo too large', { logo: 'Max 200 KB' });
  for (const k of allowed) if (k in c.body) db.org[k] = c.body[k];
  audit(c.user, 'org.update'); send(c.res, 200, db.org);
});

// ---- catalog
R('GET', '/catalog/manifest', 'any', (c) => send(c.res, 200, { version: '2026.10.0-mock', generatedAt: now(), counts: { points: C.points.length, pairs: C.pairs.length, entities: C.entities.length, protocols: C.protocols.length, symptoms: C.symptoms.length } }));
R('GET', '/catalog/points', 'any', (c) => send(c.res, 200, { items: C.points, total: C.points.length }));
R('GET', '/catalog/regions', 'any', (c) => send(c.res, 200, { items: C.regions, total: C.regions.length }));
R('GET', '/catalog/pairs', 'any', (c) => {
  const { q, category, level, point, system, protocol } = c.query;
  let arr = C.pairs;
  if (q) { const n = norm(q); arr = arr.filter((p) => norm(textOf(p.name)).includes(n) || String(p.number) === q.trim() || p.relations.some((r) => norm(textOf(entById.get(r.entity)?.name)).includes(n))); }
  if (category) arr = arr.filter((p) => p.category === category);
  if (level) arr = arr.filter((p) => String(p.level) === String(level));
  if (point) arr = arr.filter((p) => p.tracking.point === point || p.impact.point === point);
  if (system) arr = arr.filter((p) => p.symptoms.some((s) => s.system === system));
  if (protocol) { const ids = new Set(expandProtocol(protoById.get(protocol) || { items: [] }).map((x) => x.pairId)); arr = arr.filter((p) => ids.has(p.id)); }
  send(c.res, 200, list(arr.map(pairSummary), c.query));
});
R('GET', '/catalog/pairs/:id', 'any', (c) => { const p = pairsById.get(c.params.id); return p ? send(c.res, 200, pairFull(p)) : err(c.res, 404, 'NOT_FOUND', 'Pair not found'); });
R('GET', '/catalog/points/:id/pairs', 'any', (c) => {
  const pid = c.params.id;
  const arr = C.pairs.filter((p) => p.tracking.point === pid || p.impact.point === pid).map((p) => ({ ...pairSummary(p), role: p.tracking.point === pid && p.impact.point === pid ? 'both' : p.tracking.point === pid ? 'tracking' : 'impact' }));
  send(c.res, 200, { items: arr, total: arr.length });
});
R('GET', '/catalog/entities', 'any', (c) => {
  let arr = C.entities; const { q, kind, classification } = c.query;
  if (q) arr = arr.filter((e) => norm(textOf(e.name)).includes(norm(q)));
  if (kind) arr = arr.filter((e) => e.kind === kind);
  if (classification) arr = arr.filter((e) => e.classification === classification);
  send(c.res, 200, list(arr.map((e) => ({ ...e, polePairs: C.pairs.filter((p) => p.relations.some((r) => r.entity === e.id)).map((p) => ({ neg: p.tracking.point, pos: p.impact.point, pairId: p.id })) })), c.query));
});
R('GET', '/catalog/entities/:id', 'any', (c) => { const e = entById.get(c.params.id); return e ? send(c.res, 200, { ...e, pairs: C.pairs.filter((p) => p.relations.some((r) => r.entity === e.id)).map(pairSummary) }) : err(c.res, 404, 'NOT_FOUND', 'Not found'); });
R('GET', '/catalog/protocols', 'any', (c) => send(c.res, 200, { items: C.protocols.map((p) => ({ id: p.id, kind: p.kind, name: p.name, count: expandProtocol(p).length, source: p.source })), total: C.protocols.length }));
R('GET', '/catalog/protocols/:id', 'any', (c) => {
  const p = protoById.get(c.params.id); if (!p) return err(c.res, 404, 'NOT_FOUND', 'Protocol not found');
  send(c.res, 200, { ...p, pairs: expandProtocol(p).map((x) => ({ ...pairSummary(pairsById.get(x.pairId)), via: x.via })) });
});
R('GET', '/catalog/symptoms', 'any', (c) => {
  let arr = C.symptoms; const { q, system } = c.query;
  if (q) arr = arr.filter((s) => norm(textOf(s.name)).includes(norm(q)));
  if (system) arr = arr.filter((s) => s.system === system);
  send(c.res, 200, list(arr, c.query));
});
R('POST', '/catalog/suggest', 'any', (c) => send(c.res, 200, { items: suggest(c.body), total: 0 }));
R('GET', '/catalog/search', 'any', (c) => {
  const n = norm(c.query.q || ''); if (!n) return send(c.res, 200, { items: [] });
  const out = [];
  for (const p of C.points) if (norm(textOf(p.name)).includes(n)) out.push({ type: 'point', id: p.id, name: p.name });
  for (const p of C.pairs) if (norm(textOf(p.name)).includes(n) || String(p.number) === n) out.push({ type: 'pair', id: p.id, name: p.name, number: p.number });
  for (const e of C.entities) if (norm(textOf(e.name)).includes(n)) out.push({ type: 'entity', id: e.id, name: e.name, kind: e.kind });
  for (const p of C.protocols) if (norm(textOf(p.name)).includes(n)) out.push({ type: 'protocol', id: p.id, name: p.name });
  for (const s of C.symptoms) if (norm(textOf(s.name)).includes(n)) out.push({ type: 'symptom', id: s.id, name: s.name });
  send(c.res, 200, { items: out.slice(0, 30), total: out.length });
});
R('GET', '/catalog/contraindications', 'any', (c) => send(c.res, 200, { items: C.contraindications, total: C.contraindications.length }));
R('GET', '/catalog/recommendations', 'any', (c) => send(c.res, 200, { items: C.recommendations, total: C.recommendations.length }));
R('GET', '/catalog/glossary', 'any', (c) => send(c.res, 200, { items: C.glossary, total: C.glossary.length }));

// ---- patients
R('GET', '/patients', 'practitioner+', (c) => {
  const q = norm(c.query.q || '').trim();
  let arr = db.patients;
  if (q) arr = arr.filter((p) => norm(p.lastName).startsWith(q) || norm(p.firstName).startsWith(q) || norm(p.mrn) === q || norm(`${p.firstName} ${p.lastName}`).includes(q));
  arr = [...arr].sort((a, b) => a.lastName.localeCompare(b.lastName));
  const withLast = arr.map((p) => { const ss = db.scanSessions.filter((s) => s.patientId === p.id).sort((a, b) => b.startedAt.localeCompare(a.startedAt)); return { ...patientSummary(p), phone: p.phone, lastSessionAt: ss[0]?.startedAt || null, sessionCount: ss.length, updatedAt: p.updatedAt }; });
  audit(c.user, 'patient.list');
  send(c.res, 200, list(withLast, c.query));
});
const PATIENT_FIELDS = ['firstName', 'lastName', 'dob', 'sex', 'phone', 'email', 'address', 'mrn', 'notes', 'emergencyContact', 'occupation', 'referredBy'];
R('POST', '/patients', 'intake', (c) => {
  const b = c.body; const fields = {};
  if (!b.firstName) fields.firstName = 'Required'; if (!b.lastName) fields.lastName = 'Required';
  if (!b.dob || !/^\d{4}-\d{2}-\d{2}$/.test(b.dob)) fields.dob = 'Use YYYY-MM-DD';
  if (Object.keys(fields).length) return err(c.res, 400, 'VALIDATION', 'Please check the highlighted fields', fields);
  const p = { id: id('pat'), createdAt: now(), updatedAt: now() };
  for (const k of PATIENT_FIELDS) p[k] = b[k] ?? '';
  if (!p.mrn) p.mrn = nextMrn();
  db.patients.push(p); audit(c.user, 'patient.create', p.id); send(c.res, 201, p);
});
R('GET', '/patients/:id', 'practitioner+', (c) => { const p = db.patients.find((x) => x.id === c.params.id); if (!p) return err(c.res, 404, 'NOT_FOUND', 'Patient not found'); audit(c.user, 'patient.read', p.id); send(c.res, 200, p); });
R('PATCH', '/patients/:id', 'intake', (c) => {
  const p = db.patients.find((x) => x.id === c.params.id); if (!p) return err(c.res, 404, 'NOT_FOUND', 'Patient not found');
  for (const k of PATIENT_FIELDS) if (k in c.body) p[k] = c.body[k];
  p.updatedAt = now(); audit(c.user, 'patient.update', p.id); send(c.res, 200, p);
});
R('GET', '/patients/:id/consents', 'practitioner+', (c) => { const arr = db.consents.filter((x) => x.patientId === c.params.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); send(c.res, 200, { items: arr, total: arr.length }); });
R('POST', '/patients/:id/consents', 'intake', (c) => {
  const b = c.body;
  if (!b.signatureName) return err(c.res, 400, 'VALIDATION', 'Signature required', { signatureName: 'Required' });
  const x = { id: id('cns'), patientId: c.params.id, type: b.type || 'intake', answers: b.answers || {}, contraindications: b.contraindications || { relative: [], absolute: [] }, signatureName: b.signatureName, signedAt: b.signedAt || now(), createdAt: now(), createdBy: c.user.id };
  db.consents.push(x); audit(c.user, 'consent.create', x.id); send(c.res, 201, x);
});
R('GET', '/patients/:id/sessions', 'practitioner+', (c) => { const arr = db.scanSessions.filter((s) => s.patientId === c.params.id).sort((a, b) => b.startedAt.localeCompare(a.startedAt)).map(sessionOut); send(c.res, 200, { items: arr, total: arr.length }); });
R('POST', '/patients/:id/sessions', 'clinical', (c) => {
  const p = db.patients.find((x) => x.id === c.params.id); if (!p) return err(c.res, 404, 'NOT_FOUND', 'Patient not found');
  const b = c.body;
  if (!['biomagnetism', 'bioenergetics', 'telebioenergetics'].includes(b.methodology)) return err(c.res, 400, 'VALIDATION', 'Invalid methodology', { methodology: 'Invalid' });
  const s = { id: id('ses'), patientId: p.id, practitionerId: c.user.id, methodology: b.methodology, protocolIds: b.protocolIds || [], chiefComplaint: b.chiefComplaint || '', symptoms: b.symptoms || [], symptomsText: '', vitals: b.vitals || {},
    status: 'draft', revision: 1, amendOf: null, startedAt: now(), finalizedAt: null, followUpDate: null, findings: [], scanState: {}, notes: '' };
  db.scanSessions.push(s); audit(c.user, 'session.create', s.id); send(c.res, 201, sessionOut(s));
});
// Assumed (not in CONTRACT §5): cross-patient session listing for the dashboard.
R('GET', '/sessions', 'practitioner+', (c) => {
  const { status, from, to, followUpFrom, followUpTo } = c.query;
  let arr = db.scanSessions;
  if (status) { const st = status.split(','); arr = arr.filter((s) => st.includes(s.status)); }
  if (from) arr = arr.filter((s) => s.startedAt >= from);
  if (to) arr = arr.filter((s) => s.startedAt < to);
  if (followUpFrom || followUpTo) {
    // only the latest session per patient carries the active follow-up
    const latest = new Map(); for (const s of db.scanSessions) { const l = latest.get(s.patientId); if (!l || s.startedAt > l.startedAt) latest.set(s.patientId, s); }
    arr = arr.filter((s) => latest.get(s.patientId) === s && s.followUpDate && (!followUpFrom || s.followUpDate >= followUpFrom) && (!followUpTo || s.followUpDate <= followUpTo));
  }
  arr = [...arr].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).map((s) => { const o = sessionOut(s); delete o.findings; delete o.reportSnapshot; return o; });
  send(c.res, 200, list(arr, c.query));
});
const getSes = (c) => db.scanSessions.find((s) => s.id === c.params.id);
const locked = (s) => s.status !== 'draft';
R('GET', '/sessions/:id', 'practitioner+', (c) => { const s = getSes(c); if (!s) return err(c.res, 404, 'NOT_FOUND', 'Session not found'); audit(c.user, 'session.read', s.id); const o = sessionOut(s); delete o.reportSnapshot; send(c.res, 200, o); });
R('PATCH', '/sessions/:id', 'clinical', (c) => {
  const s = getSes(c); if (!s) return err(c.res, 404, 'NOT_FOUND', 'Session not found');
  if (locked(s)) return err(c.res, 409, 'LOCKED', 'Session is finalized');
  for (const k of ['methodology', 'protocolIds', 'chiefComplaint', 'symptoms', 'symptomsText', 'vitals', 'followUpDate', 'notes', 'scanState']) if (k in c.body) s[k] = c.body[k];
  send(c.res, 200, sessionOut(s));
});
R('POST', '/sessions/:id/findings', 'clinical', (c) => {
  const s = getSes(c); if (!s) return err(c.res, 404, 'NOT_FOUND', 'Session not found');
  if (locked(s)) return err(c.res, 409, 'LOCKED', 'Session is finalized');
  const b = c.body; const p = b.pairId ? pairsById.get(b.pairId) : null;
  if (b.pairId && !p) return err(c.res, 400, 'VALIDATION', 'Unknown pair', { pairId: 'Unknown' });
  if (!p && (!b.trackingPoint || !b.impactPoint)) return err(c.res, 400, 'VALIDATION', 'Pair or points required');
  const f = { id: id('fnd'), pairId: b.pairId || null, trackingPoint: b.trackingPoint || p.tracking.point, impactPoint: b.impactPoint || p.impact.point,
    trackingSide: b.trackingSide || 'C', impactSide: b.impactSide || 'C', qualifiers: b.qualifiers || [], phenomena: b.phenomena || [], dwellMinutes: b.dwellMinutes ?? null,
    status: b.status || 'found', notes: b.notes || '', createdAt: now(), updatedAt: now() };
  s.findings.push(f); audit(c.user, 'finding.create', f.id); send(c.res, 201, f);
});
R('PATCH', '/sessions/:id/findings/:fid', 'clinical', (c) => {
  const s = getSes(c); if (!s) return err(c.res, 404, 'NOT_FOUND', 'Session not found');
  if (locked(s)) return err(c.res, 409, 'LOCKED', 'Session is finalized');
  const f = s.findings.find((x) => x.id === c.params.fid); if (!f) return err(c.res, 404, 'NOT_FOUND', 'Finding not found');
  for (const k of ['trackingSide', 'impactSide', 'qualifiers', 'phenomena', 'dwellMinutes', 'status', 'notes']) if (k in c.body) f[k] = c.body[k];
  f.updatedAt = now(); send(c.res, 200, f);
});
R('DELETE', '/sessions/:id/findings/:fid', 'clinical', (c) => {
  const s = getSes(c); if (!s) return err(c.res, 404, 'NOT_FOUND', 'Session not found');
  if (locked(s)) return err(c.res, 409, 'LOCKED', 'Session is finalized');
  s.findings = s.findings.filter((x) => x.id !== c.params.fid); audit(c.user, 'finding.delete', c.params.fid); send(c.res, 200, { ok: true });
});
R('POST', '/sessions/:id/finalize', 'clinical', (c) => {
  const s = getSes(c); if (!s) return err(c.res, 404, 'NOT_FOUND', 'Session not found');
  if (locked(s)) return err(c.res, 409, 'LOCKED', 'Session is already finalized');
  if (!c.body.signatureName) return err(c.res, 400, 'VALIDATION', 'Signature required', { signatureName: 'Required' });
  finalizeSession(s, c.body.signatureName, c.user);
  audit(c.user, 'session.finalize', s.id, { reportHash: s.reportHash });
  send(c.res, 200, sessionOut(s));
});
R('POST', '/sessions/:id/amend', 'clinical', (c) => {
  const s = getSes(c); if (!s) return err(c.res, 404, 'NOT_FOUND', 'Session not found');
  if (!locked(s)) return err(c.res, 409, 'NOT_FINAL', 'Only finalized sessions can be amended');
  if (!c.body.reason) return err(c.res, 400, 'VALIDATION', 'Reason required', { reason: 'Required' });
  const n = { ...structuredClone(s), id: id('ses'), status: 'draft', revision: s.revision + 1, amendOf: s.id, amendReason: c.body.reason, finalizedAt: null, signature: null, reportHash: null, reportSnapshot: null, practitionerId: c.user.id };
  n.findings = n.findings.map((f) => ({ ...f, id: id('fnd') }));
  db.scanSessions.push(n); audit(c.user, 'session.amend', n.id, { amendOf: s.id }); send(c.res, 201, sessionOut(n));
});
R('GET', '/sessions/:id/report', 'practitioner+', (c) => {
  const s = getSes(c); if (!s) return err(c.res, 404, 'NOT_FOUND', 'Session not found');
  if (c.user.role === 'assistant') return err(c.res, 403, 'FORBIDDEN', 'Not allowed');
  audit(c.user, 'report.read', s.id);
  const rep = s.reportSnapshot ? { ...s.reportSnapshot, generatedAt: now(), images: db.reportImages.get(s.id) || null } : buildReport(s);
  send(c.res, 200, rep);
});
R('PUT', '/sessions/:id/report/images', 'clinical', (c) => {
  const s = getSes(c); if (!s) return err(c.res, 404, 'NOT_FOUND', 'Session not found');
  const { front, back } = c.body;
  for (const [k, v] of Object.entries({ front, back })) if (v && (!/^data:image\/(png|jpeg|webp);base64,/.test(v) || v.length > 2.8e6)) return err(c.res, 400, 'VALIDATION', `Invalid ${k} image`);
  db.reportImages.set(s.id, { front, back }); send(c.res, 200, { ok: true });
});

// ---- audit / admin
R('GET', '/audit', 'audit', (c) => {
  let arr = [...db.audit].reverse();
  if (c.query.actor) arr = arr.filter((a) => a.actor && (a.actor.email.includes(c.query.actor) || a.actor.name.toLowerCase().includes(c.query.actor.toLowerCase())));
  if (c.query.action) arr = arr.filter((a) => a.action.startsWith(c.query.action));
  send(c.res, 200, list(arr, { limit: c.query.limit || 50, offset: c.query.offset || 0 }));
});
R('GET', '/audit/verify', 'audit', (c) => {
  let prev = '0'.repeat(64);
  for (const row of db.audit) {
    const h = sha256(prev + canon({ ...row, hash: undefined }));
    if (row.prevHash !== prev || h !== row.hash) return send(c.res, 200, { ok: false, checked: row.id, brokenAt: row.id });
    prev = row.hash;
  }
  audit(c.user, 'audit.verify');
  send(c.res, 200, { ok: true, checked: db.audit.length - 1 });
});
R('GET', '/admin/backup', 'admin', (c) => {
  audit(c.user, 'backup.export');
  c.res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="youheal-backup-${dateOnly(new Date())}.yhb"` });
  c.res.end(crypto.randomBytes(256));
});

// ---- mock-only helpers
R('GET', '/__mock/totp', null, (c) => { const u = db.users.find((x) => x.email === String(c.query.email || '').toLowerCase()); if (!u) return err(c.res, 404, 'NOT_FOUND', 'no user'); send(c.res, 200, { code: totp(u.mfaSecret || u.pendingSecret) }); });

async function handleApi(req, res, url) {
  const p = url.pathname.slice('/api/v1'.length) || '/';
  const r = routes.find((x) => x.method === req.method && x.re.test(p));
  if (!r) return err(res, 404, 'NOT_FOUND', `No route ${req.method} ${p}`);
  const m = r.re.exec(p); const params = {}; r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
  let body = {};
  if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)) {
    try { body = await readBody(req); } catch (e) { return err(res, e.message === 'too large' ? 413 : 400, 'BAD_REQUEST', e.message); }
  }
  const ctx = { req, res, params, body, query: Object.fromEntries(url.searchParams) };
  if (r.roles) {
    const s = currentSession(req);
    if (!s) return err(res, 401, 'UNAUTHENTICATED', 'Sign in required');
    if (!ROLE_SETS[r.roles].includes(s.user.role)) return err(res, 403, 'FORBIDDEN', 'Your role cannot perform this action');
    if (req.method !== 'GET' && req.headers['x-csrf-token'] !== s.csrf) return err(res, 403, 'CSRF', 'Missing or invalid CSRF token');
    ctx.sess = s; ctx.user = s.user;
  }
  if (LATENCY) await new Promise((r2) => setTimeout(r2, LATENCY));
  return r.fn(ctx);
}

function serveStatic(req, res, url) {
  let p = decodeURIComponent(url.pathname);
  if (p === '/' || p === '') p = '/index.html';
  const file = path.resolve(WEB, `.${p}`);
  if (!file.startsWith(WEB)) { res.writeHead(403); return res.end(); }
  fs.stat(file, (e, st) => {
    if (e || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('X-Frame-Options', 'DENY');
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/v1/') || url.pathname === '/api/v1') await handleApi(req, res, url);
    else serveStatic(req, res, url);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) err(res, 500, 'INTERNAL', 'Internal error');
  }
});

if (args.includes('--seeded')) {
  db.org = { id: id('org'), name: 'YOU HEAL Queens', legalName: 'YOU HEAL Queens LLC', address: '37-12 Main St, Flushing, NY 11354', phone: '(718) 555-0142', email: 'care@youheal.test', website: 'youheal.test', license: 'NY-BIO-00421', reportFooter: '', polarity: { negative: '#2563EB', positive: '#DC2626' }, defaultLocale: 'en', logo: null };
  const u = { id: id('usr'), email: 'admin@clinic.test', name: 'Clinic Admin', role: 'admin', locale: 'en', theme: 'system', pw: hashPw('correct-horse-battery'), mfaEnabled: false, active: true, createdAt: now() };
  db.users.push(u); if (DEMO) seedDemo(u);
}

server.listen(PORT, '127.0.0.1', () => console.log(`[mock] YOU HEAL Clinical mock on http://127.0.0.1:${PORT}  (demo=${DEMO})`));
export default server;
