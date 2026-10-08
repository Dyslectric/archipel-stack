-- Native stanza IDs are scoped to streams; multiple resources may reuse them.
CREATE TABLE xmpp_message_ids_scoped (
  message_id TEXT PRIMARY KEY REFERENCES messages(id),
  sender TEXT NOT NULL, stanza_id TEXT NOT NULL, origin_id TEXT,
  scope TEXT NOT NULL DEFAULT ''
);
INSERT INTO xmpp_message_ids_scoped(message_id,sender,stanza_id,origin_id)
  SELECT message_id,sender,stanza_id,origin_id FROM xmpp_message_ids;
DROP TABLE xmpp_message_ids;
ALTER TABLE xmpp_message_ids_scoped RENAME TO xmpp_message_ids;
CREATE INDEX xmpp_message_ids_sender ON xmpp_message_ids(sender,stanza_id);
PRAGMA user_version=9;
