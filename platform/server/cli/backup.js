// npm run backup [-- --out <file.yhbak>]      create an encrypted backup (safe while the server runs)
// npm run backup -- --verify <file.yhbak>     verify a backup's integrity (GCM tag) without restoring

import path from 'node:path';
import { cliContext, parseArgs, die } from './_common.js';
import { loadKeyring } from '../lib/keys.js';
import { openDb } from '../lib/db.js';
import { writeBackupFile, verifyBackup, backupFilename } from '../lib/backup.js';

const args = parseArgs();
const { cfg, log } = cliContext();
const { keyring } = loadKeyring(cfg, log, { allowGenerate: false });

if (args.verify) {
  try {
    const h = await verifyBackup(path.resolve(String(args.verify)), keyring);
    console.log(`OK: backup verified (created ${h.createdAt}, key ${h.keyId}, schema ${h.schema}).`);
  } catch (e) { die(`INVALID: ${e.message}`); }
} else {
  const out = path.resolve(String(args.out || path.join(cfg.backupsDir, backupFilename())));
  const db = openDb(cfg.dbPath, { log });
  try {
    const h = await writeBackupFile(db, keyring, out, { appVersion: cfg.version });
    console.log(`Backup written: ${out}\n  key id ${h.keyId} · schema ${h.schema} · ${h.bytes} bytes before compression`);
    console.log('Keep the master key (data/keys/master.key) stored separately — the backup cannot be restored without it.');
  } catch (e) { die(`Backup failed: ${e.message}`); } finally { db.close(); }
}
