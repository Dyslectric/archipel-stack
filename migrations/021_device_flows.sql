-- A program without a browser waiting to be signed in (src/device.ts): what it asks with and
-- the code its user is shown, both hashed, and who said yes once someone has.
CREATE TABLE device_flows (
  device_hash TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  user_id TEXT REFERENCES users(id),
  expires_at INTEGER NOT NULL
);
PRAGMA user_version=21;
