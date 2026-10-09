-- Who a followed channel's home says is in it, kept beside the subscribers here.
CREATE TABLE channel_roster (
  channel_id TEXT NOT NULL REFERENCES channels(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK(role IN ('owner','moderator','member')),
  PRIMARY KEY(channel_id,user_id)
);
PRAGMA user_version=16;
