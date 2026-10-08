-- How a reader treats a conversation, or one topic or thread inside a channel: whether it is
-- hidden from them, and whether what is said there notifies them.
CREATE TABLE conversation_prefs (
  user_id TEXT NOT NULL REFERENCES users(id),
  target TEXT NOT NULL,  -- a channel's id, dm:<peer>, topic:<topic id> or thread:<first message's id>
  channel_id TEXT,       -- the channel itself, or the one a topic or thread is in
  hidden INTEGER NOT NULL DEFAULT 0,
  notify INTEGER,        -- 1 or 0; NULL follows the channel, and a channel or direct conversation notifies
  PRIMARY KEY(user_id,target)
);
CREATE INDEX conversation_prefs_channel ON conversation_prefs(channel_id);
CREATE INDEX messages_parent ON messages(parent_id);
-- A browser that asked to be notified. It belongs to the session that registered it, so signing
-- out, or the session ending, stops delivery to it.
CREATE TABLE push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  session_hash TEXT NOT NULL REFERENCES sessions(token_hash) ON DELETE CASCADE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX push_subscriptions_user ON push_subscriptions(user_id);
CREATE INDEX push_subscriptions_session ON push_subscriptions(session_hash);
PRAGMA user_version=14;
