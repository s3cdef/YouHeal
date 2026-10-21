-- 002: integration round 2 (additive).
--  * scan_sessions.scan_state_enc — encrypted scan workspace state (checklist marks, cursor, active protocols, free text)
--  * orgs.logo                    — clinic logo data: URL (PNG/JPEG/WebP, <= 200 KB; non-PHI)
--  * index for the cross-patient session list (dashboard)
ALTER TABLE scan_sessions ADD COLUMN scan_state_enc TEXT;
ALTER TABLE orgs ADD COLUMN logo TEXT;
CREATE INDEX scan_sessions_org_date ON scan_sessions(org_id, session_date);
CREATE INDEX scan_sessions_org_followup ON scan_sessions(org_id, follow_up_date);
