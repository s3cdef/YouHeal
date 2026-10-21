// Scan sessions (rastreo), findings, finalize/amend, report assembly + immutable snapshots (ADR-006).

import { v, check, uuidStr, catalogId } from '../lib/validate.js';
import { uuid, sha256hex, canonicalJson, safeEqual } from '../lib/crypto.js';
import { notFound, conflict, HttpError, badRequest } from '../lib/http.js';
import { PERM } from '../lib/rbac.js';
import { encCol, decCol, decryptPatient } from '../lib/phi.js';
import { SIDES, QUALIFIERS } from '../catalog/load.js';
import { catalogMeta } from '../catalog/load.js';
import { nowIso, today, addDays, parseJson, orgView, getOrg, ageAt } from './_shared.js';
import { getPatientRow } from './patients.js';

export const METHODOLOGIES = ['biomagnetism', 'bioenergetics', 'telebioenergetics'];
export const PHENOMENA = ['infiltrate', 'exudate', 'cyst', 'abscess', 'neoplasia'];
export const FINDING_STATUS = ['found', 'impacted', 'cleared'];
export const REPORT_TITLE = 'Biomagnetic Pair Scan Report';
export const DISCLAIMER = Object.freeze({
  en: 'Biomagnetic Pair findings are complementary, non-diagnostic observations. They do not identify disease and do not replace evaluation, diagnosis or treatment by a licensed physician. Continue all medical indications.',
  es: 'Los hallazgos del Par Biomagnético son observaciones complementarias y no diagnósticas. No identifican enfermedades y no sustituyen la evaluación, el diagnóstico ni el tratamiento por un médico con licencia. Continúe con todas las indicaciones médicas.',
});
const FOLLOW_UP_NOTE = Object.freeze({
  en: 'A follow-up scan is recommended after one week (reservoir release).',
  es: 'Se recomienda un rastreo de control a la semana (liberación de reservorios).',
});
const IMAGE_MAX_CHARS = 2 * 1024 * 1024;

// ---------------------------------------------------------------- schemas

const qualList = () => v.array(v.enum(QUALIFIERS), { max: 5, unique: true });
function parseQualifiers(q, errs) {
  if (q === undefined) return undefined;
  if (q === null) return { tracking: [], impact: [] };
  const e = {};
  let out;
  if (Array.isArray(q)) { const a = qualList().parse(q, 'qualifiers', e); out = { tracking: a, impact: a }; }
  else out = v.object({ tracking: qualList().default([]), impact: qualList().default([]) }).parse(q, 'qualifiers', e);
  Object.assign(errs, e);
  return out;
}

const findingFields = {
  pairId: catalogId().optional().nullable(),
  trackingPoint: catalogId().optional(),
  impactPoint: catalogId().optional(),
  trackingSide: v.enum(SIDES).optional(),
  impactSide: v.enum(SIDES).optional(),
  qualifiers: { parse: (val) => val }, // validated by parseQualifiers
  phenomena: v.array(v.enum(PHENOMENA), { max: 5, unique: true }).optional(),
  dwellMinutes: v.number({ min: 0, max: 240 }).optional().nullable(),
  status: v.enum(FINDING_STATUS).optional(),
  notes: v.string({ max: 4000, multiline: true }).optional().nullable(),
};
const findingSchema = v.object(findingFields);

const sessionCreateSchema = v.object({
  methodology: v.enum(METHODOLOGIES),
  protocolIds: v.array(catalogId(), { max: 50, unique: true }).default([]),
  chiefComplaint: v.string({ max: 4000, multiline: true }).optional().nullable(),
  symptoms: v.array(catalogId(), { max: 200, unique: true }).default([]),
  vitals: v.json({ maxBytes: 8 * 1024, maxDepth: 3 }).optional().nullable(),
  notes: v.string({ max: 8000, multiline: true }).optional().nullable(),
  sessionDate: v.datetime().optional(),
  followUpDate: v.date().optional().nullable(),
});
const sessionPatchSchema = v.object({
  methodology: v.enum(METHODOLOGIES).optional(),
  protocolIds: v.array(catalogId(), { max: 50, unique: true }).optional(),
  chiefComplaint: v.string({ max: 4000, multiline: true }).optional().nullable(),
  symptoms: v.array(catalogId(), { max: 200, unique: true }).optional(),
  vitals: v.json({ maxBytes: 8 * 1024, maxDepth: 3 }).optional().nullable(),
  notes: v.string({ max: 8000, multiline: true }).optional().nullable(),
  sessionDate: v.datetime().optional(),
  followUpDate: v.date().optional().nullable(),
});

