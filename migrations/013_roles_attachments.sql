-- What a local account may do on this instance. Accounts without a role of their own take the default one.
CREATE TABLE roles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  is_default INTEGER NOT NULL DEFAULT 0,
  create_channels INTEGER NOT NULL DEFAULT 1,
  federate_channels INTEGER NOT NULL DEFAULT 1,
  direct_messages INTEGER NOT NULL DEFAULT 1,
  attachments INTEGER NOT NULL DEFAULT 1,
  xmpp_rooms INTEGER NOT NULL DEFAULT 1,
  federation_send INTEGER NOT NULL DEFAULT 0,
  federation_receive INTEGER NOT NULL DEFAULT 0,
  federation_subscribe INTEGER NOT NULL DEFAULT 0,
  federation_post INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX roles_default ON roles(is_default) WHERE is_default=1;
-- Only accounts given a role other than the default have a row.
CREATE TABLE user_roles (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  role_id TEXT NOT NULL REFERENCES roles(id)
);
CREATE INDEX user_roles_role ON user_roles(role_id);
INSERT INTO roles(id,name,is_default,created_at) VALUES('member','Member',1,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
-- Federation grants made account by account become roles, so nobody loses or gains access.
-- The users.federation_* columns stay as the effective copy of each account's role.
INSERT INTO roles(id,name,federation_send,federation_receive,federation_subscribe,federation_post,created_at)
  SELECT DISTINCT 'federated-'||federation_send||federation_receive||federation_subscribe||federation_post,
    CASE WHEN federation_send+federation_receive+federation_subscribe+federation_post=4 THEN 'Federated'
      ELSE 'Federated ('||rtrim(
        CASE WHEN federation_send=1 THEN 'send, ' ELSE '' END||
        CASE WHEN federation_receive=1 THEN 'receive, ' ELSE '' END||
        CASE WHEN federation_subscribe=1 THEN 'subscribe, ' ELSE '' END||
        CASE WHEN federation_post=1 THEN 'post, ' ELSE '' END, ', ')||')' END,
    federation_send,federation_receive,federation_subscribe,federation_post,strftime('%Y-%m-%dT%H:%M:%fZ','now')
  FROM users WHERE remote_actor IS NULL AND federation_send+federation_receive+federation_subscribe+federation_post>0;
INSERT INTO user_roles
  SELECT id,'federated-'||federation_send||federation_receive||federation_subscribe||federation_post FROM users
  WHERE remote_actor IS NULL AND federation_send+federation_receive+federation_subscribe+federation_post>0;
-- Pictures and videos put in messages. The id is the secret: a message carries the address,
-- so whoever can read the message, here or on another server, can fetch the file.
CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  data BLOB NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX attachments_owner ON attachments(owner_id,created_at);
-- A room that drops its occupants (a restart at either end, a lost connection) is joined again:
-- when the next attempt is due, and how many have failed in a row.
ALTER TABLE xmpp_remote_rooms ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE xmpp_remote_rooms ADD COLUMN retry_at INTEGER;
UPDATE xmpp_remote_rooms SET retry_at=0 WHERE desired=1 AND state IN ('error','left');
PRAGMA user_version=13;
