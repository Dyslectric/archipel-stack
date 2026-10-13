//! FWDXP origin proofs, fresh authority checks and transactional outbox production.
//! The async native network sender is implemented in outbox.rs.
use crate::{Config, Failure};
use axum::http::StatusCode;
use base64::{Engine, engine::general_purpose::STANDARD};
use ring::{
    rand::SystemRandom,
    signature::{RSA_PKCS1_SHA256, RsaKeyPair},
};
use rsa::{
    RsaPrivateKey,
    pkcs8::{EncodePrivateKey, EncodePublicKey, LineEnding},
};
use serde_json::{Value, json};
use sqlx::{Postgres, Row, Transaction};
use std::sync::Arc;
use tokio::sync::Mutex;
use uuid::Uuid;

#[derive(Default)]
pub struct Signer(Mutex<Option<(String, Arc<RsaKeyPair>)>>);
impl Signer {
    pub async fn headers(
        &self,
        pool: &sqlx::PgPool,
        url: &reqwest::Url,
        actor: &str,
        body: &[u8],
    ) -> Result<axum::http::HeaderMap, Failure> {
        let private: String =
            sqlx::query_scalar("SELECT private_key FROM federation_keys WHERE id=1")
                .fetch_optional(pool)
                .await?
                .ok_or_else(signing_error)?;
        let pair = {
            let mut cached = self.0.lock().await;
            if cached.as_ref().is_none_or(|(pem, _)| pem != &private) {
                let der = pem::parse(&private).map_err(|_| signing_error())?;
                let pair = RsaKeyPair::from_pkcs8(der.contents()).map_err(|_| signing_error())?;
                *cached = Some((private, Arc::new(pair)));
            }
            Arc::clone(&cached.as_ref().ok_or_else(signing_error)?.1)
        };
        let host = &url[url::Position::BeforeHost..url::Position::AfterPort];
        let target = &url[url::Position::BeforePath..url::Position::AfterQuery];
        let date = httpdate::fmt_http_date(std::time::SystemTime::now());
        let digest = crate::net::digest(body);
        let canonical = format!(
            "(request-target): post {target}\nhost: {host}\ndate: {date}\ndigest: {digest}"
        );
        let signature = tokio::task::spawn_blocking(move || {
            let mut signature = vec![0; pair.public().modulus_len()];
            pair.sign(
                &RSA_PKCS1_SHA256,
                &SystemRandom::new(),
                canonical.as_bytes(),
                &mut signature,
            )
            .map_err(|_| signing_error())?;
            Ok::<_, Failure>(STANDARD.encode(signature))
        })
        .await
        .map_err(|_| signing_error())??;
        let mut headers = axum::http::HeaderMap::new();
        for (name, value) in [
            ("host", host.to_owned()),
            ("date", date),
            ("digest", digest),
            ("accept", "application/activity+json".into()),
            ("content-type", "application/activity+json".into()),
            (
                "signature",
                format!(
                    "keyId=\"{actor}#main-key\",algorithm=\"rsa-sha256\",headers=\"(request-target) host date digest\",signature=\"{signature}\""
                ),
            ),
        ] {
            headers.insert(name, value.parse().map_err(|_| signing_error())?);
        }
        Ok(headers)
    }
    pub async fn sign(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        mut note: Value,
        actor: &str,
    ) -> Result<Value, Failure> {
        let mut key: Option<String> =
            sqlx::query_scalar("SELECT private_key FROM federation_keys WHERE id=1 FOR SHARE")
                .fetch_optional(&mut **tx)
                .await?;
        if key.is_none() {
            // Rare first-use initialization is serialized across processes. No
            // per-message lock is held once the persistent key exists.
            sqlx::query("SELECT pg_advisory_xact_lock(781294639)")
                .execute(&mut **tx)
                .await?;
            key =
                sqlx::query_scalar("SELECT private_key FROM federation_keys WHERE id=1 FOR SHARE")
                    .fetch_optional(&mut **tx)
                    .await?;
            if key.is_none() {
                let (private, public) = tokio::task::spawn_blocking(|| {
                    let key = RsaPrivateKey::new(&mut rand::rngs::OsRng, 2048)
                        .map_err(|_| signing_error())?;
                    Ok::<_, Failure>((
                        key.to_pkcs8_pem(LineEnding::LF)
                            .map_err(|_| signing_error())?
                            .to_string(),
                        key.to_public_key()
                            .to_public_key_pem(LineEnding::LF)
                            .map_err(|_| signing_error())?,
                    ))
                })
                .await
                .map_err(|_| signing_error())??;
                sqlx::query("INSERT INTO federation_keys(id,private_key,public_key) VALUES(1,$1,$2) ON CONFLICT(id) DO NOTHING")
                    .bind(&private).bind(public).execute(&mut **tx).await?;
                key = sqlx::query_scalar(
                    "SELECT private_key FROM federation_keys WHERE id=1 FOR SHARE",
                )
                .fetch_optional(&mut **tx)
                .await?;
            }
        }
        let private = key.ok_or_else(signing_error)?;
        let pair = {
            let mut cached = self.0.lock().await;
            if cached.as_ref().is_none_or(|(pem, _)| pem != &private) {
                let der = pem::parse(&private).map_err(|_| signing_error())?;
                let pair = RsaKeyPair::from_pkcs8(der.contents()).map_err(|_| signing_error())?;
                *cached = Some((private, Arc::new(pair)));
            }
            Arc::clone(&cached.as_ref().ok_or_else(signing_error)?.1)
        };
        // preserve_order is mandatory: receivers verify JSON.stringify after
        // removing proof, so serialization must retain exactly the signed order.
        let document = serde_json::to_vec(&note).map_err(|_| signing_error())?;
        let signature = tokio::task::spawn_blocking(move || {
            let mut signature = vec![0; pair.public().modulus_len()];
            pair.sign(
                &RSA_PKCS1_SHA256,
                &SystemRandom::new(),
                &document,
                &mut signature,
            )
            .map_err(|_| signing_error())?;
            Ok::<_, Failure>(STANDARD.encode(signature))
        })
        .await
        .map_err(|_| signing_error())??;
        note["proof"] =
            json!({"actor":actor,"keyId":format!("{actor}#main-key"),"signature":signature});
        Ok(note)
    }
}
fn signing_error() -> Failure {
    Failure(StatusCode::SERVICE_UNAVAILABLE, "Origin signing failed.")
}

