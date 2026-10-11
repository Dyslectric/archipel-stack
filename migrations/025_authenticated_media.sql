-- Old uploads are treated as published: only live messages grant access to them.
-- New, unsent uploads can be previewed only by their uploader.
ALTER TABLE attachments ADD COLUMN published INTEGER NOT NULL DEFAULT 1;
PRAGMA user_version=25;
