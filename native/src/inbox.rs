//! Durable receipt of channel Notes. Origin verification and actor discovery
//! precede the transaction. Unsupported protocol extensions roll back entirely.
use crate::{
    Failure, federation,
    metrics::Stage,
    net,
    outbox::{Authentication, State},
};
use axum::http::StatusCode;
use base64::{Engine, engine::general_purpose::STANDARD};
use chrono::{DateTime, SecondsFormat, Utc};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{Acquire, Postgres, Row, Transaction, postgres::PgRow};
use uuid::Uuid;

impl State {
    pub async fn receive(&self, input: Authentication) -> Result<(), Failure> {
        let stream = input.stream.clone();
        let _admission = self.chat.admission.try_acquire().map_err(|_| {
            Failure(
                StatusCode::SERVICE_UNAVAILABLE,
                "Federation receiver is busy.",
            )
        })?;
        let raw = STANDARD
            .decode(input.body.as_deref().unwrap_or(""))
            .map_err(|_| bad("Invalid activity JSON."))?;
        let activity: Value = serde_json::from_slice(&raw).map_err(|_| Failure::unsupported())?;
        if activity["type"] == "Follow" {
            return self.receive_follow(input, &activity, &raw).await;
        }
        let announce = activity["type"] == "Announce";
        let kind = if announce {
            &activity["object"]["type"]
        } else {
            &activity["type"]
        };
        let note = if announce {
            &activity["object"]["object"]
        } else {
            &activity["object"]
        };
        if !matches!(kind.as_str(), Some("Create" | "Update"))
            || note["type"] != "Note"
            || note["channel"].as_str().is_none()
        {
            return Err(Failure::unsupported());
        }
        // JSON.stringify normalizes numbers and integer-key ordering. Notes made
        // by this protocol contain neither; route extensions to their codec.
        if !canonical_note(note)
            || !note["inReplyTo"].is_null() && !note["inReplyTo"].is_string()
            || !note["topic"].is_null() && !note["topic"].is_object()
        {
            return Err(Failure::unsupported());
        }
        let channel_key = string(note, "channel")?;
        if channel_key.encode_utf16().count() > 2048 {
            return Err(bad("Invalid federation URL."));
        }
        let prefix = format!("{}/actors/channels/", self.config().base);
        let key = if let Some(id) = channel_key.strip_prefix(&prefix) {
            id.to_owned()
        } else {
            sqlx::query_scalar::<_, String>("SELECT id FROM channels WHERE remote_actor=$1")
                .bind(channel_key)
                .fetch_optional(&mut *self.connection().await?)
                .await?
                .unwrap_or_else(|| channel_key.to_owned())
        };
        let lane = self.chat.lane(&key).await;
        // Do not let a hot channel's advisory-lock waiters occupy the SQL pool.
        let lane_timer = self.chat.timings.time(Stage::InboxLane);
        let _lane = lane.acquire().await.map_err(|_| {
            Failure(
                StatusCode::SERVICE_UNAVAILABLE,
                "Federation receiver unavailable.",
            )
        })?;
        drop(lane_timer);
        if note["published"]
            .as_str()
            .is_some_and(|s| date(s).is_none())
            || note["updated"].as_str().is_some_and(|s| date(s).is_none())
        {
            return Err(Failure::unsupported());
        }
        let authentication_timer = self.chat.timings.time(Stage::InboxAuthentication);
        // Only the bearer-authenticated local gateway can supply a checkpoint.
        // It obtained the frame over a pinned HTTPS connection to this channel.
        let sender = if let Some(checkpoint) = &stream {
            if !announce || checkpoint.actor != checkpoint.channel || activity["actor"] != checkpoint.channel {
                return Err(Failure(StatusCode::FORBIDDEN, "Invalid channel stream authority."));
            }
            self.actor(&checkpoint.actor).await?
        } else { self.authenticate(input).await? };
        drop(authentication_timer);
        let activity_id = string(&activity, "id")?;
        if activity["actor"] != sender["id"] {
            return Err(Failure(
                StatusCode::FORBIDDEN,
                "Activity authority does not match its signing actor.",
            ));
        }
        let authorities = self
            .allowed_many(&[activity_id, string(&sender, "id")?])
            .await?;
        if authorities[0].origin() != authorities[1].origin() {
            return Err(Failure(
                StatusCode::FORBIDDEN,
                "Activity authority does not match its signing actor.",
            ));
        }
        let hash = format!("{:x}", Sha256::digest(&raw));
        let previous: Option<String> =
            sqlx::query_scalar("SELECT digest FROM federation_incoming WHERE id=$1")
                .bind(activity_id)
                .fetch_optional(&mut *self.connection().await?)
                .await?;
        if let Some(previous) = previous {
            if previous != hash {
                return Err(Failure(
                    StatusCode::CONFLICT,
                    "Activity ID reused with different content.",
                ));
            }
            if let Some(checkpoint) = &stream {
                let mut tx = self.chat.protocol_database.begin().await?;
                stream_checkpoint(self.config(), &mut tx, checkpoint).await?;
                tx.commit().await?;
            }
            return Ok(());
        }
        let author = string(note, "attributedTo")?;
        if note["proof"]["actor"].as_str() != Some(author)
            || note["proof"]["keyId"].as_str() != Some(format!("{author}#main-key").as_str())
        {
            return Err(bad("Message origin proof is required."));
        }
        let authorities = self.allowed_many(&[string(note, "id")?, author]).await?;
        if authorities[0].origin() != authorities[1].origin() {
            return Err(bad("Message ID must belong to its author instance."));
        }
        if announce {
            if sender["type"] != "Group" {
                return Err(bad("Invalid channel distribution activity."));
            }
        } else if sender["type"] != "Person" || sender["id"] != author {
            return Err(Failure(
                StatusCode::FORBIDDEN,
                "Only the message author may create or update it.",
            ));
        }
        let actor = self.actor(author).await?;
        let signature = note["proof"]["signature"]
            .as_str()
            .filter(|s| s.len() <= 1000)
            .ok_or(bad("Message origin proof is required."))?;
        if actor["type"] != "Person" {
            return Err(Failure(
                StatusCode::UNAUTHORIZED,
                "Message origin signature failed.",
            ));
        }
        let mut document = note.clone();
        document
            .as_object_mut()
            .expect("note")
            .shift_remove("proof");
        net::verify_signature(
            string(&actor["publicKey"], "publicKeyPem")?,
            document.to_string().as_bytes(),
            signature,
        )?;
        let body = js_trim(string(note, "content")?);
        if body.is_empty() || body.encode_utf16().count() > 8000 {
            return Err(bad("Message must be between 1 and 8000 characters."));
        }
        if note["mediaType"] != "text/plain"
            || date(string(note, "published")?).is_none()
            || note["updated"].as_str().is_some_and(|s| date(s).is_none())
            || !note["updated"].is_null() && !note["updated"].is_string()
            || !note["name"].is_null()
                && !note["name"]
                    .as_str()
                    .is_some_and(|s| s.encode_utf16().count() <= 160)
        {
            return Err(bad("Invalid remote message."));
        }
        let prepared = self.prepare_emojis(note).await?;
        let mut connection = self.connection().await?;
        let _transaction_timer = self.chat.timings.time(Stage::InboxTransaction);
        let mut tx = connection.begin().await?;
        // Duplicate receipt and the channel's mutations are serialized, while
        // different channels use independent transactions/connections.
        let activity_timer = self.chat.timings.time(Stage::InboxActivityLock);
        advisory(&mut tx, &format!("incoming:{activity_id}")).await?;
        drop(activity_timer);
        let previous: Option<String> =
            sqlx::query_scalar("SELECT digest FROM federation_incoming WHERE id=$1")
                .bind(activity_id)
                .fetch_optional(&mut *tx)
                .await?;
        if let Some(previous) = previous {
            if previous != hash {
                return Err(Failure(StatusCode::CONFLICT, "Conflicting activity."));
            }
            if let Some(checkpoint) = &stream { stream_checkpoint(self.config(), &mut tx, checkpoint).await?; tx.commit().await?; }
            return Ok(());
        }
        let enabled: Option<String> = sqlx::query_scalar(
            "SELECT value FROM instance_settings WHERE key='federation_enabled' FOR SHARE",
        )
        .fetch_optional(&mut *tx)
        .await?;
        if enabled.as_deref() != Some("true") {
            return Err(Failure(
                StatusCode::FORBIDDEN,
                "Federation is disabled by this instance administrator.",
            ));
        }
        federation::allowed_many(self.config(), &mut tx, &[string(&sender, "id")?, author]).await?;
        let channel = if announce {
            sqlx::query("SELECT * FROM channels WHERE remote_actor=$1 FOR SHARE")
                .bind(string(&sender, "id")?)
                .fetch_optional(&mut *tx)
                .await?
        } else {
            let prefix = format!("{}/actors/channels/", self.config().base);
            let id = string(note, "channel")?
                .strip_prefix(&prefix)
                .ok_or(bad("Message is not addressed to a home channel."))?;
            sqlx::query("SELECT * FROM channels WHERE id=$1 FOR SHARE")
                .bind(id)
                .fetch_optional(&mut *tx)
                .await?
        }
        .ok_or(Failure(StatusCode::FORBIDDEN, "Unknown remote channel."))?;
        let channel_id: String = channel.get("id");
        let channel_timer = self.chat.timings.time(Stage::InboxChannelLock);
        advisory(&mut tx, &format!("inbox-channel:{channel_id}")).await?;
        drop(channel_timer);
        if sqlx::query("SELECT 1 FROM channel_mirrors WHERE channel_id=$1 UNION ALL SELECT 1 FROM channel_bridges WHERE channel_id=$1 UNION ALL SELECT 1 FROM instance_settings WHERE key='xmpp_domain' AND value<>'' LIMIT 1")
            .bind(&channel_id).fetch_optional(&mut *tx).await?.is_some() { return Err(Failure::unsupported()); }
        if announce {
            // Stream admission is checked by unique Follow ID in the atomic
            // checkpoint before commit. It must not search local subscribers.
            let admitted: bool = if stream.is_some() { true } else {
                sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM federation_subscriptions s JOIN users u ON u.id=s.user_id WHERE s.channel_id=$1 AND s.status='accepted' AND u.banned=0 AND u.admission_status='approved' AND u.federation_receive=1 AND u.federation_subscribe=1)")
                    .bind(&channel_id).fetch_one(&mut *tx).await?
            };
            if !admitted {
                return Err(Failure(
                    StatusCode::FORBIDDEN,
                    "No permitted recipients for this channel.",
                ));
            }
        } else {
            if channel.get::<i64, _>("federation_enabled") == 0
                || channel.get::<Option<String>, _>("remote_actor").is_some()
            {
                return Err(Failure(
                    StatusCode::FORBIDDEN,
                    "Channel federation is disabled.",
                ));
            }
            let admitted: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM federation_follows f JOIN users u ON u.remote_actor=f.actor WHERE f.channel_id=$1 AND f.actor=$2 AND f.status='accepted' AND u.banned=0 AND u.admission_status='approved' AND NOT EXISTS(SELECT 1 FROM channel_rules r WHERE r.channel_id=f.channel_id AND r.user_id=u.id AND r.rule='block'))")
                .bind(&channel_id).bind(author).fetch_one(&mut *tx).await?;
            if !admitted {
                return Err(Failure(
                    StatusCode::FORBIDDEN,
                    "Channel subscription or posting permission denied.",
                ));
            }
        }
        let user = remote_user(self.config(), &mut tx, &actor).await?;
        let mut tags = vec![];
        for emoji in prepared {
            // Recheck policy after image discovery; cached images cannot bypass it.
            federation::allowed(self.config(), &mut tx, &emoji.source).await?;
            let existing: Option<String> = sqlx::query_scalar(
                "SELECT id FROM remote_emoji_cache WHERE source_url=$1 FOR SHARE",
            )
            .bind(&emoji.source)
            .fetch_optional(&mut *tx)
            .await?;
            let id = if let Some(id) = existing {
                id
            } else {
                let (mime, image) = emoji.image.ok_or(Failure(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "Emoji cache changed during receipt.",
                ))?;
                sqlx::query("INSERT INTO remote_emoji_cache(id,source_url,mime,image) VALUES($1,$2,$3,$4) ON CONFLICT(source_url) DO NOTHING")
                    .bind(Uuid::new_v4().to_string()).bind(&emoji.source).bind(mime).bind(image).execute(&mut *tx).await?;
                sqlx::query_scalar("SELECT id FROM remote_emoji_cache WHERE source_url=$1")
                    .bind(&emoji.source)
                    .fetch_one(&mut *tx)
                    .await?
            };
            let mut tag =
                json!({"id":id,"name":emoji.name,"url":format!("/api/emojis/{id}/image")});
            if let Some(owner) = emoji.owner {
                tag["personal"] = json!(true);
                tag["owner"] = json!(owner);
            }
            tags.push(tag);
        }
        let channel_actor = channel
            .get::<Option<String>, _>("remote_actor")
            .unwrap_or_else(|| format!("{}/actors/channels/{channel_id}", self.config().base));
        import_note(
            self.config(),
            &mut tx,
            &channel,
            &user,
            note,
            &channel_actor,
            &tags,
        )
        .await?;
        let mut outgoing = false;
        if !announce {
            let recipients: Vec<String> = sqlx::query_scalar(
                "SELECT actor FROM federation_follows WHERE channel_id=$1 AND status='accepted' AND (stream_capable=0 OR stream_start IS NULL)",
            )
            .bind(&channel_id)
            .fetch_all(&mut *tx)
            .await?;
            {
                let stored: String =
                    sqlx::query_scalar("SELECT document FROM federation_objects WHERE id=$1")
                        .bind(string(note, "id")?)
                        .fetch_one(&mut *tx)
                        .await?;
                let stored: Value = serde_json::from_str(&stored).map_err(|_| {
                    Failure(
                        StatusCode::SERVICE_UNAVAILABLE,
                        "Invalid stored origin proof.",
                    )
                })?;
                let inner = federation::activity(
                    self.config(),
                    kind.as_str().expect("kind"),
                    author,
                    stored,
                );
                federation::queue(
                    self.config(),
                    &mut tx,
                    federation::activity(self.config(), "Announce", &channel_actor, inner),
                    &recipients,
                    "relay",
                    user.get::<&str, _>("id"),
                    &channel_id,
                )
                .await?;
                outgoing = true;
            }
        }
        sqlx::query("INSERT INTO federation_incoming(id,digest,received_at) VALUES($1,$2,$3)")
            .bind(activity_id)
            .bind(hash)
            .bind(Utc::now().timestamp_millis())
            .execute(&mut *tx)
            .await?;
        let mut notices = vec![json!({"table":"messages","rows":[{"channel_id":channel_id,"object":note["id"]}]})];
        if !note["topic"].is_null() {
            notices.push(json!({"table":"topics","rows":[{"channel_id":channel_id}]}));
        }
        if outgoing {
            notices.push(json!({"table":"federation_outgoing","rows":[{"user_id":user.get::<&str,_>("id")}]}));
        }
        if let Some(checkpoint) = &stream { stream_checkpoint(self.config(), &mut tx, checkpoint).await?; }
        crate::changes::append(&mut tx, json!(notices)).await?;
        tx.commit().await?;
        Ok(())
    }
}
impl State {
    async fn receive_follow(
        &self,
        input: Authentication,
        activity: &Value,
        raw: &[u8],
    ) -> Result<(), Failure> {
        let object = activity["object"].as_str().unwrap_or("");
        let prefix = format!("{}/actors/channels/", self.config().base);
        let key = object.strip_prefix(&prefix).unwrap_or("follow:invalid");
        let lane = self.chat.lane(key).await;
        let lane_timer = self.chat.timings.time(Stage::InboxLane);
        let _lane = lane.acquire().await.map_err(|_| {
            Failure(
                StatusCode::SERVICE_UNAVAILABLE,
                "Federation receiver unavailable.",
            )
        })?;
        drop(lane_timer);
        let authentication_timer = self.chat.timings.time(Stage::InboxAuthentication);
        let sender = self.authenticate(input).await?;
        drop(authentication_timer);
        let sender_id = string(&sender, "id")?;
        let activity_id = string(activity, "id")?;
        if activity["actor"] != sender["id"]
            || self.allowed(activity_id).await?.origin() != self.allowed(sender_id).await?.origin()
        {
            return Err(Failure(
                StatusCode::FORBIDDEN,
                "Activity authority does not match its signing actor.",
            ));
        }
        if sender["type"] != "Person"
            || activity["object"].as_str().is_none()
            || !object.starts_with(&prefix)
        {
            return Err(bad("Follow a home channel."));
        }
        let hash = format!("{:x}", Sha256::digest(raw));
        let mut connection = self.connection().await?;
        let _transaction_timer = self.chat.timings.time(Stage::InboxTransaction);
        let mut tx = connection.begin().await?;
        let activity_timer = self.chat.timings.time(Stage::InboxActivityLock);
        advisory(&mut tx, &format!("incoming:{activity_id}")).await?;
        drop(activity_timer);
        if let Some(previous) =
            sqlx::query_scalar::<_, String>("SELECT digest FROM federation_incoming WHERE id=$1")
                .bind(activity_id)
                .fetch_optional(&mut *tx)
                .await?
        {
            if previous != hash {
                return Err(Failure(
                    StatusCode::CONFLICT,
                    "Activity ID reused with different content.",
                ));
            }
            return Ok(());
        }
        let enabled: Option<String> = sqlx::query_scalar(
            "SELECT value FROM instance_settings WHERE key='federation_enabled' FOR SHARE",
        )
        .fetch_optional(&mut *tx)
        .await?;
        if enabled.as_deref() != Some("true") {
            return Err(Failure(
                StatusCode::FORBIDDEN,
                "Federation is disabled by this instance administrator.",
            ));
        }
        federation::allowed(self.config(), &mut tx, sender_id).await?;
        let channel = sqlx::query("SELECT * FROM channels WHERE id=$1 FOR SHARE")
            .bind(key)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or(Failure(StatusCode::NOT_FOUND, "Channel not found."))?;
        if channel.get::<i64, _>("federation_enabled") == 0
            || channel.get::<Option<String>, _>("remote_actor").is_some()
        {
            return Err(Failure(
                StatusCode::FORBIDDEN,
                "Channel federation is disabled.",
            ));
        }
        let channel_timer = self.chat.timings.time(Stage::InboxChannelLock);
        advisory(&mut tx, &format!("inbox-channel:{key}")).await?;
        drop(channel_timer);
        // Existing delegated roles need their companion ChannelRole activity;
        // keep that whole state transition in compatibility until it is ported.
        let delegated:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM channel_member_roles r JOIN users u ON u.id=r.user_id WHERE r.channel_id=$1 AND u.remote_actor=$2)").bind(key).bind(sender_id).fetch_one(&mut *tx).await?;
        if delegated {
            return Err(Failure::unsupported());
        }
        let user = remote_user(self.config(), &mut tx, &sender).await?;
        let old: Option<String> = sqlx::query_scalar(
            "SELECT status FROM federation_follows WHERE channel_id=$1 AND actor=$2 FOR UPDATE",
        )
        .bind(key)
        .bind(sender_id)
        .fetch_optional(&mut *tx)
        .await?;
        let rule: Option<String> = sqlx::query_scalar(
            "SELECT rule FROM channel_rules WHERE channel_id=$1 AND user_id=$2 FOR SHARE",
        )
        .bind(key)
        .bind(user.get::<&str, _>("id"))
        .fetch_optional(&mut *tx)
        .await?;
        let origin = net::peer_url(sender_id, self.config())?
            .origin()
            .ascii_serialization();
        let banned=rule.as_deref()==Some("block") || sqlx::query_scalar::<_,bool>("SELECT EXISTS(SELECT 1 FROM channel_instance_bans WHERE channel_id=$1 AND instance=$2)").bind(key).bind(origin).fetch_one(&mut *tx).await?;
        let blocked = banned || old.as_deref() == Some("blocked");
        let accept = !blocked
            && (channel.get::<&str, _>("admission") == "open"
                || old.as_deref() == Some("accepted")
                || rule.as_deref() == Some("allow"));
        if banned {
            sqlx::query("DELETE FROM federation_follows WHERE channel_id=$1 AND actor=$2 AND status<>'blocked'").bind(key).bind(sender_id).execute(&mut *tx).await?;
        } else {
            sqlx::query("INSERT INTO federation_follows(channel_id,actor,follow_id,status) VALUES($1,$2,$3,$4) ON CONFLICT(channel_id,actor) DO UPDATE SET follow_id=excluded.follow_id,status=excluded.status,stream_start=CASE WHEN federation_follows.follow_id=excluded.follow_id THEN federation_follows.stream_start ELSE NULL END,instance_start=CASE WHEN federation_follows.follow_id=excluded.follow_id THEN federation_follows.instance_start ELSE NULL END").bind(key).bind(sender_id).bind(activity_id).bind(if blocked{"blocked"}else if accept{"accepted"}else{"pending"}).execute(&mut *tx).await?;
        }
        let capable = accept && self.config().channel_transport && sender["channelEvents"]["version"] == 1;
        let tail: i64 = sqlx::query_scalar("SELECT COALESCE((SELECT tail FROM federation_channel_state WHERE channel_id=$1),0)").bind(key).fetch_one(&mut *tx).await?;
        let start: Option<i64> = sqlx::query_scalar("UPDATE federation_follows SET stream_start=CASE WHEN $3 THEN COALESCE(stream_start,$4) ELSE NULL END,stream_capable=CASE WHEN $3 THEN 1 ELSE 0 END,instance_start=CASE WHEN $3 THEN COALESCE(instance_start,(SELECT tail FROM federation_instance_state WHERE id=1)) ELSE NULL END WHERE channel_id=$1 AND actor=$2 RETURNING stream_start").bind(key).bind(sender_id).bind(capable).bind(tail).fetch_optional(&mut *tx).await?.flatten();
        if accept || blocked {
            let response = federation::activity(
                self.config(),
                if accept { "Accept" } else { "Reject" },
                object,
                json!({"id":activity_id,"type":"Follow","actor":sender_id,"object":object}),
            );
            let id = string(&response, "id")?;
            let mut response = response.clone();
            response["to"] = json!([sender_id]);
            if capable { let instance_start:i64=sqlx::query_scalar("SELECT instance_start FROM federation_follows WHERE channel_id=$1 AND actor=$2").bind(key).bind(sender_id).fetch_one(&mut *tx).await?; response["object"]["channelEvents"] = json!({"version":1,"cursor":start.unwrap_or(tail),"instanceCursor":instance_start}); }
            sqlx::query("INSERT INTO federation_outgoing(id,activity,signer,user_id,channel_id,purpose,created_at) VALUES($1,$2,$3,NULL,$4,'membership',$5)").bind(id).bind(response.to_string()).bind(object).bind(key).bind(Utc::now().timestamp_millis()).execute(&mut *tx).await?;
            sqlx::query("INSERT INTO federation_deliveries(activity_id,recipient) VALUES($1,$2)")
                .bind(id)
                .bind(sender_id)
                .execute(&mut *tx)
                .await?;
        }
        sqlx::query("INSERT INTO federation_incoming(id,digest,received_at) VALUES($1,$2,$3)")
            .bind(activity_id)
            .bind(hash)
            .bind(Utc::now().timestamp_millis())
            .execute(&mut *tx)
            .await?;
        let mut changes = vec![json!({"table":"federation_follows","rows":[{"channel_id":key}]})];
        if accept || blocked {
            changes.push(json!({"table":"federation_outgoing","rows":[]}));
        }
        crate::changes::append(&mut tx, json!(changes)).await?;
        tx.commit().await?;
        Ok(())
    }
}
struct PreparedEmoji {
    source: String,
    name: String,
    owner: Option<String>,
    image: Option<(&'static str, Vec<u8>)>,
}
impl State {
    async fn prepare_emojis(&self, note: &Value) -> Result<Vec<PreparedEmoji>, Failure> {
        let Some(emojis) = note.get("emoji") else {
            return Ok(vec![]);
        };
        let emojis = emojis
            .as_array()
            .filter(|v| v.len() <= 8)
            .ok_or(bad("A message can carry up to eight custom emoji."))?;
        let origin = self.allowed(string(note, "attributedTo")?).await?.origin();
        let mut result = vec![];
        for emoji in emojis {
            let name = string(emoji, "name")?;
            if !(1..=64).contains(&name.len())
                || !name.as_bytes()[0].is_ascii_lowercase() && !name.as_bytes()[0].is_ascii_digit()
                || !name.bytes().all(|b| {
                    b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'_' | b'-')
                })
            {
                return Err(bad("Invalid message emoji origin."));
            }
            let url = self.allowed(string(emoji, "url")?).await?;
            if url.origin() != origin {
                return Err(bad("Invalid message emoji origin."));
            }
            let cached: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM remote_emoji_cache WHERE source_url=$1)",
            )
            .bind(url.as_str())
            .fetch_one(&mut *self.connection().await?)
            .await?;
            let image = if cached {
                None
            } else {
                let response = self
                    .transport
                    .request(
                        self.config(),
                        &url,
                        reqwest::Method::GET,
                        axum::http::HeaderMap::new(),
                        None,
                        262144,
                        std::time::Duration::from_secs(15),
                    )
                    .await?;
                let mime = crate::images::mime(&response.body).ok_or(bad(
                    "Only PNG, JPEG, GIF and WebP emoji images are supported.",
                ))?;
                Some((mime, response.body))
            };
            let owner = emoji["owner"]
                .as_str()
                .filter(|s| {
                    emoji["personal"] == true
                        && (1..=64).contains(&s.len())
                        && s.bytes()
                            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
                })
                .map(str::to_owned);
            result.push(PreparedEmoji {
                source: url.to_string(),
                name: name.to_owned(),
                owner,
                image,
            });
        }
        Ok(result)
    }
}
async fn remote_user(
    config: &crate::Config,
    tx: &mut Transaction<'_, Postgres>,
    actor: &Value,
) -> Result<PgRow, Failure> {
    let actor_id = string(actor, "id")?;
    let url = net::peer_url(actor_id, config)?;
    let local = url.origin().ascii_serialization() == config.base;
    let name = truncate(
        actor["name"]
            .as_str()
            .filter(|s| !s.is_empty())
            .or_else(|| actor["preferredUsername"].as_str())
            .unwrap_or("Remote member"),
        80,
    );
    if !local {
        // Existing unchanged authors only need the same current row lock and
        // active-account checks as before. Creation/name changes keep the actor
        // advisory lock, so concurrent initialization and profile updates still
        // serialize without turning every ordinary receipt into three queries.
        if let Some(row) = sqlx::query("SELECT * FROM users WHERE remote_actor=$1 AND display_name=$2 AND $3='Person' FOR SHARE")
            .bind(actor_id).bind(&name).bind(actor["type"].as_str()).fetch_optional(&mut **tx).await?
        {
            return active_user(row);
        }
        advisory(tx, &format!("remote-user:{actor_id}")).await?;
    }
    let row = if local {
        let prefix = format!("{}/actors/users/", config.base);
        let id = actor_id
            .strip_prefix(&prefix)
            .ok_or(bad("Invalid local author."))?;
        sqlx::query("SELECT * FROM users WHERE id=$1 FOR SHARE")
            .bind(id)
            .fetch_optional(&mut **tx)
            .await?
    } else {
        sqlx::query("UPDATE users SET display_name=$2 WHERE remote_actor=$1 AND display_name<>$2 AND $3='Person'")
            .bind(actor_id).bind(&name).bind(actor["type"].as_str()).execute(&mut **tx).await?;
        sqlx::query("SELECT * FROM users WHERE remote_actor=$1 FOR SHARE")
            .bind(actor_id)
            .fetch_optional(&mut **tx)
            .await?
    };
    let row = if let Some(row) = row {
        row
    } else if local {
        return Err(Failure(StatusCode::NOT_FOUND, "User not found."));
    } else {
        let id = Uuid::new_v4().to_string();
        let stem: String = actor["preferredUsername"]
            .as_str()
            .unwrap_or("remote")
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
            .take(40)
            .collect();
        let stem = if stem.is_empty() { "remote" } else { &stem };
        let stem = format!(
            "{stem}@{}",
            &url[url::Position::BeforeHost..url::Position::AfterPort]
        );
        let exists: bool =
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM users WHERE username=$1)")
                .bind(&stem)
                .fetch_one(&mut **tx)
                .await?;
        let username = if exists {
            format!("{stem}-{}", &id[..6])
        } else {
            stem
        };
        sqlx::query("INSERT INTO users(id,username,display_name,created_at,remote_actor) VALUES($1,$2,$3,$4,$5) RETURNING *")
                .bind(id).bind(username).bind(name).bind(timestamp()).bind(actor_id).fetch_one(&mut **tx).await?
    };
    active_user(row)
}
fn active_user(row: PgRow) -> Result<PgRow, Failure> {
    if row.get::<i64, _>("banned") != 0 || row.get::<String, _>("admission_status") != "approved" {
        return Err(Failure(StatusCode::FORBIDDEN, "Account is not active."));
    }
    Ok(row)
}
async fn import_note(
    config: &crate::Config,
    tx: &mut Transaction<'_, Postgres>,
    channel: &PgRow,
    user: &PgRow,
    note: &Value,
    channel_actor: &str,
    tags: &[Value],
) -> Result<(), Failure> {
    let channel_id: &str = channel.get("id");
    if note["channel"].as_str() != Some(channel_actor) {
        return Err(bad("Message belongs to another channel."));
    }
    let object = string(note, "id")?;
    let local = object.strip_prefix(&format!("{}/objects/messages/", config.base));
    let existing = sqlx::query("SELECT * FROM messages WHERE remote_object=$1 OR id=$2 FOR UPDATE")
        .bind(object)
        .bind(local)
        .fetch_optional(&mut **tx)
        .await?;
    let topic: Option<String> = if note["topic"].is_null() {
        None
    } else if channel.get::<Option<String>, _>("remote_actor").is_some() {
        Some(import_topic(config, tx, channel, &note["topic"]).await?)
    } else {
        let prefix = format!("{}/objects/topics/", config.base);
        let local = string(&note["topic"], "id")?
            .strip_prefix(&prefix)
            .ok_or(bad("Topic is not hosted by this channel."))?;
        Some(
            sqlx::query_scalar("SELECT id FROM topics WHERE id=$1 AND channel_id=$2")
                .bind(local)
                .bind(channel_id)
                .fetch_optional(&mut **tx)
                .await?
                .ok_or(bad("Topic not found in this channel."))?,
        )
    };
    let parent = if let Some(object) = note["inReplyTo"].as_str().filter(|s| !s.is_empty()) {
        if object == string(note, "id")? {
            return Err(bad("A message cannot reply to itself."));
        }
        let local = object.strip_prefix(&format!("{}/objects/messages/", config.base));
        let parent =
            sqlx::query("SELECT * FROM messages WHERE remote_object=$1 OR id=$2 FOR SHARE")
                .bind(object)
                .bind(local)
                .fetch_optional(&mut **tx)
                .await?;
        let parent = match parent {
            Some(parent) => parent,
            None => history_placeholder(config, tx, channel, object, topic.as_deref()).await?,
        };
        if parent.get::<&str, _>("channel_id") != channel_id {
            return Err(bad("Remote reply parent is unavailable in this channel."));
        }
        Some(parent)
    } else {
        None
    };
    let parent_id: Option<String> = parent.as_ref().map(|r| r.get("id"));
    if let Some(parent_id) = &parent_id {
        let invalid: bool=sqlx::query_scalar("WITH RECURSIVE ancestry(id,parent_id,depth,path,cycle) AS (SELECT id,parent_id,1,ARRAY[id],false FROM messages WHERE id=$1 UNION ALL SELECT m.id,m.parent_id,a.depth+1,a.path||m.id,m.id=ANY(a.path) FROM messages m JOIN ancestry a ON m.id=a.parent_id WHERE NOT a.cycle AND a.depth<=1000) SELECT COALESCE(bool_or(id=$2 OR cycle OR depth>1000),false) FROM ancestry")
            .bind(parent_id).bind(existing.as_ref().map(|r|r.get::<&str,_>("id"))).fetch_one(&mut **tx).await?;
        if invalid {
            return Err(bad("Invalid remote reply ancestry."));
        }
        if topic.is_some()
            && parent.as_ref().is_some_and(|p| {
                p.get::<i64, _>("history_placeholder") != 0
                    && p.get::<Option<String>, _>("topic_id").is_none()
            })
        {
            sqlx::query("UPDATE messages SET topic_id=$2 WHERE id=$1")
                .bind(parent_id)
                .bind(&topic)
                .execute(&mut **tx)
                .await?;
        }
    }
    let title = note["name"].as_str().filter(|s| !s.is_empty());
    let untitled = channel.get::<Option<String>, _>("remote_actor").is_some()
        || channel.get::<i64, _>("optional_titles") != 0
        || existing
            .as_ref()
            .is_some_and(|r| r.get::<Option<String>, _>("title").is_none());
    match channel.get::<&str, _>("mode") {
        "timeline" if topic.is_some() || title.is_some() => {
            return Err(bad("Invalid remote conversation structure."));
        }
        "threaded"
            if topic.is_some()
                || parent_id.is_some() && title.is_some()
                || parent_id.is_none() && title.is_none() && !untitled =>
        {
            return Err(bad("Invalid remote conversation structure."));
        }
        "topical"
            if topic.is_none()
                || title.is_some()
                || parent
                    .as_ref()
                    .is_some_and(|p| p.get::<Option<String>, _>("topic_id") != topic) =>
        {
            return Err(bad("Invalid remote conversation structure."));
        }
        _ => {}
    }
    let published = string(note, "published")?;
    let updated = note["updated"].as_str();
    let body = js_trim(string(note, "content")?);
    let tags = serde_json::to_string(tags).map_err(|_| bad("Invalid message emoji."))?;
    if let Some(existing) = existing {
        if existing.get::<&str, _>("channel_id") != channel_id {
            return Err(Failure(
                StatusCode::FORBIDDEN,
                "Object belongs to another channel.",
            ));
        }
        if existing.get::<Option<String>, _>("deleted_at").is_some() {
            return Ok(());
        }
        if existing.get::<i64, _>("history_placeholder") != 0 {
            sqlx::query("UPDATE messages SET author_id=$2,body=$3,title=$4,topic_id=$5,parent_id=$6,created_at=$7,edited_at=$8,emoji_tags=$9,history_placeholder=0 WHERE id=$1")
                .bind(existing.get::<&str,_>("id")).bind(user.get::<&str,_>("id")).bind(body).bind(title).bind(&topic).bind(&parent_id).bind(published).bind(updated).bind(&tags).execute(&mut **tx).await?;
        } else {
            if existing.get::<&str, _>("author_id") != user.get::<&str, _>("id")
                || existing.get::<Option<String>, _>("parent_id") != parent_id
                || existing.get::<Option<String>, _>("topic_id") != topic
            {
                return Err(Failure(
                    StatusCode::FORBIDDEN,
                    "Remote update cannot change message authority or relationships.",
                ));
            }
            let old_time: String = existing
                .get::<Option<String>, _>("edited_at")
                .unwrap_or_else(|| existing.get("created_at"));
            let new_time =
                date(updated.unwrap_or(published)).ok_or(bad("Invalid remote message."))?;
            let old_time = date(&old_time).ok_or_else(Failure::unsupported)?;
            if new_time <= old_time {
                if new_time == old_time
                    && (body != existing.get::<&str, _>("body")
                        || title != existing.get::<Option<&str>, _>("title"))
                {
                    return Err(Failure(
                        StatusCode::CONFLICT,
                        "Conflicting message with an existing object ID.",
                    ));
                }
                return Ok(());
            }
            sqlx::query(
                "UPDATE messages SET body=$2,title=$3,edited_at=$4,emoji_tags=$5 WHERE id=$1",
            )
            .bind(existing.get::<&str, _>("id"))
            .bind(body)
            .bind(title)
            .bind(updated)
            .bind(&tags)
            .execute(&mut **tx)
            .await?;
        }
    } else {
        sqlx::query("INSERT INTO messages(id,channel_id,author_id,body,title,topic_id,parent_id,created_at,edited_at,remote_object,emoji_tags) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)")
            .bind(Uuid::new_v4().to_string()).bind(channel_id).bind(user.get::<&str,_>("id")).bind(body).bind(title).bind(&topic).bind(&parent_id).bind(published).bind(updated).bind(object).bind(&tags).execute(&mut **tx).await?;
    }
    sqlx::query("INSERT INTO federation_objects(id,user_id,channel_actor,document) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO UPDATE SET document=excluded.document")
        .bind(object).bind(user.get::<&str,_>("id")).bind(channel_actor).bind(note.to_string()).execute(&mut **tx).await?;
    Ok(())
}
async fn import_topic(
    config: &crate::Config,
    tx: &mut Transaction<'_, Postgres>,
    channel: &PgRow,
    topic: &Value,
) -> Result<String, Failure> {
    let object = string(topic, "id")?;
    let channel_actor = channel
        .get::<Option<String>, _>("remote_actor")
        .unwrap_or_else(|| {
            format!(
                "{}/actors/channels/{}",
                config.base,
                channel.get::<&str, _>("id")
            )
        });
    federation::allowed(config, tx, object).await?;
    if net::peer_url(object, config)?.origin() != net::peer_url(&channel_actor, config)?.origin() {
        return Err(bad("Invalid topic origin."));
    }
    let title = js_trim(string(topic, "name")?);
    if title.is_empty() || title.encode_utf16().count() > 100 {
        return Err(bad("Invalid topic title."));
    }
    let existing = sqlx::query("SELECT id,channel_id FROM topics WHERE remote_id=$1")
        .bind(object)
        .fetch_optional(&mut **tx)
        .await?;
    if let Some(row) = existing {
        if row.get::<&str, _>("channel_id") != channel.get::<&str, _>("id") {
            return Err(bad("Topic belongs to another channel."));
        }
        return Ok(row.get("id"));
    }
    let id = Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO topics(id,channel_id,title,created_at,remote_id) VALUES($1,$2,$3,$4,$5)",
    )
    .bind(&id)
    .bind(channel.get::<&str, _>("id"))
    .bind(title)
    .bind(timestamp())
    .bind(object)
    .execute(&mut **tx)
    .await?;
    Ok(id)
}
async fn history_placeholder(
    config: &crate::Config,
    tx: &mut Transaction<'_, Postgres>,
    channel: &PgRow,
    object: &str,
    topic: Option<&str>,
) -> Result<PgRow, Failure> {
    let actor = channel
        .get::<Option<String>, _>("remote_actor")
        .ok_or(bad("A home channel requires an existing parent."))?;
    federation::allowed(config, tx, object).await?;
    let source=remote_user(config,tx,&json!({"id":actor,"name":channel.get::<&str,_>("name"),"preferredUsername":channel.get::<&str,_>("name")})).await?;
    let title = if channel.get::<&str, _>("mode") == "threaded" {
        Some("Earlier thread")
    } else {
        None
    };
    sqlx::query("INSERT INTO messages(id,channel_id,author_id,body,title,topic_id,created_at,remote_object,history_placeholder) VALUES($1,$2,$3,'Earlier message is outside the cached history.',$4,$5,$6,$7,1) RETURNING *")
        .bind(Uuid::new_v4().to_string()).bind(channel.get::<&str,_>("id")).bind(source.get::<&str,_>("id")).bind(title).bind(topic).bind(timestamp()).bind(object).fetch_one(&mut **tx).await.map_err(Failure::from)
}
async fn advisory(tx: &mut Transaction<'_, Postgres>, key: &str) -> Result<(), Failure> {
    let hash = i64::from_be_bytes(
        Sha256::digest(key.as_bytes())[..8]
            .try_into()
            .expect("hash"),
    );
    sqlx::query("SELECT pg_advisory_xact_lock($1)")
        .bind(hash)
        .execute(&mut **tx)
        .await?;
    Ok(())
}
fn canonical_note(value: &Value) -> bool {
    match value {
        Value::Number(n) => n
            .as_i64()
            .is_some_and(|n| n.unsigned_abs() <= 9007199254740991),
        Value::Object(obj) => obj
            .iter()
            .all(|(k, v)| k.parse::<u32>().is_err() && canonical_note(v)),
        Value::Array(a) => a.iter().all(canonical_note),
        Value::String(s) => !s.contains('\0'),
        _ => true,
    }
}
fn string<'a>(value: &'a Value, key: &str) -> Result<&'a str, Failure> {
    value[key].as_str().ok_or(bad("Invalid remote message."))
}
fn bad(message: &'static str) -> Failure {
    Failure(StatusCode::BAD_REQUEST, message)
}
fn date(value: &str) -> Option<i64> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|d| d.timestamp_millis())
}
fn timestamp() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}
fn truncate(value: &str, limit: usize) -> String {
    String::from_utf16_lossy(&value.encode_utf16().take(limit).collect::<Vec<_>>())
}
pub(crate) fn js_trim(value: &str) -> &str {
    value.trim_matches(|c|matches!(c,'\u{0009}'..='\u{000d}'|' '|'\u{00a0}'|'\u{1680}'|'\u{2000}'..='\u{200a}'|'\u{2028}'|'\u{2029}'|'\u{202f}'|'\u{205f}'|'\u{3000}'|'\u{feff}'))
}

