//! Local FWDXP actor exports. Policy and metadata are read together on every request.
use crate::{Failure, outbox::State};
use axum::http::StatusCode;
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::Row;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    kind: String,
    id: String,
}
impl State {
    pub async fn public_actor(&self, request: Request) -> Result<Value, Failure> {
        if !matches!(request.kind.as_str(), "users" | "channels") {
            return Err(Failure(StatusCode::NOT_FOUND, "Actor not found."));
        }
        let mut tx = self
            .chat
            .database
            .begin_with("BEGIN ISOLATION LEVEL REPEATABLE READ")
            .await?;
        let enabled: Option<String> = sqlx::query_scalar(
            "SELECT value FROM instance_settings WHERE key='federation_enabled'",
        )
        .fetch_optional(&mut *tx)
        .await?;
        if enabled.as_deref() != Some("true") {
            return Err(Failure(
                StatusCode::FORBIDDEN,
                "Federation is disabled by this instance administrator.",
            ));
        }
        let id = format!(
            "{}/actors/{}/{}",
            self.config().base,
            request.kind,
            request.id
        );
        let mut actor = if request.kind == "users" {
            let user=sqlx::query("SELECT u.*,a.mime AS avatar_mime,a.revision AS avatar_revision,EXISTS(SELECT 1 FROM federation_outgoing o WHERE o.user_id=u.id) AS previously_federated FROM users u LEFT JOIN user_avatars a ON a.user_id=u.id WHERE u.id=$1")
                .bind(&request.id).fetch_optional(&mut *tx).await?
                .ok_or(Failure(StatusCode::NOT_FOUND,"User not found."))?;
            let flags = [
                "federation_send",
                "federation_receive",
                "federation_subscribe",
                "federation_post",
            ]
            .iter()
            .any(|flag| user.get::<i64, _>(*flag) != 0);
            if user.get::<Option<String>, _>("remote_actor").is_some()
                || user.get::<&str, _>("admission_status") != "approved"
                || !flags && !user.get::<bool, _>("previously_federated")
            {
                return Err(Failure(StatusCode::NOT_FOUND, "Actor is not federated."));
            }
            let icon = match (
                user.get::<Option<String>, _>("avatar_mime"),
                user.get::<Option<String>, _>("avatar_revision"),
            ) {
                (Some(mime), Some(revision)) if flags && user.get::<i64, _>("banned") == 0 => {
                    json!({"type":"Image","mediaType":mime,"url":format!("{}/federation/avatars/{}?v={revision}",self.config().base,request.id)})
                }
                _ => Value::Null,
            };
            json!({"id":id,"type":"Person","preferredUsername":user.get::<&str,_>("username"),"name":user.get::<&str,_>("display_name"),"icon":icon})
        } else {
            let channel = sqlx::query("SELECT * FROM channels WHERE id=$1")
                .bind(&request.id)
                .fetch_optional(&mut *tx)
                .await?
                .ok_or(Failure(StatusCode::NOT_FOUND, "Channel not found."))?;
            if channel.get::<i64, _>("federation_enabled") == 0
                || channel.get::<Option<String>, _>("remote_actor").is_some()
            {
                return Err(Failure(StatusCode::NOT_FOUND, "Channel is not federated."));
            }
            let bans: Value = serde_json::from_str(channel.get::<&str, _>("reaction_bans"))
                .map_err(|_| {
                    Failure(StatusCode::SERVICE_UNAVAILABLE, "Invalid channel metadata.")
                })?;
            json!({"id":id,"type":"Group","preferredUsername":channel.get::<&str,_>("name"),"name":channel.get::<&str,_>("name"),
                "summary":channel.get::<&str,_>("description"),"mode":channel.get::<&str,_>("mode"),"visibility":channel.get::<&str,_>("visibility"),
                "admission":channel.get::<&str,_>("admission"),"showMembers":channel.get::<i64,_>("show_members")!=0,
                "hideHandles":channel.get::<i64,_>("hide_handles")!=0,"reactions":channel.get::<i64,_>("reactions")!=0,
                "reactionBans":bans,"optionalTitles":channel.get::<i64,_>("optional_titles")!=0})
        };
        let mut public: Option<String> =
            sqlx::query_scalar("SELECT public_key FROM federation_keys WHERE id=1")
                .fetch_optional(&mut *tx)
                .await?;
        if public.is_none() {
            // Bootstrap keys using the same serialized, transactional initializer as posts.
            self.signer.sign(&mut tx, json!({}), &id).await?;
            public = sqlx::query_scalar("SELECT public_key FROM federation_keys WHERE id=1")
                .fetch_optional(&mut *tx)
                .await?;
        }
        actor["@context"] = json!(["https://www.w3.org/ns/activitystreams","https://w3id.org/security/v1",{
            "fwdxp":"https://fwdxp.invalid/ns#","fwdxpVersion":"fwdxp:version","archipelVersion":"fwdxp:version",
            "channel":"fwdxp:channel","mode":"fwdxp:mode","admission":"fwdxp:admission","visibility":"fwdxp:visibility",
            "showMembers":"fwdxp:showMembers","hideHandles":"fwdxp:hideHandles","optionalTitles":"fwdxp:optionalTitles",
            "topic":"fwdxp:topic","topics":"fwdxp:topics","proof":"fwdxp:proof","emoji":"fwdxp:emoji"}]);
        actor["fwdxpVersion"] = json!(1);
        actor["archipelVersion"] = json!(1);
        if self.config().channel_transport {
            actor["channelEvents"] = if request.kind == "channels" {
                json!({"version":1,"batches":format!("{id}/events"),"stream":format!("{id}/stream"),"instanceStream":format!("{}/federation/stream",self.config().base),"instanceBatches":format!("{}/federation/events",self.config().base)})
            } else { json!({"version":1}) };
        }
        actor["inbox"] = json!(format!("{}/federation/inbox", self.config().base));
        actor["outbox"] = json!(format!("{id}/outbox"));
        actor["publicKey"] = json!({"id":format!("{id}#main-key"),"owner":id,"publicKeyPem":public.ok_or(Failure(StatusCode::SERVICE_UNAVAILABLE,"Actor signing key unavailable."))?});
        tx.commit().await?;
        Ok(actor)
    }
}
