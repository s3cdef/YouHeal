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
const PACKS_DIR = path.resolve(__dirname, '../../data/i18n/packs');
const args = process.argv.slice(2);
const argVal = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const PORT = Number(process.env.PORT || argVal('--port', 4173));
const DEMO = !args.includes('--no-demo');
const LATENCY = Number(argVal('--latency', 60));
const NO_MFA = args.includes('--no-mfa');
const LEGACY_RECOVERY = args.includes('--legacy-recovery'); // flag users as holding old-format recovery codes
const SETUP_TOKEN = args.includes('--no-setup-token') ? null : crypto.randomBytes(12).toString('base64url');

const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.glb': 'model/gltf-binary', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' };

// ---------------------------------------------------------------- state
const db = {
  org: null, users: [], sessions: new Map(), patients: [], consents: [], scanSessions: [], audit: [],
  failed: new Map(), reportImages: new Map(),
};
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
  const row = { id: db.audit.length + 1, ts: now(), actor: actor ? { id: actor.id, name: actor.name, email: actor.email, role: actor.role } : null, action,
    targetType: target ? (String(action).split('.')[0]) : null, targetId: target, outcome: /failure/.test(action) ? 'failure' : 'success', ip: '127.0.0.1', detail: extra.detail || null };
  row.prevHash = prev; row.hash = sha256(prev + canon({ ...row, hash: undefined }));
  db.audit.push(row);
}

// ---------------------------------------------------------------- catalog helpers (shapes mirror server/routes/catalog.js)
const pointsById = new Map(C.points.map((p) => [p.id, p]));
const pairsById = new Map(C.pairs.map((p) => [p.id, p]));
const entById = new Map(C.entities.map((e) => [e.id, e]));
const protoById = new Map(C.protocols.map((p) => [p.id, p]));
const sourceById = new Map(C.sources.map((s) => [s.id, s]));
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const textOf = (o) => (o ? Object.values(o).join(' ') : '');

function expandProtocol(proto, seen = new Set()) {
  const out = [];
  for (const it of proto.items) {
    if (it.pair) { if (!out.some((x) => x.pairId === it.pair)) out.push({ pairId: it.pair, via: proto.id }); }
    else if (it.protocol && !seen.has(it.protocol)) { seen.add(it.protocol); for (const x of expandProtocol(protoById.get(it.protocol), seen)) if (!out.some((y) => y.pairId === x.pairId)) out.push(x); }
  }
  return out;
}
const protocolsContaining = (pairId) => C.protocols.filter((p) => expandProtocol(p).some((x) => x.pairId === pairId)).map((p) => ({ id: p.id, kind: p.kind, name: p.name }));
const pointRef = (id, end) => ({ point: id, side: end?.side || 'C', qualifiers: end?.qualifiers || [], name: pointsById.get(id)?.name ?? null });
const pairSummary = (p) => (p ? {
  id: p.id, number: p.number ?? null, level: p.level ?? 0, name: p.name,
  tracking: pointRef(p.tracking.point, p.tracking), impact: pointRef(p.impact.point, p.impact),
  category: p.category ?? null, ratings: p.ratings || {},
  relations: p.relations.map((r) => ({ entity: r.entity, ordinal: r.ordinal ?? null, name: entById.get(r.entity)?.name ?? null, kind: entById.get(r.entity)?.kind ?? null })),
} : null);
function pairFull(p) {
  const src = sourceById.get(p.source?.doc);
  return { ...p, ...pairSummary(p),
    relations: p.relations.map((r) => { const e = entById.get(r.entity); return { entity: r.entity, ordinal: r.ordinal ?? null, name: e?.name ?? null, kind: e?.kind ?? null, classification: e?.classification ?? null }; }),
    trackingPoint: pointsById.get(p.tracking.point) || null, impactPoint: pointsById.get(p.impact.point) || null,
    symptomIds: C.symptoms.filter((s) => s.pairs.includes(p.id)).map((s) => s.id),
    protocols: protocolsContaining(p.id),
    sourceInfo: src ? { id: src.id, title: src.title, license_status: src.license_status, notice: src.notice ?? null } : null };
}
const fWeight = (p) => { const F = p.ratings?.F; return F > 0 ? (1 + F) / 4 : 0.4; };
function suggest({ symptoms = [], text = '' }) {
  const scores = new Map();
  const bump = (pid, inc, reason) => { const e = scores.get(pid) || { pairId: pid, score: 0, matched: [] }; e.score += inc; e.matched.push(reason); scores.set(pid, e); };
  for (const sid of symptoms) {
    const s = C.symptoms.find((x) => x.id === sid); if (!s || !s.pairs.length) continue;
    const spec = 1 / Math.log(1 + s.pairs.length);
    for (const pid of s.pairs) bump(pid, spec * fWeight(pairsById.get(pid)), { type: 'symptom', id: sid, name: s.name, weight: Math.round(spec * 1000) / 1000 });
  }
  const tokens = [...new Set(norm(text).match(/[a-z0-9]+/g) || [])].filter((w) => w.length >= 3).slice(0, 20);
  for (const p of C.pairs) for (const t of tokens) {
    const hit = p.symptoms.find((s) => norm(textOf(s.text)).includes(t));
    if (hit) { bump(p.id, 0.5 * fWeight(p), { type: 'text', token: t, field: 'symptom', system: hit.system, text: hit.text }); continue; }
    if (norm(textOf(p.name)).includes(t)) { bump(p.id, 0.35 * fWeight(p), { type: 'text', token: t, field: 'name' }); continue; }
    if (p.relations.some((r) => norm(textOf(entById.get(r.entity)?.name)).includes(t))) bump(p.id, 0.35 * fWeight(p), { type: 'text', token: t, field: 'relation' });
  }
  const top = Math.max(1e-9, ...[...scores.values()].map((x) => x.score));
  return [...scores.values()].map((x) => ({ ...x, score: Math.round(x.score * 1000) / 1000, score01: Math.round((x.score / top) * 1000) / 1000, pair: pairSummary(pairsById.get(x.pairId)) })).sort((a, b) => b.score - a.score).slice(0, 25);
}

// ---------------------------------------------------------------- domain helpers
const publicUser = (u) => ({ id: u.id, email: u.email, name: u.name, role: u.role, locale: u.locale, theme: u.theme, mfaEnabled: !!u.mfaEnabled, active: u.active !== false,
  locked: !!(u.lockedUntil && u.lockedUntil > Date.now()), mustChangePassword: !!u.mustChangePassword, recoveryCodesRemaining: (u.recovery || []).length, lastLoginAt: u.lastLoginAt || null, createdAt: u.createdAt });
