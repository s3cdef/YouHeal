// Patients & consents. PHI is encrypted per field; search is exact-match via blind indexes only.

import { v, check, paging, uuidStr, catalogId } from '../lib/validate.js';
import { uuid } from '../lib/crypto.js';
import { notFound, conflict, HttpError } from '../lib/http.js';
import { PERM } from '../lib/rbac.js';
import { encryptPatientFields, patientIndexes, decryptPatient, encCol, decCol } from '../lib/phi.js';
import { nowIso, ageAt } from './_shared.js';

export const SEXES = ['female', 'male', 'other', 'unknown'];
const MRN_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,31}$/;
const NAME = () => v.string({ min: 1, max: 100 });

const fields = {
  firstName: NAME(),
  lastName: NAME(),
  dob: v.date({ notFuture: true }),
  sex: v.enum(SEXES).default('unknown'),
  phone: v.string({ max: 50, pattern: /^[0-9+().\s/-]*$/ }).optional().nullable(),
  email: v.email().optional().nullable(),
  address: v.string({ max: 500, multiline: true }).optional().nullable(),
  mrn: v.string({ max: 32, pattern: MRN_RE }).optional().nullable(),
  notes: v.string({ max: 8000, multiline: true }).optional().nullable(),
};
const createSchema = v.object(fields);
const patchSchema = v.object({
  ...Object.fromEntries(Object.entries(fields).map(([k, s]) => [k, k === 'sex' ? v.enum(SEXES).optional() : s.optional()])),
  archived: v.bool().optional(),
});

const blanksToNull = (body, keys) => {
  if (!body || typeof body !== 'object') return body;
  const out = { ...body };
  for (const k of keys) if (out[k] === '') out[k] = null;
  return out;
};
const OPTIONAL_KEYS = ['phone', 'email', 'address', 'mrn', 'notes'];

export function getPatientRow(db, orgId, id) {
  check(uuidStr(), id);
  const row = db.get('SELECT * FROM patients WHERE id = ? AND org_id = ?', id, orgId);
  if (!row) throw notFound('Patient not found');
  return row;
}

const summary = (p) => ({ id: p.id, mrn: p.mrn, firstName: p.firstName, lastName: p.lastName, dob: p.dob, age: ageAt(p.dob), sex: p.sex, archived: p.archived, createdAt: p.createdAt });

export function consentView(keyring, row) {
  return {
    id: row.id, patientId: row.patient_id, type: row.type,
    answers: decCol(keyring, 'consents', 'answers_enc', row.id, row.answers_enc, { json: true }) || {},
    contraindications: decCol(keyring, 'consents', 'contraindications_enc', row.id, row.contraindications_enc, { json: true }) || { relative: [], absolute: [] },
    hasAbsolute: Boolean(row.has_absolute), hasRelative: Boolean(row.has_relative),
    signatureName: decCol(keyring, 'consents', 'signature_name_enc', row.id, row.signature_name_enc),
    signedAt: row.signed_at, recordedBy: row.recorded_by, createdAt: row.created_at,
  };
}