pub async fn require(
    tx: &mut Transaction<'_, Postgres>,
    user: &sqlx::postgres::PgRow,
    flags: &[&str],
) -> Result<(), Failure> {
    require_at(tx, user, flags, true).await
}
pub async fn require_at(
    tx: &mut Transaction<'_, Postgres>,
    user: &sqlx::postgres::PgRow,
    flags: &[&str],
    lock: bool,
) -> Result<(), Failure> {
    let enabled: Option<String> = sqlx::query_scalar(if lock {
        "SELECT value FROM instance_settings WHERE key='federation_enabled' FOR SHARE"
    } else {
        "SELECT value FROM instance_settings WHERE key='federation_enabled'"
    })
    .fetch_optional(&mut **tx)
    .await?;
    require_enabled(user, flags, enabled.as_deref() == Some("true"))
}
pub fn require_enabled(
    user: &sqlx::postgres::PgRow,
    flags: &[&str],
    enabled: bool,
) -> Result<(), Failure> {
    if !enabled {
        return Err(Failure(
            StatusCode::FORBIDDEN,
            "Federation is disabled by this instance administrator.",
        ));
    }
    for flag in flags {
        if user.get::<Option<String>, _>("remote_actor").is_some() || user.get::<i64, _>(*flag) == 0
        {
            let message = match *flag {
                "federation_send" => "Your administrator has disabled federated send permission.",
                "federation_receive" => {
                    "Your administrator has disabled federated receive permission."
                }
                "federation_subscribe" => {
                    "Your administrator has disabled federated subscribe permission."
                }
                _ => "Your administrator has disabled federated post permission.",
            };
            return Err(Failure(StatusCode::FORBIDDEN, message));
        }
    }
    Ok(())
}
pub async fn allowed(
    config: &Config,
    tx: &mut Transaction<'_, Postgres>,
    actor: &str,
) -> Result<(), Failure> {
    allowed_at(config, tx, actor, true).await
}
pub async fn allowed_at(
    config: &Config,
    tx: &mut Transaction<'_, Postgres>,
    actor: &str,
    lock: bool,
) -> Result<(), Failure> {
    let url = crate::net::peer_url(actor, config)?;
    let blocked = sqlx::query(if lock {
        "SELECT 1 FROM federation_blocks WHERE target=$1 OR target=$2 FOR SHARE"
    } else {
        "SELECT 1 FROM federation_blocks WHERE target=$1 OR target=$2"
    })
    .bind(actor)
    .bind(url.origin().ascii_serialization())
    .fetch_optional(&mut **tx)
    .await?;
    if blocked.is_some() {
        return Err(Failure(
            StatusCode::FORBIDDEN,
            "This remote instance or actor is blocked.",
        ));
    }
    Ok(())
}
pub async fn allowed_many(
    config: &Config,
    tx: &mut Transaction<'_, Postgres>,
    actors: &[&str],
) -> Result<(), Failure> {
    let mut targets = Vec::with_capacity(actors.len() * 2);
    for actor in actors {
        targets.push((*actor).to_owned());
        targets.push(
            crate::net::peer_url(actor, config)?
                .origin()
                .ascii_serialization(),
        );
    }
    targets.sort();
    targets.dedup();
    if sqlx::query("SELECT 1 FROM federation_blocks WHERE target=ANY($1) FOR SHARE")
        .bind(targets)
        .fetch_optional(&mut **tx)
        .await?
        .is_some()
    {
        return Err(Failure(
            StatusCode::FORBIDDEN,
            "This remote instance or actor is blocked.",
        ));
    }
    Ok(())
}

