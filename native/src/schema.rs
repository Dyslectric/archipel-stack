//! Native schema initialization and recent upgrades, serialized with Node startup.
use crate::Config;
use serde::Deserialize;
use sqlx::{PgPool, Row};
#[derive(Deserialize)]
struct Upgrade {
    version: i64,
    sql: String,
}
pub async fn initialize(pool: &PgPool, config: &Config) -> Result<(), Box<dyn std::error::Error>> {
    let mut tx = pool.begin().await?;
    let name = match &config.schema {
        Some(schema) => schema.clone(),
        None => {
            sqlx::query_scalar::<_, String>("SELECT current_schema()")
                .fetch_one(&mut *tx)
                .await?
        }
    };
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))")
        .bind(format!("{name}:archipel-schema"))
        .execute(&mut *tx)
        .await?;
    if let Some(schema) = &config.schema {
        sqlx::raw_sql(&format!("CREATE SCHEMA IF NOT EXISTS \"{schema}\""))
            .execute(&mut *tx)
            .await?;
    }
    let exists: bool = sqlx::query_scalar("SELECT to_regclass('archipel_schema') IS NOT NULL")
        .fetch_one(&mut *tx)
        .await?;
    if !exists {
        let occupied:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_schema=current_schema() AND table_type='BASE TABLE')").fetch_one(&mut *tx).await?;
        if occupied {
            return Err(
                "The selected schema contains tables without an Archipel schema version".into(),
            );
        }
        sqlx::raw_sql(include_str!("../data/schema.sql"))
            .execute(&mut *tx)
            .await?;
    } else {
        let row = sqlx::query("SELECT version FROM archipel_schema")
            .fetch_one(&mut *tx)
            .await?;
        let version: i64 = row.get("version");
        if !(26..=31).contains(&version) {
            return Err("Native startup supports schema 26–31; older databases need their compatibility migrations first".into());
        }
        let upgrades: Vec<Upgrade> =
            serde_json::from_str(include_str!("../data/schema-upgrades.json"))?;
        for upgrade in upgrades.into_iter().filter(|u| u.version > version) {
            sqlx::raw_sql(&upgrade.sql).execute(&mut *tx).await?;
        }
    }
    sqlx::raw_sql(include_str!("../data/instance-feed.pg")).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}