// ---------------------------------------------------------------- views

function findingView(kr, f) {
  return {
    id: f.id, sessionId: f.session_id, seq: f.seq, pairId: f.pair_id,
    trackingPoint: f.tracking_point, trackingSide: f.tracking_side, impactPoint: f.impact_point, impactSide: f.impact_side,
    qualifiers: parseJson(f.qualifiers, { tracking: [], impact: [] }), phenomena: parseJson(f.phenomena, []),
    dwellMinutes: f.dwell_minutes, status: f.status,
    notes: decCol(kr, 'findings', 'notes_enc', f.id, f.notes_enc),
    createdAt: f.created_at, updatedAt: f.updated_at,
  };
}

function sessionSummary(db, s) {
  const pr = db.get('SELECT id, name FROM users WHERE id = ?', s.practitioner_id);
  return {
    id: s.id, patientId: s.patient_id, status: s.status, revision: s.revision, parentId: s.parent_id, supersededBy: s.superseded_by,
    methodology: s.methodology, sessionDate: s.session_date, followUpDate: s.follow_up_date,
    practitioner: pr ? { id: pr.id, name: pr.name } : null,
    findingCount: db.get('SELECT COUNT(*) AS n FROM findings WHERE session_id = ?', s.id).n,
    finalizedAt: s.finalized_at, reportSha256: s.report_sha256, createdAt: s.created_at,
  };
}

function sessionView(db, kr, s) {
  const d = (col, json) => decCol(kr, 'scan_sessions', col, s.id, s[col], { json });
  const fin = s.finalized_by ? db.get('SELECT id, name FROM users WHERE id = ?', s.finalized_by) : null;
  return {
    ...sessionSummary(db, s),
    protocolIds: parseJson(s.protocol_ids, []),
    symptoms: parseJson(s.symptoms, []),
    chiefComplaint: d('chief_complaint_enc'),
    vitals: d('vitals_enc', true),
    notes: d('notes_enc'),
    amendReason: d('amend_reason_enc'),
    signatureName: d('signature_name_enc'),
    finalizedBy: fin ? { id: fin.id, name: fin.name } : null,
    updatedAt: s.updated_at,
    images: Object.fromEntries(['front', 'back'].map((view) => [view, Boolean(db.get('SELECT 1 AS x FROM report_images WHERE session_id = ? AND view = ?', s.id, view))])),
    findings: db.all('SELECT * FROM findings WHERE session_id = ? ORDER BY seq', s.id).map((f) => findingView(kr, f)),
  };
}

// ---------------------------------------------------------------- report assembly (CONTRACT §8)

