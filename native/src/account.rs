use crate::{Failure, outbox::State};
use axum::http::StatusCode;
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{Postgres, Row, Transaction, postgres::PgRow};
use subtle::ConstantTimeEq;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    op: String,
    token: String,
    csrf: String,
    input: Option<Value>,
}
impl State {
    pub async fn account(&self, request: Request) -> Result<Value, Failure> {
        if !matches!(request.op.as_str(), "session" | "profile" | "logout") {
            return Err(Failure::unsupported());
        }
        let mut tx = self.chat.database.begin().await?;
        let hash = format!("{:x}", Sha256::digest(request.token.as_bytes()));
        let user=sqlx::query(match request.op.as_str() {
            "session"=>"SELECT u.*,s.csrf FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>$2",
            "profile"=>"SELECT u.*,s.csrf FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>$2 FOR UPDATE OF u FOR SHARE OF s",
            _=>"SELECT u.*,s.csrf FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>$2 FOR SHARE OF u FOR UPDATE OF s",
        })
            .bind(&hash).bind(chrono::Utc::now().timestamp_millis()).fetch_optional(&mut *tx).await?;
        if user
            .as_ref()
            .is_some_and(|u| u.get::<i64, _>("banned") != 0)
        {
            return Err(Failure(
                StatusCode::FORBIDDEN,
                "This account has been suspended.",
            ));
        }
        if request.op == "session" {
            let (profile, csrf) = if let Some(user) = user {
                (
                    profile(self.config(), &mut tx, &user).await?,
                    json!(user.get::<&str, _>("csrf")),
                )
            } else {
                (Value::Null, Value::Null)
            };
            let registration: Option<String> = sqlx::query_scalar(
                "SELECT value FROM instance_settings WHERE key='registration_mode'",
            )
            .fetch_optional(&mut *tx)
            .await?;
            let enabled: Option<String> = sqlx::query_scalar(
                "SELECT value FROM instance_settings WHERE key='federation_enabled'",
            )
            .fetch_optional(&mut *tx)
            .await?;
            tx.commit().await?;
            return Ok(
                json!({"user":profile,"csrf":csrf,"registration_mode":registration.unwrap_or_else(||"open".into()),"federation_enabled":enabled.as_deref()==Some("true")}),
            );
        }
        let user = user.ok_or(Failure(StatusCode::UNAUTHORIZED, "Sign in to continue."))?;
        if !bool::from(
            user.get::<&str, _>("csrf")
                .as_bytes()
                .ct_eq(request.csrf.as_bytes()),
        ) {
            return Err(Failure(StatusCode::FORBIDDEN, "Invalid CSRF token."));
        }
        if request.op == "logout" {
            sqlx::query("DELETE FROM sessions WHERE token_hash=$1")
                .bind(hash)
                .execute(&mut *tx)
                .await?;
            crate::changes::append(&mut tx, json!([{"table":"sessions","rows":[]}])).await?;
            tx.commit().await?;
            return Ok(json!({"ok":true}));
        }
        if user.get::<&str, _>("admission_status") != "approved" {
            return Err(Failure(
                StatusCode::FORBIDDEN,
                "Instance membership approval is required.",
            ));
        }
        let input = request.input.unwrap_or(Value::Null);
        let name = input["display_name"]
            .as_str()
            .map(crate::inbox::js_trim)
            .filter(|s| !s.is_empty() && s.encode_utf16().count() <= 80)
            .ok_or(Failure(
                StatusCode::BAD_REQUEST,
                "Display name must be 1–80 characters.",
            ))?;
        let share = input["share_socials"].as_bool().ok_or(Failure(
            StatusCode::BAD_REQUEST,
            "Invalid social sharing preference.",
        ))?;
        let user = sqlx::query(
            "UPDATE users SET display_name=$2,share_socials=$3 WHERE id=$1 RETURNING *",
        )
        .bind(user.get::<&str, _>("id"))
        .bind(name)
        .bind(i64::from(share))
        .fetch_one(&mut *tx)
        .await?;
        let result = profile(self.config(), &mut tx, &user).await?;
        crate::changes::append(
            &mut tx,
            json!([{"table":"users","rows":[{"id":user.get::<&str,_>("id")}]}]),
        )
        .await?;
        tx.commit().await?;
        Ok(result)
    }
}
async fn profile(
    config: &crate::Config,
    tx: &mut Transaction<'_, Postgres>,
    user: &PgRow,
) -> Result<Value, Failure> {
    let who = user.get::<&str, _>("id");
    let actor = user.get::<Option<String>, _>("remote_actor");
    let local_avatar: Option<String> =
        sqlx::query_scalar("SELECT revision FROM user_avatars WHERE user_id=$1")
            .bind(who)
            .fetch_optional(&mut **tx)
            .await?;
    let remote_avatar = if let Some(actor) = &actor {
        sqlx::query("SELECT id,revision FROM remote_avatars WHERE peer=$1")
            .bind(actor)
            .fetch_optional(&mut **tx)
            .await?
    } else {
        None
    };
    let avatar = if actor.is_some() {
        remote_avatar.map(|a| {
            format!(
                "/api/remote-avatars/{}?v={}",
                a.get::<&str, _>("id"),
                a.get::<&str, _>("revision")
            )
        })
    } else {
        local_avatar.map(|r| format!("/api/avatars/{who}?v={r}"))
    };
    let role=sqlx::query("SELECT r.* FROM roles r LEFT JOIN user_roles u ON u.user_id=$1 AND u.role_id=r.id WHERE u.user_id IS NOT NULL OR r.is_default=1 ORDER BY CASE WHEN u.user_id IS NOT NULL THEN 0 ELSE 1 END LIMIT 1")
        .bind(who).fetch_one(&mut **tx).await?;
    let socials: Value = serde_json::from_str(user.get::<&str, _>("verified_socials"))
        .map_err(|_| Failure(StatusCode::SERVICE_UNAVAILABLE, "Invalid account profile."))?;
    let mut result = json!({"id":who,"actor_url":actor.unwrap_or_else(||format!("{}/actors/users/{who}",config.base)),"avatar_url":avatar,
        "username":user.get::<&str,_>("username"),"display_name":user.get::<&str,_>("display_name"),"admission_status":user.get::<&str,_>("admission_status"),
        "verified_socials":socials,"instance_role":{"id":role.get::<&str,_>("id"),"name":role.get::<&str,_>("name")}});
    for field in [
        "admin",
        "banned",
        "share_socials",
        "federation_send",
        "federation_receive",
        "federation_subscribe",
        "federation_post",
    ] {
        result[field] = json!(user.get::<i64, _>(field) != 0);
    }
    for field in [
        "create_channels",
        "federate_channels",
        "direct_messages",
        "attachments",
        "xmpp_rooms",
        "list_members",
    ] {
        result[field] = json!(role.get::<i64, _>(field) != 0);
    }
    Ok(result)
}
