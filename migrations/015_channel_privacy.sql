-- Who is in a channel, and the handles of the people writing in it, can be kept to its owner and
-- moderators. A channel shows both unless its owner says otherwise.
ALTER TABLE channels ADD COLUMN show_members INTEGER NOT NULL DEFAULT 1;
ALTER TABLE channels ADD COLUMN hide_handles INTEGER NOT NULL DEFAULT 0;
-- Members the owner or a moderator allowed to see what the channel keeps from the rest.
CREATE TABLE channel_grants (
  channel_id TEXT NOT NULL REFERENCES channels(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  see_members INTEGER NOT NULL DEFAULT 0,
  see_handles INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(channel_id,user_id)
);
PRAGMA user_version=15;
