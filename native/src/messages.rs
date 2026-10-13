use crate::{
    Config, Failure, Job,
    federation::{self, Signer},
};
use axum::http::StatusCode;
use chrono::{SecondsFormat, Utc};
use serde_json::{Value, json};
use sqlx::{Postgres, Row, Transaction, postgres::PgRow, types::Json as SqlJson};
use std::collections::{HashMap, HashSet};
use uuid::Uuid;

struct Input {
    body: String,
    title: Option<String>,
    parent: Option<String>,
    topic: Option<String>,
    parent_object: Option<String>,
    topic_object: Option<Value>,
    tags: Vec<Value>,
    wire: Vec<Value>,
}
fn optional(value: &Option<String>, max: usize, title: bool) -> Result<Option<String>, Failure> {
    value
        .as_ref()
        .map(|v| {
            if v.contains(['\0', '\u{0085}', '\u{feff}']) {
                return Err(Failure::unsupported());
            }
            let trimmed = v.trim();
            if title && trimmed.is_empty() {
                return Ok(None);
            }
            if trimmed.is_empty() || trimmed.encode_utf16().count() > max {
                return Err(Failure(
                    StatusCode::BAD_REQUEST,
                    "Invalid message structure.",
                ));
            }
            Ok(Some(trimmed.to_owned()))
        })
        .unwrap_or(Ok(None))
}
async fn input(
    config: &Config,
    job: &Job,
    channel: &PgRow,
    who: &str,
    tx: &mut Transaction<'_, Postgres>,
) -> Result<Input, Failure> {
    let body = job
        .body
        .as_deref()
        .ok_or(Failure(StatusCode::BAD_REQUEST, "Message is required."))?;
    let title = optional(&job.title, 160, true)?;
    // Keep NUL handling and JS-only trim characters with compatibility until
    // their storage normalization has native parity.
    if body.contains(['\0', '\u{0085}', '\u{feff}'])
        || title
            .as_deref()
            .is_some_and(|s| s.contains(['\0', '\u{0085}', '\u{feff}']))
    {
        return Err(Failure::unsupported());
    }
    let body = body.trim();
    if body.is_empty() || body.encode_utf16().count() > 8000 {
        return Err(Failure(
            StatusCode::BAD_REQUEST,
            "Message must be between 1 and 8000 characters.",
        ));
    }
    let content = format!("{body}{}", title.as_deref().unwrap_or(""));
    crate::emoji::refuse(
        &content,
        &crate::emoji::bans(tx, channel.get("reaction_bans")).await?,
    )?;
    let tags = crate::emoji::tags(tx, who, &content).await?;
    let wire = crate::emoji::wire(tx, &config.base, &tags).await?;
    let parent = optional(&job.parent_id, 100, false)?;
    let topic = optional(&job.topic_id, 100, false)?;
    let parent_row = if let Some(parent) = &parent {
        Some(sqlx::query("SELECT * FROM messages WHERE id=$1 AND channel_id=$2 AND deleted_at IS NULL FOR SHARE").bind(parent).bind(&job.channel).fetch_optional(&mut **tx).await?.ok_or(Failure(StatusCode::BAD_REQUEST,"Reply to an existing message in this channel."))?)
    } else {
        None
    };
    let topic_row = if let Some(topic) = &topic {
        Some(
            sqlx::query("SELECT * FROM topics WHERE id=$1 AND channel_id=$2 FOR SHARE")
                .bind(topic)
                .bind(&job.channel)
                .fetch_optional(&mut **tx)
                .await?
                .ok_or(Failure(
                    StatusCode::BAD_REQUEST,
                    "Choose a topic in this channel.",
                ))?,
        )
    } else {
        None
    };
    let mode: String = channel.get("mode");
    if (mode == "timeline" && (topic.is_some() || title.is_some()))
        || (mode == "threaded"
            && (topic.is_some()
                || (parent.is_none()
                    && title.is_none()
                    && channel.get::<i64, _>("optional_titles") == 0)))
        || (mode == "topical" && (topic.is_none() || title.is_some()))
        || parent_row
            .as_ref()
            .is_some_and(|p| p.get::<Option<String>, _>("topic_id") != topic || title.is_some())
    {
        return Err(Failure(
            StatusCode::BAD_REQUEST,
            "Message structure does not match this channel mode.",
        ));
    }
    let remote = channel.get::<Option<String>, _>("remote_actor").is_some();
    let parent_object = parent_row.map(|p| {
        p.get::<Option<String>, _>("remote_object")
            .unwrap_or_else(|| {
                format!(
                    "{}/objects/messages/{}",
                    config.base,
                    p.get::<String, _>("id")
                )
            })
    });
    let topic_object=topic_row.map(|t| json!({"id":if remote {t.get::<Option<String>,_>("remote_id")} else {Some(format!("{}/objects/topics/{}",config.base,t.get::<String,_>("id")))},"name":t.get::<String,_>("title")}));
    Ok(Input {
        body: body.into(),
        title,
        parent,
        topic,
        parent_object,
        topic_object,
        tags,
        wire,
    })
}
fn note(
    config: &Config,
    input: &Input,
    object: &str,
    actor: &str,
    channel: &str,
    published: &str,
) -> Value {
    let _ = config;
    json!({"id":object,"type":"Note","attributedTo":actor,"to":[channel],"channel":channel,"mediaType":"text/plain",
        "content":input.body,"name":input.title,"inReplyTo":input.parent_object,"topic":input.topic_object,"published":published,"updated":null,"emoji":input.wire})
}
pub async fn post(
    config: &Config,
    signer: &Signer,
    job: &Job,
    user: &PgRow,
    channel: &PgRow,
    tx: &mut Transaction<'_, Postgres>,
) -> Result<(Value, bool, bool), Failure> {
    let who: String = user.get("id");
    let remote: Option<String> = channel.get("remote_actor");
    let federated = channel.get::<i64, _>("federation_enabled") != 0;
    if remote.is_some() {
        federation::require(
            tx,
            user,
            &["federation_send", "federation_post", "federation_subscribe"],
        )
        .await?;
    } else if federated {
        federation::require(tx, user, &["federation_send", "federation_post"]).await?;
    }
    if sqlx::query("SELECT 1 FROM channel_mirrors WHERE channel_id=$1 UNION ALL SELECT 1 FROM channel_bridges WHERE channel_id=$1 UNION ALL SELECT 1 FROM instance_settings WHERE key='xmpp_domain' AND value!='' LIMIT 1").bind(&job.channel).fetch_optional(&mut **tx).await?.is_some() { return Err(Failure::unsupported()); }
    if sqlx::query(
        "SELECT 1 FROM channel_rules WHERE channel_id=$1 AND user_id=$2 AND rule='block' FOR SHARE",
    )
    .bind(&job.channel)
    .bind(&who)
    .fetch_optional(&mut **tx)
    .await?
    .is_some()
    {
        return Err(Failure(
            StatusCode::FORBIDDEN,
            "Join this channel before posting.",
        ));
    }
    let input = input(config, job, channel, &who, tx).await?;
    let id = job
        .message_id
        .as_deref()
        .ok_or(Failure(StatusCode::BAD_REQUEST, "Message ID is required."))?;
    if Uuid::parse_str(id).is_err() {
        return Err(Failure(StatusCode::BAD_REQUEST, "Invalid message ID."));
    }
    let actor = format!("{}/actors/users/{who}", config.base);
    let published = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
    let mut outgoing = false;
    let (result, changed) = if let Some(home) = remote {
        let object = format!("{}/federation/objects/{id}", config.base);
        let signed = signer
            .sign(
                tx,
                note(config, &input, &object, &actor, &home, &published),
                &actor,
            )
            .await?;
        let changed=sqlx::query("INSERT INTO federation_objects(id,user_id,channel_actor,document) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO NOTHING")
            .bind(&object).bind(&who).bind(&home).bind(signed.to_string()).execute(&mut **tx).await?.rows_affected()!=0;
        let previous = sqlx::query(
            "SELECT user_id,channel_actor,document FROM federation_objects WHERE id=$1 FOR SHARE",
        )
        .bind(&object)
        .fetch_one(&mut **tx)
        .await?;
        let stored: Value =
            serde_json::from_str(previous.get::<&str, _>("document")).map_err(|_| {
                Failure(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "Invalid stored origin proof.",
                )
            })?;
        if previous.get::<String, _>("user_id") != who
            || previous
                .get::<Option<String>, _>("channel_actor")
                .as_deref()
                != Some(&home)
            || ["content", "name", "inReplyTo", "topic", "emoji"]
                .iter()
                .any(|field| stored[field] != signed[field])
        {
            return Err(Failure(StatusCode::CONFLICT, "Message ID already used."));
        }
        if changed {
            outgoing = true;
            federation::queue(
                config,
                tx,
                federation::activity(config, "Create", &actor, stored.clone()),
                &[home],
                "post",
                &who,
                &job.channel,
            )
            .await?;
        }
        let revision: Option<String> =
            sqlx::query_scalar("SELECT revision FROM user_avatars WHERE user_id=$1")
                .bind(&who)
                .fetch_optional(&mut **tx)
                .await?;
        let mut page = vec![pending(
            config,
            user,
            &job.channel,
            &stored,
            &input,
            revision.as_deref(),
            None,
        )?];
        crate::emoji::live(tx, &config.base, &mut page).await?;
        (page.remove(0), changed)
    } else {
        let changed=sqlx::query("INSERT INTO messages(id,channel_id,author_id,body,title,topic_id,parent_id,created_at,emoji_tags) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(id) DO NOTHING")
            .bind(id).bind(&job.channel).bind(&who).bind(&input.body).bind(&input.title).bind(&input.topic).bind(&input.parent).bind(&published).bind(serde_json::to_string(&input.tags).map_err(|_|Failure::unsupported())?).execute(&mut **tx).await?.rows_affected()!=0;
        let previous = sqlx::query("SELECT * FROM messages WHERE id=$1")
            .bind(id)
            .fetch_one(&mut **tx)
            .await?;
        if previous.get::<String, _>("author_id") != who
            || previous.get::<String, _>("channel_id") != job.channel
            || previous.get::<String, _>("body") != input.body
            || previous.get::<Option<String>, _>("title") != input.title
            || previous.get::<Option<String>, _>("parent_id") != input.parent
            || previous.get::<Option<String>, _>("topic_id") != input.topic
            || serde_json::from_str::<Value>(previous.get("emoji_tags")).ok()
                != Some(json!(input.tags))
        {
            return Err(Failure(StatusCode::CONFLICT, "Message ID already used."));
        }
        if changed && federated {
            let recipients: Vec<String>=sqlx::query_scalar("SELECT actor FROM federation_follows WHERE channel_id=$1 AND status='accepted' FOR SHARE").bind(&job.channel).fetch_all(&mut **tx).await?;
            if !recipients.is_empty() {
                outgoing = true;
                let channel_actor = format!("{}/actors/channels/{}", config.base, job.channel);
                let signed = signer
                    .sign(
                        tx,
                        note(
                            config,
                            &input,
                            &format!("{}/objects/messages/{id}", config.base),
                            &actor,
                            &channel_actor,
                            &published,
                        ),
                        &actor,
                    )
                    .await?;
                let inner = federation::activity(config, "Create", &actor, signed);
                federation::queue(
                    config,
                    tx,
                    federation::activity(config, "Announce", &channel_actor, inner),
                    &recipients,
                    "relay",
                    &who,
                    &job.channel,
                )
                .await?;
            }
        }
        let SqlJson(result): SqlJson<Value>=sqlx::query_scalar("SELECT to_jsonb(m)||jsonb_build_object('username',u.username,'display_name',u.display_name,'emojis','[]'::jsonb,'object_url',$2||'/objects/messages/'||m.id,'author_actor_url',$2||'/actors/users/'||u.id,'avatar_url',CASE WHEN a.revision IS NULL THEN NULL ELSE '/api/avatars/'||u.id||'?v='||a.revision END) FROM messages m JOIN users u ON u.id=m.author_id LEFT JOIN user_avatars a ON a.user_id=u.id WHERE m.id=$1")
            .bind(id).bind(&config.base).fetch_one(&mut **tx).await?;
        let mut page = vec![result];
        crate::emoji::live(tx, &config.base, &mut page).await?;
        (page.remove(0), changed)
    };
    if changed {
        let prefix = format!("{}/media/", config.base);
        let media: Vec<String> = input
            .body
            .match_indices(&prefix)
            .map(|(at, _)| input.body[at + prefix.len()..].chars().take(43).collect())
            .collect();
        if !media.is_empty() {
            sqlx::query("UPDATE attachments SET published=1 WHERE owner_id=$1 AND id=ANY($2)")
                .bind(&who)
                .bind(media)
                .execute(&mut **tx)
                .await?;
        }
    }
    Ok((result, changed, outgoing))
}
pub async fn edit(
    config: &Config,
    signer: &Signer,
    job: &Job,
    user: &PgRow,
    channel: &PgRow,
    tx: &mut Transaction<'_, Postgres>,
) -> Result<(Value, bool, bool), Failure> {
    if channel.get::<Option<String>,_>("remote_actor").is_some() || sqlx::query("SELECT 1 FROM channel_mirrors WHERE channel_id=$1 UNION ALL SELECT 1 FROM channel_bridges WHERE channel_id=$1 UNION ALL SELECT 1 FROM instance_settings WHERE key='xmpp_domain' AND value<>'' LIMIT 1").bind(&job.channel).fetch_optional(&mut **tx).await?.is_some(){return Err(Failure::unsupported());}
    let who = user.get::<&str, _>("id");
    let id = job
        .message_id
        .as_deref()
        .ok_or(Failure(StatusCode::BAD_REQUEST, "Message ID is required."))?;
    let message = sqlx::query("SELECT * FROM messages WHERE id=$1 AND channel_id=$2 FOR UPDATE")
        .bind(id)
        .bind(&job.channel)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or(Failure(StatusCode::NOT_FOUND, "Message not found."))?;
    if message.get::<Option<String>, _>("remote_object").is_some() {
        return Err(Failure::unsupported());
    }
    if message.get::<&str, _>("author_id") != who {
        return Err(Failure(
            StatusCode::FORBIDDEN,
            "Only the author can edit this message.",
        ));
    }
    if message.get::<Option<String>, _>("deleted_at").is_some() {
        return Err(Failure(
            StatusCode::CONFLICT,
            "Removed messages cannot be edited.",
        ));
    }
    if message.get::<Option<String>, _>("edited_at") != job.expected_edited_at {
        return Err(Failure(
            StatusCode::CONFLICT,
            "This message changed. Close the editor and try again.",
        ));
    }
    if sqlx::query(
        "SELECT 1 FROM channel_rules WHERE channel_id=$1 AND user_id=$2 AND rule='block' FOR SHARE",
    )
    .bind(&job.channel)
    .bind(who)
    .fetch_optional(&mut **tx)
    .await?
    .is_some()
    {
        return Err(Failure(
            StatusCode::FORBIDDEN,
            "Join this channel before posting.",
        ));
    }
    if channel.get::<i64, _>("federation_enabled") != 0 {
        federation::require(tx, user, &["federation_send", "federation_post"]).await?;
    }
    let body = job
        .body
        .as_deref()
        .ok_or(Failure(StatusCode::BAD_REQUEST, "Message is required."))?;
    if body.contains(['\0', '\u{0085}', '\u{feff}']) {
        return Err(Failure::unsupported());
    }
    let body = crate::inbox::js_trim(body);
    if body.is_empty() || body.encode_utf16().count() > 8000 {
        return Err(Failure(
            StatusCode::BAD_REQUEST,
            "Message must be between 1 and 8000 characters.",
        ));
    }
    let old_title = message.get::<Option<String>, _>("title");
    let title = if job.title_supplied {
        if channel.get::<&str, _>("mode") != "threaded"
            || message.get::<Option<String>, _>("parent_id").is_some()
        {
            return Err(Failure(
                StatusCode::BAD_REQUEST,
                "Only thread roots have editable titles.",
            ));
        }
        optional(&job.title, 160, true)?
    } else {
        old_title.clone()
    };
    if title.is_none() && old_title.is_some() && channel.get::<i64, _>("optional_titles") == 0 {
        return Err(Failure(
            StatusCode::BAD_REQUEST,
            "Threads in this channel need a title.",
        ));
    }
    let content = format!("{body}{}", title.as_deref().unwrap_or(""));
    crate::emoji::refuse(
        &content,
        &crate::emoji::bans(tx, channel.get("reaction_bans")).await?,
    )?;
    let tags = crate::emoji::tags(tx, who, &content).await?;
    let previous = message
        .get::<Option<String>, _>("edited_at")
        .unwrap_or_else(|| message.get("created_at"));
    let previous = chrono::DateTime::parse_from_rfc3339(&previous)
        .map_err(|_| Failure::unsupported())?
        .timestamp_millis();
    let updated = chrono::DateTime::from_timestamp_millis(
        Utc::now()
            .timestamp_millis()
            .max(previous.saturating_add(1)),
    )
    .ok_or_else(Failure::unsupported)?
    .to_rfc3339_opts(SecondsFormat::Millis, true);
    sqlx::query("UPDATE messages SET body=$2,title=$3,edited_at=$4,emoji_tags=$5 WHERE id=$1")
        .bind(id)
        .bind(body)
        .bind(&title)
        .bind(&updated)
        .bind(serde_json::to_string(&tags).map_err(|_| Failure::unsupported())?)
        .execute(&mut **tx)
        .await?;
    let prefix = format!("{}/media/", config.base);
    let media: Vec<String> = body
        .match_indices(&prefix)
        .map(|(at, _)| body[at + prefix.len()..].chars().take(43).collect())
        .collect();
    if !media.is_empty() {
        sqlx::query("UPDATE attachments SET published=1 WHERE owner_id=$1 AND id=ANY($2)")
            .bind(who)
            .bind(media)
            .execute(&mut **tx)
            .await?;
    }
    let mut outgoing = false;
    if channel.get::<i64, _>("federation_enabled") != 0 {
        let recipients:Vec<String>=sqlx::query_scalar("SELECT actor FROM federation_follows WHERE channel_id=$1 AND status='accepted' FOR SHARE").bind(&job.channel).fetch_all(&mut **tx).await?;
        if !recipients.is_empty() {
            let parent_id = message.get::<Option<String>, _>("parent_id");
            let parent_object = if let Some(parent) = &parent_id {
                sqlx::query_scalar("SELECT COALESCE(remote_object,$2||'/objects/messages/'||id) FROM messages WHERE id=$1").bind(parent).bind(&config.base).fetch_optional(&mut **tx).await?
            } else {
                None
            };
            let topic_id = message.get::<Option<String>, _>("topic_id");
            let topic_object = if let Some(topic) = &topic_id {
                let row = sqlx::query("SELECT id,title FROM topics WHERE id=$1")
                    .bind(topic)
                    .fetch_optional(&mut **tx)
                    .await?;
                row.map(|r|json!({"id":format!("{}/objects/topics/{}",config.base,r.get::<&str,_>("id")),"name":r.get::<&str,_>("title")}))
            } else {
                None
            };
            let input = Input {
                body: body.into(),
                title: title.clone(),
                parent: parent_id,
                topic: topic_id,
                parent_object,
                topic_object,
                tags: tags.clone(),
                wire: crate::emoji::wire(tx, &config.base, &tags).await?,
            };
            let actor = format!("{}/actors/users/{who}", config.base);
            let channel_actor = format!("{}/actors/channels/{}", config.base, job.channel);
            let mut document = note(
                config,
                &input,
                &format!("{}/objects/messages/{id}", config.base),
                &actor,
                &channel_actor,
                message.get("created_at"),
            );
            document["updated"] = json!(updated);
            let document = signer.sign(tx, document, &actor).await?;
            federation::queue(
                config,
                tx,
                federation::activity(
                    config,
                    "Announce",
                    &channel_actor,
                    federation::activity(config, "Update", &actor, document),
                ),
                &recipients,
                "relay",
                who,
                &job.channel,
            )
            .await?;
            outgoing = true;
        }
    }
    sqlx::query(
        "INSERT INTO audit(actor_id,action,target,created_at) VALUES($1,'message.edit',$2,$3)",
    )
    .bind(who)
    .bind(id)
    .bind(Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true))
    .execute(&mut **tx)
    .await?;
    let SqlJson(result):SqlJson<Value>=sqlx::query_scalar("SELECT to_jsonb(m)||jsonb_build_object('username',u.username,'display_name',u.display_name,'emojis','[]'::jsonb,'object_url',COALESCE(m.remote_object,$2||'/objects/messages/'||m.id),'author_actor_url',COALESCE(u.remote_actor,$2||'/actors/users/'||u.id),'avatar_url',CASE WHEN a.revision IS NULL THEN NULL ELSE '/api/avatars/'||u.id||'?v='||a.revision END) FROM messages m JOIN users u ON u.id=m.author_id LEFT JOIN user_avatars a ON a.user_id=u.id WHERE m.id=$1").bind(id).bind(&config.base).fetch_one(&mut **tx).await?;
    let mut page = vec![result];
    crate::emoji::live(tx, &config.base, &mut page).await?;
    Ok((page.remove(0), true, outgoing))
}
fn pending(
    config: &Config,
    user: &PgRow,
    channel: &str,
    note: &Value,
    input: &Input,
    revision: Option<&str>,
    failed: Option<&str>,
) -> Result<Value, Failure> {
    let who: String = user.get("id");
    let object = note["id"].as_str().ok_or(Failure(
        StatusCode::SERVICE_UNAVAILABLE,
        "Invalid stored post.",
    ))?;
    let mut result = json!({"seq":0,"id":format!("queued-{}",object.rsplit('/').next().unwrap_or_default()),"channel_id":channel,"author_id":who,"body":note["content"],
        "title":note["name"],"topic_id":input.topic,"parent_id":input.parent,"created_at":note["published"],"deleted_at":null,"edited_at":null,
        "remote_object":object,"emoji_tags":serde_json::to_string(&input.tags).map_err(|_|Failure::unsupported())?,"history_placeholder":0,"username":user.get::<String,_>("username"),"display_name":user.get::<String,_>("display_name"),
        "object_url":object,"emojis":[],"author_actor_url":format!("{}/actors/users/{who}",config.base),"avatar_url":revision.map(|r|format!("/api/avatars/{who}?v={r}")),"queued":true});
    if let Some(error) = failed {
        result["failed"] = json!(error);
    }
    Ok(result)
}

