CREATE TABLE origins (
  origin TEXT PRIMARY KEY,                  -- canonical: new URL(x).origin, lowercase host
  instance_name TEXT NOT NULL,
  federated_registration_open INTEGER NOT NULL,
  version TEXT,
  document_hash TEXT NOT NULL,              -- SHA-256 of the validated, canonicalised document
  first_seen_at INTEGER NOT NULL,
  last_ok_at INTEGER NOT NULL
);
CREATE TABLE fetch_attempts (
  origin TEXT PRIMARY KEY,                  -- every origin ever pinged, valid or not
  last_fetch_at INTEGER NOT NULL
);
CREATE TABLE spaces (
  origin TEXT NOT NULL REFERENCES origins(origin) ON DELETE CASCADE,
  id TEXT NOT NULL,
  row_hash TEXT NOT NULL,                   -- SHA-256 of this space's fields
  name TEXT NOT NULL, description TEXT, icon TEXT, banner TEXT, avatar_color TEXT,
  visibility TEXT NOT NULL, member_count INTEGER NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY (origin, id)
);
CREATE TABLE blocks (
  origin TEXT NOT NULL,
  space_id TEXT NOT NULL DEFAULT '*',       -- '*' blocks the whole origin; NULL would not be unique in SQLite
  reason TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY (origin, space_id)
);
CREATE INDEX spaces_members ON spaces(member_count DESC, created_at DESC);