const ageAt = (dob, at = new Date().toISOString()) => { if (!dob) return null; const [y, m, d] = dob.split('-').map(Number); const [ay, am, ad] = at.slice(0, 10).split('-').map(Number); let a = ay - y; if (am < m || (am === m && ad < d)) a--; return a; };
const patientSummary = (p) => ({ id: p.id, mrn: p.mrn, firstName: p.firstName, lastName: p.lastName, dob: p.dob, age: ageAt(p.dob), sex: p.sex, archived: false, createdAt: p.createdAt });
const restrictionOf = (u) => (u.mustChangePassword ? 'password' : u.role === 'admin' && !u.mfaEnabled && !NO_MFA ? 'mfa' : null);
const orgPublic = () => (db.org ? (({ logo, ...rest }) => ({ ...rest, hasLogo: !!logo }))(db.org) : null);
const mePayload = (u, csrf) => ({ user: publicUser(u), org: orgPublic(), csrfToken: csrf, mfaEnrollmentRequired: restrictionOf(u) === 'mfa', passwordChangeRequired: restrictionOf(u) === 'password', recoveryCodesRegenerationRequired: !!(u.mfaEnabled && u.legacyRecovery), session: { idleTimeoutSec: 900 } });
const nextMrn = () => `YH-${String(db.patients.length + 1).padStart(6, '0')}`;
const addDays = (iso, n) => { const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const userName = (uid) => { const u = db.users.find((x) => x.id === uid); return u ? { id: u.id, name: u.name } : null; };
function sessionSummary(s) {
  return { id: s.id, patientId: s.patientId, status: s.status, revision: s.revision, parentId: s.parentId, supersededBy: s.supersededBy,
    methodology: s.methodology, sessionDate: s.sessionDate, followUpDate: s.followUpDate, practitioner: userName(s.practitionerId),
    findingCount: s.findings.length, findingsCount: s.findings.length, startedAt: s.sessionDate, finalizedAt: s.finalizedAt, reportSha256: s.reportSha256, createdAt: s.createdAt };
}
const withChief = (s, user) => ({ ...sessionSummary(s), ...(ROLE_SETS.clinical.includes(user.role) ? { chiefComplaint: s.chiefComplaint } : {}) });
const sessionView = (s) => ({ ...sessionSummary(s), scanState: s.scanState ?? null, protocolIds: s.protocolIds, symptoms: s.symptoms, chiefComplaint: s.chiefComplaint, vitals: s.vitals, notes: s.notes,
  amendReason: s.amendReason, signatureName: s.signatureName, finalizedBy: userName(s.finalizedBy), updatedAt: s.updatedAt,
  images: { front: !!db.reportImages.get(s.id)?.front, back: !!db.reportImages.get(s.id)?.back }, findings: s.findings.map((f) => ({ ...f })) });

function makeFinding(s, pairId, status, extra = {}) {
  const p = pairsById.get(pairId);
  return { id: crypto.randomUUID(), sessionId: s.id, seq: s.findings.length + 1, pairId, trackingPoint: p.tracking.point, trackingSide: p.tracking.side, impactPoint: p.impact.point, impactSide: p.impact.side,
    qualifiers: { tracking: [], impact: [] }, phenomena: [], dwellMinutes: 15, status, notes: null, createdAt: now(), updatedAt: now(), ...extra };
}
const DISCLAIMER = {
  en: 'Biomagnetic Pair findings are complementary, non-diagnostic observations. They do not identify disease and do not replace evaluation, diagnosis or treatment by a licensed physician. Continue all medical indications.',
  es: 'Los hallazgos del Par Biomagnético son observaciones complementarias y no diagnósticas. No identifican enfermedades y no sustituyen la evaluación, el diagnóstico ni el tratamiento por un médico con licencia. Continúe con todas las indicaciones médicas.',
};
function assembleReport(s, over = {}) {
  const pt = db.patients.find((p) => p.id === s.patientId);
  const pr = db.users.find((u) => u.id === s.practitionerId);
  const status = over.status ?? s.status;
  const nameOfPoint = (id) => pointsById.get(id)?.name ?? { es: id, en: id };
  const findings = s.findings.map((f) => {
    const p = f.pairId ? pairsById.get(f.pairId) : null;
    return { seq: f.seq, pairId: f.pairId, pair: p ? { id: p.id, number: p.number, level: p.level, name: p.name } : null,
      tracking: { point: f.trackingPoint, name: nameOfPoint(f.trackingPoint), side: f.trackingSide, qualifiers: f.qualifiers.tracking || [], polarity: 'negative' },
      impact: { point: f.impactPoint, name: nameOfPoint(f.impactPoint), side: f.impactSide, qualifiers: f.qualifiers.impact || [], polarity: 'positive' },
      relatedTo: (p?.relations || []).map((r) => { const e = entById.get(r.entity); return { entity: r.entity, name: e?.name ?? null, kind: e?.kind ?? null, classification: e?.classification ?? null, ordinal: r.ordinal ?? null }; }),
      category: p?.category ?? 'uncatalogued', ratings: { F: p?.ratings?.F ?? null, P: p?.ratings?.P ?? null, R: p?.ratings?.R ?? null },
      phenomena: f.phenomena, status: f.status, dwellMinutes: f.dwellMinutes, notes: f.notes };
  });
  const groups = []; for (const f of findings) { let g = groups.find((x) => x.category === f.category); if (!g) { g = { category: f.category, seqs: [] }; groups.push(g); } g.seqs.push(f.seq); }
  const magnets = [];
  for (const f of findings) {
    for (const side of f.tracking.side === 'RL' ? ['R', 'L'] : [f.tracking.side]) magnets.push({ id: `${f.seq}-n-${side}`, pointId: f.tracking.point, side, polarity: 'negative', label: String(f.seq), state: f.status === 'found' ? 'active' : 'done' });
    for (const side of f.impact.side === 'RL' ? ['R', 'L'] : [f.impact.side]) magnets.push({ id: `${f.seq}-p-${side}`, pointId: f.impact.point, side, polarity: 'positive', label: String(f.seq), state: f.status === 'found' ? 'active' : 'done' });
  }
  const pairSpecific = []; const seen = new Set();
  for (const f of findings) { if (!f.pairId || seen.has(f.pairId)) continue; seen.add(f.pairId); const recs = pairsById.get(f.pairId).recommendations || []; if (recs.length) pairSpecific.push({ pairId: f.pairId, number: f.pair.number, name: f.pair.name, items: recs }); }
  const parent = s.parentId ? db.scanSessions.find((x) => x.id === s.parentId) : null;
  const img = db.reportImages.get(s.id) || {};
  const finalizer = userName(over.finalizedBy ?? s.finalizedBy);
  return {
    schema: 'youheal.report/v1', title: 'Biomagnetic Pair Scan Report', reportId: s.id,
    reportNumber: `${pt.mrn}-${s.sessionDate.slice(0, 10).replace(/-/g, '')}-R${s.revision}`,
    status: status === 'draft' ? 'DRAFT' : status === 'amended' ? 'AMENDED' : 'FINAL', revision: s.revision,
    amendment: parent ? { parentId: parent.id, parentRevision: parent.revision, parentSha256: parent.reportSha256, reason: s.amendReason } : null,
    org: { name: db.org.name, legalName: db.org.legalName, address: db.org.address, phone: db.org.phone, email: db.org.email, website: db.org.website, license: db.org.license, reportFooter: db.org.reportFooter, logo: db.org.logo || null },
    polarity: db.org.polarity,
    patient: { id: pt.id, mrn: pt.mrn, firstName: pt.firstName, lastName: pt.lastName, fullName: `${pt.firstName} ${pt.lastName}`, dob: pt.dob, age: ageAt(pt.dob, s.sessionDate), sex: pt.sex, preferredLanguage: pt.preferredLanguage || null },
    reportLocale: status === 'draft' ? null : (over.reportLocale ?? s.reportLocale ?? null),
    practitioner: pr ? { id: pr.id, name: pr.name, email: pr.email, role: pr.role } : null,
    session: { id: s.id, date: s.sessionDate, methodology: s.methodology,
      protocols: s.protocolIds.map((x) => ({ id: x, name: protoById.get(x)?.name ?? null, kind: protoById.get(x)?.kind ?? null })),
      chiefComplaint: s.chiefComplaint, symptoms: s.symptoms.map((x) => { const y = C.symptoms.find((z) => z.id === x); return { id: x, name: y?.name ?? null, system: y?.system ?? null }; }),
      vitals: s.vitals, notes: s.notes },
    findings, groups,
    totals: { findings: findings.length, byStatus: Object.fromEntries(['found', 'impacted', 'cleared'].map((st) => [st, findings.filter((f) => f.status === st).length])) },
    bodyMap: { magnets, images: { front: img.front || null, back: img.back || null } },
    recommendations: { pairSpecific, general: generalRecs(findings) },
    generalRecommendations: generalRecs(findings),
    followUp: { date: s.followUpDate, note: { en: 'A follow-up scan is recommended after one week (reservoir release).', es: 'Se recomienda un rastreo de control a la semana (liberación de reservorios).' } },
    attestation: status === 'draft' ? null : { signatureName: over.signatureName ?? s.signatureName, finalizedAt: over.finalizedAt ?? s.finalizedAt, finalizedBy: finalizer,
      statement: { en: 'I attest that this report accurately reflects the findings of the session described above.', es: 'Certifico que este informe refleja fielmente los hallazgos de la sesión descrita.' } },
    disclaimer: DISCLAIMER,
    terminology: { en: 'Findings are reported as "related to" — never as a diagnosis.', es: 'Los hallazgos se reportan como "relacionado con", nunca como diagnóstico.' },
    catalog: { version: '2026.10.0-mock', sources: [...new Set(findings.map((f) => pairsById.get(f.pairId)?.source?.doc).filter(Boolean))].map((x) => sourceById.get(x)).filter(Boolean).map((x) => ({ id: x.id, title: x.title, license_status: x.license_status, notice: x.notice })) },
    generatedAt: status === 'draft' ? now() : (over.finalizedAt ?? s.finalizedAt),
  };
}
function generalRecs(findings) {
  const pick = (r, matchedBy) => ({ id: r.id, title: r.title, summary: Object.fromEntries(Object.entries(r.body).map(([k, v]) => [k, (/^.*?[.!?](?=\s|$)/.exec(v) || [v])[0]])), body: r.body, matchedBy });
  const ids = findings.map((f) => f.pairId).filter(Boolean);
  return [pick(C.recommendations[0], [{ rule: 'always', pairIds: [] }]), ...(ids.length ? [pick(C.recommendations[1], [{ rule: 'rec-followup', pairIds: ids.slice(0, 2) }])] : [])];
}
function finalizeSession(s, signatureName, user, when = new Date(), reportLocale = null) {
  const status = s.parentId ? 'amended' : 'final';
  const finalizedAt = when.toISOString();
  s.reportLocale = reportLocale || db.patients.find((p) => p.id === s.patientId)?.preferredLanguage || db.org.defaultLocale || 'en';
  const report = assembleReport(s, { status, finalizedAt, finalizedBy: user.id, signatureName });
  s.snapshot = canon(report);
  s.reportSha256 = sha256(s.snapshot);
  Object.assign(s, { status, finalizedAt, finalizedBy: user.id, signatureName, updatedAt: finalizedAt });
  if (s.parentId) { const parent = db.scanSessions.find((x) => x.id === s.parentId); if (parent) parent.supersededBy = s.id; }
}

function seedDemo(admin) {
  const mkU = (email, name, role, locale) => { const u = { id: crypto.randomUUID(), email, name, role, locale, theme: 'system', pw: hashPw('correct-horse-battery'), mfaEnabled: false, active: true, createdAt: now() }; db.users.push(u); return u; };
  const practitioner = mkU('practitioner@clinic.test', 'Dr. Pat Practitioner', 'practitioner', 'en');
  mkU('frontdesk@clinic.test', 'Front Desk Demo', 'assistant', 'es');
  mkU('auditor@clinic.test', 'Quality Auditor', 'auditor', 'en');
  const mk = (firstName, lastName, dob, sex) => { const p = { id: crypto.randomUUID(), mrn: nextMrn(), firstName, lastName, dob, sex, phone: `(718) 555-01${10 + db.patients.length}`, email: `${firstName.toLowerCase().replace(/\s/g, '')}@example.test`, address: 'Queens, NY', notes: null, createdAt: now(), updatedAt: now() }; db.patients.push(p); return p; };
  const mary = mk('Mary', 'Example', '1979-04-12', 'female');
  const john = mk('John', 'Demo', '1964-09-30', 'male');
  const ana = mk('Ana', 'Prueba', '1991-01-22', 'female');
  ana.preferredLanguage = 'es';
  const robert = mk('Robert', 'Testcase', '1958-06-05', 'male');
  const consent = (p, absolute = [], relative = []) => db.consents.push({ id: crypto.randomUUID(), patientId: p.id, type: 'intake', answers: { techniqueExplained: true, questionsAnswered: true, understandsScope: true, continuesMedical: true, authorizesPlacement: true, followUpInformed: true }, contraindications: { absolute, relative }, hasAbsolute: absolute.length > 0, hasRelative: relative.length > 0, signatureName: `${p.firstName} ${p.lastName}`, signedAt: addDays(now(), -20) + 'T15:00:00.000Z', recordedBy: practitioner.id, createdAt: now() });
  consent(mary, [], ['rel-04']); consent(john); consent(robert); consent(ana, ['abs-01'], []);
  const mkSession = (p, daysAgo, findings, { status = 'final', chief = '', symptoms = [], protocolIds = [], follow } = {}) => {
    const start = new Date(); start.setDate(start.getDate() - daysAgo); start.setHours(daysAgo ? 10 : Math.max(8, new Date().getHours() - 1), 15, 0, 0);
    const s = { id: crypto.randomUUID(), patientId: p.id, practitionerId: practitioner.id, methodology: 'biomagnetism', protocolIds, chiefComplaint: chief, symptoms, vitals: null, notes: null,
      status: 'draft', revision: 1, parentId: null, supersededBy: null, amendReason: null, sessionDate: start.toISOString(), finalizedAt: null, finalizedBy: null, signatureName: null, reportSha256: null,
      followUpDate: follow === undefined ? addDays(start.toISOString(), 7) : follow, findings: [], createdAt: start.toISOString(), updatedAt: start.toISOString() };
    for (const [pid, st, ex] of findings) s.findings.push(makeFinding(s, pid, st, ex));
    db.scanSessions.push(s);
    if (status === 'final') finalizeSession(s, practitioner.name, practitioner, new Date(start.getTime() + 50 * 60000));
    return s;
  };
  mkSession(mary, 14, [['pb-231', 'cleared'], ['pb-232', 'cleared'], ['pb-234', 'impacted', { phenomena: ['infiltrate'] }]], { chief: 'Heavy legs, evening ankle swelling', symptoms: ['piernas-pesadas', 'varices'], protocolIds: ['app-19-circulacion-de-piernas'] });
  mkSession(mary, 7, [['pb-231', 'cleared'], ['pb-232', 'impacted'], ['pb-236', 'impacted']], { chief: 'Follow-up: leg circulation', symptoms: ['piernas-pesadas', 'calambres'], protocolIds: ['app-19-circulacion-de-piernas'] });
  mkSession(john, 1, [['pb-047', 'found', { notes: 'Marked epigastric tenderness' }], ['pb-063', 'found']], { status: 'draft', chief: 'Gastritis, bloating after meals', symptoms: ['gastritis', 'distension-abdominal'], protocolIds: ['top10-gastrointestinal'] });
  mkSession(robert, 35, [['pb-235', 'cleared']], { chief: 'Low-back pain', symptoms: ['dolor-lumbar'] });
  mkSession(robert, 0, [['pb-235', 'impacted'], ['pb-232', 'cleared']], { chief: 'Low-back pain radiating to right leg', symptoms: ['dolor-lumbar'] });
  audit(admin, 'demo.seed');
}

// ---------------------------------------------------------------- http plumbing
function send(res, status, body, headers = {}) {
  const data = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(data);
}
const err = (res, status, code, message, fields) => send(res, status, { error: { code, message, ...(fields ? { fields } : {}) } });
function readBody(req, limit = 4 * 1024 * 1024 + 4096) {
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
/** Strict body check like server/lib/validate.js: unknown keys → 400 VALIDATION. */
function strict(res, body, allowed) {
  const bad = Object.keys(body || {}).filter((k) => !allowed.includes(k));
  if (bad.length) { err(res, 400, 'VALIDATION', 'Invalid input', Object.fromEntries(bad.map((k) => [k, 'is not an allowed field']))); return false; }
  return true;
}

const ROLE_SETS = {
  any: ['admin', 'practitioner', 'assistant', 'auditor'],
  patientRead: ['admin', 'practitioner', 'assistant'],
  intake: ['admin', 'practitioner', 'assistant'],
  clinical: ['admin', 'practitioner'],
  report: ['admin', 'practitioner', 'auditor'],
  admin: ['admin'],
  audit: ['admin', 'auditor'],
};

const routes = [];
const R = (method, pattern, roles, fn, allowWhen = []) => {
  const keys = []; const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; })}$`);
  if (roles === 'anyRestricted') { roles = 'any'; allowWhen = ['mfa', 'password']; }
  routes.push({ method, re, keys, roles, fn, allowWhen });
};
const list = (arr, q, def = 500) => { const limit = Math.min(Number(q.limit || def), 5000); const offset = Number(q.offset || 0); return { items: arr.slice(offset, offset + limit), total: arr.length }; };

// ---- public
R('GET', '/health', null, (c) => send(c.res, 200, { status: 'ok', version: '0.0.0-mock', catalogVersion: '2026.10.0-mock' }));
R('GET', '/setup/status', null, (c) => send(c.res, 200, { needsSetup: db.users.length === 0, tokenRequired: !!SETUP_TOKEN && db.users.length === 0 }));
R('POST', '/setup', null, (c) => {
  if (db.users.length) return err(c.res, 409, 'ALREADY_SETUP', 'Setup has already been completed');
  const { org, admin } = c.body;
  if (SETUP_TOKEN && c.body.setupToken !== SETUP_TOKEN) return err(c.res, 403, 'SETUP_TOKEN_INVALID', 'Setup token is missing or incorrect', { setupToken: 'is incorrect' });
  const fields = {};
  if (!org?.name) fields['org.name'] = 'is required';
  if (!admin?.email || !/^[^\s@]+@[^\s@]+$/.test(admin.email)) fields['admin.email'] = 'must be a valid email';
  if (!admin?.password || admin.password.length < 12) fields['admin.password'] = 'must be at least 12 characters';
  if (Object.keys(fields).length) return err(c.res, 400, 'VALIDATION', 'Invalid input', fields);
  db.org = { id: crypto.randomUUID(), name: org.name, legalName: null, address: null, phone: null, email: null, website: null, license: null, reportFooter: null, polarity: { negative: '#2563EB', positive: '#DC2626' }, defaultLocale: org.defaultLocale || 'en' };
  const u = { id: crypto.randomUUID(), email: admin.email.toLowerCase(), name: admin.name || 'Administrator', role: 'admin', locale: admin.locale || 'en', theme: 'system', pw: hashPw(admin.password), mfaEnabled: false, active: true, createdAt: now() };
  db.users.push(u);
  audit(u, 'setup.complete');
  if (DEMO) seedDemo(u);
  send(c.res, 200, { ok: true });
});
R('POST', '/auth/login', null, (c) => {
  const { email = '', password = '', totp: code } = c.body;
  const u = db.users.find((x) => x.email === String(email).toLowerCase());
  const f = db.failed.get(email) || 0;
  if (f >= 5) return err(c.res, 423, 'ACCOUNT_LOCKED', 'Too many failed attempts. Try again in 15 minutes or contact your administrator.');
  if (!u || u.active === false || !checkPw(password, u.pw)) { db.failed.set(email, f + 1); audit(u || null, 'auth.login.failure', email); return err(c.res, 401, 'INVALID_CREDENTIALS', 'Invalid email or password'); }
  if (u.mfaEnabled) {
    if (!code) return err(c.res, 401, 'MFA_REQUIRED', 'Enter the 6-digit code from your authenticator app');
    const rc = (u.recovery || []).findIndex((h) => h === sha256(String(code).trim().toLowerCase()));
    if (rc >= 0) u.recovery.splice(rc, 1);
    else if (!totpOk(u.mfaSecret, code)) { db.failed.set(email, f + 1); return err(c.res, 401, 'MFA_INVALID', 'Invalid or already used authentication code'); }
  }
  db.failed.delete(email);
  u.lastLoginAt = now();
  const csrf = startSession(c.res, u);
  audit(u, 'auth.login.success');
  send(c.res, 200, mePayload(u, csrf));
});

// ---- session-bound
R('POST', '/auth/logout', 'anyRestricted', (c) => { db.sessions.delete(sha256(cookies(c.req).yh_sid)); audit(c.user, 'auth.logout'); send(c.res, 200, { ok: true }, { 'Set-Cookie': 'yh_sid=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict' }); });
R('GET', '/auth/me', 'any', (c) => send(c.res, 200, mePayload(c.user, c.sess.csrf)), ['mfa', 'password']);
R('POST', '/auth/password', 'any', (c) => {
  if (!checkPw(c.body.current || '', c.user.pw)) return err(c.res, 400, 'VALIDATION', 'Current password is incorrect', { current: 'is incorrect' });
  if (!c.body.next || c.body.next.length < 12) return err(c.res, 400, 'VALIDATION', 'Password does not meet policy', { next: 'must be at least 12 characters' });
  c.user.pw = hashPw(c.body.next); c.user.mustChangePassword = false; audit(c.user, 'auth.password.change'); send(c.res, 200, { ok: true });
}, ['password']);
R('POST', '/auth/mfa/setup', 'any', (c) => {
  if (c.user.mfaEnabled) return err(c.res, 409, 'MFA_ALREADY_ENABLED', 'MFA is already enabled; disable it first to re-enroll');
  c.user.pendingSecret = b32enc(crypto.randomBytes(20));
  const label = encodeURIComponent(`YOU HEAL Clinical:${c.user.email}`);
  send(c.res, 200, { secret: c.user.pendingSecret, otpauthUrl: `otpauth://totp/${label}?secret=${c.user.pendingSecret}&issuer=${encodeURIComponent('YOU HEAL Clinical')}&algorithm=SHA1&digits=6&period=30` });
}, ['mfa']);
R('POST', '/auth/mfa/enable', 'any', (c) => {
  if (!c.user.pendingSecret || !totpOk(c.user.pendingSecret, c.body.code)) return err(c.res, 400, 'MFA_INVALID', 'The code did not match. Check the time on your device and try again.', { code: 'is invalid' });
  c.user.mfaSecret = c.user.pendingSecret; delete c.user.pendingSecret; c.user.mfaEnabled = true;
  const codes = Array.from({ length: 10 }, () => { const h = crypto.randomBytes(5).toString('hex'); return `${h.slice(0, 5)}-${h.slice(5)}`; });
  c.user.recovery = codes.map((x) => sha256(x));
  if (LEGACY_RECOVERY) c.user.legacyRecovery = true;
  audit(c.user, 'auth.mfa.enable');
  send(c.res, 200, { ok: true, recoveryCodes: codes });
}, ['mfa']);
R('POST', '/auth/mfa/recovery-codes', 'any', (c) => {
  if (!strict(c.res, c.body, ['password', 'code'])) return;
  if (!c.user.mfaEnabled) return err(c.res, 409, 'MFA_NOT_ENABLED', 'MFA is not enabled');
  if (!checkPw(c.body.password || '', c.user.pw) || !totpOk(c.user.mfaSecret, c.body.code)) return err(c.res, 403, 'REAUTH_FAILED', 'Password or authentication code is incorrect');
  const codes = Array.from({ length: 10 }, () => { const h = crypto.randomBytes(5).toString('hex'); return `${h.slice(0, 5)}-${h.slice(5)}`; });
  c.user.recovery = codes.map((x) => sha256(x)); c.user.legacyRecovery = false;
  audit(c.user, 'auth.mfa.recovery_codes.regenerate');
  send(c.res, 200, { ok: true, recoveryCodes: codes });
});
R('POST', '/auth/mfa/disable', 'any', (c) => {
  if (!checkPw(c.body.password || '', c.user.pw) || !totpOk(c.user.mfaSecret, c.body.code)) return err(c.res, 403, 'REAUTH_FAILED', 'Password or authentication code is incorrect');
  c.user.mfaEnabled = false; delete c.user.mfaSecret; audit(c.user, 'auth.mfa.disable'); send(c.res, 200, { ok: true });
});
R('PATCH', '/auth/prefs', 'any', (c) => { if (!strict(c.res, c.body, ['locale', 'theme'])) return; if (c.body.locale) c.user.locale = c.body.locale; if (c.body.theme) c.user.theme = c.body.theme; send(c.res, 200, { ok: true, user: publicUser(c.user) }); });

