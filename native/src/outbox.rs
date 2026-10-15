//! Async FWDXP delivery, sharing an instance lock across native supervisors.
//! Individual inbox recipients retain audit and retry rows; negotiated channel
//! broadcasts use the channel event log. Discovery happens outside
//! database transactions; current delivery policy is read again before sending.
use crate::{Config, Failure, chat, federation::Signer, metrics::Stage, net};
use axum::http::{HeaderMap, StatusCode};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{Acquire, Row, types::Json};
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Weak},
    time::{Duration, Instant},
};
use tokio::{sync::Mutex, task::JoinSet};

pub struct State {
    pub(crate) chat: Arc<chat::State>,
    pub(crate) transport: net::Transport,
    pub(crate) signer: Signer,
    sender: Mutex<Sender>,
    completions: crate::delivery_marks::Batch,
    sends: Mutex<HashMap<String, Vec<i64>>>,
    freshness: Mutex<HashMap<String, (String, i64)>>,
    actors: Mutex<HashMap<String, Weak<Mutex<()>>>>,
}
#[derive(Clone)]
struct Delivery {
    id: i64,
    recipient: String,
    attempts: i64,
    outgoing: String,
    activity: Arc<Activity>,
    signer: String,
    user: Option<String>,
    channel: Option<String>,
    purpose: String,
}
struct Activity {
    body: String,
    announce: bool,
}
// Only immutable plain channel Creates may pass pending work in other channels.
// Updates, deletes, subscriptions and all other state changes remain recipient
// barriers; retries in the same channel retain their order.
fn plain_create(alias: &str) -> String {
    format!(
        "({alias}.channel_id IS NOT NULL AND {alias}.purpose IN ('post','relay') AND CASE WHEN {alias}.activity::jsonb->>'type'='Announce' THEN {alias}.activity::jsonb->'object' ELSE {alias}.activity::jsonb END @> '{{\"type\":\"Create\",\"object\":{{\"type\":\"Note\"}}}}'::jsonb)"
    )
}
fn predecessor() -> String {
    format!(
        "(SELECT 1 FROM federation_deliveries earlier JOIN federation_outgoing eo ON eo.id=earlier.activity_id WHERE earlier.recipient=d.recipient AND earlier.id<d.id AND earlier.status='pending' AND (eo.channel_id IS NOT DISTINCT FROM o.channel_id OR NOT {} OR NOT {}) LIMIT 1) IS NULL",
        plain_create("o"),
        plain_create("eo")
    )
}
#[derive(Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
pub struct Authentication {
    pub headers: HashMap<String, String>,
    pub method: String,
    pub target: String,
    pub body: Option<String>,
    #[serde(default)]
    pub stream: Option<StreamCheckpoint>,
}
#[derive(Clone, Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
pub struct StreamCheckpoint {
    pub actor: String,
    pub channel: String,
    pub follow: String,
    pub after: i64,
    pub cursor: i64,
}
impl State {
    pub fn new(chat: Arc<chat::State>) -> Arc<Self> {
        let completions = crate::delivery_marks::Batch::start(chat.clone());
        Arc::new(Self {
            chat,
            completions,
            transport: net::Transport::default(),
            signer: Signer::default(),
            sender: Mutex::new(Sender::default()),
            sends: Mutex::new(HashMap::new()),
            freshness: Mutex::new(HashMap::new()),
            actors: Mutex::new(HashMap::new()),
        })
    }
    pub(crate) async fn connection(
        &self,
    ) -> Result<sqlx::pool::PoolConnection<sqlx::Postgres>, Failure> {
        let _timer = self.chat.timings.time(Stage::Pool);
        if let Some(connection) = self.chat.protocol_database.try_acquire() {
            return Ok(connection);
        }
        // The reservation is a minimum, not a throughput ceiling. Borrow only
        // immediately idle foreground capacity; never queue protocol work behind
        // foreground requests or increase the configured connection budget.
        if self.chat.protocol_reserved
            && let Some(connection) = self.chat.database.try_acquire()
        {
            let _borrow = self.chat.timings.time(Stage::PoolBorrow);
            return Ok(connection);
        }
        Ok(self.chat.protocol_database.acquire().await?)
    }
    pub(crate) fn config(&self) -> &Config {
        &self.chat.config
    }
    pub(crate) async fn enabled(&self) -> Result<(), Failure> {
        let enabled: Option<String> = sqlx::query_scalar(
            "SELECT value FROM instance_settings WHERE key='federation_enabled'",
        )
        .fetch_optional(&mut *self.connection().await?)
        .await?;
        if enabled.as_deref() != Some("true") {
            return Err(Failure(
                StatusCode::FORBIDDEN,
                "Federation is disabled by this instance administrator.",
            ));
        }
        Ok(())
    }
    pub(crate) async fn allowed(&self, actor: &str) -> Result<reqwest::Url, Failure> {
        let url = net::peer_url(actor, self.config())?;
        let blocked: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM federation_blocks WHERE target=$1 OR target=$2)",
        )
        .bind(actor)
        .bind(url.origin().ascii_serialization())
        .fetch_one(&mut *self.connection().await?)
        .await?;
        if blocked {
            return Err(Failure(
                StatusCode::FORBIDDEN,
                "This remote instance or actor is blocked.",
            ));
        }
        Ok(url)
    }
    pub async fn actor(&self, id: &str) -> Result<Value, Failure> {
        let url = net::peer_url(id, self.config())?;
        let lock = {
            let mut locks = self.actors.lock().await;
            if locks.len() >= 4096 {
                locks.retain(|_, v| v.strong_count() > 0);
            }
            if let Some(lock) = locks.get(id).and_then(Weak::upgrade) {
                lock
            } else {
                let lock = Arc::new(Mutex::new(()));
                locks.insert(id.to_owned(), Arc::downgrade(&lock));
                lock
            }
        };
        let _guard = lock.lock().await;
        let row = sqlx::query("SELECT a.document,a.fetched_at,EXISTS(SELECT 1 FROM instance_settings WHERE key='federation_enabled' AND value='true') AS enabled,EXISTS(SELECT 1 FROM federation_blocks WHERE target=$1 OR target=$2) AS blocked FROM (SELECT 1) seed LEFT JOIN federation_actors a ON a.id=$1")
            .bind(id)
            .bind(url.origin().ascii_serialization())
            .fetch_one(&mut *self.connection().await?)
            .await?;
        if !row.get::<bool, _>("enabled") {
            return Err(Failure(
                StatusCode::FORBIDDEN,
                "Federation is disabled by this instance administrator.",
            ));
        }
        if row.get::<bool, _>("blocked") {
            return Err(Failure(
                StatusCode::FORBIDDEN,
                "This remote instance or actor is blocked.",
            ));
        }
        let document: Option<String> = row.get("document");
        if let Some(document) = &document {
            let hash = format!("{:x}", Sha256::digest(document.as_bytes()));
            let fresh = self
                .freshness
                .lock()
                .await
                .get(id)
                .filter(|(h, _)| h == &hash)
                .map(|(_, at)| *at)
                .unwrap_or_else(|| row.get("fetched_at"));
            if fresh > now() - 60000 {
                return serde_json::from_str(document)
                    .map_err(|_| Failure(StatusCode::BAD_GATEWAY, "Invalid cached actor."));
            }
        }
        let actor = self.transport.json(self.config(), &url).await?;
        if actor["id"].as_str() != Some(id)
            || !matches!(actor["type"].as_str(), Some("Person" | "Group"))
            || actor
                .get("fwdxpVersion")
                .filter(|v| !v.is_null())
                .or_else(|| actor.get("archipelVersion"))
                .and_then(Value::as_f64)
                != Some(1.0)
            || actor["publicKey"]["owner"].as_str() != Some(id)
            || actor["publicKey"]["id"].as_str() != Some(format!("{id}#main-key").as_str())
            || !actor["publicKey"]["publicKeyPem"]
                .as_str()
                .is_some_and(|s| s.len() <= 10000)
        {
            return Err(Failure(
                StatusCode::BAD_REQUEST,
                "This actor does not support FWDXP federation.",
            ));
        }
        if self
            .allowed(actor["inbox"].as_str().unwrap_or(""))
            .await?
            .origin()
            != url.origin()
        {
            return Err(Failure(
                StatusCode::BAD_REQUEST,
                "An actor inbox must be on its home instance.",
            ));
        }
        net::public_key(actor["publicKey"]["publicKeyPem"].as_str().unwrap_or(""))?;
        // Optional images cannot reject an otherwise valid actor/message.
        let _ = self.sync_avatar(&actor).await;
        // Do not publish a stale fetch after instance/actor revocation.
        self.enabled().await?;
        self.allowed(id).await?;
        let next = actor.to_string();
        if document.as_deref() != Some(&next) {
            sqlx::query("INSERT INTO federation_actors(id,document,fetched_at) VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET document=excluded.document,fetched_at=excluded.fetched_at")
                .bind(id).bind(&next).bind(now()).execute(&mut *self.connection().await?).await?;
        }
        let mut freshness = self.freshness.lock().await;
        if freshness.len() >= 4096
            && let Some(old) = freshness.keys().next().cloned()
        {
            freshness.remove(&old);
        }
        freshness.insert(
            id.to_owned(),
            (format!("{:x}", Sha256::digest(next.as_bytes())), now()),
        );
        Ok(actor)
    }
    pub(crate) async fn allowed_many(&self, actors: &[&str]) -> Result<Vec<reqwest::Url>, Failure> {
        let urls: Vec<_> = actors
            .iter()
            .map(|actor| net::peer_url(actor, self.config()))
            .collect::<Result<_, _>>()?;
        let mut targets = Vec::with_capacity(actors.len() * 2);
        for (actor, url) in actors.iter().zip(&urls) {
            targets.push((*actor).to_owned());
            targets.push(url.origin().ascii_serialization());
        }
        targets.sort();
        targets.dedup();
        let blocked: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM federation_blocks WHERE target=ANY($1))",
        )
        .bind(targets)
        .fetch_one(&mut *self.connection().await?)
        .await?;
        if blocked {
            return Err(Failure(
                StatusCode::FORBIDDEN,
                "This remote instance or actor is blocked.",
            ));
        }
        Ok(urls)
    }
    async fn sync_avatar(&self, actor: &Value) -> Result<(), Failure> {
        if actor["type"] != "Person" {
            return Ok(());
        }
        let id = actor["id"]
            .as_str()
            .ok_or(Failure(StatusCode::BAD_REQUEST, "Invalid actor."))?;
        if actor["icon"].is_null() {
            // A no-avatar refresh is common. Delete and its durable notice are
            // one atomic statement, including the no-op case, without a separate
            // BEGIN/COMMIT round trip for every fetched author document.
            sqlx::query("WITH removed AS (DELETE FROM remote_avatars WHERE peer=$1 RETURNING peer), notice AS (INSERT INTO native_changes(payload) SELECT $2 WHERE EXISTS(SELECT 1 FROM removed) RETURNING seq) SELECT COUNT(*) FROM removed")
                .bind(id).bind(json!([{"table":"remote_avatars","rows":[]}]).to_string())
                .execute(&mut *self.connection().await?).await?;
            return Ok(());
        }
        if actor["icon"]["type"] != "Image" {
            return Ok(());
        }
        let url = self
            .allowed(actor["icon"]["url"].as_str().unwrap_or(""))
            .await?;
        if url.origin() != self.allowed(id).await?.origin() {
            return Ok(());
        }
        let source: Option<String> =
            sqlx::query_scalar("SELECT source FROM remote_avatars WHERE peer=$1")
                .bind(id)
                .fetch_optional(&mut *self.connection().await?)
                .await?;
        if source.as_deref() == Some(url.as_str()) {
            return Ok(());
        }
        let mut headers = HeaderMap::new();
        headers.insert(
            "accept",
            "image/png,image/jpeg,image/gif,image/webp"
                .parse()
                .expect("header"),
        );
        let image = self
            .transport
            .request(
                self.config(),
                &url,
                reqwest::Method::GET,
                headers,
                None,
                2097152,
                Duration::from_secs(3),
            )
            .await?
            .body;
        let mime = crate::images::mime(&image).ok_or(Failure(
            StatusCode::BAD_REQUEST,
            "Unsupported profile picture.",
        ))?;
        self.enabled().await?;
        self.allowed(id).await?;
        let revision = format!("{:x}", Sha256::digest(STANDARD.encode(&image).as_bytes()));
        let mut connection = self.connection().await?;
        let mut tx = connection.begin().await?;
        sqlx::query("INSERT INTO remote_avatars(id,peer,revision,mime,image,source,fetched_at) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(peer) DO UPDATE SET revision=excluded.revision,mime=excluded.mime,image=excluded.image,source=excluded.source,fetched_at=excluded.fetched_at")
            .bind(format!("{:x}",Sha256::digest(id.as_bytes()))).bind(id).bind(revision).bind(mime).bind(image).bind(url.as_str()).bind(now()).execute(&mut *tx).await?;
        crate::changes::append(&mut tx, json!([{"table":"remote_avatars","rows":[]}])).await?;
        tx.commit().await?;
        Ok(())
    }
    pub async fn authenticate(&self, input: Authentication) -> Result<Value, Failure> {
        let mut headers = HeaderMap::new();
        for (key, value) in input.headers {
            headers.insert(
                key.parse::<axum::http::HeaderName>()
                    .map_err(|_| Failure(StatusCode::BAD_REQUEST, "Invalid header."))?,
                value
                    .parse()
                    .map_err(|_| Failure(StatusCode::BAD_REQUEST, "Invalid header."))?,
            );
        }
        let values = net::signature_key(&headers)?;
        let id = values
            .get("keyId")
            .expect("validated key")
            .strip_suffix("#main-key")
            .expect("suffix");
        let actor = self.actor(id).await?;
        let body = input
            .body
            .map(|s| STANDARD.decode(s))
            .transpose()
            .map_err(|_| Failure(StatusCode::BAD_REQUEST, "Invalid body encoding."))?;
        net::verify_request(
            &headers,
            &input.method,
            &input.target,
            &actor,
            body.as_deref(),
        )?;
        let base = reqwest::Url::parse(&self.config().base).expect("validated base");
        if headers.get("host").and_then(|v| v.to_str().ok())
            != Some(&base[url::Position::BeforeHost..url::Position::AfterPort])
        {
            return Err(Failure(
                StatusCode::UNAUTHORIZED,
                "Signed host must match this instance.",
            ));
        }
        self.allowed(id).await?;
        Ok(actor)
    }
    async fn policy(
        &self,
        delivery: &Delivery,
        recipients: &[Delivery],
    ) -> Result<Vec<(i64, Result<(), Failure>)>, Failure> {
        let _timer = self.chat.timings.time(Stage::Policy);
        // One fresh statement for common authority. Sender tasks share the
        // supervisor pool with SSE/actor reads; serial round trips here otherwise
        // consume that budget twice per delivery (before and after discovery).
        let authority = sqlx::query(
            "SELECT EXISTS(SELECT 1 FROM instance_settings WHERE key='federation_enabled' AND value='true') AS enabled,
                to_jsonb(c) AS channel,to_jsonb(u) AS account,
                CASE WHEN $4='subscribe' THEN EXISTS(SELECT 1 FROM federation_subscriptions WHERE channel_id=$1 AND user_id=$2 AND follow_id=$3 AND status<>'left') ELSE false END AS subscribed,
                CASE WHEN $4 IN ('post','moderate') THEN EXISTS(SELECT 1 FROM memberships WHERE channel_id=$1 AND user_id=$2) ELSE false END AS member,
                CASE WHEN $4 IN ('relay','moderation') AND u.remote_actor IS NOT NULL THEN EXISTS(SELECT 1 FROM channel_rules WHERE channel_id=$1 AND user_id=$2 AND rule='block') ELSE false END AS author_blocked
             FROM (SELECT 1) seed LEFT JOIN channels c ON c.id=$1 LEFT JOIN users u ON u.id=$2"
        ).bind(&delivery.channel).bind(&delivery.user).bind(&delivery.outgoing).bind(&delivery.purpose)
            .fetch_one(&mut *self.connection().await?).await?;
        if !authority.get::<bool, _>("enabled") {
            return Err(Failure(
                StatusCode::FORBIDDEN,
                "Federation is disabled by this instance administrator.",
            ));
        }
        let channel: Option<Json<Value>> = authority.get("channel");
        let user: Option<Json<Value>> = authority.get("account");
        let channel = channel.map(|j| j.0).unwrap_or(Value::Null);
        let user = user.map(|j| j.0).unwrap_or(Value::Null);
        let activity: Value = serde_json::from_str(&delivery.activity.body)
            .map_err(|_| Failure(StatusCode::BAD_REQUEST, "Invalid queued activity."))?;
        if delivery.channel.is_some() && channel.is_null() {
            return Err(Failure(StatusCode::NOT_FOUND, "Channel not found."));
        }
        if delivery.user.is_some() && user.is_null() {
            return Err(Failure(StatusCode::NOT_FOUND, "Account not found."));
        }
        let active = || {
            if user["banned"].as_i64() != Some(0) || user["admission_status"] != "approved" {
                Err(Failure(StatusCode::FORBIDDEN, "Account is not active."))
            } else {
                Ok(())
            }
        };
        let require = |flags: &[&str]| -> Result<(), Failure> {
            active()?;
            if !user["remote_actor"].is_null()
                || flags
                    .iter()
                    .any(|f| user[*f].as_i64().is_none_or(|n| n == 0))
            {
                return Err(Failure(
                    StatusCode::FORBIDDEN,
                    "Federation permission revoked.",
                ));
            }
            Ok(())
        };
        if delivery.purpose != "cleanup" {
            if !channel.is_null()
                && channel["federation_enabled"]
                    .as_i64()
                    .is_none_or(|n| n == 0)
            {
                return Err(Failure(
                    StatusCode::FORBIDDEN,
                    "Channel federation disabled.",
                ));
            }
            match delivery.purpose.as_str() {
                "membership" => {}
                "subscribe" => {
                    require(&["federation_subscribe", "federation_receive"])?;
                    if !authority.get::<bool, _>("subscribed") {
                        return Err(Failure(StatusCode::FORBIDDEN, "Subscription withdrawn."));
                    }
                }
                "relay" | "moderation" => {
                    if let Some(actor) = user["remote_actor"].as_str() {
                        active()?;
                        self.allowed(actor).await?;
                        if authority.get::<bool, _>("author_blocked") {
                            return Err(Failure(
                                StatusCode::FORBIDDEN,
                                "Author blocked from channel.",
                            ));
                        }
                    } else if delivery.purpose == "relay" {
                        require(&["federation_send", "federation_post"])?;
                    } else if !user.is_null() {
                        active()?;
                    }
                }
                "post" | "moderate" => {
                    if delivery.purpose == "post" {
                        require(&["federation_send", "federation_post", "federation_subscribe"])?;
                    } else {
                        active()?;
                    }
                    if !authority.get::<bool, _>("member") {
                        return Err(Failure(StatusCode::FORBIDDEN, "No longer subscribed."));
                    }
                }
                "profile" => {
                    active()?;
                    if ![
                        "federation_send",
                        "federation_receive",
                        "federation_subscribe",
                        "federation_post",
                    ]
                    .iter()
                    .any(|f| user[*f].as_i64().is_some_and(|n| n != 0))
                    {
                        return Err(Failure(
                            StatusCode::FORBIDDEN,
                            "Profile federation is disabled for this account.",
                        ));
                    }
                }
                "direct" => require(&["federation_send"])?,
                _ => {
                    return Err(Failure(
                        StatusCode::BAD_REQUEST,
                        "Unknown delivery purpose.",
                    ));
                }
            }
        }
        let needs_follow = matches!(delivery.purpose.as_str(), "relay" | "moderation")
            || delivery.purpose == "membership" && activity["type"] == "Accept";
        let mut valid = Vec::new();
        let mut result = Vec::new();
        for recipient in recipients {
            match net::peer_url(&recipient.recipient, self.config()) {
                Ok(url) => valid.push((
                    recipient.id,
                    recipient.recipient.clone(),
                    url.origin().ascii_serialization(),
                )),
                Err(error) => result.push((recipient.id, Err(error))),
            }
        }
        let ids: Vec<_> = valid.iter().map(|v| v.0).collect();
        let actors: Vec<_> = valid.iter().map(|v| v.1.clone()).collect();
        let origins: Vec<_> = valid.iter().map(|v| v.2.clone()).collect();
        let rows = sqlx::query("WITH candidates(id,actor,origin) AS (SELECT * FROM unnest($1::bigint[],$2::text[],$3::text[])) SELECT c.id, EXISTS(SELECT 1 FROM federation_blocks b WHERE b.target=c.actor OR b.target=c.origin) AS blocked, EXISTS(SELECT 1 FROM federation_follows f JOIN users u ON u.remote_actor=f.actor WHERE f.channel_id=$4 AND f.actor=c.actor AND f.status='accepted' AND u.banned=0 AND u.admission_status='approved' AND NOT EXISTS(SELECT 1 FROM channel_rules r WHERE r.channel_id=f.channel_id AND r.user_id=u.id AND r.rule='block')) AS admitted, EXISTS(SELECT 1 FROM user_blocks b WHERE b.user_id=$5 AND b.peer=c.actor) AS user_blocked FROM candidates c")
            .bind(ids).bind(actors).bind(origins).bind(&delivery.channel).bind(&delivery.user).fetch_all(&mut *self.connection().await?).await?;
        for row in rows {
            let error = if row.get::<bool, _>("blocked") {
                Some(Failure(
                    StatusCode::FORBIDDEN,
                    "This remote instance or actor is blocked.",
                ))
            } else if needs_follow && !row.get::<bool, _>("admitted") {
                Some(Failure(
                    StatusCode::FORBIDDEN,
                    "Recipient no longer has channel access.",
                ))
            } else if matches!(delivery.purpose.as_str(), "direct" | "profile")
                && row.get::<bool, _>("user_blocked")
            {
                Some(Failure(StatusCode::FORBIDDEN, "You blocked this user."))
            } else {
                None
            };
            result.push((row.get("id"), error.map_or(Ok(()), Err)));
        }
        Ok(result)
    }
    async fn allowance(&self, recipient: &str, spend: bool) -> Result<bool, Failure> {
        let url = net::peer_url(recipient, self.config())?;
        let host = url[url::Position::BeforeHost..url::Position::AfterPort].to_owned();
        let mut sends = self.sends.lock().await;
        if sends.len() >= 4096 {
            sends.retain(|_, times| times.last().is_some_and(|at| *at > now() - 60000));
        }
        let recent = sends.entry(host).or_default();
        recent.retain(|at| *at > now() - 60000);
        if self.config().peer_rate != 0 && recent.len() >= self.config().peer_rate as usize {
            return Ok(false);
        }
        if spend {
            recent.push(now());
        }
        Ok(true)
    }
    async fn finish_error(&self, rows: &[Delivery], error: Failure) -> Result<(), Failure> {
        let _timer = self.chat.timings.time(Stage::Finish);
        let permanent = matches!(error.0.as_u16(), 400 | 401 | 403 | 404 | 409 | 410 | 413);
        // Recheck after network errors so revoked rows are cancelled, not retried.
        let policy = self.policy(&rows[0], rows).await;
        let allowed: HashSet<i64> = match policy {
            Ok(policy) => policy,
            Err(error) if matches!(error.0.as_u16(), 400 | 401 | 403 | 404 | 409 | 410) => {
                Vec::new()
            }
            Err(error) => return Err(error),
        }
        .into_iter()
        .filter_map(|(id, r)| r.ok().map(|_| id))
        .collect();
        let mut connection = self.connection().await?;
        let mut tx = connection.begin().await?;
        let mut ids = Vec::with_capacity(rows.len());
        let mut statuses = Vec::with_capacity(rows.len());
        let mut deadlines = Vec::with_capacity(rows.len());
        let at = now();
        for row in rows {
            let status = if !allowed.contains(&row.id) {
                "cancelled"
            } else if permanent || row.attempts >= 11 {
                "failed"
            } else {
                "pending"
            };
            ids.push(row.id);
            statuses.push(status);
            deadlines.push(at+5000i64.saturating_mul(1i64.checked_shl(row.attempts.min(20) as u32).unwrap_or(i64::MAX)).min(3600000));
        }
        sqlx::query("UPDATE federation_deliveries d SET status=p.status,attempts=d.attempts+1,next_attempt=p.deadline,error=$4 FROM unnest($1::bigint[],$2::text[],$3::bigint[]) AS p(id,status,deadline) WHERE d.id=p.id AND d.status='pending'")
            .bind(ids).bind(statuses).bind(deadlines).bind(error.1).execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(())
    }
    async fn deliver(
        self: Arc<Self>,
        delivery: Delivery,
        peers: Vec<Delivery>,
    ) -> Result<(u64, u64), Failure> {
        let _timer = self.chat.timings.time(Stage::Delivery);
        let mut group = vec![delivery.clone()];
        let result = async {
            for (_,policy) in self.policy(&delivery,&group).await? { policy?; }
            let discovery_timer = self.chat.timings.time(Stage::Discovery);
            let cached=Arc::new(self.cached_inboxes(&peers).await?);
            let destination=if let Some(url)=cached.get(&delivery.recipient) {url.clone()}
                else {let actor=self.actor(&delivery.recipient).await?;self.allowed(actor["inbox"].as_str().unwrap_or("")).await?};
            let url=self.allowed(destination.as_str()).await?;
            let mut candidates = peers.into_iter().filter(|p| p.id != delivery.id);
            loop {
                let mut jobs = JoinSet::new();
                for peer in candidates.by_ref().take(8) {
                    let state = self.clone(); let destination = url.clone();let cached=cached.clone();
                    jobs.spawn(async move {
                        let inbox=if let Some(inbox)=cached.get(&peer.recipient){inbox.clone()}
                            else {let actor = state.actor(&peer.recipient).await.ok()?;state.allowed(actor["inbox"].as_str()?).await.ok()?};
                        (inbox == destination).then_some(peer) });
                }
                if jobs.is_empty() { break; }
                while let Some(result) = jobs.join_next().await { if let Ok(Some(peer)) = result { group.push(peer); } }
            }
            drop(discovery_timer);
            let policy = match self.policy(&delivery,&group).await {
                Ok(policy) => policy,
                Err(error) if matches!(error.0.as_u16(),400|401|403|404|409|410) =>
                    group.iter().map(|row|(row.id,Err(Failure(error.0,error.1)))).collect(),
                Err(error) => return Err(error),
            };
            let mut authorized = HashSet::new();
            let mut cancelled = Vec::new();
            let mut errors = Vec::new();
            for (id,result) in policy { match result { Ok(()) => { authorized.insert(id); }, Err(error) => {
                cancelled.push(id); errors.push(error.1);
            } } }
            if !cancelled.is_empty() {
                sqlx::query("UPDATE federation_deliveries d SET status='cancelled',error=p.error FROM unnest($1::bigint[],$2::text[]) AS p(id,error) WHERE d.id=p.id AND d.status='pending'")
                    .bind(cancelled).bind(errors).execute(&mut *self.connection().await?).await?;
            }
            group.retain(|row|authorized.contains(&row.id));
            if group.is_empty() || !self.allowance(&delivery.recipient,true).await? { return Ok((0,0)); }
            self.allowed(url.as_str()).await?;
            let signing_timer = self.chat.timings.time(Stage::Signing);
            let headers = self.signer.headers(&self.chat.protocol_database,&url,&delivery.signer,delivery.activity.body.as_bytes()).await?;
            drop(signing_timer);
            let http_timer = self.chat.timings.time(Stage::Http);
            let result = self.transport.request(self.config(),&url,reqwest::Method::POST,headers,Some(delivery.activity.body.as_bytes().to_vec()),262144,Duration::from_secs(15)).await;
            drop(http_timer);
            if let Err(error) = result { self.finish_error(&group,error).await?; return Ok((1,group.len() as u64)); }
            let _finish_timer = self.chat.timings.time(Stage::Finish);
            let ids: Vec<_> = group.iter().map(|r|r.id).collect();
            self.completions.sent(ids).await?;
            Ok((1,group.len() as u64))
        }.await;
        match result {
            Ok(result) => Ok(result),
            Err(error) => {
                if !group.is_empty() {
                    self.finish_error(&group, error).await?;
                }
                Ok((0, 0))
            }
        }
    }
    async fn cached_inboxes(
        &self,
        peers: &[Delivery],
    ) -> Result<HashMap<String, reqwest::Url>, Failure> {
        let ids: Vec<_> = peers.iter().map(|p| p.recipient.clone()).collect();
        let rows =
            sqlx::query("SELECT id,document,fetched_at FROM federation_actors WHERE id=ANY($1)")
                .bind(ids)
                .fetch_all(&mut *self.connection().await?)
                .await?;
        let freshness = self.freshness.lock().await;
        let mut result = HashMap::new();
        for row in rows {
            let id: String = row.get("id");
            let document: &str = row.get("document");
            let hash = format!("{:x}", Sha256::digest(document.as_bytes()));
            let at = freshness
                .get(&id)
                .filter(|(h, _)| h == &hash)
                .map(|(_, at)| *at)
                .unwrap_or_else(|| row.get("fetched_at"));
            if at <= now() - 60000 {
                continue;
            }
            let Ok(actor) = serde_json::from_str::<Value>(document) else {
                continue;
            };
            let Some(inbox) = actor["inbox"].as_str() else {
                continue;
            };
            let (Ok(recipient), Ok(inbox)) = (
                net::peer_url(&id, self.config()),
                net::peer_url(inbox, self.config()),
            ) else {
                continue;
            };
            if recipient.origin() == inbox.origin() {
                result.insert(id, inbox);
            }
        }
        // Only actor documents are cached. Policy (including each follower's
        // current block/admission) is still queried after discovery, before POST.
        Ok(result)
    }
    pub async fn tick(self: &Arc<Self>, input: Tick) -> Result<Value, Failure> {
        let Ok(mut sender) = self.sender.try_lock() else {
            return Ok(json!({"requests":0,"recipientAttempts":0,"busy":true}));
        };
        // In-flight jobs and their claims survive a scheduling tick. The session
        // lock stays on a dedicated socket until all jobs finish, including the
        // gaps between timer calls. Cancelling an RPC does not discard this state.
        // An RPC cancelled while trying the session lock may have acquired it
        // without receiving its acknowledgement. Close that socket before retry
        // rather than recursively acquiring the lock on the same session.
        if sender.locking {
            sender.connection.take();
            sender.locking = false;
        }
        if sender.connection.is_none() {
            sender.connection = Some(self.connection().await?.detach());
        }
        let acquired = if sender.locked {
            sqlx::query("SELECT 1")
                .execute(sender.connection.as_mut().expect("sender socket"))
                .await
                .map(|_| true)
                .map_err(Failure::from)
        } else {
            async {
                let schema: String = sqlx::query_scalar("SELECT current_schema()")
                    .fetch_one(sender.connection.as_mut().expect("sender socket"))
                    .await?;
                sender.key = i64::from_be_bytes(
                    Sha256::digest(format!("{schema}:federation-sender").as_bytes())[..8]
                        .try_into()
                        .expect("hash"),
                );
                sender.locking = true;
                let key = sender.key;
                let result = sqlx::query_scalar::<_, bool>("SELECT pg_try_advisory_lock($1)")
                    .bind(key)
                    .fetch_one(sender.connection.as_mut().expect("sender socket"))
                    .await
                    .map_err(Failure::from);
                sender.locking = false;
                result
            }
            .await
        };
        match acquired {
            Ok(false) => return Ok(json!({"requests":0,"recipientAttempts":0,"busy":true})),
            Ok(true) => sender.locked = true,
            Err(error) => {
                sender.connection.take();
                // A lost lock socket cannot authorize further sending. Abort and
                // join before reconnecting; durable pending rows remain retryable.
                sender.abort().await;
                let _ = self.completions.drain().await;
                sender.locked = false;
                return Err(error);
            }
        }
        let result = self.round(&mut sender, input).await;
        if sender.jobs.is_empty() {
            // Cancelled jobs may have submitted a successful completion before
            // their join was aborted. Finish those before giving up this socket.
            let drained = self.completions.drain().await;
            let mut connection = sender.connection.take().expect("sender socket");
            sender.locked = false;
            if sqlx::query_scalar::<_, bool>("SELECT pg_advisory_unlock($1)")
                .bind(sender.key)
                .fetch_one(&mut connection)
                .await
                .is_ok_and(|released| released)
            {
                sender.connection = Some(connection);
            }
            drained?;
        }
        result
    }
    async fn round(self: &Arc<Self>, sender: &mut Sender, input: Tick) -> Result<Value, Failure> {
        let batch: Option<String> = sqlx::query_scalar(
            "SELECT value FROM instance_settings WHERE key='federation_send_batch'",
        )
        .fetch_optional(&mut *self.connection().await?)
        .await?;
        let batch = batch
            .and_then(|v| v.parse::<u32>().ok())
            .unwrap_or(self.config().send_batch)
            .clamp(1, 1000);
        let deadline = tokio::time::Instant::now() + Duration::from_secs(1);
        let mut exhausted = HashSet::<String>::new();
        let mut work = 0;
        let mut selection_ms = 0;
        loop {
            while let Some(result) = sender.jobs.try_join_next() {
                sender.complete(result).await?;
            }
            if input.drain_only || work >= batch || tokio::time::Instant::now() >= deadline {
                if input.wait || input.drain_only {
                    while let Some(result) = sender.jobs.join_next().await {
                        sender.complete(result).await?;
                    }
                }
                break;
            }
            if sender.jobs.len() >= self.config().send_concurrency as usize {
                tokio::select! {
                    result = sender.jobs.join_next() => {
                        if let Some(result) = result { sender.complete(result).await?; }
                    }
                    _ = tokio::time::sleep_until(deadline) => {}
                }
                continue;
            }
            let ids: Vec<_> = sender.claimed.iter().copied().collect();
            let actors: Vec<_> = sender.claimed_actors.iter().cloned().collect();
            let omitted: Vec<_> = exhausted
                .iter()
                .map(|origin| {
                    format!(
                        "{}/%",
                        origin
                            .replace('\\', "\\\\")
                            .replace('%', "\\%")
                            .replace('_', "\\_")
                    )
                })
                .collect();
            // Cache only the first pending ID per recipient/channel. Queue
            // triggers advance it atomically for both native and compatibility
            // writers. Eligibility, cross-channel barriers and final authority
            // are still read fresh from the durable rows.
            let slots = (self.config().send_concurrency as usize - sender.jobs.len())
                .min((batch - work) as usize);
            // Keep each head's durable-row lookup parameterized by its primary
            // key. Flattening this lateral boundary can scan the entire pending
            // delivery index in a merge join, even when only a few heads are due.
            let head_sql = format!(
                "SELECT d.id AS delivery_id,d.recipient,d.attempts,o.id,o.signer,o.user_id,o.channel_id,o.purpose FROM native_federation_heads h CROSS JOIN LATERAL(SELECT * FROM federation_deliveries WHERE id=h.head_id AND status='pending' AND next_attempt<=$1 OFFSET 0) d JOIN federation_outgoing o ON o.id=d.activity_id WHERE NOT(h.head_id=ANY($2)) AND NOT(h.recipient=ANY($4)) AND NOT EXISTS(SELECT 1 FROM unnest($3::text[]) AS pattern WHERE h.recipient LIKE pattern ESCAPE '\\') AND {} ORDER BY h.head_id LIMIT $5",
                predecessor()
            );
            let start = Instant::now();
            let timer = self.chat.timings.time(Stage::Selection);
            let heads = sqlx::query(&head_sql)
                // Backlog size and active-recipient exclusions change quickly.
                // Keep current backlog/claim parameter selectivity in the plan.
                .persistent(false)
                .bind(now())
                .bind(&ids)
                .bind(&omitted)
                .bind(&actors)
                .bind((slots * 8).clamp(32, 256) as i64)
                .fetch_all(&mut *self.connection().await?)
                .await?;
            drop(timer);
            selection_ms += start.elapsed().as_millis() as u64;
            if heads.is_empty() {
                if sender.jobs.is_empty() {
                    break;
                }
                tokio::select! {
                    result = sender.jobs.join_next() => {
                        if let Some(result) = result { sender.complete(result).await?; }
                    }
                    _ = tokio::time::sleep_until(deadline) => {}
                }
                continue;
            }
            // Fetch each immutable activity once, rather than repeating its full
            // JSON for every recipient head. Grouped jobs share these bytes.
            let payload_start = Instant::now();
            let payload_timer = self.chat.timings.time(Stage::Selection);
            let outgoing: Vec<String> = heads.iter().map(|h| h.get("id")).collect::<HashSet<_>>().into_iter().collect();
            let mut activities = HashMap::new();
            for row in sqlx::query("SELECT id,activity FROM federation_outgoing WHERE id=ANY($1)")
                .bind(outgoing).fetch_all(&mut *self.connection().await?).await? {
                let body: String = row.get("activity");
                let announce = serde_json::from_str::<Value>(&body).is_ok_and(|a| a["type"] == "Announce");
                activities.insert(row.get::<String,_>("id"), Arc::new(Activity { body, announce }));
            }
            drop(payload_timer);
            selection_ms += payload_start.elapsed().as_millis() as u64;
            let deliveries: Vec<_> = heads
                .into_iter()
                .map(|head| -> Result<Delivery, Failure> { Ok(Delivery {
                    id: head.get("delivery_id"),
                    recipient: head.get("recipient"),
                    attempts: head.get("attempts"),
                    outgoing: head.get("id"),
                    activity: activities.get(&head.get::<String,_>("id")).cloned().ok_or(Failure(StatusCode::SERVICE_UNAVAILABLE,"Queued activity unavailable."))?,
                    signer: head.get("signer"),
                    user: head.get("user_id"),
                    channel: head.get("channel_id"),
                    purpose: head.get("purpose"),
                }) })
                .collect::<Result<_,_>>()?;
            let groupable: Vec<_> = deliveries
                .iter()
                .filter(|delivery| delivery.groupable())
                .map(|d| d.outgoing.clone())
                .collect::<HashSet<_>>()
                .into_iter()
                .collect();
            let mut peer_rows = HashMap::<String, Vec<(i64, String, i64)>>::new();
            if !groupable.is_empty() {
                let _timer = self.chat.timings.time(Stage::Peers);
                let sql = format!(
                    "SELECT d.activity_id,d.id,d.recipient,d.attempts FROM federation_deliveries d JOIN federation_outgoing o ON o.id=d.activity_id WHERE d.activity_id=ANY($1) AND d.status='pending' AND d.next_attempt<=$2 AND NOT(d.id=ANY($3)) AND NOT(d.recipient=ANY($4)) AND {} ORDER BY d.id",
                    predecessor()
                );
                for row in sqlx::query(&sql)
                    .persistent(false)
                    .bind(groupable)
                    .bind(now())
                    .bind(&ids)
                    .bind(&actors)
                    .fetch_all(&mut *self.connection().await?)
                    .await?
                {
                    peer_rows.entry(row.get("activity_id")).or_default().push((
                        row.get("id"),
                        row.get("recipient"),
                        row.get("attempts"),
                    ));
                }
            }
            // Selection/discovery queries can finish after several network jobs
            // do. Reap them now so completed tasks do not occupy dispatch slots.
            while let Some(result) = sender.jobs.try_join_next() {
                sender.complete(result).await?;
            }
            for delivery in deliveries {
                if sender.jobs.len() >= self.config().send_concurrency as usize
                    || work >= batch
                    || tokio::time::Instant::now() >= deadline
                {
                    break;
                }
                if sender.claimed.contains(&delivery.id)
                    || sender.claimed_actors.contains(&delivery.recipient)
                {
                    continue;
                }
                let origin = reqwest::Url::parse(&delivery.recipient)
                    .ok()
                    .map(|u| u.origin());
                if origin
                    .as_ref()
                    .is_some_and(|o| exhausted.contains(&o.ascii_serialization()))
                {
                    continue;
                }
                // Invalid queued URLs still enter deliver and get an audit error.
                if matches!(self.allowance(&delivery.recipient, false).await, Ok(false)) {
                    exhausted.insert(origin.expect("allowance URL").ascii_serialization());
                    continue;
                }
                let mut peers = vec![delivery.clone()];
                if let Some(rows) = peer_rows.get(&delivery.outgoing) {
                    for (id, recipient, attempts) in rows {
                        if *id != delivery.id
                            && !sender.claimed.contains(id)
                            && !sender.claimed_actors.contains(recipient)
                            && reqwest::Url::parse(recipient).ok().map(|u| u.origin()) == origin
                        {
                            peers.push(Delivery {
                                id: *id,
                                recipient: recipient.clone(),
                                attempts: *attempts,
                                ..delivery.clone()
                            });
                        }
                    }
                }
                let ids: Vec<_> = peers.iter().map(|p| p.id).collect();
                let actors: Vec<_> = peers.iter().map(|p| p.recipient.clone()).collect();
                sender.claimed.extend(ids.iter().copied());
                sender.claimed_actors.extend(actors.iter().cloned());
                work += 1;
                let state = self.clone();
                sender.jobs.spawn(async move {
                    let start = Instant::now();
                    let counts = state.deliver(delivery, peers).await;
                    (ids, actors, counts, start.elapsed().as_millis() as u64)
                });
            }
        }
        let (requests, attempts, delivery_ms) = std::mem::take(&mut sender.completed);
        Ok(
            json!({"requests":requests,"recipientAttempts":attempts,"selectionMs":selection_ms,
            "deliveryMs":delivery_ms,"jobs":work,"active":sender.jobs.len(),
            "stages":self.chat.timings.snapshot()}),
        )
    }
}
#[derive(Deserialize)]
#[serde(default, deny_unknown_fields, rename_all = "camelCase")]
pub struct Tick {
    pub wait: bool,
    pub drain_only: bool,
}
impl Default for Tick {
    fn default() -> Self {
        Self {
            wait: true,
            drain_only: false,
        }
    }
}
type JobResult = (Vec<i64>, Vec<String>, Result<(u64, u64), Failure>, u64);
#[derive(Default)]
struct Sender {
    // Jobs drop before the lock socket when the runtime shuts down.
    jobs: JoinSet<JobResult>,
    connection: Option<sqlx::PgConnection>,
    locked: bool,
    locking: bool,
    key: i64,
    claimed: HashSet<i64>,
    claimed_actors: HashSet<String>,
    completed: (u64, u64, u64),
}
impl Sender {
    async fn abort(&mut self) {
        self.jobs.abort_all();
        while self.jobs.join_next().await.is_some() {}
        self.claimed.clear();
        self.claimed_actors.clear();
    }
    async fn complete(
        &mut self,
        result: Result<JobResult, tokio::task::JoinError>,
    ) -> Result<(), Failure> {
        let (ids, actors, counts, elapsed) = match result {
            Ok(result) => result,
            Err(_) => {
                self.abort().await;
                return Err(Failure(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "Delivery worker failed.",
                ));
            }
        };
        for id in ids {
            self.claimed.remove(&id);
        }
        for actor in actors {
            self.claimed_actors.remove(&actor);
        }
        let (requests, attempts) = counts?;
        self.completed.0 += requests;
        self.completed.1 += attempts;
        self.completed.2 += elapsed;
        Ok(())
    }
}
impl Delivery {
    fn groupable(&self) -> bool {
        matches!(self.purpose.as_str(), "relay" | "moderation")
            && self.activity.announce
    }
}
fn now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
