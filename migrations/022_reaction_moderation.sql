-- A reaction may be a custom emoji of another instance: the picture a name stands for on a
-- message is the one it was first given with there.
CREATE TABLE reaction_emojis (
  message_id TEXT NOT NULL REFERENCES messages(id),
  emoji TEXT NOT NULL,
  emoji_id TEXT NOT NULL,
  PRIMARY KEY(message_id,emoji)
);
-- The emoji a channel's moderators do not want as reactions: a JSON list of shortcode names.
ALTER TABLE channels ADD COLUMN reaction_bans TEXT NOT NULL DEFAULT '[]';
PRAGMA user_version=22;
