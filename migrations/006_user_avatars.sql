CREATE TABLE user_avatars (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  revision TEXT NOT NULL,
  mime TEXT NOT NULL,
  image BLOB NOT NULL
);
PRAGMA user_version=6;
