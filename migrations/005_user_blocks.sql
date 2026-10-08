CREATE TABLE user_blocks (
  user_id TEXT NOT NULL REFERENCES users(id),
  peer TEXT NOT NULL,
  PRIMARY KEY(user_id, peer)
);
PRAGMA user_version=5;
