-- The role a followed channel's home says one of this instance's members holds there. The home
-- decides what the role allows each time it is used; this copy only says what to offer.
CREATE TABLE channel_held_roles (
  channel_id TEXT NOT NULL REFERENCES channels(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  kick_members INTEGER NOT NULL DEFAULT 0,
  ban_members INTEGER NOT NULL DEFAULT 0,
  ban_instances INTEGER NOT NULL DEFAULT 0,
  delete_messages INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(channel_id,user_id)
);
PRAGMA user_version=24;