pub fn activity(config: &Config, kind: &str, actor: &str, object: Value) -> Value {
    json!({"@context":["https://www.w3.org/ns/activitystreams","https://w3id.org/security/v1",{
        "fwdxp":"https://fwdxp.invalid/ns#","fwdxpVersion":"fwdxp:version","archipelVersion":"fwdxp:version",
        "channel":"fwdxp:channel","mode":"fwdxp:mode","admission":"fwdxp:admission","visibility":"fwdxp:visibility",
        "showMembers":"fwdxp:showMembers","hideHandles":"fwdxp:hideHandles","optionalTitles":"fwdxp:optionalTitles",
        "topic":"fwdxp:topic","topics":"fwdxp:topics","proof":"fwdxp:proof","emoji":"fwdxp:emoji"}],
        "id":format!("{}/federation/activities/{}",config.base,Uuid::new_v4()),"type":kind,"actor":actor,"object":object})
}
pub async fn queue(
    config: &Config,
    tx: &mut Transaction<'_, Postgres>,
    mut activity: Value,
    recipients: &[String],
    purpose: &str,
    user: &str,
    channel: &str,
) -> Result<(), Failure> {
    activity["to"] = json!(recipients);
    let id = activity["id"].as_str().ok_or_else(signing_error)?;
    sqlx::query("INSERT INTO federation_outgoing(id,activity,signer,user_id,channel_id,purpose,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)")
        .bind(id).bind(activity.to_string()).bind(activity["actor"].as_str().ok_or_else(signing_error)?)
        .bind(user).bind(channel).bind(purpose).bind(chrono::Utc::now().timestamp_millis()).execute(&mut **tx).await?;
    // One bounded bulk query, retaining one retry/audit row per recipient.
    sqlx::query("INSERT INTO federation_deliveries(activity_id,recipient) SELECT $1,recipient FROM unnest($2::text[]) AS recipient ON CONFLICT(activity_id,recipient) DO NOTHING")
        .bind(id).bind(recipients).execute(&mut **tx).await?;
    let _ = config;
    Ok(())
}
