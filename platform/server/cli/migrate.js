// npm run migrate — apply pending forward-only migrations.
import { cliContext } from './_common.js';
import { openDb, migrate, schemaVersion } from '../lib/db.js';
import { ensureDir } from '../lib/keys.js';
import path from 'node:path';

const { cfg, log } = cliContext();
ensureDir(path.dirname(cfg.dbPath));
const db = openDb(cfg.dbPath, { log });
try {
  const ran = migrate(db, { log });
  console.log(ran.length ? `Applied ${ran.length} migration(s): ${ran.join(', ')}` : 'Database is up to date.');
  console.log(`Schema version: ${schemaVersion(db)}  (FTS5: ${db.hasFts5 ? 'yes' : 'no — LIKE fallback'})`);
} catch (e) {
  console.error(`Migration failed: ${e.message}`);
  process.exitCode = 1;
} finally { db.close(); }