pub async fn pending_posts(
    config: &Config,
    tx: &mut Transaction<'_, Postgres>,
    user: &PgRow,
    channel: &PgRow,
) -> Result<Vec<Value>, Failure> {
    let Some(home) = channel.get::<Option<String>, _>("remote_actor") else {
        return Ok(vec![]);
    };
    let who: String = user.get("id");
    let channel_id: String = channel.get("id");
    let now = Utc::now().timestamp_millis();
    let rows=sqlx::query("SELECT o.activity,d.status,d.error FROM federation_deliveries d JOIN federation_outgoing o ON o.id=d.activity_id WHERE d.recipient=$1 AND o.channel_id=$2 AND o.user_id=$3 AND o.purpose='post' AND (d.status='pending' OR (d.status='sent' AND o.created_at>$4) OR (d.status IN ('failed','cancelled') AND o.created_at>$5)) ORDER BY d.id")
        .bind(home).bind(&channel_id).bind(&who).bind(now-3600000).bind(now-86400000).fetch_all(&mut **tx).await?;
    let mut notes = vec![];
    for row in rows {
        let activity: Value = serde_json::from_str(row.get::<&str, _>("activity"))
            .map_err(|_| Failure(StatusCode::SERVICE_UNAVAILABLE, "Invalid queued activity."))?;
        let note = &activity["object"];
        if activity["type"] != "Create" {
            continue;
        }
        let object = note["id"].as_str().ok_or(Failure(
            StatusCode::SERVICE_UNAVAILABLE,
            "Invalid queued post.",
        ))?;
        let _ = object;
        notes.push((
            note.clone(),
            row.get::<String, _>("status"),
            row.get::<Option<String>, _>("error"),
        ));
    }
    if notes.is_empty() {
        return Ok(vec![]);
    }
    let objects: Vec<_> = notes
        .iter()
        .filter_map(|(n, _, _)| n["id"].as_str())
        .collect();
    let received: HashSet<String> =
        sqlx::query_scalar("SELECT remote_object FROM messages WHERE remote_object=ANY($1)")
            .bind(objects)
            .fetch_all(&mut **tx)
            .await?
            .into_iter()
            .collect();
    notes.retain(|(n, _, _)| !n["id"].as_str().is_some_and(|id| received.contains(id)));
    if notes.is_empty() {
        return Ok(vec![]);
    }
    let revision: Option<String> =
        sqlx::query_scalar("SELECT revision FROM user_avatars WHERE user_id=$1")
            .bind(&who)
            .fetch_optional(&mut **tx)
            .await?;
    let parent_objects: Vec<_> = notes
        .iter()
        .filter_map(|(n, _, _)| n["inReplyTo"].as_str())
        .collect();
    let prefix = format!("{}/objects/messages/", config.base);
    let parent_ids: Vec<_> = parent_objects
        .iter()
        .filter_map(|p| p.strip_prefix(&prefix))
        .collect();
    let mut parents = HashMap::<String, String>::new();
    if !parent_objects.is_empty() {
        for row in sqlx::query("SELECT id,remote_object FROM messages WHERE channel_id=$1 AND (remote_object=ANY($2) OR id=ANY($3)) ORDER BY seq").bind(&channel_id).bind(parent_objects).bind(parent_ids).fetch_all(&mut **tx).await? {
            let id:String=row.get("id");parents.entry(format!("{prefix}{id}")).or_insert_with(||id.clone());
            if let Some(object)=row.get::<Option<String>,_>("remote_object"){parents.entry(object).or_insert(id);}
        }
    }
    let topic_objects: Vec<_> = notes
        .iter()
        .filter_map(|(n, _, _)| n["topic"]["id"].as_str())
        .collect();
    let topics: HashMap<String, String> = if topic_objects.is_empty() {
        HashMap::new()
    } else {
        sqlx::query("SELECT id,remote_id FROM topics WHERE channel_id=$1 AND remote_id=ANY($2)")
            .bind(&channel_id)
            .bind(topic_objects)
            .fetch_all(&mut **tx)
            .await?
            .into_iter()
            .map(|r| (r.get("remote_id"), r.get("id")))
            .collect()
    };
    let text = notes
        .iter()
        .map(|(n, _, _)| {
            format!(
                "{}{}",
                n["content"].as_str().unwrap_or(""),
                n["name"].as_str().unwrap_or("")
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    let catalog: HashMap<String, Value> = crate::emoji::tags(tx, &who, &text)
        .await?
        .into_iter()
        .filter_map(|t| t["name"].as_str().map(|name| (name.to_owned(), t.clone())))
        .collect();
    let mut result = vec![];
    for (note, status, error) in notes {
        let content = format!(
            "{}{}",
            note["content"].as_str().unwrap_or(""),
            note["name"].as_str().unwrap_or("")
        );
        let mut tags = vec![];
        let mut seen = HashSet::new();
        for (_, _, name) in crate::emoji::shortcodes(&content) {
            if seen.insert(name.clone())
                && let Some(tag) = catalog.get(&name)
            {
                tags.push(tag.clone());
            }
        }
        let input = Input {
            body: note["content"].as_str().unwrap_or_default().into(),
            title: note["name"].as_str().map(str::to_owned),
            parent: note["inReplyTo"]
                .as_str()
                .and_then(|p| parents.get(p))
                .cloned(),
            topic: note["topic"]["id"]
                .as_str()
                .and_then(|t| topics.get(t))
                .cloned(),
            parent_object: None,
            topic_object: None,
            tags,
            wire: vec![],
        };
        result.push(pending(
            config,
            user,
            &channel_id,
            &note,
            &input,
            revision.as_deref(),
            if matches!(status.as_str(), "failed" | "cancelled") {
                Some(error.as_deref().unwrap_or("Delivery failed."))
            } else {
                None
            },
        )?);
    }
    crate::emoji::live(tx, &config.base, &mut result).await?;
    Ok(result)
}
