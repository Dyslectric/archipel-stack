use crate::{Config, Failure};
use serde_json::Value;
use sqlx::{Postgres, Row, Transaction, postgres::PgRow, types::Json};

/// Account-scoped overview. DM/XMPP projections retain their compatibility path.
pub async fn read(
    config: &Config,
    user: &PgRow,
    tx: &mut Transaction<'_, Postgres>,
) -> Result<(Value, bool), Failure> {
    let who: String = user.get("id");
    if sqlx::query("SELECT 1 FROM direct_messages WHERE user_id=$1 UNION ALL SELECT 1 FROM xmpp_remote_rooms WHERE user_id=$1 AND bridged=0 LIMIT 1")
        .bind(&who)
        .fetch_optional(&mut **tx)
        .await?
        .is_some()
    {
        return Err(Failure::unsupported());
    }
    let channel_rows=sqlx::query("SELECT c.id,mark.target IS NULL AS mark_missing FROM channels c JOIN memberships m ON m.channel_id=c.id LEFT JOIN read_marks mark ON mark.user_id=m.user_id AND mark.target=c.id WHERE m.user_id=$1 AND (c.remote_actor IS NULL OR ($2!=0 AND $3!=0)) AND ($4!=0 OR NOT EXISTS(SELECT 1 FROM channel_rules r WHERE r.channel_id=c.id AND r.user_id=$1 AND r.rule='block'))")
        .bind(&who).bind(user.get::<i64,_>("federation_receive")).bind(user.get::<i64,_>("federation_subscribe")).bind(user.get::<i64,_>("admin")).fetch_all(&mut **tx).await?;
    let channels: Vec<String> = channel_rows.iter().map(|r| r.get("id")).collect();
    let missing: Vec<String> = channel_rows
        .iter()
        .filter(|r| r.get::<bool, _>("mark_missing"))
        .map(|r| r.get("id"))
        .collect();
    let Json(result):Json<Value>=sqlx::query_scalar(r#"
        WITH RECURSIVE hid(channel_id,id) AS (
          SELECT channel_id,substr(target,8) FROM conversation_prefs
            WHERE user_id=$1 AND hidden=1 AND target>='thread:' AND target<'thread;'
          UNION SELECT h.channel_id,r.id FROM messages r JOIN hid h ON r.parent_id=h.id
        ), latest AS (SELECT COALESCE(MAX(seq),0) AS seq FROM messages), readable AS (
          SELECT c.id,COALESCE(mark.seq,(SELECT seq FROM latest)) AS after
            FROM unnest($2::text[]) AS c(id) LEFT JOIN read_marks mark ON mark.user_id=$1 AND mark.target=c.id
        ), unread AS (
          SELECT c.id AS channel_id,n.n FROM readable c CROSS JOIN LATERAL (
          SELECT COUNT(*) AS n FROM messages m
          WHERE m.channel_id=c.id AND m.seq>c.after
            AND m.author_id!=$1 AND m.deleted_at IS NULL AND m.history_placeholder=0
            AND ($3!=0 OR (m.remote_object IS NULL AND NOT EXISTS(
              SELECT 1 FROM users foreigner WHERE foreigner.id=m.author_id AND foreigner.remote_actor LIKE 'xmpp:%')))
            AND NOT EXISTS(SELECT 1 FROM user_blocks b JOIN users author ON author.id=m.author_id
              WHERE b.user_id=$1 AND b.peer=COALESCE(author.remote_actor,$4||'/actors/users/'||author.id))
            AND NOT EXISTS(SELECT 1 FROM hid h WHERE h.channel_id=m.channel_id AND h.id=m.id)
            AND (m.topic_id IS NULL OR NOT EXISTS(SELECT 1 FROM conversation_prefs p
              WHERE p.user_id=$1 AND p.target='topic:'||m.topic_id AND p.hidden=1))
          ) n WHERE n.n>0
        ) SELECT jsonb_build_object(
          'dms','[]'::jsonb,'message_cursor',(SELECT seq FROM latest),'unread',COALESCE((SELECT jsonb_object_agg(channel_id,n) FROM unread),'{}'::jsonb),
          'prefs',COALESCE((SELECT jsonb_object_agg(target,jsonb_build_object('hidden',hidden!=0,'notify',
            CASE WHEN notify IS NULL THEN 'null'::jsonb WHEN notify=2 THEN to_jsonb('mentions'::text) ELSE to_jsonb(notify!=0) END))
            FROM conversation_prefs WHERE user_id=$1),'{}'::jsonb),
          'layout',(SELECT layout::jsonb FROM sidebar_layouts WHERE user_id=$1),
          'user_blocks',COALESCE((SELECT jsonb_agg(peer ORDER BY peer) FROM user_blocks WHERE user_id=$1),'[]'::jsonb))
    "#).bind(&who).bind(&channels).bind(user.get::<i64,_>("federation_receive")).bind(&config.base).fetch_one(&mut **tx).await?;
    if result.to_string().len() > 4 * 1024 * 1024 {
        return Err(Failure::unsupported());
    }
    // First observation starts from the current end, exactly as channelMark.
    // Existing marks stay untouched; the private notice is emitted after commit.
    let changed = if missing.is_empty() {
        false
    } else {
        sqlx::query("INSERT INTO read_marks(user_id,target,seq) SELECT $1,target,(SELECT COALESCE(MAX(seq),0) FROM messages) FROM unnest($2::text[]) AS target ON CONFLICT(user_id,target) DO NOTHING")
        .bind(who).bind(missing).execute(&mut **tx).await?.rows_affected()!=0
    };
    Ok((result, changed))
}
