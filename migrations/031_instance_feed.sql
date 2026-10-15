CREATE INDEX federation_legacy_followers ON federation_follows(channel_id,actor)
  WHERE status='accepted' AND (stream_capable=0 OR stream_start IS NULL);
CREATE TABLE federation_instance_state (id INTEGER PRIMARY KEY, tail INTEGER NOT NULL DEFAULT 0, floor INTEGER NOT NULL DEFAULT 0);
INSERT INTO federation_instance_state(id) VALUES(1);
CREATE TABLE federation_instance_events (
  seq INTEGER PRIMARY KEY, channel_id TEXT NOT NULL,
  channel_seq INTEGER NOT NULL, activity_id TEXT NOT NULL REFERENCES federation_outgoing(id),
  created_at INTEGER NOT NULL, public INTEGER NOT NULL DEFAULT 0, epoch INTEGER NOT NULL DEFAULT 1, frame TEXT,
  UNIQUE(channel_id,channel_seq)
);
CREATE INDEX federation_instance_events_age ON federation_instance_events(created_at);
CREATE TABLE federation_channel_epochs (channel_id TEXT PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE, epoch INTEGER NOT NULL DEFAULT 1);
CREATE TABLE federation_channel_keys (
  channel_id TEXT NOT NULL, epoch INTEGER NOT NULL, secret TEXT NOT NULL,
  PRIMARY KEY(channel_id,epoch)
);
CREATE TABLE federation_instance_cursors (origin TEXT PRIMARY KEY, cursor INTEGER NOT NULL DEFAULT 0, error TEXT, retry_at INTEGER NOT NULL DEFAULT 0);
CREATE TABLE federation_instance_incoming (
  origin TEXT NOT NULL, seq INTEGER NOT NULL, channel_actor TEXT NOT NULL, channel_seq INTEGER NOT NULL,
  frame TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', error TEXT, retry_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(origin,seq)
);
CREATE INDEX federation_instance_pending ON federation_instance_incoming(state,retry_at,origin,seq);
CREATE TABLE federation_received_keys (channel_actor TEXT NOT NULL, epoch INTEGER NOT NULL, secret TEXT NOT NULL, PRIMARY KEY(channel_actor,epoch));
ALTER TABLE federation_follows ADD COLUMN key_epoch INTEGER;
ALTER TABLE federation_follows ADD COLUMN instance_start INTEGER;
ALTER TABLE federation_subscriptions ADD COLUMN instance_start INTEGER;
CREATE INDEX federation_instance_channel_pending ON federation_instance_incoming(channel_actor,state,channel_seq);
INSERT INTO federation_instance_events(seq,channel_id,channel_seq,activity_id,created_at,public,epoch)
  SELECT ROW_NUMBER() OVER(ORDER BY e.created_at,e.channel_id,e.seq),e.channel_id,e.seq,e.activity_id,e.created_at,
    CASE WHEN c.visibility='public' THEN 1 ELSE 0 END,1 FROM federation_channel_events e JOIN channels c ON c.id=e.channel_id;
UPDATE federation_instance_state SET tail=COALESCE((SELECT MAX(seq) FROM federation_instance_events),0);
PRAGMA user_version=31;
