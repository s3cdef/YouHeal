-- YOU HEAL Clinical — initial schema (forward-only).
-- Conventions: ids are TEXT (UUID v4 for tenant data, slugs for catalog); timestamps ISO-8601 UTC TEXT;
-- booleans INTEGER 0/1; JSON as TEXT. Columns suffixed _enc hold AES-256-GCM ciphertext
-- ("v1:<keyId>:<iv>:<tag>:<ct>", ADR-003); columns suffixed _bidx hold HMAC blind indexes.
-- SQLite-specific bits: triggers with RAISE(ABORT, ...), DEFERRABLE FKs syntax is shared with PostgreSQL.

-- ------------------------------------------------------------------ tenancy & identity
CREATE TABLE orgs (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  profile       TEXT NOT NULL DEFAULT '{}',      -- JSON clinic profile (non-PHI)
  next_mrn      INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE users (
  id                    TEXT PRIMARY KEY,
  org_id                TEXT NOT NULL REFERENCES orgs(id),
  email                 TEXT NOT NULL UNIQUE,     -- normalized lower-case; unique across tenants (login has no org selector)
  name                  TEXT NOT NULL,
  role                  TEXT NOT NULL CHECK (role IN ('admin','practitioner','assistant','auditor')),
  password_hash         TEXT NOT NULL,            -- scrypt$N=..,r=..,p=..$salt$hash
  password_changed_at   TEXT,
  must_change_password  INTEGER NOT NULL DEFAULT 0,
  mfa_enabled           INTEGER NOT NULL DEFAULT 0,
  mfa_secret_enc        TEXT,
  mfa_pending_enc       TEXT,
  mfa_last_step         INTEGER,
  recovery_codes        TEXT,                     -- JSON [{h: sha256-hmac, used: iso|null}]
  failed_attempts       INTEGER NOT NULL DEFAULT 0,
  last_failed_at        TEXT,
  locked_until          TEXT,
  active                INTEGER NOT NULL DEFAULT 1,
  locale                TEXT NOT NULL DEFAULT 'en',
  theme                 TEXT NOT NULL DEFAULT 'system',
  last_login_at         TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);
CREATE INDEX users_org ON users(org_id);

CREATE TABLE user_sessions (
  id            TEXT PRIMARY KEY,
  token_hash    TEXT NOT NULL UNIQUE,             -- SHA-256 of the 256-bit cookie token
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id        TEXT NOT NULL REFERENCES orgs(id),
  csrf          TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,
  expires_at    TEXT NOT NULL,                    -- absolute expiry
  ip            TEXT,
  ua            TEXT
);
CREATE INDEX user_sessions_user ON user_sessions(user_id);
CREATE INDEX user_sessions_expires ON user_sessions(expires_at);

-- ------------------------------------------------------------------ audit (append-only, hash-chained)
CREATE TABLE audit_log (
  id            INTEGER PRIMARY KEY,              -- assigned by the application (monotonic, gap-free)
  ts            TEXT NOT NULL,
  org_id        TEXT,
  actor_id      TEXT,
  actor_role    TEXT,
  action        TEXT NOT NULL,
  target_type   TEXT,
  target_id     TEXT,
  outcome       TEXT NOT NULL DEFAULT 'success',
  ip            TEXT,
  request_id    TEXT,
  detail        TEXT,                             -- JSON, never PHI values
  prev_hash     TEXT NOT NULL,
  hash          TEXT NOT NULL
);
CREATE INDEX audit_log_org_ts ON audit_log(org_id, id);
CREATE INDEX audit_log_actor ON audit_log(actor_id);
CREATE INDEX audit_log_action ON audit_log(action);

CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;

-- Keyed (HMAC with the audit subkey) pointer to the chain head: detects tail truncation.
CREATE TABLE audit_anchor (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  last_id     INTEGER NOT NULL,
  last_hash   TEXT NOT NULL,
  mac         TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- ------------------------------------------------------------------ patients & clinical records
CREATE TABLE patients (
  id                  TEXT PRIMARY KEY,
  org_id              TEXT NOT NULL REFERENCES orgs(id),
  mrn_enc             TEXT NOT NULL,
  mrn_bidx            TEXT NOT NULL,
  first_name_enc      TEXT NOT NULL,
  last_name_enc       TEXT NOT NULL,
  last_name_bidx      TEXT NOT NULL,
  last_initial_bidx   TEXT,
  dob_enc             TEXT,
  dob_bidx            TEXT,
  sex_enc             TEXT,
  phone_enc           TEXT,
  email_enc           TEXT,
  address_enc         TEXT,
  notes_enc           TEXT,
  archived            INTEGER NOT NULL DEFAULT 0,
  created_by          TEXT REFERENCES users(id),
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  UNIQUE (org_id, mrn_bidx)
);
CREATE INDEX patients_last ON patients(org_id, last_name_bidx);
CREATE INDEX patients_initial ON patients(org_id, last_initial_bidx);
CREATE INDEX patients_dob ON patients(org_id, dob_bidx);
CREATE INDEX patients_created ON patients(org_id, created_at);

CREATE TABLE consents (
  id                    TEXT PRIMARY KEY,
  org_id                TEXT NOT NULL REFERENCES orgs(id),
  patient_id            TEXT NOT NULL REFERENCES patients(id),
  type                  TEXT NOT NULL CHECK (type IN ('intake','treatment','telehealth','privacy')),
  answers_enc           TEXT,
  contraindications_enc TEXT,
  has_absolute          INTEGER NOT NULL DEFAULT 0,
  has_relative          INTEGER NOT NULL DEFAULT 0,
  signature_name_enc    TEXT NOT NULL,
  signed_at             TEXT NOT NULL,
  recorded_by           TEXT REFERENCES users(id),
  created_at            TEXT NOT NULL
);
CREATE INDEX consents_patient ON consents(org_id, patient_id);

CREATE TABLE scan_sessions (
  id                  TEXT PRIMARY KEY,
  org_id              TEXT NOT NULL REFERENCES orgs(id),
  patient_id          TEXT NOT NULL REFERENCES patients(id),
  practitioner_id     TEXT NOT NULL REFERENCES users(id),
  status              TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','final','amended')),
  revision            INTEGER NOT NULL DEFAULT 1,
  parent_id           TEXT REFERENCES scan_sessions(id),
  superseded_by       TEXT REFERENCES scan_sessions(id),
  methodology         TEXT NOT NULL CHECK (methodology IN ('biomagnetism','bioenergetics','telebioenergetics')),
  protocol_ids        TEXT NOT NULL DEFAULT '[]',   -- JSON [protocolId]
  chief_complaint_enc TEXT,
  symptoms            TEXT NOT NULL DEFAULT '[]',   -- JSON [symptomId] (catalog ids only)
  vitals_enc          TEXT,
  notes_enc           TEXT,
  amend_reason_enc    TEXT,
  session_date        TEXT NOT NULL,
  follow_up_date      TEXT,                         -- YYYY-MM-DD
  signature_name_enc  TEXT,
  finalized_by        TEXT REFERENCES users(id),
  finalized_at        TEXT,
  report_sha256       TEXT,
  report_snapshot     TEXT,                         -- encrypted canonical JSON of the finalized report
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE INDEX scan_sessions_patient ON scan_sessions(org_id, patient_id, session_date);
CREATE INDEX scan_sessions_parent ON scan_sessions(parent_id);

-- Finalized sessions are immutable: only ciphertext re-encryption (key rotation) and the
-- superseded_by pointer may change.
CREATE TRIGGER scan_sessions_lock BEFORE UPDATE OF
  status, revision, parent_id, patient_id, practitioner_id, methodology, protocol_ids, symptoms,
  session_date, follow_up_date, finalized_by, finalized_at, report_sha256
ON scan_sessions WHEN OLD.status <> 'draft'
BEGIN SELECT RAISE(ABORT, 'session is finalized and immutable'); END;
CREATE TRIGGER scan_sessions_no_delete BEFORE DELETE ON scan_sessions WHEN OLD.status <> 'draft'
BEGIN SELECT RAISE(ABORT, 'session is finalized and immutable'); END;

CREATE TABLE findings (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL REFERENCES orgs(id),
  session_id      TEXT NOT NULL REFERENCES scan_sessions(id),
  seq             INTEGER NOT NULL,
  pair_id         TEXT,                             -- catalog id (no FK: catalog is versioned independently)
  tracking_point  TEXT NOT NULL,
  tracking_side   TEXT NOT NULL CHECK (tracking_side IN ('R','L','C','RL')),
  impact_point    TEXT NOT NULL,
  impact_side     TEXT NOT NULL CHECK (impact_side IN ('R','L','C','RL')),
  qualifiers      TEXT NOT NULL DEFAULT '{"tracking":[],"impact":[]}',
  phenomena       TEXT NOT NULL DEFAULT '[]',
  dwell_minutes   REAL,
  status          TEXT NOT NULL CHECK (status IN ('found','impacted','cleared')),
  notes_enc       TEXT,
  created_by      TEXT REFERENCES users(id),
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX findings_session ON findings(session_id, seq);

CREATE TRIGGER findings_lock_insert BEFORE INSERT ON findings
WHEN (SELECT status FROM scan_sessions WHERE id = NEW.session_id) <> 'draft'
BEGIN SELECT RAISE(ABORT, 'session is finalized and immutable'); END;
CREATE TRIGGER findings_lock_update BEFORE UPDATE OF
  session_id, seq, pair_id, tracking_point, tracking_side, impact_point, impact_side, qualifiers,
  phenomena, dwell_minutes, status
ON findings WHEN (SELECT status FROM scan_sessions WHERE id = OLD.session_id) <> 'draft'
BEGIN SELECT RAISE(ABORT, 'session is finalized and immutable'); END;
CREATE TRIGGER findings_lock_delete BEFORE DELETE ON findings
WHEN (SELECT status FROM scan_sessions WHERE id = OLD.session_id) <> 'draft'
BEGIN SELECT RAISE(ABORT, 'session is finalized and immutable'); END;

CREATE TABLE report_images (
  session_id  TEXT NOT NULL REFERENCES scan_sessions(id),
  view        TEXT NOT NULL CHECK (view IN ('front','back')),
  org_id      TEXT NOT NULL REFERENCES orgs(id),
  mime        TEXT NOT NULL,
  data_enc    TEXT NOT NULL,                        -- encrypted data: URL
  sha256      TEXT NOT NULL,
  bytes       INTEGER NOT NULL,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (session_id, view)
);
CREATE TRIGGER report_images_lock_insert BEFORE INSERT ON report_images
WHEN (SELECT status FROM scan_sessions WHERE id = NEW.session_id) <> 'draft'
BEGIN SELECT RAISE(ABORT, 'session is finalized and immutable'); END;
CREATE TRIGGER report_images_lock_update BEFORE UPDATE OF session_id, view, mime, sha256, bytes ON report_images
WHEN (SELECT status FROM scan_sessions WHERE id = OLD.session_id) <> 'draft'
BEGIN SELECT RAISE(ABORT, 'session is finalized and immutable'); END;
CREATE TRIGGER report_images_lock_delete BEFORE DELETE ON report_images
WHEN (SELECT status FROM scan_sessions WHERE id = OLD.session_id) <> 'draft'
BEGIN SELECT RAISE(ABORT, 'session is finalized and immutable'); END;

-- ------------------------------------------------------------------ catalog (org_id NULL = global)
-- Catalog ids are globally unique slugs; org-custom records (future) use an org-scoped id prefix.
CREATE TABLE catalog_sources (
  id              TEXT PRIMARY KEY,
  org_id          TEXT REFERENCES orgs(id),
  title           TEXT NOT NULL,
  author          TEXT,
  license_status  TEXT NOT NULL CHECK (license_status IN ('internal-use','licensed','public-domain','original')),
  notice          TEXT,
  data            TEXT NOT NULL
);

CREATE TABLE regions (
  id        TEXT PRIMARY KEY,
  org_id    TEXT REFERENCES orgs(id),
  name      TEXT NOT NULL,                          -- JSON {es,en}
  parent    TEXT,
  sort      INTEGER NOT NULL DEFAULT 0,
  data      TEXT NOT NULL
);

CREATE TABLE points (
  id          TEXT PRIMARY KEY,
  org_id      TEXT REFERENCES orgs(id),
  name        TEXT NOT NULL,
  name_norm   TEXT NOT NULL,
  aliases     TEXT NOT NULL DEFAULT '[]',
  laterality  TEXT NOT NULL CHECK (laterality IN ('central','bilateral')),
  region      TEXT,
  view        TEXT,
  pos_x       REAL, pos_y REAL, pos_z REAL,
  source      TEXT,
  sort        INTEGER NOT NULL DEFAULT 0,
  data        TEXT NOT NULL
);

CREATE TABLE pairs (
  id                  TEXT PRIMARY KEY,
  org_id              TEXT REFERENCES orgs(id),
  number              INTEGER,
  level               INTEGER NOT NULL DEFAULT 0,
  name                TEXT NOT NULL,
  name_norm           TEXT NOT NULL,
  tracking_point      TEXT NOT NULL REFERENCES points(id) DEFERRABLE INITIALLY DEFERRED,
  tracking_side       TEXT NOT NULL,
  tracking_qualifiers TEXT NOT NULL DEFAULT '[]',
  impact_point        TEXT NOT NULL REFERENCES points(id) DEFERRABLE INITIALLY DEFERRED,
  impact_side         TEXT NOT NULL,
  impact_qualifiers   TEXT NOT NULL DEFAULT '[]',
  category            TEXT,
  rating_f            INTEGER, rating_p INTEGER, rating_r INTEGER,
  source_doc          TEXT,
  sort                INTEGER NOT NULL DEFAULT 0,
  data                TEXT NOT NULL                  -- full JSON record as loaded
);
CREATE INDEX pairs_tracking ON pairs(tracking_point);
CREATE INDEX pairs_impact ON pairs(impact_point);
CREATE INDEX pairs_category ON pairs(category, level);

CREATE TABLE entities (
  id              TEXT PRIMARY KEY,
  org_id          TEXT REFERENCES orgs(id),
  name            TEXT NOT NULL,
  name_norm       TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('pathogen','condition','named-pair')),
  classification  TEXT,
  source_doc      TEXT,
  data            TEXT NOT NULL
);

CREATE TABLE pair_relations (
  pair_id    TEXT NOT NULL REFERENCES pairs(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  entity_id  TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  ordinal    INTEGER,
  sort       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (pair_id, entity_id)
);
CREATE INDEX pair_relations_entity ON pair_relations(entity_id);

CREATE TABLE pair_symptoms (
  id         INTEGER PRIMARY KEY,
  pair_id    TEXT NOT NULL REFERENCES pairs(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  system     TEXT,
  text       TEXT NOT NULL,                           -- JSON {es,en}
  text_norm  TEXT NOT NULL,
  sort       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX pair_symptoms_pair ON pair_symptoms(pair_id);
CREATE INDEX pair_symptoms_system ON pair_symptoms(system);

CREATE TABLE entity_pole_pairs (
  entity_id  TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  sort       INTEGER NOT NULL,
  neg_point  TEXT NOT NULL,
  pos_point  TEXT NOT NULL,
  pair_id    TEXT REFERENCES pairs(id) DEFERRABLE INITIALLY DEFERRED,
  PRIMARY KEY (entity_id, sort)
);
CREATE INDEX entity_pole_pairs_pair ON entity_pole_pairs(pair_id);

CREATE TABLE protocols (
  id          TEXT PRIMARY KEY,
  org_id      TEXT REFERENCES orgs(id),
  kind        TEXT NOT NULL CHECK (kind IN ('basic','top10','top5','disease','application')),
  name        TEXT NOT NULL,
  name_norm   TEXT NOT NULL,
  source_doc  TEXT,
  sort        INTEGER NOT NULL DEFAULT 0,
  data        TEXT NOT NULL
);

CREATE TABLE protocol_items (
  protocol_id        TEXT NOT NULL REFERENCES protocols(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  seq                INTEGER NOT NULL,
  pair_id            TEXT REFERENCES pairs(id) DEFERRABLE INITIALLY DEFERRED,
  child_protocol_id  TEXT REFERENCES protocols(id) DEFERRABLE INITIALLY DEFERRED,
  data               TEXT NOT NULL,
  PRIMARY KEY (protocol_id, seq),
  CHECK ((pair_id IS NULL) <> (child_protocol_id IS NULL))
);
CREATE INDEX protocol_items_pair ON protocol_items(pair_id);
CREATE INDEX protocol_items_child ON protocol_items(child_protocol_id);

CREATE TABLE symptoms (
  id         TEXT PRIMARY KEY,
  org_id     TEXT REFERENCES orgs(id),
  system     TEXT,
  name       TEXT NOT NULL,
  name_norm  TEXT NOT NULL,
  data       TEXT NOT NULL
);
CREATE INDEX symptoms_system ON symptoms(system);

CREATE TABLE symptom_pairs (
  symptom_id TEXT NOT NULL REFERENCES symptoms(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  pair_id    TEXT NOT NULL REFERENCES pairs(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  PRIMARY KEY (symptom_id, pair_id)
);
CREATE INDEX symptom_pairs_pair ON symptom_pairs(pair_id);

CREATE TABLE contraindications (
  id      TEXT PRIMARY KEY,
  org_id  TEXT REFERENCES orgs(id),
  kind    TEXT NOT NULL CHECK (kind IN ('absolute','relative')),
  sort    INTEGER NOT NULL DEFAULT 0,
  data    TEXT NOT NULL
);

CREATE TABLE recommendations (
  id      TEXT PRIMARY KEY,
  org_id  TEXT REFERENCES orgs(id),
  sort    INTEGER NOT NULL DEFAULT 0,
  data    TEXT NOT NULL
);

CREATE TABLE glossary (
  id      INTEGER PRIMARY KEY,
  org_id  TEXT REFERENCES orgs(id),
  abbr    TEXT NOT NULL,
  data    TEXT NOT NULL
);

CREATE TABLE catalog_meta (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);

-- Normalized (accent-stripped, lower-case) search text; LIKE fallback when FTS5 is unavailable.
CREATE TABLE catalog_search (
  kind    TEXT NOT NULL,
  ref_id  TEXT NOT NULL,
  body    TEXT NOT NULL,
  PRIMARY KEY (kind, ref_id)
);