R('GET', '/users', 'audit', (c) => {
  if (c.query.minimal === '1') return send(c.res, 200, { items: db.users.map((u) => ({ id: u.id, name: u.name })), total: db.users.length });
  if (c.user.role !== 'admin') return err(c.res, 403, 'FORBIDDEN', 'Your role cannot perform this action');
  send(c.res, 200, list(db.users.map(publicUser), c.query));
});
R('POST', '/users', 'admin', (c) => {
  if (!strict(c.res, c.body, ['email', 'name', 'role', 'password', 'mustChangePassword', 'locale'])) return;
  const { email, name, role } = c.body; let { password } = c.body;
  if (!email || !name || !ROLE_SETS.any.includes(role)) return err(c.res, 400, 'VALIDATION', 'Invalid input', { ...(!email ? { email: 'is required' } : {}), ...(!name ? { name: 'is required' } : {}) });
  if (db.users.some((u) => u.email === email.toLowerCase())) return err(c.res, 409, 'EMAIL_TAKEN', 'A user with this email already exists');
  let generated = false;
  if (password === undefined) { password = crypto.randomBytes(9).toString('base64url'); generated = true; }
  if (password.length < 12) return err(c.res, 400, 'VALIDATION', 'Password does not meet policy', { password: 'must be at least 12 characters' });
  const u = { id: crypto.randomUUID(), email: email.toLowerCase(), name, role, locale: c.body.locale || 'en', theme: 'system', pw: hashPw(password), mustChangePassword: generated || c.body.mustChangePassword === true, mfaEnabled: false, active: true, createdAt: now() };
  db.users.push(u); audit(c.user, 'user.create', u.id);
  send(c.res, 201, { user: publicUser(u), ...(generated ? { temporaryPassword: password } : {}) });
});
R('PATCH', '/users/:id', 'admin', (c) => {
  if (!strict(c.res, c.body, ['email', 'name', 'role', 'active', 'password', 'locale', 'unlock', 'resetMfa'])) return;
  const u = db.users.find((x) => x.id === c.params.id); if (!u) return err(c.res, 404, 'NOT_FOUND', 'User not found');
  if (u.role === 'admin' && ((c.body.role && c.body.role !== 'admin') || c.body.active === false) && db.users.filter((x) => x.role === 'admin' && x.active).length <= 1) return err(c.res, 409, 'LAST_ADMIN', 'The clinic must keep at least one active administrator');
  for (const k of ['name', 'role', 'active', 'email', 'locale']) if (k in c.body) u[k] = c.body[k];
  if (c.body.password) { u.pw = hashPw(c.body.password); u.mustChangePassword = true; }
  if (c.body.unlock) { db.failed.delete(u.email); u.lockedUntil = null; }
  if (c.body.resetMfa) { u.mfaEnabled = false; delete u.mfaSecret; }
  audit(c.user, 'user.update', u.id); send(c.res, 200, { user: publicUser(u) });
});
R('GET', '/org', 'any', (c) => send(c.res, 200, { ...db.org, logo: db.org.logo || null }));
R('PATCH', '/org', 'admin', (c) => {
  const allowed = ['name', 'legalName', 'address', 'phone', 'email', 'website', 'license', 'reportFooter', 'polarity', 'defaultLocale', 'logo'];
  if (!strict(c.res, c.body, allowed)) return;
  if (c.body.logo && (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(c.body.logo) || c.body.logo.length > Math.ceil(200 * 1024 * 4 / 3) + 64)) return err(c.res, 400, 'VALIDATION', 'Invalid logo', { logo: 'must be a PNG/JPEG/WebP data URL ≤ 200 KB' });
  if (c.body.website && !/^https?:\/\/\S+$/.test(c.body.website)) return err(c.res, 400, 'VALIDATION', 'Invalid input', { website: 'must start with http:// or https://' });
  for (const k of allowed) if (k in c.body) db.org[k] = c.body[k];
  audit(c.user, 'org.update'); send(c.res, 200, db.org);
});

