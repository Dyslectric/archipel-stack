ALTER TABLE users ADD COLUMN admission_status TEXT NOT NULL DEFAULT 'approved' CHECK(admission_status IN ('pending','approved','rejected'));
ALTER TABLE users ADD COLUMN reviewed_at TEXT;
ALTER TABLE messages ADD COLUMN edited_at TEXT;
CREATE TABLE instance_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE custom_emojis (
  name TEXT PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  mime TEXT NOT NULL,
  image BLOB NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE INDEX users_admission ON users(admission_status,created_at);
PRAGMA user_version=2;