export function assembleReport({ db, keyring, catalog }, s, overrides = {}) {
  const c = catalog.get();
  const org = orgView(getOrg(db, s.org_id));
  const patient = decryptPatient(keyring, db.get('SELECT * FROM patients WHERE id = ?', s.patient_id));
  const prac = db.get('SELECT id, name, email, role FROM users WHERE id = ?', s.practitioner_id);
  const d = (col, json) => decCol(keyring, 'scan_sessions', col, s.id, s[col], { json });
  const status = overrides.status ?? s.status;
  const finalizedAt = overrides.finalizedAt ?? s.finalized_at;
  const finalizedById = overrides.finalizedBy ?? s.finalized_by;
  const finalizer = finalizedById ? db.get('SELECT id, name FROM users WHERE id = ?', finalizedById) : null;
  const signatureName = overrides.signatureName ?? d('signature_name_enc');
  const sessionDate = s.session_date;

  const nameOfPoint = (id) => c.points.get(id)?.name ?? { es: id, en: id };
  const findings = db.all('SELECT * FROM findings WHERE session_id = ? ORDER BY seq', s.id).map((row) => {
    const f = findingView(keyring, row);
    const p = f.pairId ? c.pairs.get(f.pairId) : null;
    return {
      seq: f.seq,
      pairId: f.pairId,
      pair: p ? { id: p.id, number: p.number ?? null, level: p.level ?? 0, name: p.name } : null,
      tracking: { point: f.trackingPoint, name: nameOfPoint(f.trackingPoint), side: f.trackingSide, qualifiers: f.qualifiers.tracking || [], polarity: 'negative' },
      impact: { point: f.impactPoint, name: nameOfPoint(f.impactPoint), side: f.impactSide, qualifiers: f.qualifiers.impact || [], polarity: 'positive' },
      relatedTo: (p?.relations || []).map((r) => {
        const e = c.entities.get(r.entity);
        return { entity: r.entity, name: e?.name ?? null, kind: e?.kind ?? null, classification: e?.classification ?? null, ordinal: r.ordinal ?? null };
      }),
      category: p?.category ?? 'uncatalogued',
      ratings: { F: p?.ratings?.F ?? null, P: p?.ratings?.P ?? null, R: p?.ratings?.R ?? null },
      phenomena: f.phenomena,
      status: f.status,
      dwellMinutes: f.dwellMinutes,
      notes: f.notes,
      source: p?.source ?? null,
    };
  });

  const groupOrder = [];
  const groups = new Map();
  for (const f of findings) {
    if (!groups.has(f.category)) { groups.set(f.category, []); groupOrder.push(f.category); }
    groups.get(f.category).push(f.seq);
  }

  const magnets = [];
  const sidesOf = (side) => (side === 'RL' ? ['R', 'L'] : [side]);
  for (const f of findings) {
    for (const side of sidesOf(f.tracking.side)) magnets.push({ id: `${f.seq}-n-${side}`, pointId: f.tracking.point, side, polarity: 'negative', label: String(f.seq), state: f.status === 'found' ? 'active' : 'done' });
    for (const side of sidesOf(f.impact.side)) magnets.push({ id: `${f.seq}-p-${side}`, pointId: f.impact.point, side, polarity: 'positive', label: String(f.seq), state: f.status === 'found' ? 'active' : 'done' });
  }
  const image = (view) => {
    const r = db.get('SELECT * FROM report_images WHERE session_id = ? AND view = ?', s.id, view);
    return r ? decCol(keyring, 'report_images', 'data_enc', `${s.id}/${view}`, r.data_enc) : null;
  };

  const pairSpecific = [];
  const seenPairs = new Set();
  for (const f of findings) {
    if (!f.pairId || seenPairs.has(f.pairId)) continue;
    seenPairs.add(f.pairId);
    const recs = c.pairs.get(f.pairId)?.recommendations || [];
    if (recs.length) pairSpecific.push({ pairId: f.pairId, number: f.pair?.number ?? null, name: f.pair?.name ?? null, items: recs });
  }

  const protocolIds = parseJson(s.protocol_ids, []);
  const symptomIds = parseJson(s.symptoms, []);
  const usedDocs = new Set(findings.map((f) => f.source?.doc).filter(Boolean));
  const meta = catalogMeta(db);
  const parent = s.parent_id ? db.get('SELECT id, revision, report_sha256 FROM scan_sessions WHERE id = ?', s.parent_id) : null;

  return {
    schema: 'youheal.report/v1',
    title: REPORT_TITLE,
    reportId: s.id,
    reportNumber: `${patient.mrn}-${sessionDate.slice(0, 10).replace(/-/g, '')}-R${s.revision}`,
    status: status === 'draft' ? 'DRAFT' : status === 'amended' ? 'AMENDED' : 'FINAL',
    revision: s.revision,
    amendment: parent ? { parentId: parent.id, parentRevision: parent.revision, parentSha256: parent.report_sha256, reason: d('amend_reason_enc') } : null,
    org: { name: org.name, legalName: org.legalName, address: org.address, phone: org.phone, email: org.email, website: org.website, license: org.license, reportFooter: org.reportFooter },
    polarity: org.polarity,
    patient: {
      id: patient.id, mrn: patient.mrn, firstName: patient.firstName, lastName: patient.lastName,
      fullName: `${patient.firstName} ${patient.lastName}`, dob: patient.dob, age: ageAt(patient.dob, sessionDate), sex: patient.sex,
    },
    practitioner: prac ? { id: prac.id, name: prac.name, email: prac.email, role: prac.role } : null,
    session: {
      id: s.id, date: sessionDate, methodology: s.methodology,
      protocols: protocolIds.map((id) => ({ id, name: c.protocols.get(id)?.name ?? null, kind: c.protocols.get(id)?.kind ?? null })),
      chiefComplaint: d('chief_complaint_enc'),
      symptoms: symptomIds.map((id) => ({ id, name: c.symptoms.get(id)?.name ?? null, system: c.symptoms.get(id)?.system ?? null })),
      vitals: d('vitals_enc', true),
      notes: d('notes_enc'),
    },
    findings: findings.map(({ source, ...rest }) => rest),
    groups: groupOrder.map((category) => ({ category, seqs: groups.get(category) })),
    totals: {
      findings: findings.length,
      byStatus: Object.fromEntries(FINDING_STATUS.map((st) => [st, findings.filter((f) => f.status === st).length])),
    },
    bodyMap: { magnets, images: { front: image('front'), back: image('back') } },
    recommendations: { pairSpecific, general: c.recommendations },
    followUp: { date: s.follow_up_date, note: FOLLOW_UP_NOTE },
    attestation: status === 'draft' ? null : {
      signatureName, finalizedAt, finalizedBy: finalizer ? { id: finalizer.id, name: finalizer.name } : null,
      statement: { en: 'I attest that this report accurately reflects the findings of the session described above.', es: 'Certifico que este informe refleja fielmente los hallazgos de la sesión descrita.' },
    },
    disclaimer: DISCLAIMER,
    terminology: { en: 'Findings are reported as "related to" — never as a diagnosis.', es: 'Los hallazgos se reportan como "relacionado con", nunca como diagnóstico.' },
    catalog: {
      version: meta?.version ?? null,
      sources: [...usedDocs].map((id) => c.sources.get(id)).filter(Boolean).map((src) => ({ id: src.id, title: src.title, license_status: src.license_status, notice: src.notice ?? null })),
    },
    generatedAt: status === 'draft' ? nowIso() : finalizedAt,
  };
}