// ---- catalog
R('GET', '/catalog/manifest', 'any', (c) => send(c.res, 200, { version: '2026.10.0-mock', counts: { points: C.points.length, pairs: C.pairs.length, entities: C.entities.length, protocols: C.protocols.length, symptoms: C.symptoms.length }, sources: C.sources }));
R('GET', '/catalog/sources', 'any', (c) => send(c.res, 200, { items: C.sources, total: C.sources.length }));
R('GET', '/catalog/points', 'any', (c) => send(c.res, 200, list(C.points, c.query, 5000)));
R('GET', '/catalog/points/:id', 'any', (c) => { const p = pointsById.get(c.params.id); return p ? send(c.res, 200, p) : err(c.res, 404, 'NOT_FOUND', 'Point not found'); });
R('GET', '/catalog/points/:id/pairs', 'any', (c) => {
  const point = pointsById.get(c.params.id); if (!point) return err(c.res, 404, 'NOT_FOUND', 'Point not found');
  const items = C.pairs.filter((p) => p.tracking.point === point.id || p.impact.point === point.id).map((p) => ({ role: p.tracking.point === point.id && p.impact.point === point.id ? 'both' : p.tracking.point === point.id ? 'tracking' : 'impact', pair: pairSummary(p) }));
  send(c.res, 200, { point, items, total: items.length });
});
R('GET', '/catalog/regions', 'any', (c) => send(c.res, 200, list(C.regions, c.query, 5000)));
R('GET', '/catalog/pairs', 'any', (c) => {
  const { q, category, level, point, system, protocol } = c.query;
  let arr = C.pairs;
  if (q) { const n = norm(q); const num = /^\s*(?:pb[\s-]*)?(\d{1,4})\s*$/i.exec(q); arr = arr.filter((p) => (num && p.number === Number(num[1])) || norm(textOf(p.name)).includes(n) || p.relations.some((r) => norm(textOf(entById.get(r.entity)?.name)).includes(n))); }
  if (category) arr = arr.filter((p) => p.category === category);
  if (level) arr = arr.filter((p) => String(p.level) === String(level));
  if (point) arr = arr.filter((p) => p.tracking.point === point || p.impact.point === point);
  if (system) arr = arr.filter((p) => p.symptoms.some((s) => s.system === system));
  if (protocol) { const ids = new Set(expandProtocol(protoById.get(protocol) || { items: [] }).map((x) => x.pairId)); arr = arr.filter((p) => ids.has(p.id)); }
  send(c.res, 200, list(arr.map(pairSummary), c.query));
});
R('GET', '/catalog/pairs/:id', 'any', (c) => { const p = pairsById.get(c.params.id); return p ? send(c.res, 200, pairFull(p)) : err(c.res, 404, 'NOT_FOUND', 'Pair not found'); });
R('GET', '/catalog/entities', 'any', (c) => {
  let arr = C.entities; const { q, kind, classification } = c.query;
  if (q) arr = arr.filter((e) => norm(textOf(e.name)).includes(norm(q)));
  if (kind) arr = arr.filter((e) => e.kind === kind);
  if (classification) arr = arr.filter((e) => e.classification === classification);
  send(c.res, 200, list(arr.map((e) => ({ id: e.id, name: e.name, kind: e.kind, classification: e.classification ?? null, pairCount: C.pairs.filter((p) => p.relations.some((r) => r.entity === e.id)).length })), c.query));
});
R('GET', '/catalog/entities/:id', 'any', (c) => { const e = entById.get(c.params.id); return e ? send(c.res, 200, { ...e, polePairs: [], pairs: C.pairs.filter((p) => p.relations.some((r) => r.entity === e.id)).map(pairSummary), protocols: [] }) : err(c.res, 404, 'NOT_FOUND', 'Entity not found'); });
R('GET', '/catalog/protocols', 'any', (c) => send(c.res, 200, list(C.protocols.map((p) => ({ id: p.id, kind: p.kind, name: p.name, source: p.source ?? null, pairCount: expandProtocol(p).length })), c.query)));
R('GET', '/catalog/protocols/:id', 'any', (c) => {
  const p = protoById.get(c.params.id); if (!p) return err(c.res, 404, 'NOT_FOUND', 'Protocol not found');
  send(c.res, 200, { ...p, pairs: expandProtocol(p).map((x) => ({ ...x, pair: pairSummary(pairsById.get(x.pairId)) })), children: p.items.filter((i) => i.protocol).map((i) => ({ id: i.protocol, name: protoById.get(i.protocol)?.name ?? null, kind: protoById.get(i.protocol)?.kind ?? null })) });
});
R('GET', '/catalog/symptoms', 'any', (c) => {
  let arr = C.symptoms; const { q, system } = c.query;
  if (q) arr = arr.filter((s) => norm(textOf(s.name)).includes(norm(q)));
  if (system) arr = arr.filter((s) => s.system === system);
  send(c.res, 200, list(arr.map((s) => ({ ...s, pairCount: s.pairs.length })), c.query));
});
R('POST', '/catalog/suggest', 'any', (c) => { const items = suggest(c.body); send(c.res, 200, { items, total: items.length }); });
R('GET', '/catalog/search', 'any', (c) => {
  const n = norm(c.query.q || ''); if (!n) return send(c.res, 200, { items: [], total: 0 });
  const out = [];
  const num = /^\s*(?:pb[\s-]*)?(\d{1,4})\s*$/i.exec(c.query.q);
  for (const p of C.pairs) if ((num && p.number === Number(num[1])) || norm(textOf(p.name)).includes(n)) out.push({ kind: 'pair', id: p.id, name: p.name, number: p.number, category: p.category, summary: pairSummary(p) });
  for (const p of C.points) if (norm(textOf(p.name)).includes(n)) out.push({ kind: 'point', id: p.id, name: p.name, laterality: p.laterality, region: p.region });
  for (const e of C.entities) if (norm(textOf(e.name)).includes(n)) out.push({ kind: 'entity', id: e.id, name: e.name, entityKind: e.kind, classification: e.classification });
  for (const p of C.protocols) if (norm(textOf(p.name)).includes(n)) out.push({ kind: 'protocol', id: p.id, name: p.name, protocolKind: p.kind });
  for (const s of C.symptoms) if (norm(textOf(s.name)).includes(n)) out.push({ kind: 'symptom', id: s.id, name: s.name, system: s.system });
  send(c.res, 200, { items: out.slice(0, Number(c.query.limit || 50)), total: out.length });
});
R('GET', '/catalog/contraindications', 'any', (c) => send(c.res, 200, list(C.contraindications, c.query)));
R('GET', '/catalog/recommendations', 'any', (c) => send(c.res, 200, list(C.recommendations, c.query)));
R('GET', '/catalog/glossary', 'any', (c) => send(c.res, 200, list(C.glossary, c.query)));

