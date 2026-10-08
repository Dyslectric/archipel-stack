-- The occupant's own address, when the room discloses it; nicknames alone can be reused.
ALTER TABLE xmpp_remote_messages ADD COLUMN sender_jid TEXT;
-- A local timeline channel and one room on another XMPP server carrying the same conversation.
CREATE TABLE channel_bridges (
  channel_id TEXT PRIMARY KEY REFERENCES channels(id),
  room TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);
-- Every bridged occupant hears the same room message; it enters the channel once.
CREATE TABLE channel_bridge_seen (
  channel_id TEXT NOT NULL REFERENCES channels(id),
  source_key TEXT NOT NULL,
  PRIMARY KEY(channel_id, source_key)
);
-- Occupants that exist only to speak for a member of a bridged channel stay out of their room list.
ALTER TABLE xmpp_remote_rooms ADD COLUMN bridged INTEGER NOT NULL DEFAULT 0;
-- The channel message a queued room message repeats; its echo must not come back into the channel.
ALTER TABLE xmpp_remote_messages ADD COLUMN relay_of TEXT;
-- A local channel its owner fills from channels and rooms hosted elsewhere; read-only until opened.
CREATE TABLE channel_mirrors (
  channel_id TEXT PRIMARY KEY REFERENCES channels(id),
  writable INTEGER NOT NULL DEFAULT 0
);
-- What a mirror copies: a followed remote channel's local replica, or one of the owner's room subscriptions.
CREATE TABLE mirror_sources (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES channels(id),
  kind TEXT NOT NULL CHECK(kind IN ('channel','xmpp')),
  source TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  cursor INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE(channel_id,kind,source)
);
PRAGMA user_version=12;
