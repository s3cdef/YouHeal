// npm run restore -- <file.yhbak> [--yes]
// Verifies the backup's GCM tag + SQLite integrity BEFORE replacing the database. The server must be stopped.

import path from 'node:path';
import fs from 'node:fs';
import { cliContext, parseArgs, ask, die } from './_common.js';
import { loadKeyring } from '../lib/keys.js';
import { restoreBackup, readBackupHeader } from '../lib/backup.js';
import { isServerRunning } from '../index.js';

const args = parseArgs();
const file = args._[0] || args.file;
if (!file) die('Usage: npm run restore -- <backup.yhbak> [--yes]', 2);
const { cfg, log } = cliContext();
const abs = path.resolve(String(file));
if (!fs.existsSync(abs)) die(`No such file: ${abs}`);
const pid = isServerRunning(cfg);
if (pid) die(`The server is running (pid ${pid}). Stop it before restoring.`);
const { keyring } = loadKeyring(cfg, log, { allowGenerate: false });

let header;
try { ({ header } = readBackupHeader(abs)); } catch (e) { die(`Not a valid backup: ${e.message}`); }
console.log(`Backup created ${header.createdAt} (app ${header.app}, schema ${header.schema}, key ${header.keyId}).`);
if (!args.yes) {
  if (!process.stdin.isTTY) die('Refusing to restore non-interactively without --yes.', 2);
  const a = (await ask(`This REPLACES ${cfg.dbPath}. The current database is kept as a .pre-restore copy. Continue? [y/N] `)).toLowerCase();
  if (a !== 'y') die('Aborted.', 0);
}
try {
  const r = await restoreBackup(abs, keyring, cfg.dbPath, { log, anchorFile: cfg.auditAnchorFile });
  console.log(`Restore complete (backup sha256 ${r.sourceSha256.slice(0, 16)}…, recorded in the audit log).${r.previous ? ` Previous database saved as ${r.previous}` : ''}`);
} catch (e) { die(`Restore FAILED (database untouched): ${e.message}`); }
