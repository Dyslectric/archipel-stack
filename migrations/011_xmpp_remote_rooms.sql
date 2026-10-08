-- External rooms are private subscriptions, never local channel replicas.
CREATE TABLE xmpp_remote_rooms (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  room TEXT NOT NULL,
  nick TEXT NOT NULL,
  session TEXT NOT NULL UNIQUE,
  desired INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL DEFAULT 'joining',
  role TEXT NOT NULL DEFAULT 'none',
  subject TEXT NOT NULL DEFAULT '',
  error TEXT,
  updated_at INTEGER NOT NULL,
  UNIQUE(user_id,room)
);
CREATE TABLE xmpp_remote_messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  subscription_id TEXT NOT NULL REFERENCES xmpp_remote_rooms(id),
  sender TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  source_key TEXT,
  status TEXT NOT NULL DEFAULT 'received',
  error TEXT,
  UNIQUE(subscription_id,source_key)
);
CREATE INDEX xmpp_remote_history ON xmpp_remote_messages(subscription_id,seq);
PRAGMA user_version=11;
