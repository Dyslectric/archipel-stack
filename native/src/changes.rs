use crate::Failure;
use serde_json::{Value, json};
use sqlx::{PgPool, Postgres, Row, Transaction};
use std::{collections::HashSet, time::Duration};

pub async fn append(tx: &mut Transaction<'_, Postgres>, changes: Value) -> Result<(), Failure> {
    sqlx::query("INSERT INTO native_changes(payload) VALUES($1)")
        .bind(changes.to_string())
        .execute(&mut **tx)
        .await?;
    Ok(())
}
/// Publishes as soon as a forwarded mutation is woken through `wake`; the
/// interval remains a fallback for writers that do not pass the gateway.
pub fn start(
    pool: PgPool,
    channel: String,
    wake: std::sync::Arc<tokio::sync::Notify>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_millis(1000));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tokio::select! { _ = interval.tick() => {}, _ = wake.notified() => {} }
            if publish(&pool, &channel).await.is_err() {
                // Rows remain durable on any failure; a later round retries.
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
        }
    })
}
async fn publish(pool: &PgPool, channel: &str) -> Result<(), Failure> {
    let mut tx = pool.begin().await?;
    // Only notices are removed here. If a crash lost this commit they would be
    // published again, which listeners already treat as a harmless repeat, so
    // the relay need not wait for its WAL to reach disk.
    sqlx::query("SET LOCAL synchronous_commit = off")
        .execute(&mut *tx)
        .await?;
    let rows = sqlx::query(
        "SELECT seq,payload FROM native_changes ORDER BY seq LIMIT 512 FOR UPDATE SKIP LOCKED",
    )
    .fetch_all(&mut *tx)
    .await?;
    if rows.is_empty() {
        return Ok(());
    }
    let ids: Vec<i64> = rows.iter().map(|r| r.get("seq")).collect();
    let mut seen = HashSet::new();
    let mut notices = Vec::new();
    for row in rows {
        let payload: Value = serde_json::from_str(row.get::<&str, _>("payload")).map_err(|_| {
            Failure(
                axum::http::StatusCode::SERVICE_UNAVAILABLE,
                "Invalid durable change notice.",
            )
        })?;
        for notice in payload.as_array().into_iter().flatten() {
            let table = notice["table"].as_str().unwrap_or("");
            if let Some(rows) = notice["rows"].as_array() {
                if rows.is_empty() {
                    let notice = json!({"table":table,"rows":[]});
                    if seen.insert(notice.to_string()) {
                        notices.push(notice);
                    }
                }
                for row in rows {
                    let notice = json!({"table":table,"rows":[row]});
                    if seen.insert(notice.to_string()) {
                        notices.push(notice);
                    }
                }
            }
        }
    }
    // NOTIFY payloads must be below 8 KiB. All chunks are committed together,
    // acquiring its global commit lock once, independent of the write count.
    let mut chunks = Vec::new();
    let mut size = 2;
    for notice in notices {
        let bytes = notice.to_string().len() + 1;
        if size + bytes > 7000 && !chunks.is_empty() {
            send(&mut tx, channel, &chunks).await?;
            chunks.clear();
            size = 2;
        }
        chunks.push(notice);
        size += bytes;
    }
    if !chunks.is_empty() {
        send(&mut tx, channel, &chunks).await?;
    }
    sqlx::query("DELETE FROM native_changes WHERE seq=ANY($1)")
        .bind(ids)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}
async fn send(
    tx: &mut Transaction<'_, Postgres>,
    channel: &str,
    notices: &[Value],
) -> Result<(), Failure> {
    sqlx::query("SELECT pg_notify($1,$2)")
        .bind(channel)
        .bind(json!(notices).to_string())
        .execute(&mut **tx)
        .await?;
    Ok(())
}
