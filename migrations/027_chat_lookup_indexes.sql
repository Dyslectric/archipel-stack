CREATE INDEX IF NOT EXISTS memberships_user_channel ON memberships(user_id,channel_id);
CREATE INDEX IF NOT EXISTS xmpp_remote_queued ON xmpp_remote_messages(subscription_id,status,seq);
PRAGMA user_version=27;