// Admission, imported mutation and durable checkpoint share one transaction.
async fn stream_checkpoint(config: &crate::Config, tx: &mut Transaction<'_, Postgres>, checkpoint: &crate::outbox::StreamCheckpoint) -> Result<(), Failure> {
    if checkpoint.after < 0 || checkpoint.cursor != checkpoint.after.checked_add(1).ok_or(bad("Invalid channel checkpoint."))? || checkpoint.actor != checkpoint.channel {
        return Err(bad("Invalid channel checkpoint."));
    }
    let enabled: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM instance_settings WHERE key='federation_enabled' AND value='true')").fetch_one(&mut **tx).await?;
    if !enabled { return Err(Failure(StatusCode::FORBIDDEN,"Federation is disabled.")); }
    federation::allowed(config, tx, &checkpoint.channel).await?;
    let row = sqlx::query("SELECT c.id,s.stream_start,p.cursor FROM channels c JOIN federation_subscriptions s ON s.channel_id=c.id JOIN users u ON u.id=s.user_id JOIN federation_channel_cursors p ON p.channel_id=c.id WHERE c.remote_actor=$1 AND s.follow_id=$2 AND s.status='accepted' AND u.banned=0 AND u.admission_status='approved' AND u.federation_receive=1 AND u.federation_subscribe=1 FOR UPDATE OF p FOR SHARE OF s,u")
        .bind(&checkpoint.channel).bind(&checkpoint.follow).fetch_optional(&mut **tx).await?.ok_or(Failure(StatusCode::CONFLICT,"Channel consumption admission changed."))?;
    let start = row.get::<Option<i64>,_>("stream_start").ok_or(bad("Channel stream was not negotiated."))?;
    if checkpoint.after != row.get::<i64,_>("cursor").max(start) { return Err(Failure(StatusCode::CONFLICT,"Channel consumption checkpoint changed.")); }
    sqlx::query("UPDATE federation_channel_cursors SET cursor=$1,error=NULL,retry_at=0 WHERE channel_id=$2").bind(checkpoint.cursor).bind(row.get::<&str,_>("id")).execute(&mut **tx).await?;
    Ok(())
}
