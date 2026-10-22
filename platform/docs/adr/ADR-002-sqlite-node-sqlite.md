# ADR-002 — SQLite via `node:sqlite`, `org_id` on every tenant table, single data-access layer

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10 |
| **Controls** | AC-4, SC-4, SC-28, SI-10, CP-9, CP-10, AU-9 |

## Context

On-prem deployments are one clinic on one host, typically 1–20 concurrent users, often no DBA and no
separate database server. The SaaS future needs strict tenant isolation and horizontal scale.

## Decision

* Persistence is **SQLite through the built-in `node:sqlite`** module, file `data/db/youheal.sqlite`
  (`YH_DB_PATH`). PRAGMAs: `journal_mode=WAL` (concurrent readers, crash safety), `foreign_keys=ON`,
  `secure_delete=ON` (deleted content is overwritten, reducing forensic remanence of PHI in free pages).
* **Every tenant-owned table carries `org_id`** from day one, even though on-prem has one organisation.
* **All SQL is parameterized**; no string-built SQL with user input (SI-10).
* All data access goes through **`server/lib/db.js`**; SQLite-specific features (`INSERT OR IGNORE`,
  `VACUUM INTO`, FTS5) are isolated there, in migrations, the catalog loader and `lib/backup.js`, so a
  PostgreSQL adapter can be added without touching routes.
* Migrations are **forward-only** numbered SQL files (`server/db/migrations/NNN_*.sql`).
* Backups use `VACUUM INTO` for a transactionally consistent snapshot while the server runs, then
  gzip + AES-256-GCM (ADR-003); restore verifies the GCM tag and SQLite integrity before replacing the DB.
* The audit table is append-only, enforced by triggers that reject `UPDATE`/`DELETE` (AU-9).

## Consequences

**Positive**: zero-admin database; one file to back up; consistent online backups; tenant model ready
for SaaS (row-level security can key on `org_id`); no network listener for the DB (SC-7 surface reduced).

**Negative**: single-writer — fine for clinic scale, not for SaaS scale (hence the PostgreSQL path);
forward-only migrations mean **rollback of an upgrade requires restoring the pre-upgrade DB snapshot**
(the upgrade scripts take one automatically); `node:sqlite` is experimental in Node 22 (ADR-001).

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| PostgreSQL on-prem | Requires installing, patching and backing up a second service at every clinic; overkill for one site. Kept as the SaaS target. |
| better-sqlite3 / sqlite3 npm | Native add-ons (ADR-001). |
| Embedded document store / JSON files | No transactions/constraints; weak integrity guarantees for clinical records. |
| SQLCipher (whole-file encryption) | Native dependency; field-level encryption (ADR-003) plus host FDE gives finer-grained protection and survives SaaS migration. |