// ---- patients (blind-index semantics: exact last name / MRN, ?dob=, or first letter)
const PATIENT_FIELDS = ['firstName', 'lastName', 'dob', 'sex', 'phone', 'email', 'address', 'mrn', 'notes', 'preferredLanguage'];
const SEXES = ['female', 'male', 'other', 'unknown'];
const patientSearch = (c, src) => {
  const q = (src.q || '').trim();
  let arr = [...db.patients].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  let mode = 'list';
  if (src.dob) { arr = arr.filter((p) => p.dob === src.dob); mode = 'dob'; }
  if (q.length === 1 && /\p{L}/u.test(q)) { arr = arr.filter((p) => norm(p.lastName).startsWith(norm(q))); mode = 'letter'; }
  else if (q) { arr = arr.filter((p) => norm(p.lastName) === norm(q) || norm(p.mrn) === norm(q)); mode = 'exact'; }
  if (mode !== 'list') arr.sort((a, b) => a.lastName.localeCompare(b.lastName) || a.firstName.localeCompare(b.firstName));
  audit(c.user, 'patient.search', null, { detail: { mode } });
  const enrich = (p) => { const ss = db.scanSessions.filter((s) => s.patientId === p.id && !s.supersededBy); return { ...patientSummary(p), sessionCount: ss.length, lastSessionDate: ss.map((s) => s.sessionDate).sort().pop() || null }; };
  send(c.res, 200, list(arr.map(enrich), { limit: src.limit, offset: src.offset }, 25));
};
R('GET', '/patients', 'patientRead', (c) => {
  if (c.query.q || c.query.dob) return err(c.res, 410, 'GONE', 'Searching via URL parameters was removed; use POST /api/v1/patients/search');
  patientSearch(c, c.query);
});
R('POST', '/patients/search', 'patientRead', (c) => { if (!strict(c.res, c.body, ['q', 'dob', 'limit', 'offset'])) return; patientSearch(c, c.body); });
function checkPatient(res, b, create) {
  if (!strict(res, b, [...PATIENT_FIELDS, ...(create ? [] : ['archived'])])) return false;
  const fields = {};
  if (create || 'firstName' in b) if (!b.firstName) fields.firstName = 'is required';
  if (create || 'lastName' in b) if (!b.lastName) fields.lastName = 'is required';
  if (create || 'dob' in b) if (!b.dob || !/^\d{4}-\d{2}-\d{2}$/.test(b.dob) || b.dob > new Date().toISOString().slice(0, 10)) fields.dob = 'must be a valid date, not in the future';
  if (b.sex && !SEXES.includes(b.sex)) fields.sex = `must be one of ${SEXES.join(', ')}`;
  if (b.phone && !/^[0-9+().\s/-]*$/.test(b.phone)) fields.phone = 'has an invalid format';
  if (b.preferredLanguage && !packs.has(b.preferredLanguage)) fields.preferredLanguage = `must be one of ${[...packs.keys()].join(', ')}`;
  if (Object.keys(fields).length) { err(res, 400, 'VALIDATION', 'Invalid input', fields); return false; }
  return true;
}
R('POST', '/patients', 'intake', (c) => {
  const b = Object.fromEntries(Object.entries(c.body).map(([k, v]) => [k, v === '' ? null : v]));
  if (!checkPatient(c.res, b, true)) return;
  if (b.mrn && db.patients.some((p) => p.mrn === b.mrn)) return err(c.res, 409, 'MRN_TAKEN', 'This MRN is already assigned to another patient');
  const p = { id: crypto.randomUUID(), createdAt: now(), updatedAt: now() };
  for (const k of PATIENT_FIELDS) p[k] = b[k] ?? null;
  if (!p.sex) p.sex = 'unknown';
  if (!p.mrn) p.mrn = nextMrn();
  db.patients.push(p); audit(c.user, 'patient.create', p.id); send(c.res, 201, { ...p, age: ageAt(p.dob) });
});
R('GET', '/patients/:id', 'patientRead', (c) => {
  const p = db.patients.find((x) => x.id === c.params.id); if (!p) return err(c.res, 404, 'NOT_FOUND', 'Patient not found');
  const cs = db.consents.filter((x) => x.patientId === p.id).sort((a, b) => b.signedAt.localeCompare(a.signedAt))[0];
  const ss = db.scanSessions.filter((s) => s.patientId === p.id && !s.supersededBy);
  audit(c.user, 'patient.read', p.id);
  send(c.res, 200, { ...p, age: ageAt(p.dob), latestConsent: cs ? { id: cs.id, type: cs.type, signedAt: cs.signedAt, hasAbsolute: cs.hasAbsolute, hasRelative: cs.hasRelative } : null,
    sessionCount: ss.length, lastSessionDate: ss.map((s) => s.sessionDate).sort().pop() || null });
});
R('PATCH', '/patients/:id', 'intake', (c) => {
  const p = db.patients.find((x) => x.id === c.params.id); if (!p) return err(c.res, 404, 'NOT_FOUND', 'Patient not found');
  const b = Object.fromEntries(Object.entries(c.body).map(([k, v]) => [k, v === '' ? null : v]));
  if (!checkPatient(c.res, b, false)) return;
  for (const k of PATIENT_FIELDS) if (k in b && !(k === 'mrn' && !b.mrn)) p[k] = b[k];
  p.updatedAt = now(); audit(c.user, 'patient.update', p.id); send(c.res, 200, { ...p, age: ageAt(p.dob) });
});
R('GET', '/patients/:id/consents', 'patientRead', (c) => { const arr = db.consents.filter((x) => x.patientId === c.params.id).sort((a, b) => b.signedAt.localeCompare(a.signedAt)); send(c.res, 200, { items: arr, total: arr.length }); });
R('POST', '/patients/:id/consents', 'intake', (c) => {
  if (!strict(c.res, c.body, ['type', 'answers', 'contraindications', 'signatureName', 'signedAt'])) return;
  const b = c.body;
  if (!b.signatureName) return err(c.res, 400, 'VALIDATION', 'Invalid input', { signatureName: 'is required' });
  const ci = { relative: b.contraindications?.relative || [], absolute: b.contraindications?.absolute || [] };
  const x = { id: crypto.randomUUID(), patientId: c.params.id, type: b.type || 'intake', answers: b.answers || {}, contraindications: ci, hasAbsolute: ci.absolute.length > 0, hasRelative: ci.relative.length > 0, signatureName: b.signatureName, signedAt: b.signedAt || now(), recordedBy: c.user.id, createdAt: now() };
  db.consents.push(x); audit(c.user, 'consent.create', x.id);
  const warnings = [];
  if (x.hasAbsolute) warnings.push({ code: 'ABSOLUTE_CONTRAINDICATION', message: 'Absolute contraindication recorded: biomagnetic scanning should not be performed.' });
  if (x.hasRelative) warnings.push({ code: 'RELATIVE_CONTRAINDICATION', message: 'Relative contraindication recorded: proceed only with clinical judgement.' });
  send(c.res, 201, { consent: x, warnings });
});

