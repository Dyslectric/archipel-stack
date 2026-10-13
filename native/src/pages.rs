//! Bounded per-process raw pages, validated against the reader's SQL snapshot.
//! Reader-specific permissions, profiles, blocks and emoji metadata stay fresh.
use crate::{Config, Failure};
use axum::http::StatusCode;
use serde_json::{Value, json};
use sqlx::{Postgres, Row, Transaction, types::Json};
use std::{
    collections::{HashMap, VecDeque},
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, Instant},
};
use tokio::sync::Mutex;

struct Entry {
    stamp: String,
    rows: Vec<Value>,
    bytes: usize,
    until: Instant,
}
#[derive(Default)]
struct Entries {
    pages: HashMap<String, Entry>,
    order: VecDeque<String>,
    bytes: usize,
}
#[derive(Default)]
pub struct Cache {
    entries: Mutex<Entries>,
    hits: AtomicU64,
    misses: AtomicU64,
}
impl Cache {
    async fn get(&self, key: &str, stamp: &str) -> Option<Vec<Value>> {
        let entries = self.entries.lock().await;
        if let Some(entry) = entries
            .pages
            .get(key)
            .filter(|e| e.stamp == stamp && e.until > Instant::now())
        {
            self.hits.fetch_add(1, Ordering::Relaxed);
            return Some(entry.rows.clone());
        }
        self.misses.fetch_add(1, Ordering::Relaxed);
        None
    }
    async fn put(&self, key: String, stamp: String, rows: &[Value]) {
        let bytes = serde_json::to_vec(rows).map_or(usize::MAX, |r| r.len().saturating_mul(2));
        if bytes > 2 * 1024 * 1024 {
            return;
        }
        let mut entries = self.entries.lock().await;
        if let Some(old) = entries.pages.remove(&key) {
            entries.bytes -= old.bytes;
            entries.order.retain(|k| k != &key);
        }
        while entries.pages.len() >= 256 || entries.bytes + bytes > 16 * 1024 * 1024 {
            let Some(old) = entries.order.pop_front() else {
                break;
            };
            if let Some(old) = entries.pages.remove(&old) {
                entries.bytes -= old.bytes;
            }
        }
        entries.order.push_back(key.clone());
        entries.bytes += bytes;
        entries.pages.insert(
            key,
            Entry {
                stamp,
                rows: rows.to_vec(),
                bytes,
                until: Instant::now() + Duration::from_secs(2),
            },
        );
    }
    pub async fn statistics(&self) -> Value {
        let entries = self.entries.lock().await;
        json!({"hits":self.hits.load(Ordering::Relaxed),"misses":self.misses.load(Ordering::Relaxed),"bytes":entries.bytes,"entries":entries.pages.len()})
    }
}
pub struct Window {
    pub stamp: String,
    pub first: Option<i64>,
    pub last: i64,
    pub count: i64,
}
pub struct Cursor<'a> {
    pub before: i64,
    pub after: Option<(i64, &'a str)>,
}
async fn window(
    tx: &mut Transaction<'_, Postgres>,
    channel: &str,
    before: i64,
    receive: i64,
) -> Result<Window, Failure> {
    // Bound the message window before looking up author versions. A join ahead
    // of LIMIT can hash every account for every reader; lateral lookup keeps
    // this work bounded to the page, including custom/generic prepared plans.
    let row = sqlx::query("WITH page AS MATERIALIZED (SELECT m.id,m.seq,m.author_id,m.ctid::text AS physical,m.xmin::text AS version FROM messages m WHERE m.channel_id=$1 AND m.seq<$2 AND ($3=1 OR (m.remote_object IS NULL AND EXISTS(SELECT 1 FROM users v WHERE v.id=m.author_id AND COALESCE(v.remote_actor,'') NOT LIKE 'xmpp:%'))) ORDER BY m.seq DESC LIMIT 100) SELECT md5(COALESCE(string_agg(p.id||':'||p.physical||':'||p.version||':'||u.author_physical||':'||u.author_version,',' ORDER BY p.seq),'')) AS stamp,MIN(p.seq) AS first,COALESCE(MAX(p.seq),0) AS last,COUNT(*) AS count FROM page p CROSS JOIN LATERAL (SELECT v.ctid::text AS author_physical,v.xmin::text AS author_version FROM users v WHERE v.id=p.author_id OFFSET 0) u")
        .bind(channel).bind(before).bind(receive).fetch_one(&mut **tx).await?;
    Ok(Window {
        stamp: row.get("stamp"),
        first: row.get("first"),
        last: row.get("last"),
        count: row.get("count"),
    })
}
pub async fn read(
    cache: &Cache,
    config: &Config,
    tx: &mut Transaction<'_, Postgres>,
    channel: &str,
    cursor: Cursor<'_>,
    user: &str,
    receive: i64,
) -> Result<(Vec<Value>, Window, bool), Failure> {
    let Cursor { before, after } = cursor;
    let key = format!("{channel}:{before}:{receive}");
    // Physical tuple + creating transaction change on UPDATE, including a
    // legacy edit/delete that emits no native notice. Page membership/order is
    // included too. Two-second retention prevents transaction-ID wrap/reuse.
    let mut incremental = false;
    let mut appended = None;
    if let Some((seq, stamp)) = after {
        let prior = window(tx, channel, seq + 1, receive).await?;
        if prior.last == seq && prior.stamp == stamp {
            let Json(value): Json<Value> = sqlx::query_scalar("WITH page AS (SELECT m.* FROM messages m JOIN users u ON u.id=m.author_id WHERE m.channel_id=$1 AND m.seq>$2 AND ((m.remote_object IS NULL AND COALESCE(u.remote_actor,'') NOT LIKE 'xmpp:%') OR $3=1) ORDER BY m.seq LIMIT 101) SELECT COALESCE(jsonb_agg(to_jsonb(page) ORDER BY seq),'[]'::jsonb) FROM page")
                .bind(channel).bind(seq).bind(receive).fetch_one(&mut **tx).await?;
            let rows = value.as_array().cloned().ok_or(Failure(
                StatusCode::SERVICE_UNAVAILABLE,
                "Invalid incremental page.",
            ))?;
            // Overflow uses the normal complete latest window. Never advance a
            // cursor over an unreturned gap while labelling it incremental.
            if rows.len() <= 100 {
                incremental = true;
                appended = Some(rows);
            }
        }
    }
    let latest = window(tx, channel, before, receive).await?;
    let mut rows = if let Some(rows) = appended {
        rows
    } else if let Some(rows) = cache.get(&key, &latest.stamp).await {
        rows
    } else {
        let Json(value):Json<Value>=sqlx::query_scalar("WITH page AS (SELECT m.* FROM messages m JOIN users u ON u.id=m.author_id WHERE m.channel_id=$1 AND m.seq<$2 AND ((m.remote_object IS NULL AND COALESCE(u.remote_actor,'') NOT LIKE 'xmpp:%') OR $3=1) ORDER BY m.seq DESC LIMIT 100) SELECT COALESCE(jsonb_agg(to_jsonb(page) ORDER BY seq),'[]'::jsonb) FROM page")
            .bind(channel).bind(before).bind(receive).fetch_one(&mut **tx).await?;
        let rows = value.as_array().cloned().ok_or(Failure(
            StatusCode::SERVICE_UNAVAILABLE,
            "Invalid raw message page.",
        ))?;
        cache.put(key, latest.stamp.clone(), &rows).await;
        rows
    };
    let mut authors = vec![];
    for row in &rows {
        if let Some(author) = row["author_id"].as_str()
            && !authors.contains(&author)
        {
            authors.push(author);
        }
    }
    if authors.is_empty() {
        return Ok((rows, latest, incremental));
    }
    let projections=sqlx::query("SELECT u.id,jsonb_build_object('username',u.username,'display_name',CASE WHEN u.remote_actor IS NOT NULL THEN COALESCE(n.display_name,u.display_name) ELSE u.display_name END,'author_actor_url',COALESCE(u.remote_actor,$2||'/actors/users/'||u.id),'avatar_url',CASE WHEN u.remote_actor IS NOT NULL THEN CASE WHEN r.id IS NULL THEN NULL ELSE '/api/remote-avatars/'||r.id||'?v='||r.revision END WHEN a.revision IS NULL THEN NULL ELSE '/api/avatars/'||u.id||'?v='||a.revision END,'_blocked',b.peer IS NOT NULL) AS projection FROM users u LEFT JOIN user_avatars a ON a.user_id=u.id LEFT JOIN remote_avatars r ON r.peer=u.remote_actor LEFT JOIN contact_names n ON n.user_id=$3 AND n.peer=u.remote_actor LEFT JOIN user_blocks b ON b.user_id=$3 AND b.peer=COALESCE(u.remote_actor,$2||'/actors/users/'||u.id) WHERE u.id=ANY($1)")
        .bind(authors).bind(&config.base).bind(user).fetch_all(&mut **tx).await?;
    let projections: HashMap<String, Value> = projections
        .into_iter()
        .map(|row| {
            let Json(projection): Json<Value> = row.get("projection");
            (row.get("id"), projection)
        })
        .collect();
    for row in &mut rows {
        let author = row["author_id"].as_str().unwrap_or("");
        let projection = projections
            .get(author)
            .and_then(Value::as_object)
            .ok_or(Failure(
                StatusCode::SERVICE_UNAVAILABLE,
                "Message author unavailable.",
            ))?;
        let placeholder = row["history_placeholder"].as_i64().is_some_and(|n| n != 0);
        let object = row["remote_object"]
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| {
                format!(
                    "{}/objects/messages/{}",
                    config.base,
                    row["id"].as_str().unwrap_or("")
                )
            });
        let row = row.as_object_mut().ok_or(Failure(
            StatusCode::SERVICE_UNAVAILABLE,
            "Invalid raw message page.",
        ))?;
        row.extend(projection.clone());
        row.insert("object_url".into(), json!(object));
        row.insert("emojis".into(), json!([]));
        if placeholder {
            row.insert("username".into(), json!("history"));
            row.insert("display_name".into(), json!("Earlier message"));
            row.insert("avatar_url".into(), Value::Null);
        }
    }
    Ok((rows, latest, incremental))
}
