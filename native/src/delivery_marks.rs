//! Coalesce successful, already accepted network deliveries into durable commits.
//! Jobs keep their recipient claims until their completion reply arrives.
use crate::{Failure, chat, metrics::Stage};
use axum::http::StatusCode;
use std::{sync::Arc, time::Duration};
use tokio::sync::{mpsc, oneshot};

type Reply = oneshot::Sender<Result<(), Failure>>;
enum Request {
    Sent(Vec<i64>, Reply),
    Drain(Reply),
}
pub struct Batch {
    sender: mpsc::Sender<Request>,
}
impl Batch {
    pub fn start(chat: Arc<chat::State>) -> Self {
        let (sender, mut receiver) = mpsc::channel::<Request>(64);
        tokio::spawn(async move {
            while let Some(first) = receiver.recv().await {
                let (mut ids, first_reply) = match first {
                    Request::Sent(ids, reply) => (ids, reply),
                    Request::Drain(reply) => {
                        let _ = reply.send(Ok(()));
                        continue;
                    }
                };
                let mut replies = vec![first_reply];
                let deadline = tokio::time::Instant::now() + Duration::from_millis(8);
                while replies.len() < 32 {
                    tokio::select! {
                        _ = tokio::time::sleep_until(deadline) => break,
                        next = receiver.recv() => match next {
                            Some(Request::Sent(next, reply)) => { ids.extend(next); replies.push(reply); }
                            Some(Request::Drain(reply)) => { replies.push(reply); break; }
                            None => break,
                        }
                    }
                }
                ids.sort_unstable();
                ids.dedup();
                let result = apply(&chat, ids).await;
                for reply in replies {
                    let result = match &result {
                        Ok(()) => Ok(()),
                        Err(error) => Err(Failure(error.0, error.1)),
                    };
                    let _ = reply.send(result);
                }
            }
        });
        Self { sender }
    }
    pub async fn sent(&self, ids: Vec<i64>) -> Result<(), Failure> {
        let (reply, response) = oneshot::channel();
        self.sender
            .send(Request::Sent(ids, reply))
            .await
            .map_err(|_| unavailable())?;
        response.await.map_err(|_| unavailable())?
    }
    /// Called after aborting/joining delivery jobs, before reconnecting or
    /// releasing their sender socket. Earlier accepted sends finish first.
    pub async fn drain(&self) -> Result<(), Failure> {
        let (reply, response) = oneshot::channel();
        self.sender
            .send(Request::Drain(reply))
            .await
            .map_err(|_| unavailable())?;
        response.await.map_err(|_| unavailable())?
    }
}
async fn apply(chat: &chat::State, ids: Vec<i64>) -> Result<(), Failure> {
    let _batch = chat.timings.time(Stage::DeliveryBatch);
    let pool = chat.timings.time(Stage::Pool);
    // Outgoing scheduling runs in the supervisor, within its existing SQL pool.
    let mut connection = chat.protocol_database.acquire().await?;
    drop(pool);
    sqlx::query("UPDATE federation_deliveries SET status='sent',attempts=attempts+1,error=NULL WHERE id=ANY($1) AND status='pending'")
        .bind(ids).execute(&mut *connection).await?;
    Ok(())
}
fn unavailable() -> Failure {
    Failure(
        StatusCode::SERVICE_UNAVAILABLE,
        "Delivery completion worker unavailable.",
    )
}
