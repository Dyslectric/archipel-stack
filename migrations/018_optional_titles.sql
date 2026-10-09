-- A threaded channel can let threads start without a title; titles are required unless it says so.
ALTER TABLE channels ADD COLUMN optional_titles INTEGER NOT NULL DEFAULT 0;
PRAGMA user_version=18;
