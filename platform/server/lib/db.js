// Data-access layer over node:sqlite (ADR-002). All SQL is parameterized.
//
// Portability notes (for a future PostgreSQL adapter):
//  * Placeholders are positional `?` (pg adapter rewrites to $1..$n).
//  * Timestamps are ISO-8601 UTC TEXT; booleans are INTEGER 0/1; JSON is TEXT.
//  * SQLite-specific: PRAGMAs below, `INSERT OR IGNORE`, `VACUUM INTO` (backup),
//    triggers using RAISE(ABORT, ...), FTS5 virtual table `catalog_fts`, BEGIN IMMEDIATE.
//    Each is isolated here, in migrations, catalog/load.js or lib/backup.js.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { ensureDir } from './keys.js';

export const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');

const toParam = (v) => {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof Date) return v.toISOString();
  return v;
};
const normParams = (params) => params.map(toParam);

export class Db {
  constructor(file, { log, readOnly = false } = {}) {
    this.file = file;
    this.log = log;
    if (file !== ':memory:') ensureDir(path.dirname(file));
    this.raw = new DatabaseSync(file, { readOnly });
    this.cache = new Map();
    this.depth = 0;
    this.commitHooks = [];
    this.raw.exec('PRAGMA busy_timeout = 5000');
    if (!readOnly) {
      this.raw.exec('PRAGMA journal_mode = WAL');
      this.raw.exec('PRAGMA synchronous = FULL');
    }
    this.raw.exec('PRAGMA foreign_keys = ON');
    this.raw.exec('PRAGMA secure_delete = ON');
    this.raw.exec('PRAGMA trusted_schema = OFF');
    if (process.env.YH_DB_TUNE !== '0') {
      // measured on the catalog load + list queries (see tests/perf): larger page cache, in-memory temp B-trees,
      // memory-mapped reads. SQLite-specific; harmless for small DBs.
      this.raw.exec('PRAGMA cache_size = -32768');   // 32 MiB
      this.raw.exec('PRAGMA temp_store = MEMORY');
      this.raw.exec('PRAGMA mmap_size = 268435456'); // 256 MiB (address space only)
    }
    if (file !== ':memory:' && process.platform !== 'win32') {
      for (const f of [file, `${file}-wal`, `${file}-shm`]) { try { fs.chmodSync(f, 0o600); } catch { /* may not exist yet */ } }
    }
    const opts = this.raw.prepare('PRAGMA compile_options').all().map((r) => r.compile_options);
    this.hasFts5 = opts.includes('ENABLE_FTS5');
  }

  stmt(sql) {
    let s = this.cache.get(sql);
    if (!s) {
      s = this.raw.prepare(sql);
      if (this.cache.size > 500) this.cache.clear();
      this.cache.set(sql, s);
    }
    return s;
  }
  get(sql, ...params) { const r = this.stmt(sql).get(...normParams(params)); return r === undefined ? null : r; }
  all(sql, ...params) { return this.stmt(sql).all(...normParams(params)); }
  run(sql, ...params) { return this.stmt(sql).run(...normParams(params)); }
  exec(sql) { this.raw.exec(sql); }
  /** Iterate without materializing (large tables: rotate-key, audit verify). */
  *iterate(sql, ...params) { yield* this.raw.prepare(sql).iterate(...normParams(params)); }

  /** Run fn synchronously inside a transaction; nested calls use savepoints. */
  tx(fn) {
    if (this.depth === 0) {
      this.raw.exec('BEGIN IMMEDIATE');
      this.depth++;
      try {
        const r = fn(this);
        if (r && typeof r.then === 'function') throw new Error('db.tx callback must be synchronous');
        this.raw.exec('COMMIT');
        const hooks = this.commitHooks; this.commitHooks = [];
        this.depth--;
        for (const h of hooks) { try { h(); } catch (e) { this.log?.warn('after-commit hook failed', { err: e.message }); } }
        this.depth++;
        return r;
      } catch (e) {
        this.commitHooks = [];
        try { this.raw.exec('ROLLBACK'); } catch { /* already rolled back */ }
        throw e;
      } finally { this.depth--; }
    }
    const sp = `sp_${this.depth}`;
    this.raw.exec(`SAVEPOINT ${sp}`);
    this.depth++;
    try {
      const r = fn(this);
      this.raw.exec(`RELEASE ${sp}`);
      return r;
    } catch (e) {
      this.raw.exec(`ROLLBACK TO ${sp}`); this.raw.exec(`RELEASE ${sp}`);
      throw e;
    } finally { this.depth--; }
  }

  /** Run fn after the outermost transaction commits (immediately when not in a transaction); dropped on rollback. */
  afterCommit(fn) {
    if (this.depth === 0) fn(); else this.commitHooks.push(fn);
  }

  checkpoint(mode = 'PASSIVE') {
    if (!['PASSIVE', 'FULL', 'RESTART', 'TRUNCATE'].includes(mode)) throw new Error('bad checkpoint mode');
    try { return this.raw.prepare(`PRAGMA wal_checkpoint(${mode})`).get(); } catch (e) { this.log?.warn('wal checkpoint failed', { err: e }); return null; }
  }

  close() {
    this.cache.clear();
    try { this.raw.close(); } catch { /* ignore */ }
  }
}

export function openDb(file, opts) { return new Db(file, opts); }

// ---------------------------------------------------------------- migrations

export function listMigrations(dir = MIGRATIONS_DIR) {
  return fs.readdirSync(dir).filter((f) => /^\d{3,}_[a-z0-9_]+\.sql$/i.test(f)).sort()
    .map((f) => {
      const sql = fs.readFileSync(path.join(dir, f), 'utf8');
      return { version: f.split('_')[0], name: f, sql, checksum: crypto.createHash('sha256').update(sql).digest('hex') };
    });
}

export function migrate(db, { log, dir = MIGRATIONS_DIR } = {}) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)`);
  const applied = new Map(db.all('SELECT version, name, checksum FROM schema_migrations').map((r) => [r.version, r]));
  const ran = [];
  for (const m of listMigrations(dir)) {
    const prev = applied.get(m.version);
    if (prev) {
      if (prev.checksum !== m.checksum) log?.warn('applied migration file has changed since it ran (forward-only: add a new migration instead)', { migration: m.name });
      continue;
    }
    db.tx(() => {
      db.exec(m.sql);
      db.run('INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?,?,?,?)', m.version, m.name, m.checksum, new Date().toISOString());
    });
    log?.info('migration applied', { migration: m.name });
    ran.push(m.name);
  }
  ensureFts(db);
  return ran;
}

/** FTS5 index for catalog search (SQLite-specific; LIKE fallback over catalog_search when absent). */
export function ensureFts(db) {
  if (!db.hasFts5) return false;
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS catalog_fts USING fts5(
    kind UNINDEXED, ref_id UNINDEXED, body, tokenize = 'unicode61 remove_diacritics 2')`);
  return true;
}

export function schemaVersion(db) {
  return db.get('SELECT MAX(version) AS v FROM schema_migrations')?.v ?? null;
}
