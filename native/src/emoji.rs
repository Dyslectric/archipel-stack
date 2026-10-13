use crate::Failure;
use axum::http::StatusCode;
use serde_json::{Value, json};
use sqlx::{Postgres, Row, Transaction};
use std::{
    collections::{HashMap, HashSet},
    sync::OnceLock,
};
static STANDARD: OnceLock<HashMap<String, String>> = OnceLock::new();
static ALIASES: OnceLock<HashMap<String, Vec<String>>> = OnceLock::new();
fn aliases() -> &'static HashMap<String, Vec<String>> {
    ALIASES.get_or_init(|| {
        serde_json::from_str(include_str!("../data/emoji-aliases.json"))
            .expect("generated gemoji aliases")
    })
}
fn bare(value: &str) -> String {
    value
        .chars()
        .filter(|c| *c != '\u{fe0f}' && !(0x1f3fb..=0x1f3ff).contains(&(*c as u32)))
        .collect()
}
pub fn shortcodes(text: &str) -> Vec<(usize, usize, String)> {
    let bytes = text.as_bytes();
    let mut found = Vec::new();
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] == b':' {
            let start = at;
            let mut end = at + 1;
            while end < bytes.len()
                && end - start <= 64
                && (bytes[end].is_ascii_lowercase()
                    || bytes[end].is_ascii_digit()
                    || matches!(bytes[end], b'_' | b'+' | b'-'))
            {
                end += 1;
            }
            if end > start + 1 && end < bytes.len() && bytes[end] == b':' {
                found.push((start, end + 1, text[start + 1..end].to_owned()));
                at = end + 1;
                continue;
            }
        }
        at += 1;
    }
    found
}
fn typed(text: &str) -> Vec<(usize, usize)> {
    let chars: Vec<_> = text.char_indices().collect();
    let mut result = Vec::new();
    let mut at = 0;
    let flag = |c: char| (0x1f1e6..=0x1f1ff).contains(&(c as u32));
    let component = |c: char| {
        (0x2600..=0x27bf).contains(&(c as u32)) || (0x1f000..=0x1faff).contains(&(c as u32))
    };
    let head = |c: char| {
        component(c)
            || (0x231a..=0x23ff).contains(&(c as u32))
            || (0x2b00..=0x2bff).contains(&(c as u32))
    };
    let modifier = |c: char| c == '\u{fe0f}' || (0x1f3fb..=0x1f3ff).contains(&(c as u32));
    while at < chars.len() {
        let start = at;
        if flag(chars[at].1) && chars.get(at + 1).is_some_and(|(_, c)| flag(*c)) {
            at += 2;
        } else if head(chars[at].1) {
            at += 1;
            if chars.get(at).is_some_and(|(_, c)| modifier(*c)) {
                at += 1;
            }
            while chars.get(at).is_some_and(|(_, c)| *c == '\u{200d}')
                && chars.get(at + 1).is_some_and(|(_, c)| component(*c))
            {
                at += 2;
                if chars.get(at).is_some_and(|(_, c)| modifier(*c)) {
                    at += 1;
                }
            }
        } else {
            at += 1;
            continue;
        }
        result.push((
            chars[start].0,
            chars.get(at).map_or(text.len(), |(index, _)| *index),
        ));
    }
    result
}
pub async fn bans(
    tx: &mut Transaction<'_, Postgres>,
    channel: &str,
) -> Result<HashSet<String>, Failure> {
    let global: Option<String> =
        sqlx::query_scalar("SELECT value FROM instance_settings WHERE key='emoji_bans'")
            .fetch_optional(&mut **tx)
            .await?;
    bans_from(channel, global.as_deref())
}
pub fn bans_from(channel: &str, global: Option<&str>) -> Result<HashSet<String>, Failure> {
    let mut names: Vec<String> = serde_json::from_str(channel)
        .map_err(|_| Failure(StatusCode::SERVICE_UNAVAILABLE, "Invalid emoji bans."))?;
    if let Some(global) = global {
        names.extend(
            serde_json::from_str::<Vec<String>>(global)
                .map_err(|_| Failure(StatusCode::SERVICE_UNAVAILABLE, "Invalid emoji bans."))?,
        );
    }
    let mut result = HashSet::new();
    for name in names {
        if standard(&name)
            && let Some(glyph) = STANDARD.get().and_then(|m| m.get(&name))
            && let Some(other) = aliases().get(&bare(glyph))
        {
            result.extend(other.iter().cloned());
        }
        result.insert(name);
    }
    Ok(result)
}
fn banned_spans(text: &str, names: &HashSet<String>) -> Vec<(usize, usize, String)> {
    if names.is_empty() {
        return vec![];
    }
    let mut result: Vec<_> = shortcodes(text)
        .into_iter()
        .filter(|(_, _, n)| names.contains(n))
        .collect();
    for (start, end) in typed(text) {
        if let Some(name) = aliases()
            .get(&bare(&text[start..end]))
            .and_then(|n| n.first())
            .filter(|n| names.contains(*n))
        {
            result.push((start, end, name.clone()));
        }
    }
    result
}
pub fn refuse(text: &str, names: &HashSet<String>) -> Result<(), Failure> {
    if !banned_spans(text, names).is_empty() {
        return Err(Failure(StatusCode::FORBIDDEN, "This emoji is banned."));
    }
    Ok(())
}
pub fn without(text: &str, names: &HashSet<String>) -> String {
    let mut spans = banned_spans(text, names);
    spans.sort_by_key(|s| s.0);
    let mut result = String::new();
    let mut at = 0;
    for (start, end, _) in spans {
        if start >= at {
            result.push_str(&text[at..start]);
            at = end;
        }
    }
    result.push_str(&text[at..]);
    result
}
pub fn project(message: &mut Value, names: &HashSet<String>) {
    let body = message["body"].as_str().unwrap_or("");
    let title = message["title"].as_str();
    let next_body = without(body, names);
    let next_title = title.map(|t| without(t, names));
    if next_body != body || next_title.as_deref() != title {
        let body = crate::inbox::js_trim(&next_body);
        message["body"] = json!(if body.is_empty() {
            "This message was only emoji that are banned here."
        } else {
            body
        });
        message["title"] = next_title
            .map(|t| crate::inbox::js_trim(&t).to_owned())
            .filter(|t| !t.is_empty())
            .map_or(Value::Null, |t| json!(t));
    }
}
pub async fn tags(
    tx: &mut Transaction<'_, Postgres>,
    who: &str,
    text: &str,
) -> Result<Vec<Value>, Failure> {
    let mut names = Vec::new();
    for (_, _, name) in shortcodes(text) {
        if !names.contains(&name) {
            names.push(name);
        }
    }
    if names.is_empty() {
        return Ok(vec![]);
    }
    let rows=sqlx::query("SELECT name,id,NULL::text AS source_url FROM custom_emojis WHERE name=ANY($1) UNION ALL SELECT name,id,source_url FROM personal_emojis WHERE user_id=$2 AND deleted=0 AND name=ANY($1)").bind(&names).bind(who).fetch_all(&mut **tx).await?;
    let mut catalog = HashMap::new();
    for row in rows {
        let name: String = row.get("name");
        let id: String = row.get("id");
        let mut entry = json!({"name":name,"id":id,"url":format!("/api/emojis/{id}/image")});
        if let Some(source) = row.get::<Option<String>, _>("source_url") {
            entry["source_url"] = json!(source);
        }
        catalog.insert(name, entry);
    }
    Ok(names
        .into_iter()
        .filter_map(|n| catalog.remove(&n))
        .collect())
}
pub async fn wire(
    tx: &mut Transaction<'_, Postgres>,
    base: &str,
    tags: &[Value],
) -> Result<Vec<Value>, Failure> {
    let ids: Vec<_> = tags
        .iter()
        .take(8)
        .filter_map(|t| t["id"].as_str())
        .collect();
    if ids.is_empty() {
        return Ok(vec![]);
    }
    let rows=sqlx::query("SELECT p.id,u.username FROM personal_emojis p JOIN users u ON u.id=p.user_id WHERE p.id=ANY($1)").bind(ids).fetch_all(&mut **tx).await?;
    let owners: HashMap<String, String> = rows
        .into_iter()
        .map(|r| (r.get("id"), r.get("username")))
        .collect();
    Ok(tags.iter().take(8).map(|t|{let id=t["id"].as_str().unwrap_or("");let mut result=json!({"name":t["name"],"id":id,"url":format!("{base}/federation/emojis/{id}/image")});if let Some(owner)=owners.get(id){result["personal"]=json!(true);result["owner"]=json!(owner);}result}).collect())
}
pub fn standard(name: &str) -> bool {
    STANDARD
        .get_or_init(|| {
            serde_json::from_str(include_str!("../data/standard-emojis.json"))
                .expect("generated gemoji catalog")
        })
        .contains_key(name)
}
pub async fn live(
    tx: &mut Transaction<'_, Postgres>,
    base: &str,
    messages: &mut [Value],
) -> Result<(), Failure> {
    let mut tags = Vec::new();
    let mut ids = Vec::new();
    for message in messages.iter() {
        let value: Vec<Value> =
            serde_json::from_str(message["emoji_tags"].as_str().unwrap_or("[]")).map_err(|_| {
                Failure(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "Invalid stored emoji tags.",
                )
            })?;
        for tag in &value {
            if let Some(id) = tag["id"].as_str() {
                ids.push(id.to_owned());
            }
        }
        tags.push(value);
    }
    if ids.is_empty() {
        return Ok(());
    }
    let rows=sqlx::query("SELECT id,'instance' AS kind,'' AS source,'' AS owner FROM custom_emojis WHERE id=ANY($1) UNION ALL SELECT p.id,'personal',p.source_url,u.username FROM personal_emojis p JOIN users u ON u.id=p.user_id WHERE p.id=ANY($1) UNION ALL SELECT id,'remote',source_url,'' FROM remote_emoji_cache WHERE id=ANY($1)")
        .bind(ids).fetch_all(&mut **tx).await?;
    let mut found = HashMap::new();
    for row in rows {
        found.entry(row.get::<String, _>("id")).or_insert((
            row.get::<String, _>("kind"),
            row.get::<String, _>("source"),
            row.get::<String, _>("owner"),
        ));
    }
    let here = host(base).unwrap_or_default();
    for (message, tags) in messages.iter_mut().zip(tags) {
        let mut live = Vec::new();
        for mut tag in tags {
            let Some((kind, source, owner)) = tag["id"].as_str().and_then(|id| found.get(id))
            else {
                continue;
            };
            let origin = if kind == "remote" && !source.is_empty() {
                host(source).unwrap_or_else(|| here.clone())
            } else {
                here.clone()
            };
            tag["kind"] = json!(kind);
            tag["origin"] = json!(origin);
            if !owner.is_empty() {
                tag["owner"] = json!(owner);
            }
            live.push(tag);
        }
        message["emojis"] = json!(live);
    }
    Ok(())
}
fn host(value: &str) -> Option<String> {
    reqwest::Url::parse(value)
        .ok()
        .map(|url| url[url::Position::BeforeHost..url::Position::AfterPort].to_owned())
}
pub async fn reactions(
    tx: &mut Transaction<'_, Postgres>,
    ids: &[String],
    user: &str,
) -> Result<HashMap<String, Vec<Value>>, Failure> {
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    let rows=sqlx::query("SELECT r.message_id,r.emoji,r.user_id,COALESCE(CASE WHEN EXISTS(SELECT 1 FROM custom_emojis e WHERE e.id=k.emoji_id) OR EXISTS(SELECT 1 FROM remote_emoji_cache e WHERE e.id=k.emoji_id) THEN k.emoji_id ELSE NULL END,e.id) AS picture FROM message_reactions r LEFT JOIN reaction_emojis k ON k.message_id=r.message_id AND k.emoji=r.emoji LEFT JOIN custom_emojis e ON e.name=r.emoji WHERE r.message_id=ANY($1) ORDER BY r.created_at,r.ctid")
        .bind(ids).fetch_all(&mut **tx).await?;
    let mut messages = HashMap::<String, Vec<Value>>::new();
    for row in rows {
        let emoji: String = row.get("emoji");
        let list = messages.entry(row.get("message_id")).or_default();
        let index = match list.iter().position(|r| r["emoji"] == emoji) {
            Some(index) => index,
            None => {
                let mut entry = json!({"emoji":emoji,"count":0,"mine":false});
                if !standard(&emoji)
                    && let Some(picture) = row.get::<Option<String>, _>("picture")
                {
                    entry["url"] = json!(format!("/api/emojis/{picture}/image"));
                }
                list.push(entry);
                list.len() - 1
            }
        };
        list[index]["count"] = json!(list[index]["count"].as_u64().unwrap_or(0) + 1);
        if row.get::<&str, _>("user_id") == user {
            list[index]["mine"] = json!(true);
        }
    }
    Ok(messages)
}
