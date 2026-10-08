CREATE TABLE read_marks (
  user_id TEXT NOT NULL REFERENCES users(id), target TEXT NOT NULL, seq INTEGER NOT NULL,
  PRIMARY KEY(user_id,target)
);
-- Nothing that already exists counts as new.
INSERT INTO read_marks SELECT user_id,channel_id,(SELECT COALESCE(MAX(seq),0) FROM messages) FROM memberships;
INSERT INTO read_marks SELECT user_id,'dm:'||peer,MAX(seq) FROM direct_messages GROUP BY user_id,peer;
CREATE TABLE sidebar_layouts (user_id TEXT PRIMARY KEY REFERENCES users(id), layout TEXT NOT NULL);
CREATE INDEX direct_messages_peer ON direct_messages(user_id,peer,seq);
PRAGMA user_version=4;
