-- 006: performance pass.
--  * session list orderings served straight from an index (no temp B-tree, LIMIT stops early)
--  * MAC'd "verified through" checkpoint so /audit/verify walks only rows appended since the last check
DROP INDEX IF EXISTS scan_sessions_org_followup;
DROP INDEX IF EXISTS scan_sessions_org_date;
CREATE INDEX scan_sessions_org_followup_order ON scan_sessions(org_id, follow_up_date, session_date DESC);
CREATE INDEX scan_sessions_org_date_rev ON scan_sessions(org_id, session_date DESC, revision DESC);
ALTER TABLE audit_anchor ADD COLUMN verified_id INTEGER;
ALTER TABLE audit_anchor ADD COLUMN verified_hash TEXT;
ALTER TABLE audit_anchor ADD COLUMN verified_mac TEXT;
ALTER TABLE audit_anchor ADD COLUMN verified_at TEXT;