// ---- sessions (no cross-patient GET /sessions in the real API)
const SESSION_PATCH = ['methodology', 'protocolIds', 'chiefComplaint', 'symptoms', 'vitals', 'notes', 'sessionDate', 'followUpDate', 'scanState'];
R('GET', '/patients/:id/sessions', 'patientRead', (c) => { const arr = db.scanSessions.filter((s) => s.patientId === c.params.id).sort((a, b) => b.sessionDate.localeCompare(a.sessionDate) || b.revision - a.revision).map((s) => withChief(s, c.user)); send(c.res, 200, { items: arr, total: arr.length }); });
// Cross-patient listing for the dashboard (CONTRACT §5).
R('GET', '/sessions', 'patientRead', (c) => {
  const q = c.query;
  const day = (v, end) => (v && v.length === 10 ? new Date(`${v}T00:00:00`).getTime() + (end ? 86400000 : 0) : v ? Date.parse(v) : null);
  const from = day(q.from, false); const to = day(q.to, true);
  const st = q.status ? q.status.split(',') : null;
  let arr = db.scanSessions.filter((s) => (from === null || Date.parse(s.sessionDate) >= from) && (to === null || Date.parse(s.sessionDate) < to)
    && (!st || st.includes(s.status)) && (!q.followUpTo || (s.followUpDate && s.followUpDate <= q.followUpTo)) && (!q.patientId || s.patientId === q.patientId) && (!(q.latest === '1') || !s.supersededBy));
  arr.sort(q.followUpTo ? (a, b) => a.followUpDate.localeCompare(b.followUpDate) || b.sessionDate.localeCompare(a.sessionDate) : (a, b) => b.sessionDate.localeCompare(a.sessionDate));
  const items2 = arr.map((s) => { const pt = db.patients.find((p) => p.id === s.patientId); return { ...withChief(s, c.user), patient: pt ? { id: pt.id, mrn: pt.mrn, name: `${pt.firstName} ${pt.lastName}`, firstName: pt.firstName, lastName: pt.lastName } : null, patientName: pt ? `${pt.firstName} ${pt.lastName}` : null }; });
  audit(c.user, 'session.list');
  send(c.res, 200, list(items2, q, 50));
});
R('POST', '/patients/:id/sessions', 'clinical', (c) => {
  if (!strict(c.res, c.body, SESSION_PATCH)) return;
  const p = db.patients.find((x) => x.id === c.params.id); if (!p) return err(c.res, 404, 'NOT_FOUND', 'Patient not found');
  const b = c.body;
  if (!['biomagnetism', 'bioenergetics', 'telebioenergetics'].includes(b.methodology)) return err(c.res, 400, 'VALIDATION', 'Invalid input', { methodology: 'must be one of biomagnetism, bioenergetics, telebioenergetics' });
  const cs = db.consents.filter((x) => x.patientId === p.id && x.type === 'intake').sort((a, b2) => b2.signedAt.localeCompare(a.signedAt))[0];
  if (!cs) return err(c.res, 409, 'CONSENT_REQUIRED', 'An intake consent must be recorded before starting a session');
  const date = b.sessionDate || now();
  const s = { id: crypto.randomUUID(), patientId: p.id, practitionerId: c.user.id, methodology: b.methodology, protocolIds: b.protocolIds || [], chiefComplaint: b.chiefComplaint || null, symptoms: b.symptoms || [], vitals: b.vitals ?? null, notes: b.notes || null,
    status: 'draft', revision: 1, parentId: null, supersededBy: null, amendReason: null, sessionDate: date, finalizedAt: null, finalizedBy: null, signatureName: null, reportSha256: null,
    followUpDate: b.followUpDate === undefined ? addDays(date, 7) : b.followUpDate, findings: [], createdAt: now(), updatedAt: now() };
  db.scanSessions.push(s); audit(c.user, 'session.create', s.id);
  send(c.res, 201, { ...sessionView(s), warnings: cs.hasAbsolute ? [{ code: 'ABSOLUTE_CONTRAINDICATION', message: 'The latest intake records an absolute contraindication.' }] : [] });
});
const getSes = (c) => db.scanSessions.find((s) => s.id === c.params.id);
const locked = (c, s) => { if (s.status !== 'draft') { err(c.res, 409, 'SESSION_LOCKED', 'Session is finalized and cannot be modified; create an amendment instead'); return true; } return false; };
R('GET', '/sessions/:id', 'clinical', (c) => { const s = getSes(c); if (!s) return err(c.res, 404, 'NOT_FOUND', 'Session not found'); audit(c.user, 'session.read', s.id); send(c.res, 200, sessionView(s)); });
R('PATCH', '/sessions/:id', 'clinical', (c) => {
  const s = getSes(c); if (!s) return err(c.res, 404, 'NOT_FOUND', 'Session not found');
  if (locked(c, s)) return;
  if (!strict(c.res, c.body, SESSION_PATCH)) return;
  for (const k of SESSION_PATCH) if (k in c.body) s[k] = c.body[k];
  s.updatedAt = now(); send(c.res, 200, sessionView(s));
});
const FINDING_FIELDS = ['pairId', 'trackingPoint', 'impactPoint', 'trackingSide', 'impactSide', 'qualifiers', 'phenomena', 'dwellMinutes', 'status', 'notes'];
const normQual = (q) => (Array.isArray(q) ? { tracking: q, impact: q } : { tracking: q?.tracking || [], impact: q?.impact || [] });
R('POST', '/sessions/:id/findings', 'clinical', (c) => {
  const s = getSes(c); if (!s) return err(c.res, 404, 'NOT_FOUND', 'Session not found');
  if (locked(c, s)) return;
  if (!strict(c.res, c.body, FINDING_FIELDS)) return;
  const b = c.body; const p = b.pairId ? pairsById.get(b.pairId) : null;
  if (b.pairId && !p) return err(c.res, 400, 'VALIDATION', 'Unknown pair', { pairId: 'unknown pair' });
  if (!p && (!b.trackingPoint || !b.impactPoint)) return err(c.res, 400, 'VALIDATION', 'Either pairId or both trackingPoint and impactPoint are required');
  const f = { id: crypto.randomUUID(), sessionId: s.id, seq: Math.max(0, ...s.findings.map((x) => x.seq)) + 1, pairId: b.pairId || null, trackingPoint: b.trackingPoint || p.tracking.point, impactPoint: b.impactPoint || p.impact.point,
    trackingSide: b.trackingSide || p?.tracking.side || 'C', impactSide: b.impactSide || p?.impact.side || 'C', qualifiers: normQual(b.qualifiers), phenomena: b.phenomena || [], dwellMinutes: b.dwellMinutes ?? null,
    status: b.status || 'found', notes: b.notes || null, createdAt: now(), updatedAt: now() };
  s.findings.push(f); audit(c.user, 'finding.create', f.id); send(c.res, 201, f);
});
R('PATCH', '/sessions/:id/findings/:fid', 'clinical', (c) => {
  const s = getSes(c); if (!s) return err(c.res, 404, 'NOT_FOUND', 'Session not found');
  if (locked(c, s)) return;
  if (!strict(c.res, c.body, FINDING_FIELDS)) return;
  const f = s.findings.find((x) => x.id === c.params.fid); if (!f) return err(c.res, 404, 'NOT_FOUND', 'Finding not found');
  for (const k of ['trackingSide', 'impactSide', 'phenomena', 'dwellMinutes', 'status', 'notes']) if (k in c.body) f[k] = c.body[k];
  if ('qualifiers' in c.body) f.qualifiers = normQual(c.body.qualifiers);
  f.updatedAt = now(); send(c.res, 200, f);
});
R('DELETE', '/sessions/:id/findings/:fid', 'clinical', (c) => {
  const s = getSes(c); if (!s) return err(c.res, 404, 'NOT_FOUND', 'Session not found');
  if (locked(c, s)) return;
  s.findings = s.findings.filter((x) => x.id !== c.params.fid); audit(c.user, 'finding.delete', c.params.fid); send(c.res, 200, { ok: true });
});
R('POST', '/sessions/:id/finalize', 'clinical', (c) => {
  const s = getSes(c); if (!s) return err(c.res, 404, 'NOT_FOUND', 'Session not found');
  if (locked(c, s)) return;
  if (!strict(c.res, c.body, ['signatureName', 'password', 'reportLocale'])) return;
  if (c.body.reportLocale && !packs.has(c.body.reportLocale)) return err(c.res, 400, 'VALIDATION', 'Invalid input', { reportLocale: `must be one of ${[...packs.keys()].join(', ')}` });
  if (!c.body.signatureName) return err(c.res, 400, 'VALIDATION', 'Invalid input', { signatureName: 'is required' });
  if (!c.body.password || !checkPw(c.body.password, c.user.pw)) return err(c.res, 403, 'REAUTH_FAILED', 'Password is incorrect', { password: 'is incorrect' });
  if (c.body.signatureName.trim().toLowerCase() !== c.user.name.trim().toLowerCase()) return err(c.res, 422, 'SIGNATURE_MISMATCH', 'Signature must match the signed-in practitioner');
  finalizeSession(s, c.body.signatureName, c.user, new Date(), c.body.reportLocale || null);
  audit(c.user, 'session.finalize', s.id, { detail: { sha256: s.reportSha256 } });
  send(c.res, 200, { ok: true, status: s.status, sha256: s.reportSha256, hashShort: s.reportSha256.slice(0, 16), finalizedAt: s.finalizedAt, session: sessionView(s) });
});
R('POST', '/sessions/:id/amend', 'clinical', (c) => {
  const s = getSes(c); if (!s) return err(c.res, 404, 'NOT_FOUND', 'Session not found');
  if (s.status === 'draft') return err(c.res, 409, 'NOT_FINALIZED', 'Only finalized sessions can be amended; edit the draft instead');
  if (s.supersededBy) return err(c.res, 409, 'ALREADY_SUPERSEDED', 'This revision was already amended; amend the latest revision');
  const pending = db.scanSessions.find((x) => x.parentId === s.id && x.status === 'draft');
  if (pending) return err(c.res, 409, 'AMENDMENT_IN_PROGRESS', 'An amendment draft already exists for this session', { draftId: pending.id });
  if (!c.body.reason || c.body.reason.length < 3) return err(c.res, 400, 'VALIDATION', 'Invalid input', { reason: 'must be at least 3 characters' });
  const n = { ...structuredClone({ ...s, snapshot: undefined }), id: crypto.randomUUID(), status: 'draft', revision: s.revision + 1, parentId: s.id, supersededBy: null, amendReason: c.body.reason, finalizedAt: null, finalizedBy: null, signatureName: null, reportSha256: null, practitionerId: c.user.id, createdAt: now(), updatedAt: now() };
  n.findings = n.findings.map((f) => ({ ...f, id: crypto.randomUUID(), sessionId: n.id }));
  if (db.reportImages.has(s.id)) db.reportImages.set(n.id, { ...db.reportImages.get(s.id) });
  db.scanSessions.push(n); audit(c.user, 'session.amend', n.id); send(c.res, 201, sessionView(n));
});
R('GET', '/sessions/:id/report', 'report', (c) => {
  const s = getSes(c); if (!s) return err(c.res, 404, 'NOT_FOUND', 'Session not found');
  if (c.user.role === 'auditor' && s.status === 'draft') return err(c.res, 403, 'FORBIDDEN', 'Auditors can only open signed reports');
  audit(c.user, 'report.read', s.id);
  if (s.status === 'draft') return send(c.res, 200, { ...assembleReport(s), hash: null, integrity: null, supersededBy: s.supersededBy });
  const integrity = sha256(s.snapshot) === s.reportSha256 ? 'verified' : 'mismatch';
  send(c.res, 200, { ...JSON.parse(s.snapshot), hash: { sha256: s.reportSha256, short: s.reportSha256.slice(0, 16), algorithm: 'sha256', canonicalization: 'json-sorted-keys' }, integrity, supersededBy: s.supersededBy });
});
R('PUT', '/sessions/:id/report/images', 'clinical', (c) => {
  const s = getSes(c); if (!s) return err(c.res, 404, 'NOT_FOUND', 'Session not found');
  if (locked(c, s)) return;
  if (!strict(c.res, c.body, ['front', 'back'])) return;
  const cur = db.reportImages.get(s.id) || {};
  for (const k of ['front', 'back']) {
    const v = c.body[k]; if (v === undefined) continue;
    if (v !== null && (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(v) || v.length > 2 * 1024 * 1024)) return err(c.res, 400, 'VALIDATION', 'Invalid input', { [k]: 'must be a PNG/JPEG/WebP data URL ≤ 2 MB' });
    cur[k] = v;
  }
  db.reportImages.set(s.id, cur); send(c.res, 200, { ok: true, updated: Object.keys(c.body) });
});

