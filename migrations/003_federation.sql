ALTER TABLE users ADD COLUMN remote_actor TEXT;
ALTER TABLE users ADD COLUMN federation_send INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN federation_receive INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN federation_subscribe INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN federation_post INTEGER NOT NULL DEFAULT 0;
ALTER TABLE channels ADD COLUMN remote_actor TEXT;
ALTER TABLE channels ADD COLUMN federation_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE topics ADD COLUMN remote_id TEXT;
ALTER TABLE messages ADD COLUMN remote_object TEXT;
ALTER TABLE messages ADD COLUMN emoji_tags TEXT NOT NULL DEFAULT '[]';
ALTER TABLE messages ADD COLUMN history_placeholder INTEGER NOT NULL DEFAULT 0;
UPDATE messages SET emoji_tags=(
  SELECT json_group_array(json_object('id',e.id,'name',e.name,'url','/api/emojis/'||e.id||'/image'))
  FROM custom_emojis e WHERE instr(messages.body||coalesce(messages.title,''),':'||e.name||':')>0
);
CREATE TABLE federation_keys (id INTEGER PRIMARY KEY CHECK(id=1), private_key TEXT NOT NULL, public_key TEXT NOT NULL);
CREATE TABLE federation_actors (id TEXT PRIMARY KEY, document TEXT NOT NULL, fetched_at INTEGER NOT NULL);
CREATE TABLE federation_blocks (target TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('instance','actor')));
CREATE TABLE federation_follows (
  channel_id TEXT NOT NULL REFERENCES channels(id), actor TEXT NOT NULL,
  follow_id TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','accepted','blocked')),
  PRIMARY KEY(channel_id,actor)
);
CREATE TABLE federation_subscriptions (
  channel_id TEXT NOT NULL REFERENCES channels(id), user_id TEXT NOT NULL REFERENCES users(id),
  follow_id TEXT NOT NULL UNIQUE, status TEXT NOT NULL CHECK(status IN ('pending','accepted','rejected','left')),
  PRIMARY KEY(channel_id,user_id)
);
CREATE TABLE federation_incoming (id TEXT PRIMARY KEY, digest TEXT NOT NULL, received_at INTEGER NOT NULL);
CREATE TABLE federation_outgoing (
  id TEXT PRIMARY KEY, activity TEXT NOT NULL, signer TEXT NOT NULL,
  user_id TEXT REFERENCES users(id), channel_id TEXT REFERENCES channels(id),
  purpose TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE federation_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT, activity_id TEXT NOT NULL REFERENCES federation_outgoing(id),
  recipient TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sent','cancelled','failed')),
  error TEXT, UNIQUE(activity_id,recipient)
);
CREATE INDEX federation_delivery_due ON federation_deliveries(status,next_attempt);
CREATE INDEX federation_delivery_order ON federation_deliveries(recipient,status,id);
CREATE TABLE federation_objects (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), channel_actor TEXT, document TEXT NOT NULL);
CREATE TABLE direct_messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL REFERENCES users(id),
  peer TEXT NOT NULL, direction TEXT NOT NULL CHECK(direction IN ('incoming','outgoing')),
  body TEXT NOT NULL, emoji_tags TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL
);
CREATE INDEX direct_messages_user ON direct_messages(user_id,seq);
CREATE TABLE personal_emojis (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL,
  mime TEXT NOT NULL, image BLOB NOT NULL, source_url TEXT NOT NULL, created_at TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0,
  UNIQUE(user_id,name)
);
CREATE TABLE remote_emoji_cache (id TEXT PRIMARY KEY, source_url TEXT NOT NULL UNIQUE, mime TEXT NOT NULL, image BLOB NOT NULL);
CREATE UNIQUE INDEX users_remote_actor ON users(remote_actor);
CREATE UNIQUE INDEX channels_remote_actor ON channels(remote_actor);
CREATE UNIQUE INDEX topics_remote_id ON topics(remote_id);
CREATE UNIQUE INDEX messages_remote_object ON messages(remote_object);
PRAGMA user_version=3;
