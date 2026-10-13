//! A reconstructible routing index, never an authority or delivery audit.
//! PostgreSQL triggers cover native and compatibility writers in the same schema.
use sqlx::PgPool;

pub async fn initialize(pool: &PgPool) -> Result<(), sqlx::Error> {
    let mut tx = pool.begin().await?;
    sqlx::query(
        "SELECT pg_advisory_xact_lock(hashtextextended(current_schema()||':native-heads-init',0))",
    )
    .execute(&mut *tx)
    .await?;
    let exists: bool =
        sqlx::query_scalar("SELECT to_regclass('native_federation_heads') IS NOT NULL AND to_regclass('native_federation_pending') IS NOT NULL AND to_regclass('native_federation_cache_version') IS NOT NULL")
            .fetch_one(&mut *tx)
            .await?;
    let version: Option<i32> = if exists {
        sqlx::query_scalar("SELECT version FROM native_federation_cache_version LIMIT 1")
            .fetch_optional(&mut *tx)
            .await?
    } else {
        None
    };
    if version != Some(1) {
        // Match queue creation's lock order. Block compatibility writes until
        // triggers and the initial index become visible in the same commit.
        sqlx::raw_sql(SQL).execute(&mut *tx).await?;
    }
    tx.commit().await
}

const SQL: &str = r#"
LOCK TABLE federation_outgoing,federation_deliveries IN SHARE ROW EXCLUSIVE MODE;
DROP TABLE IF EXISTS native_federation_heads;
DROP TABLE IF EXISTS native_federation_pending;
DROP TABLE IF EXISTS native_federation_cache_version;
CREATE TABLE native_federation_cache_version(version INTEGER PRIMARY KEY);
INSERT INTO native_federation_cache_version VALUES(1);
CREATE TABLE native_federation_pending (
    delivery_id BIGINT PRIMARY KEY,
    recipient TEXT NOT NULL,
    lane TEXT NOT NULL
);
CREATE INDEX native_federation_pending_lane ON native_federation_pending(recipient,lane,delivery_id);
CREATE TABLE native_federation_heads (
    recipient TEXT NOT NULL,
    lane TEXT NOT NULL,
    head_id BIGINT NOT NULL,
    PRIMARY KEY(recipient,lane)
);
CREATE UNIQUE INDEX native_federation_head_order ON native_federation_heads(head_id);

CREATE OR REPLACE FUNCTION native_federation_lane(channel TEXT) RETURNS TEXT
LANGUAGE SQL IMMUTABLE AS $$ SELECT COALESCE('c:'||channel,'n:') $$;

CREATE OR REPLACE FUNCTION native_federation_heads_lock() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    -- One short cache-maintenance lock per statement/transaction. This avoids
    -- opposite recipient lock orders in bulk cancellation and queue creation.
    PERFORM pg_advisory_xact_lock(hashtextextended(current_schema()||':native-heads-write',0));
    RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION native_federation_heads_refresh(p_recipients TEXT[],p_lanes TEXT[]) RETURNS VOID
LANGUAGE plpgsql AS $$
BEGIN
    -- Remove heads that left their lane before inserting replacements. This
    -- also permits moving the same delivery ID to another recipient/channel.
    DELETE FROM native_federation_heads h USING unnest(p_recipients,p_lanes) a(recipient,lane)
      WHERE h.recipient=a.recipient AND h.lane=a.lane AND NOT EXISTS(
        SELECT 1 FROM native_federation_pending p WHERE p.delivery_id=h.head_id
          AND p.recipient=h.recipient AND p.lane=h.lane);
    INSERT INTO native_federation_heads(recipient,lane,head_id)
      SELECT a.recipient,a.lane,p.delivery_id FROM unnest(p_recipients,p_lanes) a(recipient,lane)
      CROSS JOIN LATERAL(SELECT delivery_id FROM native_federation_pending
        WHERE recipient=a.recipient AND lane=a.lane ORDER BY delivery_id LIMIT 1) p
      ON CONFLICT(recipient,lane) DO UPDATE SET head_id=excluded.head_id
      WHERE native_federation_heads.head_id IS DISTINCT FROM excluded.head_id;
END $$;

