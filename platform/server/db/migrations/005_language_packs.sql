-- 005: language packs (CONTRACT §9.2). Spanish baseline + mirrored translations embedded in the DB.
CREATE TABLE i18n_packs (
  locale        TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  native_name   TEXT NOT NULL,
  dir           TEXT NOT NULL DEFAULT 'ltr' CHECK (dir IN ('ltr','rtl')),
  role          TEXT NOT NULL CHECK (role IN ('baseline','mirror')),
  baseline      TEXT NOT NULL DEFAULT 'es',
  manifest_json TEXT NOT NULL,
  sha256        TEXT NOT NULL,
  loaded_at     TEXT NOT NULL
);

-- Baseline rows (locale 'es', status 'baseline') hold the catalog's Spanish text + hash (source of truth);
-- mirror rows hold the pack entry as shipped (text may be NULL for missing/stale).
CREATE TABLE i18n_strings (
  locale      TEXT NOT NULL,
  key         TEXT NOT NULL,
  text        TEXT,
  src_hash    TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('baseline','curated','machine','reviewed','missing','stale')),
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (locale, key)
);

-- Admin edits; survive catalog/pack reloads. Stale when src_hash no longer matches the baseline.
CREATE TABLE i18n_overrides (
  locale     TEXT NOT NULL,
  key        TEXT NOT NULL,
  text       TEXT NOT NULL,
  src_hash   TEXT NOT NULL,
  edited_by  TEXT REFERENCES users(id),
  edited_at  TEXT NOT NULL,
  PRIMARY KEY (locale, key)
);

CREATE TABLE i18n_ui (
  locale  TEXT PRIMARY KEY,
  json    TEXT NOT NULL,
  sha256  TEXT NOT NULL
);

-- Report language preference (a pack locale); NULL = clinic default.
ALTER TABLE patients ADD COLUMN preferred_language TEXT;
