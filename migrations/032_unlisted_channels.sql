-- An unlisted channel stays out of the directory: whoever knows its name can still find it.
ALTER TABLE channels ADD COLUMN unlisted INTEGER NOT NULL DEFAULT 0;
PRAGMA user_version=32;
