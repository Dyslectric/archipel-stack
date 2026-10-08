-- Personal labels leave the remote account's identity and advertised profile intact.
CREATE TABLE contact_names (
  user_id TEXT NOT NULL REFERENCES users(id),
  peer TEXT NOT NULL,
  display_name TEXT NOT NULL CHECK(length(display_name) BETWEEN 1 AND 80),
  PRIMARY KEY(user_id, peer)
);
PRAGMA user_version=8;
