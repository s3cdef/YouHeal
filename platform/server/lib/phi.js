// PHI column registry + patient record (de)serialization. Every encrypted column is bound to its
// table/column/row via AES-GCM AAD "<table>.<column>:<rowKey>" (ADR-003).

import { encryptField, decryptField, blindIndex, normalizeText } from './crypto.js';

/** All encrypted columns. Used by the app and by `npm run rotate-key`. */
export const ENCRYPTED_COLUMNS = [
  { table: 'users', key: ['id'], cols: { mfa_secret_enc: 'users.mfa_secret', mfa_pending_enc: 'users.mfa_pending' } },
  {
    table: 'patients', key: ['id'], cols: {
      mrn_enc: 'patients.mrn', first_name_enc: 'patients.first_name', last_name_enc: 'patients.last_name', dob_enc: 'patients.dob',
      sex_enc: 'patients.sex', phone_enc: 'patients.phone', email_enc: 'patients.email', address_enc: 'patients.address', notes_enc: 'patients.notes',
    },
  },
  { table: 'consents', key: ['id'], cols: { answers_enc: 'consents.answers', contraindications_enc: 'consents.contraindications', signature_name_enc: 'consents.signature_name' } },
  {
    table: 'scan_sessions', key: ['id'], cols: {
      chief_complaint_enc: 'scan_sessions.chief_complaint', vitals_enc: 'scan_sessions.vitals', notes_enc: 'scan_sessions.notes',
      amend_reason_enc: 'scan_sessions.amend_reason', scan_state_enc: 'scan_sessions.scan_state', signature_name_enc: 'scan_sessions.signature_name', report_snapshot: 'scan_sessions.report_snapshot',
    },
  },
  { table: 'findings', key: ['id'], cols: { notes_enc: 'findings.notes' } },
  { table: 'report_images', key: ['session_id', 'view'], cols: { data_enc: 'report_images.data' } },
];

export const aadFor = (prefix, rowKey) => `${prefix}:${rowKey}`;
export const rowKeyOf = (spec, row) => spec.key.map((k) => row[k]).join('/');

const P = Object.fromEntries(Object.entries(ENCRYPTED_COLUMNS[1].cols).map(([col, pre]) => [col, pre]));
const FIELD_COL = {
  mrn: 'mrn_enc', firstName: 'first_name_enc', lastName: 'last_name_enc', dob: 'dob_enc', sex: 'sex_enc',
  phone: 'phone_enc', email: 'email_enc', address: 'address_enc', notes: 'notes_enc',
};
export const PATIENT_FIELDS = Object.keys(FIELD_COL);

/** Encrypt the provided patient fields -> { column: ciphertext }. */
export function encryptPatientFields(keyring, id, fields) {
  const out = {};
  for (const [f, col] of Object.entries(FIELD_COL)) {
    if (fields[f] === undefined) continue;
    out[col] = fields[f] === null || fields[f] === '' ? null : encryptField(keyring, fields[f], aadFor(P[col], id));
  }
  return out;
}

export function patientIndexes(keyring, { lastName, dob, mrn }, keySet) {
  const out = {};
  if (lastName !== undefined) {
    out.last_name_bidx = blindIndex(keyring, 'last_name', lastName, keySet);
    const initial = normalizeText(lastName).charAt(0);
    out.last_initial_bidx = initial ? blindIndex(keyring, 'last_initial', initial, keySet) : null;
  }
  if (dob !== undefined) out.dob_bidx = dob ? blindIndex(keyring, 'dob', dob, keySet) : null;
  if (mrn !== undefined) out.mrn_bidx = blindIndex(keyring, 'mrn', mrn, keySet);
  return out;
}

export function decryptPatient(keyring, row) {
  const d = (col) => decryptField(keyring, row[col], aadFor(P[col], row.id));
  return {
    id: row.id,
    mrn: d('mrn_enc'),
    firstName: d('first_name_enc'),
    lastName: d('last_name_enc'),
    dob: d('dob_enc'),
    sex: d('sex_enc'),
    phone: d('phone_enc'),
    email: d('email_enc'),
    address: d('address_enc'),
    notes: d('notes_enc'),
    archived: Boolean(row.archived),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Encrypt/decrypt helpers for other tables, keyed by the registry. */
export function encCol(keyring, table, col, rowKey, value) {
  const spec = ENCRYPTED_COLUMNS.find((s) => s.table === table);
  if (value === null || value === undefined) return null;
  return encryptField(keyring, typeof value === 'string' ? value : JSON.stringify(value), aadFor(spec.cols[col], rowKey));
}
export function decCol(keyring, table, col, rowKey, value, { json = false } = {}) {
  if (value === null || value === undefined) return null;
  const spec = ENCRYPTED_COLUMNS.find((s) => s.table === table);
  const s = decryptField(keyring, value, aadFor(spec.cols[col], rowKey));
  return json ? JSON.parse(s) : s;
}
