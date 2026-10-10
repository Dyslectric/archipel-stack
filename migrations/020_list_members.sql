-- Seeing everyone with an account here becomes a role's grant. The default role does not carry it;
-- the other roles keep what their accounts could already do.
ALTER TABLE roles ADD COLUMN list_members INTEGER NOT NULL DEFAULT 0;
UPDATE roles SET list_members=1 WHERE is_default=0;
PRAGMA user_version=20;
