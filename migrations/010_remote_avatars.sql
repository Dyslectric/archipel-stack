CREATE TABLE remote_avatars (
  id TEXT PRIMARY KEY,
  peer TEXT NOT NULL UNIQUE,
  revision TEXT NOT NULL,
  mime TEXT NOT NULL,
  image BLOB NOT NULL,
  source TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);
CREATE TABLE xmpp_avatar_requests (
  peer TEXT PRIMARY KEY,
  requester_id TEXT NOT NULL REFERENCES users(id),
  requested_at INTEGER NOT NULL,
  last_attempt INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE xmpp_events_with_profiles (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK(kind IN ('Create','Update','Delete','Direct','Profile')),
  object_id TEXT NOT NULL,
  sender_id TEXT REFERENCES users(id),
  recipient TEXT
);
INSERT INTO xmpp_events_with_profiles SELECT * FROM xmpp_events;
DROP TABLE xmpp_events;
ALTER TABLE xmpp_events_with_profiles RENAME TO xmpp_events;
PRAGMA user_version=10;