export const reportHash = (report) => sha256hex(canonicalJson(report));

// ---------------------------------------------------------------- routes

export function register(router, deps) {
  const { db, keyring, catalog } = deps;

  const getSession = (ctx, id = ctx.params.id) => {
    check(uuidStr(), id);
    const s = db.get('SELECT * FROM scan_sessions WHERE id = ? AND org_id = ?', id, ctx.user.org_id);
    if (!s) throw notFound('Session not found');
    return s;
  };
  const requireDraft = (s) => {
    if (s.status !== 'draft') throw conflict('SESSION_LOCKED', 'Session is finalized and cannot be modified; create an amendment instead');
  };
  const validateCatalogRefs = (body) => {
    const c = catalog.get();
    const errs = {};
    (body.protocolIds || []).forEach((id, i) => { if (!c.protocols.has(id)) errs[`protocolIds[${i}]`] = 'unknown protocol'; });
    (body.symptoms || []).forEach((id, i) => { if (!c.symptoms.has(id)) errs[`symptoms[${i}]`] = 'unknown symptom'; });
    if (Object.keys(errs).length) throw new HttpError(400, 'VALIDATION', 'Unknown catalog reference', errs);
  };

  router.get('/patients/:id/sessions', (ctx) => {
    const p = getPatientRow(db, ctx.user.org_id, ctx.params.id);
    const items = db.all('SELECT * FROM scan_sessions WHERE patient_id = ? AND org_id = ? ORDER BY session_date DESC, revision DESC', p.id, p.org_id).map((s) => sessionSummary(db, s));
    ctx.audit('session.list', { targetType: 'patient', targetId: p.id, detail: { count: items.length } });
    return { items, total: items.length };
  }, { roles: PERM.sessionList });

  router.post('/patients/:id/sessions', (ctx) => {
    const p = getPatientRow(db, ctx.user.org_id, ctx.params.id);
    if (p.archived) throw conflict('PATIENT_ARCHIVED', 'Patient is archived');
    const body = check(sessionCreateSchema, ctx.body);
    validateCatalogRefs(body);
    const consent = db.get("SELECT id, has_absolute FROM consents WHERE patient_id = ? AND org_id = ? AND type = 'intake' ORDER BY signed_at DESC LIMIT 1", p.id, p.org_id);
    if (!consent) throw conflict('CONSENT_REQUIRED', 'An intake consent must be recorded before starting a session');
    const id = uuid(), ts = nowIso();
    const sessionDate = body.sessionDate || ts;
    const followUp = body.followUpDate === undefined ? addDays(sessionDate, 7) : body.followUpDate;
    db.tx(() => {
      db.run(`INSERT INTO scan_sessions (id, org_id, patient_id, practitioner_id, status, revision, methodology, protocol_ids, chief_complaint_enc, symptoms,
        vitals_enc, notes_enc, session_date, follow_up_date, created_at, updated_at) VALUES (?,?,?,?, 'draft', 1, ?,?,?,?,?,?,?,?,?,?)`,
      id, p.org_id, p.id, ctx.user.id, body.methodology, JSON.stringify(body.protocolIds),
      encCol(keyring, 'scan_sessions', 'chief_complaint_enc', id, body.chiefComplaint || null), JSON.stringify(body.symptoms),
      encCol(keyring, 'scan_sessions', 'vitals_enc', id, body.vitals ?? null), encCol(keyring, 'scan_sessions', 'notes_enc', id, body.notes || null),
      sessionDate, followUp, ts, ts);
      ctx.audit('session.create', { targetType: 'session', targetId: id, detail: { patientId: p.id, methodology: body.methodology } });
    });
    ctx.status = 201;
    const out = sessionView(db, keyring, db.get('SELECT * FROM scan_sessions WHERE id = ?', id));
    out.warnings = consent.has_absolute ? [{ code: 'ABSOLUTE_CONTRAINDICATION', message: 'The latest intake records an absolute contraindication.' }] : [];
    return out;
  }, { roles: PERM.clinicalWrite });

  router.get('/sessions/:id', (ctx) => {
    const s = getSession(ctx);
    ctx.audit('session.read', { targetType: 'session', targetId: s.id, detail: { patientId: s.patient_id } });
    return sessionView(db, keyring, s);
  }, { roles: PERM.clinicalRead });

  router.patch('/sessions/:id', (ctx) => {
    const s = getSession(ctx);
    requireDraft(s);
    const body = check(sessionPatchSchema, ctx.body ?? {});
    validateCatalogRefs(body);
    const cols = {};
    if (body.methodology) cols.methodology = body.methodology;
    if (body.protocolIds) cols.protocol_ids = JSON.stringify(body.protocolIds);
    if (body.symptoms) cols.symptoms = JSON.stringify(body.symptoms);
    if (body.chiefComplaint !== undefined) cols.chief_complaint_enc = encCol(keyring, 'scan_sessions', 'chief_complaint_enc', s.id, body.chiefComplaint || null);
    if (body.vitals !== undefined) cols.vitals_enc = encCol(keyring, 'scan_sessions', 'vitals_enc', s.id, body.vitals);
    if (body.notes !== undefined) cols.notes_enc = encCol(keyring, 'scan_sessions', 'notes_enc', s.id, body.notes || null);
    if (body.sessionDate) cols.session_date = body.sessionDate;
    if (body.followUpDate !== undefined) cols.follow_up_date = body.followUpDate;
    const keys = Object.keys(cols);
    if (keys.length) {
      db.tx(() => {
        db.run(`UPDATE scan_sessions SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ? AND status = 'draft'`, ...keys.map((k) => cols[k]), nowIso(), s.id);
        ctx.audit('session.update', { targetType: 'session', targetId: s.id, detail: { fields: Object.keys(body) } });
      });
    }
    return sessionView(db, keyring, db.get('SELECT * FROM scan_sessions WHERE id = ?', s.id));
  }, { roles: PERM.clinicalWrite });

  // ---------------------------------------------------------------- findings

  function resolveFinding(body, existing = null) {
    const c = catalog.get();
    const errs = {};
    const qualifiers = parseQualifiers(body.qualifiers, errs);
    if (Object.keys(errs).length) throw new HttpError(400, 'VALIDATION', 'Invalid qualifiers', errs);
    const cur = existing ? {
      pairId: existing.pair_id, trackingPoint: existing.tracking_point, impactPoint: existing.impact_point,
      trackingSide: existing.tracking_side, impactSide: existing.impact_side,
    } : {};
    let pairId = body.pairId !== undefined ? body.pairId : cur.pairId ?? null;
    let trackingPoint = body.trackingPoint ?? (body.pairId !== undefined && body.pairId ? undefined : cur.trackingPoint);
    let impactPoint = body.impactPoint ?? (body.pairId !== undefined && body.pairId ? undefined : cur.impactPoint);
    let pair = null;
    if (pairId) {
      pair = c.pairs.get(pairId);
      if (!pair) throw new HttpError(400, 'VALIDATION', 'Unknown pair', { pairId: 'unknown pair' });
      trackingPoint ??= pair.tracking.point;
      impactPoint ??= pair.impact.point;
      if (trackingPoint !== pair.tracking.point || impactPoint !== pair.impact.point) {
        throw new HttpError(400, 'VALIDATION', 'Points do not match the selected pair', { trackingPoint: `pair ${pairId} tracks ${pair.tracking.point}`, impactPoint: `pair ${pairId} impacts ${pair.impact.point}` });
      }
    } else {
      if (!trackingPoint || !impactPoint) throw new HttpError(400, 'VALIDATION', 'Either pairId or both trackingPoint and impactPoint are required', { pairId: 'or trackingPoint + impactPoint is required' });
      for (const [k, pid] of [['trackingPoint', trackingPoint], ['impactPoint', impactPoint]]) if (!c.points.has(pid)) errs[k] = 'unknown point';
      if (Object.keys(errs).length) throw new HttpError(400, 'VALIDATION', 'Unknown point', errs);
      const match = [...c.pairs.values()].find((p) => p.tracking.point === trackingPoint && p.impact.point === impactPoint);
      if (match) { pairId = match.id; pair = match; }
    }
    const pairChanged = existing && pairId !== existing.pair_id;
    return {
      pairId: pairId || null, trackingPoint, impactPoint,
      trackingSide: body.trackingSide ?? (pairChanged || !existing ? pair?.tracking.side || 'C' : cur.trackingSide),
      impactSide: body.impactSide ?? (pairChanged || !existing ? pair?.impact.side || 'C' : cur.impactSide),
      qualifiers: qualifiers ?? (existing && !pairChanged ? parseJson(existing.qualifiers) : { tracking: pair?.tracking.qualifiers || [], impact: pair?.impact.qualifiers || [] }),
    };
  }

  router.post('/sessions/:id/findings', (ctx) => {
    const s = getSession(ctx);
    requireDraft(s);
    const body = check(findingSchema, ctx.body);
    const r = resolveFinding(body);
    const id = uuid(), ts = nowIso();
    db.tx(() => {
      const seq = (db.get('SELECT MAX(seq) AS m FROM findings WHERE session_id = ?', s.id).m ?? 0) + 1;
      db.run(`INSERT INTO findings (id, org_id, session_id, seq, pair_id, tracking_point, tracking_side, impact_point, impact_side, qualifiers, phenomena,
        dwell_minutes, status, notes_enc, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, s.org_id, s.id, seq, r.pairId, r.trackingPoint, r.trackingSide, r.impactPoint, r.impactSide, JSON.stringify(r.qualifiers),
      JSON.stringify(body.phenomena || []), body.dwellMinutes ?? null, body.status || 'found',
      encCol(keyring, 'findings', 'notes_enc', id, body.notes || null), ctx.user.id, ts, ts);
      db.run('UPDATE scan_sessions SET updated_at = ? WHERE id = ?', ts, s.id);
      ctx.audit('finding.create', { targetType: 'finding', targetId: id, detail: { sessionId: s.id, pairId: r.pairId } });
    });
    ctx.status = 201;
    return findingView(keyring, db.get('SELECT * FROM findings WHERE id = ?', id));
  }, { roles: PERM.clinicalWrite });

  const getFinding = (s, fid) => {
    check(uuidStr(), fid);
    const f = db.get('SELECT * FROM findings WHERE id = ? AND session_id = ?', fid, s.id);
    if (!f) throw notFound('Finding not found');
    return f;
  };

  router.patch('/sessions/:id/findings/:fid', (ctx) => {
    const s = getSession(ctx);
    requireDraft(s);
    const f = getFinding(s, ctx.params.fid);
    const body = check(findingSchema, ctx.body ?? {});
    const r = resolveFinding(body, f);
    const ts = nowIso();
    db.tx(() => {
      db.run(`UPDATE findings SET pair_id = ?, tracking_point = ?, tracking_side = ?, impact_point = ?, impact_side = ?, qualifiers = ?, phenomena = ?,
        dwell_minutes = ?, status = ?, notes_enc = ?, updated_at = ? WHERE id = ?`,
      r.pairId, r.trackingPoint, r.trackingSide, r.impactPoint, r.impactSide, JSON.stringify(r.qualifiers),
      body.phenomena !== undefined ? JSON.stringify(body.phenomena) : f.phenomena,
      body.dwellMinutes !== undefined ? body.dwellMinutes : f.dwell_minutes,
      body.status ?? f.status,
      body.notes !== undefined ? encCol(keyring, 'findings', 'notes_enc', f.id, body.notes || null) : f.notes_enc, ts, f.id);
      db.run('UPDATE scan_sessions SET updated_at = ? WHERE id = ?', ts, s.id);
      ctx.audit('finding.update', { targetType: 'finding', targetId: f.id, detail: { sessionId: s.id, fields: Object.keys(body) } });
    });
    return findingView(keyring, db.get('SELECT * FROM findings WHERE id = ?', f.id));
  }, { roles: PERM.clinicalWrite });

  router.delete('/sessions/:id/findings/:fid', (ctx) => {
    const s = getSession(ctx);
    requireDraft(s);
    const f = getFinding(s, ctx.params.fid);
    db.tx(() => {
      db.run('DELETE FROM findings WHERE id = ?', f.id);
      db.run('UPDATE scan_sessions SET updated_at = ? WHERE id = ?', nowIso(), s.id);
      ctx.audit('finding.delete', { targetType: 'finding', targetId: f.id, detail: { sessionId: s.id } });
    });
    return { ok: true };
  }, { roles: PERM.clinicalWrite });

  // ---------------------------------------------------------------- finalize / amend

  router.post('/sessions/:id/finalize', (ctx) => {
    const body = check(v.object({ signatureName: v.string({ min: 1, max: 200 }) }), ctx.body);
    const s = getSession(ctx);
    requireDraft(s);
    const finalizedAt = nowIso();
    const status = s.parent_id ? 'amended' : 'final';
    const result = db.tx(() => {
      const fresh = db.get('SELECT * FROM scan_sessions WHERE id = ?', s.id);
      if (fresh.status !== 'draft') throw conflict('SESSION_LOCKED', 'Session was already finalized');
      if (fresh.parent_id) {
        const parent = db.get('SELECT superseded_by FROM scan_sessions WHERE id = ?', fresh.parent_id);
        if (parent?.superseded_by) throw conflict('ALREADY_SUPERSEDED', 'The original report was already amended by another revision');
      }
      const report = assembleReport(deps, fresh, { status, finalizedAt, finalizedBy: ctx.user.id, signatureName: body.signatureName });
      const canonical = canonicalJson(report);
      const hash = sha256hex(canonical);
      db.run(`UPDATE scan_sessions SET status = ?, signature_name_enc = ?, finalized_by = ?, finalized_at = ?, report_sha256 = ?, report_snapshot = ?, updated_at = ?
        WHERE id = ? AND status = 'draft'`, status, encCol(keyring, 'scan_sessions', 'signature_name_enc', s.id, body.signatureName),
      ctx.user.id, finalizedAt, hash, encCol(keyring, 'scan_sessions', 'report_snapshot', s.id, canonical), finalizedAt, s.id);
      if (fresh.parent_id) db.run('UPDATE scan_sessions SET superseded_by = ? WHERE id = ?', s.id, fresh.parent_id);
      ctx.audit('session.finalize', { targetType: 'session', targetId: s.id, detail: { patientId: s.patient_id, status, revision: s.revision, sha256: hash } });
      return { hash };
    });
    return { ok: true, status, sha256: result.hash, hashShort: result.hash.slice(0, 16), finalizedAt, session: sessionView(db, keyring, db.get('SELECT * FROM scan_sessions WHERE id = ?', s.id)) };
  }, { roles: PERM.clinicalWrite });

  router.post('/sessions/:id/amend', (ctx) => {
    const body = check(v.object({ reason: v.string({ min: 3, max: 2000, multiline: true }) }), ctx.body);
    const s = getSession(ctx);
    if (s.status === 'draft') throw conflict('NOT_FINALIZED', 'Only finalized sessions can be amended; edit the draft instead');
    if (s.superseded_by) throw conflict('ALREADY_SUPERSEDED', 'This revision was already amended; amend the latest revision');
    const pending = db.get("SELECT id FROM scan_sessions WHERE parent_id = ? AND status = 'draft'", s.id);
    if (pending) throw Object.assign(conflict('AMENDMENT_IN_PROGRESS', 'An amendment draft already exists for this session'), { fields: { draftId: pending.id } });
    const id = uuid(), ts = nowIso();
    const d = (col, json) => decCol(keyring, 'scan_sessions', col, s.id, s[col], { json });
    const e = (col, val) => encCol(keyring, 'scan_sessions', col, id, val);
    db.tx(() => {
      db.run(`INSERT INTO scan_sessions (id, org_id, patient_id, practitioner_id, status, revision, parent_id, methodology, protocol_ids, chief_complaint_enc,
        symptoms, vitals_enc, notes_enc, amend_reason_enc, session_date, follow_up_date, created_at, updated_at)
        VALUES (?,?,?,?, 'draft', ?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, s.org_id, s.patient_id, ctx.user.id, s.revision + 1, s.id, s.methodology, s.protocol_ids, e('chief_complaint_enc', d('chief_complaint_enc')),
      s.symptoms, e('vitals_enc', d('vitals_enc', true)), e('notes_enc', d('notes_enc')), e('amend_reason_enc', body.reason), s.session_date, s.follow_up_date, ts, ts);
      for (const f of db.all('SELECT * FROM findings WHERE session_id = ? ORDER BY seq', s.id)) {
        const fid = uuid();
        const notes = decCol(keyring, 'findings', 'notes_enc', f.id, f.notes_enc);
        db.run(`INSERT INTO findings (id, org_id, session_id, seq, pair_id, tracking_point, tracking_side, impact_point, impact_side, qualifiers, phenomena,
          dwell_minutes, status, notes_enc, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        fid, f.org_id, id, f.seq, f.pair_id, f.tracking_point, f.tracking_side, f.impact_point, f.impact_side, f.qualifiers, f.phenomena,
        f.dwell_minutes, f.status, encCol(keyring, 'findings', 'notes_enc', fid, notes), f.created_by, f.created_at, ts);
      }
      for (const img of db.all('SELECT * FROM report_images WHERE session_id = ?', s.id)) {
        const data = decCol(keyring, 'report_images', 'data_enc', `${s.id}/${img.view}`, img.data_enc);
        db.run('INSERT INTO report_images (session_id, view, org_id, mime, data_enc, sha256, bytes, created_at) VALUES (?,?,?,?,?,?,?,?)',
          id, img.view, img.org_id, img.mime, encCol(keyring, 'report_images', 'data_enc', `${id}/${img.view}`, data), img.sha256, img.bytes, ts);
      }
      ctx.audit('session.amend', { targetType: 'session', targetId: id, detail: { parentId: s.id, revision: s.revision + 1 } });
    });
    ctx.status = 201;
    return sessionView(db, keyring, db.get('SELECT * FROM scan_sessions WHERE id = ?', id));
  }, { roles: PERM.clinicalWrite });

  // ---------------------------------------------------------------- report

  router.get('/sessions/:id/report', (ctx) => {
    const s = getSession(ctx);
    let report, hash = null, integrity = null;
    if (s.status === 'draft') {
      report = assembleReport(deps, s);
    } else {
      const canonical = decCol(keyring, 'scan_sessions', 'report_snapshot', s.id, s.report_snapshot);
      report = JSON.parse(canonical);
      const actual = sha256hex(canonical);
      integrity = safeEqual(actual, s.report_sha256) ? 'verified' : 'mismatch';
      hash = { sha256: s.report_sha256, short: s.report_sha256.slice(0, 16), algorithm: 'sha256', canonicalization: 'json-sorted-keys' };
      if (integrity !== 'verified') ctx.audit('report.integrity_failure', { targetType: 'session', targetId: s.id, outcome: 'failure' });
    }
    ctx.audit('report.read', { targetType: 'session', targetId: s.id, detail: { patientId: s.patient_id, status: s.status } });
    return { ...report, hash, integrity, supersededBy: s.superseded_by };
  }, { roles: PERM.reportRead });

  const imageSchema = v.string({ min: 1, max: IMAGE_MAX_CHARS, pattern: /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/ }).optional().nullable();
  const MAGIC = { png: [0x89, 0x50, 0x4e, 0x47], jpeg: [0xff, 0xd8, 0xff], webp: [0x52, 0x49, 0x46, 0x46] };

  router.put('/sessions/:id/report/images', (ctx) => {
    const s = getSession(ctx);
    requireDraft(s);
    const body = check(v.object({ front: imageSchema, back: imageSchema }), ctx.body);
    const ts = nowIso();
    const changed = [];
    db.tx(() => {
      for (const view of ['front', 'back']) {
        const val = body[view];
        if (val === undefined) continue;
        if (val === null) { db.run('DELETE FROM report_images WHERE session_id = ? AND view = ?', s.id, view); changed.push(view); continue; }
        const kind = /^data:image\/(png|jpeg|webp);/.exec(val)[1];
        const bytes = Buffer.from(val.slice(val.indexOf(',') + 1), 'base64');
        if (!MAGIC[kind].every((b, i) => bytes[i] === b)) throw badRequest('Image content does not match its declared type', { [view]: 'invalid image data' });
        db.run(`INSERT INTO report_images (session_id, view, org_id, mime, data_enc, sha256, bytes, created_at) VALUES (?,?,?,?,?,?,?,?)
          ON CONFLICT(session_id, view) DO UPDATE SET mime = excluded.mime, data_enc = excluded.data_enc, sha256 = excluded.sha256, bytes = excluded.bytes, created_at = excluded.created_at`,
        s.id, view, s.org_id, `image/${kind}`, encCol(keyring, 'report_images', 'data_enc', `${s.id}/${view}`, val), sha256hex(bytes), bytes.length, ts);
        changed.push(view);
      }
      ctx.audit('report.images.update', { targetType: 'session', targetId: s.id, detail: { views: changed } });
    });
    return { ok: true, updated: changed };
  }, { roles: PERM.clinicalWrite, bodyLimit: 4 * 1024 * 1024 + 4096 });
}
