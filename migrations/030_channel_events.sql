ALTER TABLE federation_follows ADD COLUMN stream_start INTEGER;
ALTER TABLE federation_follows ADD COLUMN stream_capable INTEGER NOT NULL DEFAULT 0;
ALTER TABLE federation_subscriptions ADD COLUMN stream_start INTEGER;
CREATE TABLE federation_channel_state (
  channel_id TEXT PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
  tail INTEGER NOT NULL DEFAULT 0, floor INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE federation_channel_events (
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL, activity_id TEXT NOT NULL REFERENCES federation_outgoing(id),
  created_at INTEGER NOT NULL, PRIMARY KEY(channel_id,seq)
);
CREATE INDEX federation_channel_events_age ON federation_channel_events(created_at);
CREATE TABLE federation_channel_cursors (
  channel_id TEXT PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
  cursor INTEGER NOT NULL, error TEXT, retry_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE federation_channel_peers (
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  origin TEXT NOT NULL, cursor INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY(channel_id,origin)
);
PRAGMA user_version=30;
