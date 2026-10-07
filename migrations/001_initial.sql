CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  admin INTEGER NOT NULL DEFAULT 0,
  banned INTEGER NOT NULL DEFAULT 0,
  verified_socials TEXT NOT NULL DEFAULT '[]',
  share_socials INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE oidc_bindings (
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  PRIMARY KEY (issuer, subject)
);
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  csrf TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE auth_flows (
  state_hash TEXT PRIMARY KEY,
  browser_hash TEXT NOT NULL,
  verifier TEXT NOT NULL,
  nonce TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE channels (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  description TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('timeline','topical','threaded')),
  visibility TEXT NOT NULL CHECK(visibility IN ('public','members')),
  admission TEXT NOT NULL CHECK(admission IN ('open','allowlist')),
  owner_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE TABLE memberships (
  channel_id TEXT NOT NULL REFERENCES channels(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK(role IN ('owner','moderator','member')),
  PRIMARY KEY(channel_id,user_id)
);
CREATE TABLE channel_rules (
  channel_id TEXT NOT NULL REFERENCES channels(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  rule TEXT NOT NULL CHECK(rule IN ('allow','block')),
  PRIMARY KEY(channel_id,user_id)
);
CREATE TABLE topics (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES channels(id),
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(channel_id,title)
);
CREATE TABLE messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  channel_id TEXT NOT NULL REFERENCES channels(id),
  author_id TEXT NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  title TEXT,
  topic_id TEXT REFERENCES topics(id),
  parent_id TEXT REFERENCES messages(id),
  created_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX messages_channel_seq ON messages(channel_id,seq);
CREATE INDEX sessions_expiry ON sessions(expires_at);
CREATE TABLE audit (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id TEXT NOT NULL REFERENCES users(id),
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  created_at TEXT NOT NULL
);
PRAGMA user_version=1;
