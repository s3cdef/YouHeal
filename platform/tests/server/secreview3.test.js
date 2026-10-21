// Regression tests for the final re-test (Info items closed by the architect: F-16 export-point binding).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir, silent } from './helpers.js';
import { openDb, migrate } from '../../server/lib/db.js';
import { Keyring, generateMasterKey } from '../../server/lib/crypto.js';
import { createAudit, anchorMac } from '../../server/lib/audit.js';
import { reencryptAll } from '../../server/lib/rotate.js';

function setup() {
  const dir = tmpDir();
  const db = openDb(path.join(dir, 'a.sqlite')); migrate(db);
  const kr = new Keyring(generateMasterKey());
  const anchorFile = path.join(dir, 'audit-anchor.log');
  const audit = createAudit(db, kr, silent, { anchorFile, anchorEvery: 5 });
  for (let i = 0; i < 12; i++) audit.append({ action: 'test.event', detail: { i } });
  return { db, kr, anchorFile, audit };
}

test('F-16 final: clearing the recorded export point and deleting the anchor log is detected', () => {
  const { db, anchorFile, audit } = setup();
  assert.equal(audit.verify().ok, true);
  db.run('UPDATE audit_anchor SET exported_id = NULL, exported_hash = NULL WHERE id = 1');
  fs.rmSync(anchorFile);
  assert.equal(audit.verify().ok, false);
  assert.equal(audit.verify().reason, 'chain anchor signature invalid');
  db.close();
});

test('F-16 final: moving the export point backwards is detected', () => {
  const { db, audit } = setup();
  db.run('UPDATE audit_anchor SET exported_id = 5 WHERE id = 1');
  assert.equal(audit.verify().reason, 'chain anchor signature invalid');
  db.close();
});

test('F-16 final: legacy anchors without an export point remain valid until rewritten', () => {
  const dir = tmpDir();
  const db = openDb(path.join(dir, 'a.sqlite')); migrate(db);
  const kr = new Keyring(generateMasterKey());
  const audit = createAudit(db, kr, silent); // no anchor file → never exported
  for (let i = 0; i < 3; i++) audit.append({ action: 'test.event' });
  const a = db.get('SELECT last_id, last_hash FROM audit_anchor WHERE id = 1');
  db.run('UPDATE audit_anchor SET mac = ? WHERE id = 1', anchorMac(kr, a.last_id, a.last_hash)); // pre-change format
  assert.equal(audit.verify().ok, true);
  audit.append({ action: 'test.event' });
  assert.equal(audit.verify().ok, true, 'next row rewrites the anchor in the bound format');
  db.close();
});

test('F-16 final: key rotation re-MACs the bound anchor', () => {
  const { db, kr, audit } = setup();
  const { newRing } = reencryptAll(db, kr, generateMasterKey());
  const audit2 = createAudit(db, newRing, silent, { anchorFile: null });
  assert.equal(audit2.verify().ok, true);
  void audit;
  db.close();
});
