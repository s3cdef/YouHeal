import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { openDb, migrate, schemaVersion, listMigrations } from '../../server/lib/db.js';
import { tmpDir } from './helpers.js';

test('migrations apply on a fresh temp dir, are idempotent and create expected tables', () => {
  const dir = tmpDir();
  const db = openDb(path.join(dir, 'db', 'test.sqlite'));
  const ran = migrate(db);
  assert.deepEqual(ran, listMigrations().map((m) => m.name));
  assert.deepEqual(migrate(db), [], 'second run applies nothing');
  assert.equal(schemaVersion(db), listMigrations().at(-1).version);
  const tables = new Set(db.all("SELECT name FROM sqlite_master WHERE type IN ('table')").map((r) => r.name));
  for (const t of ['orgs', 'users', 'user_sessions', 'audit_log', 'patients', 'consents', 'scan_sessions', 'findings', 'report_images',
    'catalog_sources', 'points', 'regions', 'pairs', 'pair_relations', 'pair_symptoms', 'entities', 'entity_pole_pairs', 'protocols',
    'protocol_items', 'symptoms', 'contraindications', 'recommendations', 'glossary', 'catalog_meta', 'schema_migrations']) {
    assert.ok(tables.has(t), `missing table ${t}`);
  }
  assert.ok(db.all('PRAGMA table_info(scan_sessions)').some((c) => c.name === 'scan_state_enc'), '002 adds scan_state_enc');
  assert.ok(db.all('PRAGMA table_info(orgs)').some((c) => c.name === 'logo'), '002 adds orgs.logo');
  assert.equal(db.get('PRAGMA journal_mode').journal_mode, 'wal');
  assert.equal(db.get('PRAGMA foreign_keys').foreign_keys, 1);
  assert.equal(db.get('PRAGMA secure_delete').secure_delete, 1);
  if (db.hasFts5) assert.ok(tables.has('catalog_fts'));
  db.close();
});

test('audit_log triggers forbid UPDATE and DELETE', () => {
  const db = openDb(path.join(tmpDir(), 'a.sqlite'));
  migrate(db);
  db.run("INSERT INTO audit_log (id, ts, action, prev_hash, hash) VALUES (1, 'x', 'test', 'p', 'h')");
  assert.throws(() => db.run("UPDATE audit_log SET action = 'evil' WHERE id = 1"), /append-only/);
  assert.throws(() => db.run('DELETE FROM audit_log WHERE id = 1'), /append-only/);
  db.close();
});

test('transaction helper rolls back and supports nesting', () => {
  const db = openDb(path.join(tmpDir(), 't.sqlite'));
  migrate(db);
  const ts = new Date().toISOString();
  assert.throws(() => db.tx(() => {
    db.run('INSERT INTO orgs (id, name, created_at, updated_at) VALUES (?,?,?,?)', 'o1', 'A', ts, ts);
    throw new Error('boom');
  }), /boom/);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM orgs').n, 0);
  db.tx(() => {
    db.run('INSERT INTO orgs (id, name, created_at, updated_at) VALUES (?,?,?,?)', 'o1', 'A', ts, ts);
    try { db.tx(() => { db.run('INSERT INTO orgs (id, name, created_at, updated_at) VALUES (?,?,?,?)', 'o2', 'B', ts, ts); throw new Error('inner'); }); } catch { /* inner rolled back */ }
  });
  assert.deepEqual(db.all('SELECT id FROM orgs').map((r) => r.id), ['o1']);
  assert.throws(() => db.tx(async () => {}), /synchronous/);
  db.close();
});