export function register(router, { db, keyring, catalog }) {
  function nextMrn(orgId) {
    for (let i = 0; i < 1000; i++) {
      const org = db.get('SELECT next_mrn FROM orgs WHERE id = ?', orgId);
      db.run('UPDATE orgs SET next_mrn = next_mrn + 1 WHERE id = ?', orgId);
      const mrn = `YH-${String(org.next_mrn).padStart(6, '0')}`;
      const { mrn_bidx: b } = patientIndexes(keyring, { mrn });
      if (!db.get('SELECT 1 AS x FROM patients WHERE org_id = ? AND mrn_bidx = ?', orgId, b)) return mrn;
    }
    throw new Error('could not allocate MRN');
  }

  function searchPatients(ctx, { q = '', dobQ = null, includeArchived = false, limit, offset }) {
    q = String(q || '').trim();
    if (q.length > 100) throw new HttpError(400, 'VALIDATION', 'q is too long', { q: 'must be at most 100 characters' });
    const where = ['org_id = ?'], params = [ctx.user.org_id];
    if (!includeArchived) where.push('archived = 0');
    let mode = 'list';
    if (dobQ) {
      check(v.date(), dobQ);
      where.push('dob_bidx = ?'); params.push(patientIndexes(keyring, { dob: dobQ }).dob_bidx); mode = 'dob';
    }
    if (q.length === 1 && /\p{L}/u.test(q)) {
      where.push('last_initial_bidx = ?'); params.push(patientIndexes(keyring, { lastName: q }).last_initial_bidx); mode = 'letter';
    } else if (q) {
      const ix = patientIndexes(keyring, { lastName: q, mrn: q });
      where.push('(last_name_bidx = ? OR mrn_bidx = ?)'); params.push(ix.last_name_bidx, ix.mrn_bidx); mode = 'exact';
    }
    const w = where.join(' AND ');
    const total = db.get(`SELECT COUNT(*) AS n FROM patients WHERE ${w}`, ...params).n;
    const rows = db.all(`SELECT * FROM patients WHERE ${w} ORDER BY created_at DESC, id LIMIT ? OFFSET ?`, ...params, limit, offset);
    const stats = new Map();
    if (rows.length) {
      for (const st of db.all(`SELECT patient_id, COUNT(*) AS n, MAX(session_date) AS last FROM scan_sessions
        WHERE org_id = ? AND superseded_by IS NULL AND patient_id IN (${rows.map(() => '?').join(',')}) GROUP BY patient_id`, ctx.user.org_id, ...rows.map((r) => r.id))) {
        stats.set(st.patient_id, st);
      }
    }
    const items = rows.map((r) => ({ ...summary(decryptPatient(keyring, r)), sessionCount: stats.get(r.id)?.n ?? 0, lastSessionDate: stats.get(r.id)?.last ?? null }));
    if (mode !== 'list') items.sort((a, b) => a.lastName.localeCompare(b.lastName) || a.firstName.localeCompare(b.firstName));
    ctx.audit('patient.search', { targetType: 'patient', detail: { mode, returned: items.length, total, ids: items.map((i) => i.id) } });
    return { items, total };
  }

  // Deprecated (F-08): search terms in the URL end up in proxy/browser logs. Use POST /patients/search.
  router.get('/patients', (ctx) => {
    const { limit, offset } = paging(ctx.query, { defLimit: 25, maxLimit: 200 });
    ctx.res.setHeader('Deprecation', 'true');
    ctx.res.setHeader('Link', '</api/v1/patients/search>; rel="successor-version"');
    return searchPatients(ctx, {
      q: ctx.query.get('q'), dobQ: ctx.query.get('dob'),
      includeArchived: ctx.query.get('archived') === '1' || ctx.query.get('archived') === 'true', limit, offset,
    });
  }, { roles: PERM.patientRead });

  const searchSchema = v.object({
    q: v.string({ max: 100 }).optional().nullable(),
    dob: v.date().optional().nullable(),
    archived: v.bool().optional(),
    limit: v.int({ min: 1, max: 200 }).optional(),
    offset: v.int({ min: 0, max: 10_000_000 }).optional(),
  });
  router.post('/patients/search', (ctx) => {
    const b = check(searchSchema, ctx.body ?? {});
    return searchPatients(ctx, { q: b.q || '', dobQ: b.dob || null, includeArchived: Boolean(b.archived), limit: b.limit ?? 25, offset: b.offset ?? 0 });
  }, { roles: PERM.patientRead });

  router.post('/patients', (ctx) => {
    const body = check(createSchema, blanksToNull(ctx.body, OPTIONAL_KEYS));
    const id = uuid(), ts = nowIso(), orgId = ctx.user.org_id;
    db.tx(() => {
      let mrn = body.mrn;
      if (mrn) {
        const { mrn_bidx: b } = patientIndexes(keyring, { mrn });
        if (db.get('SELECT 1 AS x FROM patients WHERE org_id = ? AND mrn_bidx = ?', orgId, b)) throw conflict('MRN_TAKEN', 'This MRN is already assigned to another patient');
      } else mrn = nextMrn(orgId);
      const enc = encryptPatientFields(keyring, id, { ...body, mrn });
      const ix = patientIndexes(keyring, { lastName: body.lastName, dob: body.dob, mrn });
      db.run(`INSERT INTO patients (id, org_id, mrn_enc, mrn_bidx, first_name_enc, last_name_enc, last_name_bidx, last_initial_bidx, dob_enc, dob_bidx,
        sex_enc, phone_enc, email_enc, address_enc, notes_enc, archived, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?)`,
      id, orgId, enc.mrn_enc, ix.mrn_bidx, enc.first_name_enc, enc.last_name_enc, ix.last_name_bidx, ix.last_initial_bidx, enc.dob_enc ?? null, ix.dob_bidx ?? null,
      enc.sex_enc ?? null, enc.phone_enc ?? null, enc.email_enc ?? null, enc.address_enc ?? null, enc.notes_enc ?? null, ctx.user.id, ts, ts);
      ctx.audit('patient.create', { targetType: 'patient', targetId: id });
    });
    ctx.status = 201;
    return decryptPatient(keyring, db.get('SELECT * FROM patients WHERE id = ?', id));
  }, { roles: PERM.patientWrite });

  router.get('/patients/:id', (ctx) => {
    const row = getPatientRow(db, ctx.user.org_id, ctx.params.id);
    const p = decryptPatient(keyring, row);
    const consent = db.get('SELECT id, type, signed_at, has_absolute, has_relative FROM consents WHERE patient_id = ? AND org_id = ? ORDER BY signed_at DESC LIMIT 1', row.id, ctx.user.org_id);
    const sessions = db.get('SELECT COUNT(*) AS n, MAX(session_date) AS last FROM scan_sessions WHERE patient_id = ? AND org_id = ? AND superseded_by IS NULL', row.id, ctx.user.org_id);
    ctx.audit('patient.read', { targetType: 'patient', targetId: row.id });
    return {
      ...p, age: ageAt(p.dob),
      latestConsent: consent ? { id: consent.id, type: consent.type, signedAt: consent.signed_at, hasAbsolute: Boolean(consent.has_absolute), hasRelative: Boolean(consent.has_relative) } : null,
      sessionCount: sessions.n, lastSessionDate: sessions.last,
    };
  }, { roles: PERM.patientRead });

  router.patch('/patients/:id', (ctx) => {
    const row = getPatientRow(db, ctx.user.org_id, ctx.params.id);
    const body = check(patchSchema, blanksToNull(ctx.body ?? {}, OPTIONAL_KEYS));
    const changed = Object.keys(body);
    if (!changed.length) return decryptPatient(keyring, row);
    db.tx(() => {
      if (body.mrn) {
        const { mrn_bidx: b } = patientIndexes(keyring, { mrn: body.mrn });
        if (db.get('SELECT 1 AS x FROM patients WHERE org_id = ? AND mrn_bidx = ? AND id <> ?', row.org_id, b, row.id)) throw conflict('MRN_TAKEN', 'This MRN is already assigned to another patient');
      } else if (body.mrn === null) delete body.mrn; // MRN cannot be cleared
      const enc = encryptPatientFields(keyring, row.id, body);
      const ix = patientIndexes(keyring, { lastName: body.lastName, dob: body.dob, mrn: body.mrn ?? undefined });
      const cols = { ...enc, ...Object.fromEntries(Object.entries(ix).filter(([, val]) => val !== undefined)) };
      if (body.archived !== undefined) cols.archived = body.archived ? 1 : 0;
      for (const k of ['last_name_enc', 'first_name_enc', 'mrn_enc']) if (k in cols && cols[k] === null) delete cols[k];
      const keys = Object.keys(cols);
      if (keys.length) db.run(`UPDATE patients SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, ...keys.map((k) => cols[k]), nowIso(), row.id);
      ctx.audit('patient.update', { targetType: 'patient', targetId: row.id, detail: { fields: changed } });
    });
    return decryptPatient(keyring, db.get('SELECT * FROM patients WHERE id = ?', row.id));
  }, { roles: PERM.patientWrite });

  // ---------------------------------------------------------------- consents
  const consentSchema = v.object({
    type: v.enum(['intake', 'treatment', 'telehealth', 'privacy']).default('intake'),
    answers: v.json({ maxBytes: 64 * 1024 }).default({}),
    contraindications: v.object({
      relative: v.array(catalogId(), { max: 200, unique: true }).default([]),
      absolute: v.array(catalogId(), { max: 200, unique: true }).default([]),
    }).default({ relative: [], absolute: [] }),
    signatureName: v.string({ min: 1, max: 200 }),
    signedAt: v.datetime().optional(),
  });

  router.post('/patients/:id/consents', (ctx) => {
    const row = getPatientRow(db, ctx.user.org_id, ctx.params.id);
    const body = check(consentSchema, ctx.body);
    const known = new Map(catalog.get().contraindications.map((c) => [c.id, c.kind]));
    const errs = {};
    for (const kind of ['relative', 'absolute']) {
      body.contraindications[kind].forEach((cid, i) => {
        if (known.size && !known.has(cid)) errs[`contraindications.${kind}[${i}]`] = 'unknown contraindication';
        else if (known.size && known.get(cid) !== kind) errs[`contraindications.${kind}[${i}]`] = `is a ${known.get(cid)} contraindication`;
      });
    }
    if (Object.keys(errs).length) throw new HttpError(400, 'VALIDATION', 'Invalid contraindications', errs);
    const signedAt = body.signedAt || nowIso();
    if (Date.parse(signedAt) > Date.now() + 5 * 60_000) throw new HttpError(400, 'VALIDATION', 'signedAt is in the future', { signedAt: 'must not be in the future' });
    const id = uuid();
    const hasAbs = body.contraindications.absolute.length > 0, hasRel = body.contraindications.relative.length > 0;
    db.tx(() => {
      db.run(`INSERT INTO consents (id, org_id, patient_id, type, answers_enc, contraindications_enc, has_absolute, has_relative, signature_name_enc, signed_at, recorded_by, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, id, row.org_id, row.id, body.type,
      encCol(keyring, 'consents', 'answers_enc', id, body.answers), encCol(keyring, 'consents', 'contraindications_enc', id, body.contraindications),
      hasAbs, hasRel, encCol(keyring, 'consents', 'signature_name_enc', id, body.signatureName), signedAt, ctx.user.id, nowIso());
      ctx.audit('consent.create', { targetType: 'consent', targetId: id, detail: { patientId: row.id, type: body.type, hasAbsolute: hasAbs, hasRelative: hasRel } });
    });
    ctx.status = 201;
    const warnings = [];
    if (hasAbs) warnings.push({ code: 'ABSOLUTE_CONTRAINDICATION', message: 'Absolute contraindication recorded: biomagnetic scanning should not be performed.' });
    if (hasRel) warnings.push({ code: 'RELATIVE_CONTRAINDICATION', message: 'Relative contraindication recorded: proceed only with clinical judgement.' });
    return { consent: consentView(keyring, db.get('SELECT * FROM consents WHERE id = ?', id)), warnings };
  }, { roles: PERM.consentWrite });

  router.get('/patients/:id/consents', (ctx) => {
    const row = getPatientRow(db, ctx.user.org_id, ctx.params.id);
    const items = db.all('SELECT * FROM consents WHERE patient_id = ? AND org_id = ? ORDER BY signed_at DESC', row.id, row.org_id).map((r) => consentView(keyring, r));
    ctx.audit('consent.list', { targetType: 'patient', targetId: row.id, detail: { count: items.length } });
    return { items, total: items.length };
  }, { roles: PERM.patientRead });
}