CREATE OR REPLACE FUNCTION native_federation_heads_delivery_batch() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE peers TEXT[]; lanes TEXT[];
BEGIN
    IF TG_OP='DELETE' THEN
      SELECT array_agg(recipient),array_agg(lane) INTO peers,lanes FROM (
        SELECT DISTINCT d.recipient,native_federation_lane(o.channel_id) AS lane
          FROM old_deliveries d CROSS JOIN LATERAL(SELECT channel_id FROM federation_outgoing
            WHERE id=d.activity_id OFFSET 0) o) a;
      DELETE FROM native_federation_pending p USING old_deliveries d WHERE p.delivery_id=d.id;
    ELSIF TG_OP='UPDATE' THEN
      SELECT array_agg(recipient),array_agg(lane) INTO peers,lanes FROM (
        SELECT d.recipient,native_federation_lane(o.channel_id) AS lane FROM old_deliveries d
          CROSS JOIN LATERAL(SELECT channel_id FROM federation_outgoing WHERE id=d.activity_id OFFSET 0) o
        UNION SELECT d.recipient,native_federation_lane(o.channel_id) FROM new_deliveries d
          CROSS JOIN LATERAL(SELECT channel_id FROM federation_outgoing WHERE id=d.activity_id OFFSET 0) o) a;
      DELETE FROM native_federation_pending p USING old_deliveries d WHERE p.delivery_id=d.id
        AND NOT EXISTS(SELECT 1 FROM new_deliveries n WHERE n.id=d.id AND n.status='pending');
    ELSE
      SELECT array_agg(recipient),array_agg(lane) INTO peers,lanes FROM (
        SELECT DISTINCT d.recipient,native_federation_lane(o.channel_id) AS lane
          FROM new_deliveries d CROSS JOIN LATERAL(SELECT channel_id FROM federation_outgoing
            WHERE id=d.activity_id OFFSET 0) o WHERE d.status='pending') a;
    END IF;
    IF TG_OP<>'DELETE' THEN
      INSERT INTO native_federation_pending(delivery_id,recipient,lane)
        SELECT d.id,d.recipient,native_federation_lane(o.channel_id) FROM new_deliveries d
          CROSS JOIN LATERAL(SELECT channel_id FROM federation_outgoing WHERE id=d.activity_id OFFSET 0) o
          WHERE d.status='pending'
        ON CONFLICT(delivery_id) DO UPDATE SET recipient=excluded.recipient,lane=excluded.lane
        WHERE (native_federation_pending.recipient,native_federation_pending.lane)
          IS DISTINCT FROM (excluded.recipient,excluded.lane);
    END IF;
    PERFORM native_federation_heads_refresh(peers,lanes);
    RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION native_federation_heads_channel_batch() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE peers TEXT[]; lanes TEXT[];
BEGIN
    SELECT array_agg(recipient),array_agg(lane) INTO peers,lanes FROM (
      SELECT DISTINCT p.recipient,l.lane FROM new_outgoing n JOIN old_outgoing prior ON prior.id=n.id
        JOIN federation_deliveries d ON d.activity_id=n.id
        JOIN native_federation_pending p ON p.delivery_id=d.id
        CROSS JOIN LATERAL(VALUES(native_federation_lane(prior.channel_id)),(native_federation_lane(n.channel_id))) l(lane)
        WHERE prior.channel_id IS DISTINCT FROM n.channel_id) a;
    UPDATE native_federation_pending p SET lane=native_federation_lane(n.channel_id)
      FROM new_outgoing n JOIN old_outgoing prior ON prior.id=n.id
      JOIN federation_deliveries d ON d.activity_id=n.id
      WHERE p.delivery_id=d.id AND prior.channel_id IS DISTINCT FROM n.channel_id;
    PERFORM native_federation_heads_refresh(peers,lanes);
    RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS native_federation_heads_write ON federation_deliveries;
DROP TRIGGER IF EXISTS native_federation_heads_delivery ON federation_deliveries;
DROP TRIGGER IF EXISTS native_federation_heads_insert ON federation_deliveries;
DROP TRIGGER IF EXISTS native_federation_heads_update ON federation_deliveries;
DROP TRIGGER IF EXISTS native_federation_heads_delete ON federation_deliveries;
DROP TRIGGER IF EXISTS native_federation_heads_outgoing_write ON federation_outgoing;
DROP TRIGGER IF EXISTS native_federation_heads_channel ON federation_outgoing;
CREATE TRIGGER native_federation_heads_write BEFORE INSERT OR UPDATE OR DELETE ON federation_deliveries
FOR EACH STATEMENT EXECUTE FUNCTION native_federation_heads_lock();
CREATE TRIGGER native_federation_heads_insert AFTER INSERT ON federation_deliveries
REFERENCING NEW TABLE AS new_deliveries FOR EACH STATEMENT EXECUTE FUNCTION native_federation_heads_delivery_batch();
CREATE TRIGGER native_federation_heads_update AFTER UPDATE ON federation_deliveries
REFERENCING OLD TABLE AS old_deliveries NEW TABLE AS new_deliveries
FOR EACH STATEMENT EXECUTE FUNCTION native_federation_heads_delivery_batch();
CREATE TRIGGER native_federation_heads_delete AFTER DELETE ON federation_deliveries
REFERENCING OLD TABLE AS old_deliveries FOR EACH STATEMENT EXECUTE FUNCTION native_federation_heads_delivery_batch();
CREATE TRIGGER native_federation_heads_outgoing_write BEFORE UPDATE OF channel_id ON federation_outgoing
FOR EACH STATEMENT EXECUTE FUNCTION native_federation_heads_lock();
CREATE TRIGGER native_federation_heads_channel AFTER UPDATE ON federation_outgoing
REFERENCING OLD TABLE AS old_outgoing NEW TABLE AS new_outgoing
FOR EACH STATEMENT EXECUTE FUNCTION native_federation_heads_channel_batch();

INSERT INTO native_federation_pending(delivery_id,recipient,lane)
  SELECT d.id,d.recipient,native_federation_lane(o.channel_id)
  FROM federation_deliveries d JOIN federation_outgoing o ON o.id=d.activity_id
  WHERE d.status='pending';
INSERT INTO native_federation_heads(recipient,lane,head_id)
  SELECT DISTINCT ON(recipient,lane) recipient,lane,delivery_id FROM native_federation_pending
  ORDER BY recipient,lane,delivery_id;
"#;
