use crate::{Config, Failure, Job, Reply, authorize};
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, State as Extract},
    http::{HeaderMap, StatusCode},
    routing::{get, post},
};
use chrono::Utc;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Postgres, Row, Transaction, postgres::PgPoolOptions, types::Json as SqlJson};
use std::{
    collections::HashMap,
    sync::{Arc, Weak},
    time::Duration,
};
use tokio::sync::{Mutex, Semaphore};

pub struct State {
    pub(crate) config: Config,
    pub(crate) database: PgPool,
    pub(crate) protocol_database: PgPool,
    pub(crate) protocol_reserved: bool,
    lanes: Mutex<HashMap<String, Weak<Semaphore>>>,
    pub(crate) admission: Semaphore,
    signer: crate::federation::Signer,
    pub(crate) notification_channel: String,
    pages: crate::pages::Cache,
    marks: crate::read_marks::Batch,
    pub(crate) timings: crate::metrics::Metrics,
}
impl State {
    pub(crate) async fn lane(&self, channel: &str) -> Arc<Semaphore> {
        let mut lanes = self.lanes.lock().await;
        if lanes.len() >= 4096 {
            lanes.retain(|_, lane| lane.strong_count() > 0);
        }
        if let Some(lane) = lanes.get(channel).and_then(Weak::upgrade) {
            lane
        } else {
            let limit = self
                .config
                .channel_concurrency
                .min((self.database.options().get_max_connections() - 1) as usize);
            let lane = Arc::new(Semaphore::new(limit));
            lanes.insert(channel.to_owned(), Arc::downgrade(&lane));
            lane
        }
    }
    pub async fn connect(
        config: Config,
        worker: bool,
    ) -> Result<Arc<Self>, Box<dyn std::error::Error>> {
        let schema = config.schema.clone();
        // Reserve within the configured budget. Small two/three-connection
        // pools remain shared so independent foreground channels retain capacity.
        let reserve = u32::from(worker && config.connections >= 4);
        let options = PgPoolOptions::new()
            .acquire_timeout(Duration::from_secs(3))
            .after_connect(move |connection, _| {
                let schema = schema.clone();
                Box::pin(async move {
                    if let Some(schema) = schema {
                        sqlx::query(&format!("SET search_path TO \"{schema}\", public"))
                            .execute(&mut *connection)
                            .await?;
                    }
                    sqlx::query("SET statement_timeout='15s'")
                        .execute(&mut *connection)
                        .await?;
                    Ok(())
                })
            });
        let database = options
            .clone()
            .max_connections(config.connections - reserve)
            .connect(&config.database)
            .await?;
        crate::schema::initialize(&database, &config).await?;
        let mut version = None;
        for _ in 0..60 {
            match sqlx::query_scalar::<_, i64>("SELECT version FROM archipel_schema")
                .fetch_optional(&database)
                .await
            {
                Ok(Some(found)) if found == 29 => {
                    version = Some(found);
                    break;
                }
                Ok(None) => {}
                Ok(Some(found)) if found < 29 => {}
                Err(sqlx::Error::Database(error)) if error.code().as_deref() == Some("42P01") => {}
                Ok(Some(found)) => {
                    version = Some(found);
                    break;
                }
                Err(error) => return Err(error.into()),
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
        if version != Some(31) {
            return Err("Native chat requires the migrated schema version 31".into());
        }
        crate::queue_heads::initialize(&database).await?;
        if config.connections < 2 {
            return Err("NATIVE_DATABASE_POOL must be at least 2 to reserve capacity for independent channels".into());
        }
        let schema: String = sqlx::query_scalar("SELECT current_schema()")
            .fetch_one(&database)
            .await?;
        let notification_channel = format!(
            "archipel_native_{:.32}",
            format!("{:x}", Sha256::digest(schema.as_bytes()))
        );
        let protocol_database = if reserve > 0 {
            options
                .max_connections(reserve)
                .connect(&config.database)
                .await?
        } else {
            database.clone()
        };
        Ok(Arc::new(Self {
            config,
            marks: crate::read_marks::Batch::start(database.clone()),
            database,
            protocol_database,
            protocol_reserved: reserve > 0,
            lanes: Mutex::new(HashMap::new()),
            admission: Semaphore::new(128),
            signer: crate::federation::Signer::default(),
            notification_channel,
            pages: crate::pages::Cache::default(),
            timings: crate::metrics::Metrics::default(),
        }))
    }
}
pub fn router(state: Arc<State>) -> Router {
    let protocol = crate::outbox::State::new(state.clone());
    Router::new()
        .route("/v1/chat", post(execute))
        .route("/v1/read", post(read_projection))
        .route(
            "/v1/federation/receive",
            post(
                move |headers: HeaderMap, Json(input): Json<crate::outbox::Authentication>| {
                    let protocol = protocol.clone();
                    async move {
                        authorize(&headers, &protocol.config().secret)?;
                        protocol.receive(input).await?;
                        Ok::<_, Failure>(Json(json!({"supported":true})))
                    }
                },
            )
            .layer(DefaultBodyLimit::max(2 * 1024 * 1024)),
        )
        .route("/health", get(health))
        .layer(DefaultBodyLimit::max(65536))
        .with_state(state)
}
async fn health(
    Extract(state): Extract<Arc<State>>,
    headers: HeaderMap,
) -> Result<Json<Value>, Failure> {
    authorize(&headers, &state.config.secret)?;
    sqlx::query("SELECT 1").execute(&state.database).await?;
    Ok(Json(
        json!({"status":"ok","pages":state.pages.statistics().await,"stages":state.timings.snapshot(),
            "database":{"foreground":state.database.options().get_max_connections(),
                "protocol":state.protocol_database.options().get_max_connections(),
                "reserved":state.protocol_reserved}}),
    ))
}
async fn read_projection(
    state: Extract<Arc<State>>,
    headers: HeaderMap,
    job: Json<Job>,
) -> Result<Json<Value>, Failure> {
    authorize(&headers, &state.0.config.secret)?;
    if !matches!(job.op.as_str(), "messages" | "overview") {
        return Err(Failure::unsupported());
    }
    let overview = job.op == "overview";
    let mut result = execute(state, headers, job).await?.0.result;
    if overview {
        result["xmpp_enabled"] = json!(false);
        result["xmpp_rooms"] = json!([]);
    }
    Ok(Json(result))
}
async fn execute(
    Extract(state): Extract<Arc<State>>,
    headers: HeaderMap,
    Json(job): Json<Job>,
) -> Result<Json<Reply>, Failure> {
    authorize(&headers, &state.config.secret)?;
    if job.channel.is_empty()
        || job.channel.encode_utf16().count() > 2100
        || job.channel.trim() != job.channel
    {
        return Err(Failure::unsupported());
    }
    if !matches!(
        job.op.as_str(),
        "post" | "read" | "messages" | "overview" | "session" | "auth" | "edit"
    ) {
        return Err(Failure::unsupported());
    }
    let _admission = state
        .admission
        .try_acquire()
        .map_err(|_| Failure(StatusCode::SERVICE_UNAVAILABLE, "Worker is busy."))?;
    let hash = format!("{:x}", Sha256::digest(job.token.as_bytes()));
    // Marks are monotone, authorized atomically in their batch and clamped at
    // apply time. Waiting for that batch must not occupy the channel lanes used
    // by posts, pages and receipt, especially while a read-mark row is locked.
    if job.op == "read" {
        return Ok(Json(state.marks.mark(&job, &hash).await?));
    }
    let lane = state.lane(&job.channel).await;
    // Hot channels wait outside the SQL pool and cannot occupy every connection
    // while an unrelated channel needs to make progress.
    let _lane = lane
        .acquire()
        .await
        .map_err(|_| Failure(StatusCode::SERVICE_UNAVAILABLE, "Worker unavailable."))?;
    if matches!(job.op.as_str(), "session" | "auth") {
        let user=sqlx::query("SELECT u.id,u.banned,u.admission_status,s.csrf,s.expires_at,to_jsonb(u) AS native_user FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>$2")
            .bind(&hash).bind(Utc::now().timestamp_millis()).fetch_optional(&state.database).await?.ok_or(Failure(StatusCode::UNAUTHORIZED,"Sign in to continue."))?;
        if user.get::<i64, _>("banned") != 0 {
            return Err(Failure(
                StatusCode::FORBIDDEN,
                "This account has been suspended.",
            ));
        }
        if job.op == "session" && user.get::<&str, _>("admission_status") != "approved" {
            return Err(Failure(
                StatusCode::FORBIDDEN,
                "Instance membership approval is required.",
            ));
        }
        let SqlJson(profile): SqlJson<Value> = user.get("native_user");
        return Ok(Json(Reply {
            result: json!({"user":profile,"csrf":user.get::<String,_>("csrf"),"expiresAt":user.get::<i64,_>("expires_at")}),
            user: user.get("id"),
            changed: false,
        }));
    }
    let reading = matches!(job.op.as_str(), "messages" | "overview");
    let mut transaction = if job.op == "messages" {
        state
            .database
            .begin_with("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY")
            .await?
    } else {
        state.database.begin().await?
    };
    // Posting protects authority until commit; page/overview reads use plain
    // snapshots. Read positions use their separate authorized batch.
    let auth_sql = if reading {
        "SELECT u.*,s.csrf,s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>$2"
    } else {
        "SELECT u.*,s.csrf,s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>$2 FOR SHARE OF u,s"
    };
    let user = sqlx::query(auth_sql)
        .bind(&hash)
        .bind(Utc::now().timestamp_millis())
        .fetch_optional(&mut *transaction)
        .await?
        .ok_or(Failure(StatusCode::UNAUTHORIZED, "Sign in to continue."))?;
    if user.get::<i64, _>("banned") != 0 || user.get::<String, _>("admission_status") != "approved"
    {
        return Err(Failure(
            StatusCode::FORBIDDEN,
            "Instance membership approval is required.",
        ));
    }
    if !bool::from(
        user.get::<String, _>("csrf")
            .as_bytes()
            .ct_eq(job.csrf.as_bytes()),
    ) {
        return Err(Failure(StatusCode::FORBIDDEN, "Invalid CSRF token."));
    }
    let id: String = user.get("id");
    if job.op == "overview" {
        let (result, changed) =
            crate::overview::read(&state.config, &user, &mut transaction).await?;
        if changed {
            crate::changes::append(
                &mut transaction,
                json!([{"table":"read_marks","rows":[{"user_id":id}]}]),
            )
            .await?;
        }
        transaction.commit().await?;
        return Ok(Json(Reply {
            result,
            user: id,
            changed,
        }));
    }
    if matches!(job.op.as_str(), "post" | "edit")
        && user.get::<Option<String>, _>("remote_actor").is_some()
    {
        return Err(Failure::unsupported());
    }
    let mut channel_query = sqlx::query(if reading {
        "SELECT c.*,EXISTS(SELECT 1 FROM memberships WHERE channel_id=c.id AND user_id=$2) AS native_member,
            EXISTS(SELECT 1 FROM channel_rules WHERE channel_id=c.id AND user_id=$2 AND rule='block') AS native_blocked,
            EXISTS(SELECT 1 FROM conversation_prefs WHERE user_id=$2 AND channel_id=c.id AND hidden=1 AND target>='thread:' AND target<'thread;') AS native_hidden,
            (SELECT value FROM instance_settings WHERE key='emoji_bans') AS native_emoji_bans,
            EXISTS(SELECT 1 FROM instance_settings WHERE key='federation_enabled' AND value='true') AS native_federation_enabled
         FROM channels c WHERE c.id=$1"
    } else {
        "SELECT * FROM channels WHERE id=$1 FOR SHARE"
    })
    .bind(&job.channel);
    if reading {
        channel_query = channel_query.bind(&id);
    }
    let channel = channel_query
        .fetch_optional(&mut *transaction)
        .await?
        .ok_or(Failure(StatusCode::NOT_FOUND, "Channel not found."))?;
    let member = if reading {
        channel.get::<bool, _>("native_member")
    } else {
        sqlx::query("SELECT 1 FROM memberships WHERE channel_id=$1 AND user_id=$2 FOR SHARE")
            .bind(&job.channel)
            .bind(&id)
            .fetch_optional(&mut *transaction)
            .await?
            .is_some()
    };
    if let Some(actor) = channel.get::<Option<String>, _>("remote_actor") {
        // Read-mark behavior retains its existing membership-only contract.
        if job.op != "read" {
            if reading {
                crate::federation::require_enabled(
                    &user,
                    &["federation_receive", "federation_subscribe"],
                    channel.get("native_federation_enabled"),
                )?;
            } else {
                crate::federation::require_at(
                    &mut transaction,
                    &user,
                    &["federation_receive", "federation_subscribe"],
                    true,
                )
                .await?;
            }
            crate::federation::allowed_at(&state.config, &mut transaction, &actor, !reading)
                .await?;
        }
    }
    if job.op != "messages" && !member {
        return Err(Failure(StatusCode::FORBIDDEN, "Join this channel first."));
    }
    let (result, changed, outgoing) = if job.op == "messages" {
        let blocked = channel.get::<bool, _>("native_blocked");
        if user.get::<i64, _>("admin") == 0
            && (blocked || (channel.get::<String, _>("visibility") != "public" && !member))
        {
            return Err(Failure(
                StatusCode::FORBIDDEN,
                "You do not have access to this channel.",
            ));
        }
        (
            simple_messages(
                &state.pages,
                &state.config,
                &job,
                &user,
                &channel,
                &mut transaction,
            )
            .await?,
            false,
            false,
        )
    } else if job.op == "edit" {
        crate::messages::edit(
            &state.config,
            &state.signer,
            &job,
            &user,
            &channel,
            &mut transaction,
        )
        .await?
    } else {
        crate::messages::post(
            &state.config,
            &state.signer,
            &job,
            &user,
            &channel,
            &mut transaction,
        )
        .await?
    };
    if changed {
        let mut changes = if job.op == "read" {
            vec![json!({"table":"read_marks","rows":[{"user_id":id}]})]
        } else if result.get("queued") == Some(&json!(true)) {
            // A remote submission only changes its author's private outbox.
            // Channel readers are notified when the home actually commits it.
            vec![]
        } else {
            vec![json!({"table":"messages","rows":[{"channel_id":job.channel,"id":result.get("id")} ]})]
        };
        if outgoing {
            changes.push(json!({"table":"federation_outgoing","rows":[{"user_id":id}]}));
        }
        if job.op == "edit" {
            changes.push(json!({"table":"audit","rows":[]}));
        }
        // Durable notices share the write's transaction. The relay publishes
        // committed batches without serializing every writer on NOTIFY.
        crate::changes::append(&mut transaction, json!(changes)).await?;
    }
    transaction.commit().await?;
    Ok(Json(Reply {
        result,
        user: id,
        changed,
    }))
}
async fn simple_messages(
    cache: &crate::pages::Cache,
    config: &Config,
    job: &Job,
    user: &sqlx::postgres::PgRow,
    channel: &sqlx::postgres::PgRow,
    transaction: &mut Transaction<'_, Postgres>,
) -> Result<Value, Failure> {
    let who: String = user.get("id");
    let global_bans: Option<&str> = channel.get("native_emoji_bans");
    let bans = crate::emoji::bans_from(channel.get("reaction_bans"), global_bans)?;
    if job
        .before
        .is_some_and(|n| !(1..=9_007_199_254_740_991).contains(&n))
    {
        return Err(Failure(StatusCode::BAD_REQUEST, "Invalid message cursor."));
    }
    if job
        .after
        .is_some_and(|seq| !(0..=9_007_199_254_740_991).contains(&seq))
        || job.after.is_some()
            && (job.before.is_some()
                || !job.refresh
                || job.refresh_stamp.as_ref().is_none_or(|stamp| {
                    stamp.len() != 32 || !stamp.bytes().all(|b| b.is_ascii_hexdigit())
                }))
    {
        return Err(Failure(StatusCode::BAD_REQUEST, "Invalid refresh cursor."));
    }
    let after = job.after.zip(job.refresh_stamp.as_deref());
    let (mut messages, window, incremental) = crate::pages::read(
        cache,
        config,
        transaction,
        &job.channel,
        crate::pages::Cursor {
            before: job.before.unwrap_or(9_007_199_254_740_991),
            after,
        },
        &who,
        user.get::<i64, _>("federation_receive"),
    )
    .await?;
    crate::emoji::live(transaction, &config.base, &mut messages).await?;
    let ids: Vec<String> = messages
        .iter()
        .filter_map(|m| m["id"].as_str().map(str::to_owned))
        .collect();
    let mut reactions = crate::emoji::reactions(transaction, &ids, &who).await?;
    let hidden: Vec<String> = if channel.get::<bool, _>("native_hidden") {
        sqlx::query_scalar("WITH RECURSIVE hid(id) AS (SELECT substring(target FROM 8) FROM conversation_prefs WHERE user_id=$1 AND channel_id=$2 AND hidden=1 AND target>='thread:' AND target<'thread;' UNION SELECT m.id FROM messages m JOIN hid ON m.parent_id=hid.id) SELECT id FROM hid WHERE id=ANY($3)")
            .bind(&who).bind(&job.channel).bind(&ids).fetch_all(&mut **transaction).await?
    } else {
        Vec::new()
    };
    let handles = if channel.get::<i64, _>("hide_handles") == 0 || user.get::<i64, _>("admin") != 0
    {
        true
    } else {
        sqlx::query_scalar::<_,bool>("SELECT EXISTS(SELECT 1 FROM memberships m WHERE m.channel_id=$1 AND m.user_id=$2 AND (($3::text IS NULL AND m.role<>'member') OR EXISTS(SELECT 1 FROM channel_grants g WHERE g.channel_id=m.channel_id AND g.user_id=m.user_id AND g.see_handles<>0)))")
            .bind(&job.channel).bind(&who).bind(channel.get::<Option<String>,_>("remote_actor")).fetch_one(&mut **transaction).await?
    };
    for message in &mut messages {
        let object = message.as_object_mut().ok_or(Failure(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Invalid message page.",
        ))?;
        let id = object
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        object.insert(
            "reactions".into(),
            json!(reactions.remove(&id).unwrap_or_default()),
        );
        if hidden.contains(&id) {
            object.insert("hidden_thread".into(), json!(true));
        }
        if !handles && object.get("author_id").and_then(Value::as_str) != Some(&who) {
            object.insert("username".into(), json!(""));
            object.insert("author_actor_url".into(), Value::Null);
        }
        if object.remove("_blocked") == Some(json!(true)) {
            object.insert(
                "body".into(),
                json!("This message is hidden because you blocked this user."),
            );
            object.insert("edited_at".into(), Value::Null);
            if object.get("title") != Some(&Value::Null) {
                object.insert("title".into(), json!("Hidden thread"));
            }
            object.insert("emoji_tags".into(), json!("[]"));
            object.insert("emojis".into(), json!([]));
        } else {
            crate::emoji::project(message, &bans);
        }
    }
    let older = if window.count == 100 {
        json!(window.first)
    } else {
        Value::Null
    };
    let pending = if job.before.is_none() {
        crate::messages::pending_posts(config, transaction, user, channel).await?
    } else {
        vec![]
    };
    let mut result = json!({"messages":messages,"older_cursor":older,"pending":pending});
    if job.refresh {
        result["refresh_cursor"] = json!(window.last);
        result["refresh_stamp"] = json!(window.stamp);
        result["incremental"] = json!(incremental);
    }
    if result.to_string().len() > 4 * 1024 * 1024 {
        return Err(Failure::unsupported());
    }
    Ok(result)
}
use subtle::ConstantTimeEq;
