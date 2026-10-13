CREATE INDEX IF NOT EXISTS federation_pending_order ON federation_deliveries(id) WHERE status='pending';
CREATE INDEX IF NOT EXISTS federation_pending_recipient ON federation_deliveries(recipient,id) WHERE status='pending';
CREATE INDEX IF NOT EXISTS federation_pending_activity ON federation_deliveries(activity_id,id) WHERE status='pending';
CREATE INDEX IF NOT EXISTS federation_outgoing_owner ON federation_outgoing(user_id,purpose,channel_id,id);
CREATE INDEX IF NOT EXISTS federation_outgoing_channel ON federation_outgoing(channel_id,id);
PRAGMA user_version=28;
