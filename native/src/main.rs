mod account;
mod actors;
mod changes;
mod chat;
mod delivery_marks;
mod emoji;
mod federation;
mod images;
mod inbox;
mod messages;
mod metrics;
mod net;
mod outbox;
mod overview;
mod pages;
mod pool;
mod queue_heads;
mod read_marks;
mod schema;

use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{env, sync::Arc, time::Duration};
use subtle::ConstantTimeEq;

#[derive(Clone)]
struct Config {
    database: String,
    schema: Option<String>,
    secret: String,
    base: String,
    host: String,
    port: u16,
    workers: usize,
    connections: u32,
    channel_concurrency: usize,
    dev_auth: bool,
    policy_host: String,
    send_batch: u32,
    send_concurrency: u32,
    peer_rate: u32,
}
fn setting(name: &str, default: u32, min: u32, max: u32) -> Result<u32, String> {
    let value = env::var(name)
        .ok()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| default.to_string())
        .parse::<u32>()
        .map_err(|_| format!("Invalid {name}"))?;
    if value < min || value > max {
        return Err(format!("Invalid {name}"));
    }
    Ok(value)
}
impl Config {
    fn load() -> Result<Self, String> {
        let secret = env::var("NATIVE_BRIDGE_SECRET").unwrap_or_default();
        if !(43..=128).contains(&secret.len())
            || !secret
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        {
            return Err(
                "NATIVE_BRIDGE_SECRET must be a random base64url secret of at least 43 characters"
                    .into(),
            );
        }
        let database = env::var("DATABASE_URL").map_err(|_| "DATABASE_URL is required")?;
        let base = env::var("BASE_URL").map_err(|_| "BASE_URL is required")?;
        let parsed = reqwest::Url::parse(&base).map_err(|_| "Invalid BASE_URL")?;
        if !matches!(parsed.scheme(), "http" | "https")
            || !parsed.username().is_empty()
            || parsed.password().is_some()
            || parsed.path() != "/"
            || parsed.query().is_some()
            || parsed.fragment().is_some()
        {
            return Err("BASE_URL must be an HTTP(S) origin".into());
        }
        let schema = env::var("NATIVE_SCHEMA").ok();
        if schema.as_ref().is_some_and(|s| {
            s.is_empty()
                || s.len() > 63
                || !s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
        }) {
            return Err("Invalid NATIVE_SCHEMA".into());
        }
        let connections = setting("NATIVE_DATABASE_POOL", 4, 2, 32)?;
        let channel_concurrency = setting(
            "NATIVE_CHANNEL_CONCURRENCY",
            (connections / 2).max(1),
            1,
            connections - 1,
        )? as usize;
        Ok(Self {
            database,
            schema,
            secret,
            base: base.trim_end_matches('/').into(),
            host: env::var("NATIVE_HOST").unwrap_or_else(|_| "127.0.0.1".into()),
            port: setting("NATIVE_PORT", 8870, 0, 65535)? as u16,
            workers: setting("NATIVE_WORKERS", 4, 1, 32)? as usize,
            connections,
            channel_concurrency,
            dev_auth: env::var("DEV_AUTH").is_ok_and(|v| v == "true"),
            policy_host: env::var("HOST").unwrap_or_else(|_| "127.0.0.1".into()),
            send_batch: setting("FEDERATION_SEND_RATE", 20, 1, 1000)?,
            send_concurrency: setting("FEDERATION_SEND_CONCURRENCY", 4, 1, 32)?,
            peer_rate: setting("FEDERATION_PEER_SEND_RATE", 100, 0, 100000)?,
        })
    }
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Job {
    op: String,
    channel: String,
    token: String,
    csrf: String,
    body: Option<String>,
    seq: Option<i64>,
    message_id: Option<String>,
    before: Option<i64>,
    after: Option<i64>,
    refresh_stamp: Option<String>,
    #[serde(default)]
    refresh: bool,
    parent_id: Option<String>,
    topic_id: Option<String>,
    title: Option<String>,
    expected_edited_at: Option<String>,
    #[serde(default)]
    title_supplied: bool,
}
#[derive(Serialize, Deserialize)]
struct Reply {
    result: Value,
    user: String,
    changed: bool,
}
struct Failure(StatusCode, &'static str);
impl Failure {
    fn unsupported() -> Self {
        Self(StatusCode::NOT_IMPLEMENTED, "native_unsupported")
    }
}
impl From<sqlx::Error> for Failure {
    fn from(_: sqlx::Error) -> Self {
        Self(
            StatusCode::SERVICE_UNAVAILABLE,
            "Database operation failed.",
        )
    }
}
impl IntoResponse for Failure {
    fn into_response(self) -> Response {
        (self.0, Json(json!({ "error": self.1, "code": if self.0 == StatusCode::NOT_IMPLEMENTED { "native_unsupported" } else { "native_error" } }))).into_response()
    }
}
fn authorize(headers: &HeaderMap, secret: &str) -> Result<(), Failure> {
    let expected = format!("Bearer {secret}");
    let actual = headers
        .get("authorization")
        .map(|v| v.as_bytes())
        .unwrap_or_default();
    if !bool::from(actual.ct_eq(expected.as_bytes())) {
        return Err(Failure(
            StatusCode::UNAUTHORIZED,
            "Bridge authentication required.",
        ));
    }
    Ok(())
}
async fn shutdown() {
    #[cfg(unix)]
    {
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                .expect("signal handler");
        tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = terminate.recv() => {} }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}
async fn worker_shutdown() {
    use tokio::io::AsyncReadExt;
    let mut byte = [0u8; 1];
    let mut stdin = tokio::io::stdin();
    // Closing the supervisor's pipe ends children even after an ungraceful
    // Windows TerminateProcess, where Rust destructors cannot run in the parent.
    tokio::select! { _ = shutdown() => {}, _ = stdin.read(&mut byte) => {} }
}
#[tokio::main(worker_threads = 2)]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let config = Config::load().map_err(std::io::Error::other)?;
    if env::args().any(|arg| arg == "--check") {
        reqwest::Client::new()
            .get(format!("http://127.0.0.1:{}/health", config.port))
            .bearer_auth(&config.secret)
            .send()
            .await?
            .error_for_status()?;
        return Ok(());
    }
    if env::args().any(|arg| arg == "--worker") {
        let state = chat::State::connect(config, true).await?;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        println!(
            "{}",
            json!({"port":listener.local_addr()?.port(),"pid":std::process::id()})
        );
        axum::serve(listener, chat::router(state))
            .with_graceful_shutdown(worker_shutdown())
            .await?;
    } else {
        let workers = pool::Workers::start(config.clone()).await?;
        let protocol = outbox::State::new(chat::State::connect(config.clone(), false).await?);
        let change_relay = changes::start(
            protocol.chat.database.clone(),
            protocol.chat.notification_channel.clone(),
        );
        let state = Arc::new(Gateway {
            config: config.clone(),
            workers,
            protocol,
            admission: tokio::sync::Semaphore::new(config.workers * 128),
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(20))
                .redirect(reqwest::redirect::Policy::none())
                .build()?,
        });
        let listener = tokio::net::TcpListener::bind((config.host.as_str(), config.port)).await?;
        println!(
            "{}",
            json!({"port":listener.local_addr()?.port(),"pid":std::process::id(),"workers":state.workers.pids().await})
        );
        let router = Router::new()
            .route("/health", get(health))
            .route("/v1/chat", post(dispatch))
            .route("/v1/read", post(dispatch_read))
            .route("/v1/federation/tick", post(federation_tick))
            .route("/v1/federation/actor", post(actor_request))
            .route("/v1/federation/authenticate", post(federation_authenticate))
            .route("/v1/federation/receive", post(federation_receive))
            .route("/v1/events/sessions", post(event_sessions))
            .route("/v1/events/audience", post(event_audience))
            .route("/v1/account", post(account_request))
            .layer(DefaultBodyLimit::max(2 * 1024 * 1024))
            .with_state(state.clone());
        let result = axum::serve(listener, router)
            .with_graceful_shutdown(shutdown())
            .await;
        change_relay.abort();
        let _ = change_relay.await;
        state.workers.stop().await;
        result?;
    }
    Ok(())
}
struct Gateway {
    config: Config,
    workers: pool::Workers,
    client: reqwest::Client,
    admission: tokio::sync::Semaphore,
    protocol: Arc<outbox::State>,
}
async fn account_request(
    State(state): State<Arc<Gateway>>,
    headers: HeaderMap,
    Json(request): Json<account::Request>,
) -> Result<Json<Value>, Failure> {
    authorize(&headers, &state.config.secret)?;
    Ok(Json(state.protocol.account(request).await?))
}
async fn actor_request(
    State(state): State<Arc<Gateway>>,
    headers: HeaderMap,
    Json(request): Json<actors::Request>,
) -> Result<Json<Value>, Failure> {
    authorize(&headers, &state.config.secret)?;
    let _permit = state.admission.try_acquire().map_err(|_| {
        Failure(
            StatusCode::SERVICE_UNAVAILABLE,
            "Native request queue is full.",
        )
    })?;
    Ok(Json(state.protocol.public_actor(request).await?))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SessionHashes {
    hashes: Vec<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ChannelAudience {
    channels: Vec<String>,
}
async fn event_audience(
    State(state): State<Arc<Gateway>>,
    headers: HeaderMap,
    Json(input): Json<ChannelAudience>,
) -> Result<Json<Value>, Failure> {
    authorize(&headers, &state.config.secret)?;
    if input.channels.len() > 1000 || input.channels.iter().any(|id| id.len() > 2048) {
        return Err(Failure(
            StatusCode::BAD_REQUEST,
            "Invalid channel audience.",
        ));
    }
    let _permit = state
        .admission
        .try_acquire()
        .map_err(|_| Failure(StatusCode::SERVICE_UNAVAILABLE, "Native service is busy."))?;
    let rows:sqlx::types::Json<Value>=sqlx::query_scalar("SELECT COALESCE(jsonb_agg(to_jsonb(a)),'[]'::jsonb) FROM (SELECT c.id,c.visibility,c.mode,COALESCE(jsonb_agg(m.user_id) FILTER(WHERE m.user_id IS NOT NULL),'[]'::jsonb) AS members FROM channels c LEFT JOIN memberships m ON m.channel_id=c.id WHERE c.id=ANY($1) GROUP BY c.id,c.visibility,c.mode) a")
        .bind(input.channels).fetch_one(&state.protocol.chat.database).await?;
    Ok(Json(rows.0))
}
async fn event_sessions(
    State(state): State<Arc<Gateway>>,
    headers: HeaderMap,
    Json(input): Json<SessionHashes>,
) -> Result<Json<Value>, Failure> {
    authorize(&headers, &state.config.secret)?;
    if input.hashes.len() > 1000
        || input
            .hashes
            .iter()
            .any(|h| h.len() != 64 || !h.bytes().all(|b| b.is_ascii_hexdigit()))
    {
        return Err(Failure(StatusCode::BAD_REQUEST, "Invalid session review."));
    }
    let rows: sqlx::types::Json<Value>=sqlx::query_scalar("SELECT COALESCE(jsonb_agg(jsonb_build_object('hash',s.token_hash,'user',u.id,'approved',u.admission_status='approved','admin',u.admin<>0)),'[]'::jsonb) FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=ANY($1) AND s.expires_at>$2 AND u.banned=0")
        .bind(input.hashes).bind(chrono::Utc::now().timestamp_millis()).fetch_one(&state.protocol.chat.database).await?;
    Ok(Json(rows.0))
}
async fn federation_tick(
    State(state): State<Arc<Gateway>>,
    headers: HeaderMap,
    Json(input): Json<outbox::Tick>,
) -> Result<Json<Value>, Failure> {
    authorize(&headers, &state.config.secret)?;
    Ok(Json(state.protocol.tick(input).await?))
}
async fn federation_authenticate(
    State(state): State<Arc<Gateway>>,
    headers: HeaderMap,
    Json(input): Json<outbox::Authentication>,
) -> Result<Json<Value>, Failure> {
    authorize(&headers, &state.config.secret)?;
    Ok(Json(state.protocol.authenticate(input).await?))
}
async fn federation_receive(
    State(state): State<Arc<Gateway>>,
    headers: HeaderMap,
    Json(input): Json<outbox::Authentication>,
) -> Result<Response, Failure> {
    authorize(&headers, &state.config.secret)?;
    let _admission = state
        .admission
        .try_acquire()
        .map_err(|_| Failure(StatusCode::SERVICE_UNAVAILABLE, "Native service is busy."))?;
    let raw = base64::Engine::decode(
        &base64::engine::general_purpose::STANDARD,
        input.body.as_deref().unwrap_or(""),
    )
    .unwrap_or_default();
    let activity: Value = serde_json::from_slice(&raw).unwrap_or(Value::Null);
    let note = if activity["type"] == "Announce" {
        &activity["object"]["object"]
    } else {
        &activity["object"]
    };
    let actor = (if activity["type"] == "Follow" {
        activity["object"].as_str()
    } else {
        note["channel"].as_str()
    })
    .filter(|s| s.len() <= 8192)
    .unwrap_or("federation:unsupported");
    let prefix = format!("{}/actors/channels/", state.config.base);
    let key = if let Some(id) = actor.strip_prefix(&prefix) {
        id.to_owned()
    } else {
        sqlx::query_scalar::<_, String>("SELECT id FROM channels WHERE remote_actor=$1")
            .bind(actor)
            .fetch_optional(&state.protocol.chat.database)
            .await?
            .unwrap_or_else(|| actor.to_owned())
    };
    forward(&state, "/v1/federation/receive", &key, &input).await
}
async fn health(
    State(state): State<Arc<Gateway>>,
    headers: HeaderMap,
) -> Result<Json<Value>, Failure> {
    authorize(&headers, &state.config.secret)?;
    let mut pages = vec![];
    let mut stages = vec![];
    for port in state
        .workers
        .ports()
        .await
        .map_err(|_| Failure(StatusCode::SERVICE_UNAVAILABLE, "Worker unavailable."))?
    {
        let response = state
            .client
            .get(format!("http://127.0.0.1:{port}/health"))
            .bearer_auth(&state.config.secret)
            .send()
            .await
            .map_err(|_| Failure(StatusCode::SERVICE_UNAVAILABLE, "Worker unavailable."))?;
        if !response.status().is_success() {
            return Err(Failure(
                StatusCode::SERVICE_UNAVAILABLE,
                "Database unavailable.",
            ));
        }
        let value: Value = response
            .json()
            .await
            .map_err(|_| Failure(StatusCode::SERVICE_UNAVAILABLE, "Invalid worker health."))?;
        pages.push(value["pages"].clone());
        stages.push(value["stages"].clone());
    }
    Ok(Json(
        json!({"status":"ok","workers":state.workers.pids().await,"pages":pages,"stages":{"sender":state.protocol.chat.timings.snapshot(),"receivers":stages}}),
    ))
}
async fn dispatch(
    State(state): State<Arc<Gateway>>,
    headers: HeaderMap,
    Json(mut job): Json<Job>,
) -> Result<Response, Failure> {
    authorize(&headers, &state.config.secret)?;
    let _admission = state
        .admission
        .try_acquire()
        .map_err(|_| Failure(StatusCode::SERVICE_UNAVAILABLE, "Native service is busy."))?;
    if job.op == "edit" {
        job.channel = sqlx::query_scalar("SELECT channel_id FROM messages WHERE id=$1")
            .bind(job.message_id.as_deref())
            .fetch_optional(&state.protocol.chat.database)
            .await?
            .ok_or(Failure(StatusCode::NOT_FOUND, "Message not found."))?;
    }
    forward(&state, "/v1/chat", &job.channel, &job).await
}
async fn dispatch_read(
    State(state): State<Arc<Gateway>>,
    headers: HeaderMap,
    Json(job): Json<Job>,
) -> Result<Response, Failure> {
    authorize(&headers, &state.config.secret)?;
    if !matches!(job.op.as_str(), "messages" | "overview") {
        return Err(Failure::unsupported());
    }
    let _permit = state
        .admission
        .try_acquire()
        .map_err(|_| Failure(StatusCode::SERVICE_UNAVAILABLE, "Native service is busy."))?;
    forward(&state, "/v1/read", &job.channel, &job).await
}
async fn forward<T: Serialize>(
    state: &Gateway,
    path: &str,
    key: &str,
    job: &T,
) -> Result<Response, Failure> {
    let port = state
        .workers
        .port(key)
        .await
        .map_err(|_| Failure(StatusCode::SERVICE_UNAVAILABLE, "Worker unavailable."))?;
    // No automatic replay after a network error: the worker may already have
    // committed. A caller can explicitly replay the same message_id safely.
    let response = state
        .client
        .post(format!("http://127.0.0.1:{port}{path}"))
        .bearer_auth(&state.config.secret)
        .json(&job)
        .send()
        .await
        .map_err(|_| Failure(StatusCode::SERVICE_UNAVAILABLE, "Worker unavailable."))?;
    let status = response.status();
    if !response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.starts_with("application/json"))
    {
        return Err(Failure(StatusCode::BAD_GATEWAY, "Invalid worker response."));
    }
    let value = response
        .bytes()
        .await
        .map_err(|_| Failure(StatusCode::BAD_GATEWAY, "Invalid worker response."))?;
    if value.len() > 4 * 1024 * 1024 + 4096 {
        return Err(Failure(
            StatusCode::BAD_GATEWAY,
            "Worker response is too large.",
        ));
    }
    Ok((status, [("content-type", "application/json")], value).into_response())
}
