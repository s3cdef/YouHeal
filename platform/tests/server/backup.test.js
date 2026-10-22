// Encrypted backup (API stream) -> verify -> restore; tamper detection; master-key rotation.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startTestServer, setupToken, Client, tmpDir, silent } from './helpers.js';
import { verifyBackup, restoreBackup, readBackupHeader } from '../../server/lib/backup.js';
import { loadKeyring } from '../../server/lib/keys.js';
import { openDb } from '../../server/lib/db.js';
import { reencryptAll } from '../../server/lib/rotate.js';
import { generateMasterKey, Keyring, blindIndex } from '../../server/lib/crypto.js';
import { decryptPatient } from '../../server/lib/phi.js';
import { createAudit } from '../../server/lib/audit.js';

const ADMIN = { email: 'owner@clinic.test', name: 'Olivia Owner', password: 'Violet-Harbor-Lantern-42' };

async function seeded() {
  const srv = await startTestServer({ YH_DEV_INSECURE_NO_MFA: '1' });
  const c = new Client(srv.url);
  await c.post('/api/v1/setup', { setupToken: setupToken(srv), org: { name: 'Backup Clinic' }, admin: ADMIN });
  await c.post('/api/v1/auth/login', { email: ADMIN.email, password: ADMIN.password });
  const p = await c.post('/api/v1/patients', { firstName: 'Rosa', lastName: 'Martínez', dob: '1975-02-03', sex: 'female' });
  assert.equal(p.status, 201);
  return { srv, c, patientId: p.json.id };
}

test('admin backup streams an AES-256-GCM encrypted file that verifies and restores; tampering is detected', async () => {
  const { srv, c, patientId } = await seeded();
  try {
    const r = await c.get('/api/v1/admin/backup');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-disposition'), /attachment; filename="youheal-backup-\d{8}T\d{6}Z\.yhbak"/);
    assert.equal(r.headers.get('content-type'), 'application/octet-stream');
    assert.equal(r.buf.subarray(0, 7).toString(), 'YHBAK1 ');
    assert.ok(!r.buf.includes('Backup Clinic'), 'org name not in plaintext (encrypted + compressed)');
    const dir = tmpDir();
    const file = path.join(dir, 'b.yhbak');
    fs.writeFileSync(file, r.buf);
    const { keyring } = loadKeyring(srv.cfg, silent, { allowGenerate: false });
    const h = await verifyBackup(file, keyring);
    assert.equal(h.keyId, keyring.keyId);
    assert.equal(readBackupHeader(file).header.alg, 'aes-256-gcm');

    // restore into a fresh path, then read the patient back
    const target = path.join(dir, 'restored', 'youheal.sqlite');
    fs.mkdirSync(path.dirname(target));
    fs.writeFileSync(target, 'old database');
    const res = await restoreBackup(file, keyring, target);
    assert.ok(fs.existsSync(res.previous), 'previous db kept');
    const db = openDb(target);
    const row = db.get('SELECT * FROM patients WHERE id = ?', patientId);
    assert.equal(decryptPatient(keyring, row).lastName, 'Martínez');
    assert.equal(createAudit(db, keyring).verify().ok, true);
    db.close();

    // flip one ciphertext byte -> auth failure, and the live DB is untouched
    const bad = path.join(dir, 'bad.yhbak');
    const buf = Buffer.from(r.buf);
    buf[Math.floor(buf.length / 2)] ^= 0xff;
    fs.writeFileSync(bad, buf);
    await assert.rejects(verifyBackup(bad, keyring), /authentication failed/);
    const before = fs.readFileSync(target);
    await assert.rejects(restoreBackup(bad, keyring, target), /authentication failed/);
    assert.deepEqual(fs.readFileSync(target), before, 'restore target unchanged after failed verification');
    assert.equal(fs.readdirSync(path.dirname(target)).filter((f) => f.includes('.restore-')).length, 0, 'no temp leftovers');
    // header tampering (AAD) is detected too
    const hdr = Buffer.from(r.buf);
    const i = hdr.indexOf('"app"');
    hdr[i + 1] = 'A'.charCodeAt(0);
    fs.writeFileSync(bad, hdr);
    await assert.rejects(verifyBackup(bad, keyring));
    // wrong key
    await assert.rejects(verifyBackup(file, new Keyring(generateMasterKey())), /not in the keyring/);
    // non-admin cannot export
    await c.post('/api/v1/users', { email: 'doc@clinic.test', name: 'Doc', role: 'practitioner', password: 'Quartz-Meadow-Falcon-77' });
    const d = new Client(srv.url);
    await d.post('/api/v1/auth/login', { email: 'doc@clinic.test', password: 'Quartz-Meadow-Falcon-77' });
    assert.equal((await d.get('/api/v1/admin/backup')).status, 403);
  } finally { await srv.close(); }
});

test('master-key rotation re-encrypts PHI, rebuilds blind indexes and the audit anchor', async () => {
  const { srv, c, patientId } = await seeded();
  const { keyring } = loadKeyring(srv.cfg, silent, { allowGenerate: false });
  const oldBackup = path.join(tmpDir(), 'pre-rotation.yhbak');
  fs.writeFileSync(oldBackup, (await c.get('/api/v1/admin/backup')).buf);
  await srv.close();
  const db = openDb(srv.cfg.dbPath);
  const beforeCt = db.get('SELECT last_name_enc FROM patients WHERE id = ?', patientId).last_name_enc;
  const { newRing, counts } = reencryptAll(db, keyring, generateMasterKey());
  assert.ok(counts.patients >= 4);
  const row = db.get('SELECT * FROM patients WHERE id = ?', patientId);
  assert.notEqual(row.last_name_enc, beforeCt);
  assert.ok(row.last_name_enc.startsWith(`v1:${newRing.keyId}:`));
  assert.equal(decryptPatient(new Keyring(newRing.current.master), row).lastName, 'Martínez', 'new key alone decrypts');
  assert.equal(row.last_name_bidx, blindIndex(newRing, 'last_name', 'martinez'));
  assert.equal(createAudit(db, newRing).verify().ok, true);
  assert.equal(createAudit(db, keyring).verify().ok, false, 'anchor bound to the new key');
  db.close();
  const raw = new DatabaseSync(srv.cfg.dbPath);
  assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM patients WHERE last_name_enc LIKE 'v1:' || ? || ':%'").get(keyring.keyId).n, 0, 'no ciphertext left under the old key');
  raw.close();

  // restoring a pre-rotation backup re-keys it to the current key (old key kept as retired)
  const target = path.join(tmpDir(), 'restored.sqlite');
  await restoreBackup(oldBackup, newRing, target);
  const rdb = openDb(target);
  const rrow = rdb.get('SELECT * FROM patients WHERE id = ?', patientId);
  assert.ok(rrow.last_name_enc.startsWith(`v1:${newRing.keyId}:`));
  assert.equal(rrow.last_name_bidx, blindIndex(newRing, 'last_name', 'martinez'));
  assert.equal(createAudit(rdb, newRing).verify().ok, true);
  rdb.close();
});
