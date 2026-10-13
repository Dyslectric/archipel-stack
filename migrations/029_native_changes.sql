-- Native mutations append notices here in their own transaction. A relay batches
-- committed notices so chat writes do not acquire PostgreSQL's global NOTIFY lock.
CREATE TABLE IF NOT EXISTS native_changes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  payload TEXT NOT NULL
);
PRAGMA user_version=29;
