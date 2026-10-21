// Master-key rotation: re-encrypt every PHI column and recompute blind indexes + the audit anchor
// under a new master key, in ONE transaction. See cli/rotate-key.js for the file choreography.

import { Keyring, decryptField, encryptField } from './crypto.js';
import { ENCRYPTED_COLUMNS, aadFor, rowKeyOf, patientIndexes } from './phi.js';
import { dbAnchorMac, checkpointMac } from './audit.js';

/**
 * @param db        Db
 * @param oldRing   Keyring able to decrypt all current data
 * @param newMaster Buffer(32) new master key
 * @returns {{ newRing: Keyring, counts: object }}
 */
export function reencryptAll(db, oldRing, newMaster) {
  const retired = [...oldRing.sets.values()].map((s) => s.master);
  const newRing = new Keyring(newMaster, retired);
  const counts = {};
  db.tx(() => {
    for (const spec of ENCRYPTED_COLUMNS) {
      const cols = Object.keys(spec.cols);
      const rows = db.all(`SELECT ${[...spec.key, ...cols].join(', ')} FROM ${spec.table}`);
      let n = 0;
      for (const row of rows) {
        const rk = rowKeyOf(spec, row);
        const sets = [], params = [];
        for (const col of cols) {
          if (row[col] === null) continue;
          const aad = aadFor(spec.cols[col], rk);
          const plain = decryptField(oldRing, row[col], aad);
          sets.push(`${col} = ?`); params.push(encryptField(newRing, plain, aad)); n++;
        }
        if (!sets.length) continue;
        db.run(`UPDATE ${spec.table} SET ${sets.join(', ')} WHERE ${spec.key.map((k) => `${k} = ?`).join(' AND ')}`, ...params, ...spec.key.map((k) => row[k]));
      }
      counts[spec.table] = n;
    }
    // blind indexes depend on the master key
    for (const p of db.all('SELECT id, last_name_enc, dob_enc, mrn_enc FROM patients')) {
      const dec = (col, pre) => (p[col] === null ? null : decryptField(newRing, p[col], aadFor(pre, p.id)));
      const ix = patientIndexes(newRing, {
        lastName: dec('last_name_enc', 'patients.last_name'), dob: dec('dob_enc', 'patients.dob'), mrn: dec('mrn_enc', 'patients.mrn'),
      });
      db.run('UPDATE patients SET last_name_bidx = ?, last_initial_bidx = ?, dob_bidx = ?, mrn_bidx = ? WHERE id = ?',
        ix.last_name_bidx, ix.last_initial_bidx, ix.dob_bidx, ix.mrn_bidx, p.id);
    }
    const anchor = db.get('SELECT last_id, last_hash, exported_id, exported_hash, verified_id, verified_hash FROM audit_anchor WHERE id = 1');
    if (anchor) {
      db.run('UPDATE audit_anchor SET mac = ?, verified_mac = ?, updated_at = ? WHERE id = 1',
        dbAnchorMac(newRing, anchor.last_id, anchor.last_hash, anchor.exported_id, anchor.exported_hash),
        anchor.verified_id ? checkpointMac(newRing, anchor.verified_id, anchor.verified_hash) : null, new Date().toISOString());
    }
  });
  return { newRing, counts };
}
