-- 003: security hardening (assessment round 3).
--  F-02/F-10  recovery codes move to their own table; each code is consumed with a guarded UPDATE
--             (used_at IS NULL, exactly one row). code_hash = HMAC(recovery subkey of key_id, code);
--             key_id NULL marks legacy rows (plain domain-separated SHA-256) migrated from users.recovery_codes.
--  F-19       shadow lockout counters for unknown accounts are persisted (keyed by a hash of the email).
--  F-06       a trigger forbids removing the last active admin of an org (defense in depth).
-- SQLite-specific: json_each() for the data migration; RAISE(ABORT) triggers.

CREATE TABLE user_recovery_codes (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash  TEXT NOT NULL,
  key_id     TEXT,
  used_at    TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, code_hash)
);

INSERT OR IGNORE INTO user_recovery_codes (user_id, code_hash, key_id, used_at, created_at)
  SELECT u.id, json_extract(j.value, '$.h'), NULL, json_extract(j.value, '$.used'), u.updated_at
  FROM users u, json_each(u.recovery_codes) j
  WHERE u.recovery_codes IS NOT NULL AND json_valid(u.recovery_codes);
UPDATE users SET recovery_codes = NULL WHERE recovery_codes IS NOT NULL;

CREATE TABLE auth_ghost_lockouts (
  key_hash        TEXT PRIMARY KEY,
  attempts        INTEGER NOT NULL,
  last_failed_at  TEXT NOT NULL,
  locked_until    TEXT
);
CREATE INDEX auth_ghost_lockouts_last ON auth_ghost_lockouts(last_failed_at);

CREATE TRIGGER users_keep_last_admin BEFORE UPDATE OF role, active ON users
WHEN OLD.role = 'admin' AND OLD.active = 1 AND (NEW.role <> 'admin' OR NEW.active = 0)
  AND (SELECT COUNT(*) FROM users WHERE org_id = OLD.org_id AND role = 'admin' AND active = 1 AND id <> OLD.id) = 0
BEGIN SELECT RAISE(ABORT, 'last active admin of the organization'); END;
