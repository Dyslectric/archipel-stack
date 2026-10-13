//! Read positions share bounded commits without holding SQL connections while
//! waiting. Every entry is authorized again in the statement that writes it.
use crate::{Failure, Job, Reply};
use axum::http::StatusCode;
use serde_json::json;
use sqlx::{PgPool, Row};
use subtle::ConstantTimeEq;
use tokio::sync::{mpsc, oneshot};
struct Mark {
    user: String,
    target: String,
    hash: String,
    csrf: String,
    seq: Option<i64>,
    reply: oneshot::Sender<Result<bool, Failure>>,
}
pub struct Batch {
    database: PgPool,
    sender: mpsc::Sender<Mark>,
}
impl Batch {
    pub fn start(database: PgPool) -> Self {
        let (sender, mut receiver) = mpsc::channel::<Mark>(128);
        let pool = database.clone();
        tokio::spawn(async move {
            while let Some(first) = receiver.recv().await {
                let mut marks = vec![first];
                let deadline = tokio::time::Instant::now() + std::time::Duration::from_millis(50);
                while marks.len() < 128 {
                    tokio::select! {_ = tokio::time::sleep_until(deadline)=>break,next=receiver.recv()=>match next {Some(next)=>marks.push(next),None=>break}}
                }
                let result = apply(&pool, &marks).await;
                for (slot, mark) in marks.into_iter().enumerate() {
                    let result = match &result {
                        Ok(rows) => match rows.get(slot) {
                            Some((true, changed)) => Ok(*changed),
                            _ => Err(Failure(
                                StatusCode::FORBIDDEN,
                                "Read position authorization changed.",
                            )),
                        },
                        Err(error) => Err(Failure(error.0, error.1)),
                    };
                    let _ = mark.reply.send(result);
                }
            }
        });
        Self { database, sender }
    }
    pub async fn mark(&self, job: &Job, hash: &str) -> Result<Reply, Failure> {
        if job
            .seq
            .is_some_and(|seq| !(0..=9_007_199_254_740_991).contains(&seq))
        {
            return Err(Failure(StatusCode::BAD_REQUEST, "Invalid read position."));
        }
        let user=sqlx::query("SELECT u.id,u.banned,u.admission_status,s.csrf FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>$2")
            .bind(hash).bind(chrono::Utc::now().timestamp_millis()).fetch_optional(&self.database).await?.ok_or(Failure(StatusCode::UNAUTHORIZED,"Sign in to continue."))?;
        if user.get::<i64, _>("banned") != 0
            || user.get::<&str, _>("admission_status") != "approved"
        {
            return Err(Failure(
                StatusCode::FORBIDDEN,
                "Instance membership approval is required.",
            ));
        }
        if !bool::from(
            user.get::<&str, _>("csrf")
                .as_bytes()
                .ct_eq(job.csrf.as_bytes()),
        ) {
            return Err(Failure(StatusCode::FORBIDDEN, "Invalid CSRF token."));
        }
        let id: String = user.get("id");
        let access=sqlx::query("SELECT EXISTS(SELECT 1 FROM channels WHERE id=$1) AS known,EXISTS(SELECT 1 FROM memberships WHERE channel_id=$1 AND user_id=$2) AS member")
            .bind(&job.channel).bind(&id).fetch_one(&self.database).await?;
        if !access.get::<bool, _>("known") {
            return Err(Failure(StatusCode::NOT_FOUND, "Channel not found."));
        }
        if !access.get::<bool, _>("member") {
            return Err(Failure(StatusCode::FORBIDDEN, "Join this channel first."));
        }
        let (reply, receiver) = oneshot::channel();
        self.sender
            .try_send(Mark {
                user: id.clone(),
                target: job.channel.clone(),
                hash: hash.into(),
                csrf: job.csrf.clone(),
                seq: job.seq,
                reply,
            })
            .map_err(|_| {
                Failure(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "Read position queue is full.",
                )
            })?;
        let changed = receiver.await.map_err(|_| {
            Failure(
                StatusCode::SERVICE_UNAVAILABLE,
                "Read position worker unavailable.",
            )
        })??;
        Ok(Reply {
            result: json!({"ok":true}),
            user: id,
            changed,
        })
    }
}
async fn apply(pool: &PgPool, marks: &[Mark]) -> Result<Vec<(bool, bool)>, Failure> {
    let slots: Vec<_> = (0..marks.len()).map(|i| i as i64).collect();
    let users: Vec<_> = marks.iter().map(|m| m.user.as_str()).collect();
    let targets: Vec<_> = marks.iter().map(|m| m.target.as_str()).collect();
    let hashes: Vec<_> = marks.iter().map(|m| m.hash.as_str()).collect();
    let csrf: Vec<_> = marks.iter().map(|m| m.csrf.as_str()).collect();
    let seq: Vec<_> = marks.iter().map(|m| m.seq).collect();
    let mut tx = pool.begin().await?;
    let rows=sqlx::query(r#"WITH source(slot,user_id,target,hash,csrf,seq) AS(SELECT * FROM unnest($1::bigint[],$2::text[],$3::text[],$4::text[],$5::text[],$6::bigint[])),
      authorized AS MATERIALIZED(SELECT i.* FROM source i JOIN sessions s ON s.token_hash=i.hash AND s.user_id=i.user_id JOIN users u ON u.id=i.user_id JOIN memberships m ON m.user_id=i.user_id AND m.channel_id=i.target JOIN channels c ON c.id=m.channel_id WHERE s.csrf=i.csrf AND s.expires_at>$7 AND u.banned=0 AND u.admission_status='approved'),
      latest AS(SELECT t.target,COALESCE((SELECT MAX(seq) FROM messages WHERE channel_id=t.target),0) AS seq FROM(SELECT DISTINCT target FROM authorized)t),
      desired AS(SELECT a.user_id,a.target,MAX(LEAST(COALESCE(a.seq,l.seq),l.seq)) AS seq FROM authorized a JOIN latest l ON l.target=a.target GROUP BY a.user_id,a.target),
      written AS(INSERT INTO read_marks(user_id,target,seq) SELECT user_id,target,seq FROM desired ORDER BY user_id,target ON CONFLICT(user_id,target) DO UPDATE SET seq=excluded.seq WHERE excluded.seq>read_marks.seq RETURNING user_id,target)
      SELECT i.slot,EXISTS(SELECT 1 FROM authorized a WHERE a.slot=i.slot) AS authorized,EXISTS(SELECT 1 FROM written w WHERE w.user_id=i.user_id AND w.target=i.target) AS changed FROM source i ORDER BY slot"#)
        .bind(slots).bind(users).bind(targets).bind(hashes).bind(csrf).bind(seq).bind(chrono::Utc::now().timestamp_millis()).fetch_all(&mut *tx).await?;
    let result: Vec<(bool, bool)> = rows
        .into_iter()
        .map(|r| (r.get("authorized"), r.get("changed")))
        .collect();
    let mut changed = std::collections::HashSet::new();
    for (mark, (authorized, updated)) in marks.iter().zip(&result) {
        if *authorized && *updated {
            changed.insert(mark.user.clone());
        }
    }
    if !changed.is_empty() {
        crate::changes::append(&mut tx,json!([{"table":"read_marks","rows":changed.into_iter().map(|user|json!({"user_id":user})).collect::<Vec<_>>()}])).await?;
    }
    tx.commit().await?;
    Ok(result)
}