// ---- audit / admin
R('GET', '/audit', 'audit', (c) => {
  let arr = [...db.audit].reverse();
  if (c.query.actor) arr = arr.filter((a) => a.actor && a.actor.id === c.query.actor);
  if (c.query.action) { const q = c.query.action; arr = arr.filter((a) => (q.endsWith('*') ? a.action.startsWith(q.slice(0, -1)) : a.action === q)); }
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
  c.res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="youheal-backup-${new Date().toISOString().slice(0, 10)}.yhb"` });
  c.res.end(crypto.randomBytes(256));
});

// ---- language packs (CONTRACT §9.3) — read from data/i18n/packs; admin overrides live in memory
const packs = new Map();
const deepFallback = (top, base) => (top && typeof top === 'object' && base && typeof base === 'object'
  ? Object.fromEntries([...new Set([...Object.keys(base), ...Object.keys(top)])].map((k) => [k, k in top ? deepFallback(top[k], base[k]) : base[k]])) : top ?? base);
for (const dir of fs.existsSync(PACKS_DIR) ? fs.readdirSync(PACKS_DIR) : []) {
  const read = (f) => { try { return JSON.parse(fs.readFileSync(path.join(PACKS_DIR, dir, f), 'utf8')); } catch { return null; } };
  const manifest = read('manifest.json'); if (!manifest) continue;
  packs.set(manifest.locale, { manifest, ui: read('ui.json') || {}, catalog: read('catalog.json') || {}, overrides: new Map() });
}
const baselinePack = () => [...packs.values()].find((p) => p.manifest.role === 'baseline');
// Simulate a few entries whose Spanish baseline changed after translation (so "stale" review can be exercised).
for (const pk of packs.values()) {
  if (pk.manifest.role === 'baseline') continue;
  let n = 0; for (const [k, e] of Object.entries(pk.catalog)) { if (e.status === 'curated' && /^pairs\//.test(k) && n < 3) { pk.catalog[k] = { ...e, status: 'stale', staleText: e.text, text: null }; n++; } }
}
function effectiveEntry(pk, key) {
  const base = baselinePack().catalog[key];
  const ov = pk.overrides.get(key);
  if (ov && ov.srcHash === base?.hash) return { text: ov.text, status: 'reviewed', override: true, editedAt: ov.editedAt };
  const e = pk.catalog[key];
  if (!e) return { text: null, status: 'missing' };
  if (e.status === 'stale' || (base && e.srcHash !== base.hash)) return { text: null, staleText: e.staleText ?? e.text, status: 'stale' };
  return { text: e.text, status: e.text ? e.status : 'missing' };
}
function packCoverage(pk) {
  const base = baselinePack();
  if (pk === base) { const n = Object.keys(base.catalog).length; return { fields: n, translated: n, byStatus: { baseline: n }, percent: 100, missing: 0, stale: 0 }; }
  const byStatus = { curated: 0, machine: 0, reviewed: 0, missing: 0, stale: 0 };
  for (const key of Object.keys(base.catalog)) byStatus[effectiveEntry(pk, key).status]++;
  const fields = Object.keys(base.catalog).length; const translated = byStatus.curated + byStatus.machine + byStatus.reviewed;
  return { fields, translated, byStatus, percent: fields ? Math.round((translated / fields) * 1000) / 10 : 0, missing: byStatus.missing, stale: byStatus.stale };
}
function stringRows(pk, { q = '', status = '' } = {}) {
  const base = baselinePack(); const nq = norm(q);
  const out = [];
  for (const [key, b] of Object.entries(base.catalog)) {
    const e = effectiveEntry(pk, key);
    if (status && e.status !== status) continue;
    const row = { key, baseline: b.text, text: e.text ?? e.staleText ?? null, status: e.status, override: !!e.override, editedAt: e.editedAt || null };
    if (nq && !norm(`${key} ${b.text} ${row.text || ''}`).includes(nq)) continue;
    out.push(row);
  }
  return out;
}
const packOr404 = (c, locale) => { const pk = packs.get(locale); if (!pk) err(c.res, 404, 'NOT_FOUND', 'Unknown language pack'); return pk; };
R('GET', '/i18n/packs', null, (c) => send(c.res, 200, [...packs.values()].map((pk) => {
  const cov = packCoverage(pk); const m = pk.manifest;
  return { locale: m.locale, name: m.name, nativeName: m.nativeName, dir: m.dir || 'ltr', role: m.role, coverage: { percent: cov.percent, missing: cov.missing, stale: cov.stale } };
})));
R('GET', '/i18n/packs/:locale/ui', null, (c) => {
  const pk = packOr404(c, c.params.locale); if (!pk) return;
  const ui = c.params.locale === 'en' ? pk.ui : deepFallback(pk.ui, packs.get('en')?.ui || {});
  const etag = `"${sha256(JSON.stringify(ui)).slice(0, 32)}"`;
  if (c.req.headers['if-none-match'] === etag) { c.res.writeHead(304, { ETag: etag }); return c.res.end(); }
  c.res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', ETag: etag, 'Cache-Control': 'no-cache' });
  c.res.end(JSON.stringify(ui));
});
R('GET', '/i18n/packs/:locale/coverage', 'admin', (c) => {
  const pk = packOr404(c, c.params.locale); if (!pk) return;
  const cov = packCoverage(pk); const limit = Math.min(Number(c.query.limit ?? 50), 200); const offset = Number(c.query.offset || 0);
  const slice = (st) => stringRows(pk, { status: st }).slice(offset, offset + limit).map((r) => ({ key: r.key, baseline: r.baseline, text: r.text }));
  send(c.res, 200, { locale: c.params.locale, fields: cov.fields, translated: cov.translated, percent: cov.percent, byStatus: cov.byStatus, stale: limit ? slice('stale') : [], missing: limit ? slice('missing') : [], limit, offset });
});
R('GET', '/i18n/strings', 'admin', (c) => {
  const pk = packOr404(c, c.query.locale); if (!pk) return;
  send(c.res, 200, list(stringRows(pk, { q: c.query.q || '', status: c.query.status || '' }), { limit: c.query.limit || 50, offset: c.query.offset || 0 }));
});
R('PUT', '/i18n/strings', 'admin', (c) => {
  if (!strict(c.res, c.body, ['locale', 'key', 'text'])) return;
  const pk = packOr404(c, c.body.locale); if (!pk) return;
  if (pk.manifest.role === 'baseline') return err(c.res, 409, 'BASELINE_READONLY', 'The Spanish baseline is edited in the catalog, not here');
  const base = baselinePack().catalog[c.body.key];
  if (!base) return err(c.res, 404, 'NOT_FOUND', 'Unknown key');
  const text = String(c.body.text || '').trim();
  if (!text || text.length > 20000) return err(c.res, 400, 'VALIDATION', 'Invalid input', { text: 'is required (max 20000 characters)' });
  pk.overrides.set(c.body.key, { text, srcHash: base.hash, editedBy: c.user.id, editedAt: now() });
  audit(c.user, 'i18n.string.update', c.body.key);
  send(c.res, 200, { key: c.body.key, locale: c.body.locale, text, status: 'reviewed', override: true });
});
R('DELETE', '/i18n/strings', 'admin', (c) => {
  if (!strict(c.res, c.body, ['locale', 'key'])) return;
  const pk = packOr404(c, c.body.locale); if (!pk) return;
  if (!pk.overrides.delete(c.body.key)) return err(c.res, 404, 'NOT_FOUND', 'No override for this key');
  audit(c.user, 'i18n.string.revert', c.body.key);
  send(c.res, 200, { ok: true, key: c.body.key, ...effectiveEntry(pk, c.body.key) });
});
R('GET', '/i18n/packs/:locale/export', 'admin', (c) => {
  const pk = packOr404(c, c.params.locale); if (!pk) return;
  const base = baselinePack().catalog; const out = {};
  for (const [key, b] of Object.entries(base)) { const e = effectiveEntry(pk, key); out[key] = { text: e.text, srcHash: e.status === 'stale' ? (pk.catalog[key]?.srcHash ?? b.hash) : b.hash, status: e.status }; }
  audit(c.user, 'i18n.pack.export', c.params.locale);
  c.res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="catalog.${c.params.locale}.json"` });
  c.res.end(JSON.stringify(out, null, 1));
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
    const restriction = restrictionOf(s.user);
    if (restriction && !r.allowWhen.includes(restriction)) return err(res, 403, restriction === 'mfa' ? 'MFA_ENROLLMENT_REQUIRED' : 'PASSWORD_CHANGE_REQUIRED', restriction === 'mfa' ? 'Administrators must enroll in multi-factor authentication before continuing' : 'You must change your password before continuing');
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
  db.org = { id: crypto.randomUUID(), name: 'YOU HEAL Queens', legalName: 'YOU HEAL Queens LLC', address: '37-12 Main St, Flushing, NY 11354', phone: '(718) 555-0142', email: 'care@youheal.test', website: 'https://youheal.test', license: 'NY-BIO-00421', reportFooter: null, polarity: { negative: '#2563EB', positive: '#DC2626' }, defaultLocale: 'en' };
  const u = { id: crypto.randomUUID(), email: 'admin@clinic.test', name: 'Clinic Admin', role: 'admin', locale: 'en', theme: 'system', pw: hashPw('correct-horse-battery'), mfaEnabled: false, active: true, createdAt: now() };
  db.users.push(u); if (DEMO) seedDemo(u);
}

server.listen(PORT, '127.0.0.1', () => {
  if (SETUP_TOKEN && !args.includes('--seeded')) console.log(`[mock] setup token: ${SETUP_TOKEN}`);
  console.log(`[mock] YOU HEAL Clinical mock on http://127.0.0.1:${PORT}  (demo=${DEMO})`);
});
export default server;
