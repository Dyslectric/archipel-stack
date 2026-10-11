ALTER TABLE channel_roles ADD COLUMN allow_access INTEGER NOT NULL DEFAULT 0;
ALTER TABLE channel_held_roles ADD COLUMN allow_access INTEGER NOT NULL DEFAULT 0;
PRAGMA user_version = 26;
