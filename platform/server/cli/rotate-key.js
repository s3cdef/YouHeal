// npm run rotate-key — generate a new master key and re-encrypt all PHI under it.
// Choreography (crash-safe):
//   1. old key copied to data/keys/retired/<oldKeyId>.key   (decrypt-only; needed for old backups)
//   2. new key written to data/keys/master.key.next           (loaded as decrypt-only if we crash)
//   3. one DB transaction re-encrypts every PHI column, blind index and the audit anchor
//   4. master.key.next atomically renamed over master.key
// The server must be stopped. Take a backup first.

import fs from 'node:fs';
import path from 'node:path';
import { cliContext, parseArgs, ask, die } from './_common.js';
import { loadKeyring, writeKeyFile, readKeyFile } from '../lib/keys.js';
import { openDb, migrate } from '../lib/db.js';
import { generateMasterKey, deriveKeySet } from '../lib/crypto.js';
import { reencryptAll } from '../lib/rotate.js';
import { createAudit } from '../lib/audit.js';
import { isServerRunning } from '../index.js';

const args = parseArgs();
const { cfg, log } = cliContext();
if (cfg.masterKeyB64) die('YH_MASTER_KEY is set in the environment. Rotation manages the key FILE; unset YH_MASTER_KEY (or rotate your secret store manually).', 2);
const pid = isServerRunning(cfg);
if (pid) die(`The server is running (pid ${pid}). Stop it first.`);
if (!args.yes) {
  if (!process.stdin.isTTY) die('Refusing to rotate non-interactively without --yes.', 2);
  if ((await ask('Re-encrypt all PHI under a NEW master key? Make sure you have a fresh backup. [y/N] ')).toLowerCase() !== 'y') die('Aborted.', 0);
}

const { keyring } = loadKeyring(cfg, log, { allowGenerate: false });
const nextFile = `${cfg.masterKeyFile}.next`;
const oldSet = keyring.current;
const retiredDir = path.join(cfg.keysDir, 'retired');
const retiredFile = path.join(retiredDir, `${oldSet.keyId}.key`);
if (!fs.existsSync(retiredFile)) writeKeyFile(retiredFile, oldSet.master);

const newMaster = fs.existsSync(nextFile) ? readKeyFile(nextFile) : generateMasterKey();
if (!fs.existsSync(nextFile)) writeKeyFile(nextFile, newMaster);
const newId = deriveKeySet(newMaster).keyId;

const db = openDb(cfg.dbPath, { log });
try {
  migrate(db, { log });
  const { newRing, counts } = reencryptAll(db, keyring, newMaster);
  createAudit(db, newRing, log).append({ action: 'key.rotate', ip: 'local-cli', targetType: 'key', targetId: newId, detail: { from: oldSet.keyId, to: newId, counts } });
  db.checkpoint('TRUNCATE');
  db.close();
  fs.renameSync(nextFile, cfg.masterKeyFile);
  if (process.platform !== 'win32') fs.chmodSync(cfg.masterKeyFile, 0o600);
  console.log(`Key rotated: ${oldSet.keyId} -> ${newId}`);
  console.log(`Re-encrypted fields: ${JSON.stringify(counts)}`);
  console.log(`Old key retained (decrypt-only, for old backups) at ${retiredFile}. Back up the NEW ${cfg.masterKeyFile} offline now.`);
} catch (e) {
  try { db.close(); } catch { /* ignore */ }
  die(`Rotation FAILED; database unchanged (transaction rolled back): ${e.message}\nThe pending key remains at ${nextFile}; rerun to retry.`);
}
