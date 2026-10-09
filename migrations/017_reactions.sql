-- Moderators can turn emoji reactions off for a channel; they start on.
ALTER TABLE channels ADD COLUMN reactions INTEGER NOT NULL DEFAULT 1;
-- One row per person per emoji on a message. The emoji is a shortcode name: a standard one, or a
-- custom emoji of this instance. Reactions stay on the instance that hosts the channel.
CREATE TABLE message_reactions (
  message_id TEXT NOT NULL REFERENCES messages(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  emoji TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(message_id,user_id,emoji)
);
CREATE INDEX message_reactions_user ON message_reactions(user_id);
PRAGMA user_version=17;
