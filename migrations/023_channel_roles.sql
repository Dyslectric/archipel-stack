-- What a channel's owner lets some of its members do there, short of making them moderators.
CREATE TABLE channel_roles (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES channels(id),
  name TEXT NOT NULL COLLATE NOCASE,
  kick_members INTEGER NOT NULL DEFAULT 0,
  ban_members INTEGER NOT NULL DEFAULT 0,
  ban_instances INTEGER NOT NULL DEFAULT 0,
  delete_messages INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE(channel_id,name)
);
-- A member holds at most one of their channel's roles.
CREATE TABLE channel_member_roles (
  channel_id TEXT NOT NULL REFERENCES channels(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  role_id TEXT NOT NULL REFERENCES channel_roles(id),
  PRIMARY KEY(channel_id,user_id)
);
CREATE INDEX channel_member_roles_role ON channel_member_roles(role_id);
-- The instances and XMPP servers whose people a channel keeps out: an origin, or xmpp: and a domain.
CREATE TABLE channel_instance_bans (
  channel_id TEXT NOT NULL REFERENCES channels(id),
  instance TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(channel_id,instance)
);
PRAGMA user_version=23;
