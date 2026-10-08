-- Explicit immutable account bindings; handles and OIDC claims never link JIDs.
CREATE TABLE xmpp_accounts (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  node TEXT NOT NULL UNIQUE
);
CREATE TABLE xmpp_credentials (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  label TEXT NOT NULL,
  digest TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX xmpp_credentials_user ON xmpp_credentials(user_id);
-- References only: the application archive remains the single source of content.
CREATE TABLE xmpp_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK(kind IN ('Create','Update','Delete','Direct')),
  object_id TEXT NOT NULL,
  sender_id TEXT REFERENCES users(id),
  recipient TEXT
);
CREATE TABLE xmpp_incoming (
  sender TEXT NOT NULL, stanza_id TEXT NOT NULL, digest TEXT NOT NULL,
  result TEXT NOT NULL, PRIMARY KEY(sender,stanza_id)
);
CREATE TABLE xmpp_message_ids (
  message_id TEXT PRIMARY KEY REFERENCES messages(id),
  sender TEXT NOT NULL, stanza_id TEXT NOT NULL, origin_id TEXT,
  UNIQUE(sender,stanza_id)
);
CREATE INDEX xmpp_incoming_result ON xmpp_incoming(sender,stanza_id);
ALTER TABLE direct_messages ADD COLUMN xmpp_source_id TEXT;
CREATE INDEX direct_messages_xmpp_source ON direct_messages(user_id,xmpp_source_id);
CREATE TABLE xmpp_direct_ids (
  source_id TEXT PRIMARY KEY, stanza_id TEXT NOT NULL, origin_id TEXT
);
PRAGMA user_version=7;
