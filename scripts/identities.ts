import { PostgresDatabase, SqliteDatabase } from "../src/db.js";

const db = process.env.DATABASE_URL
  ? new PostgresDatabase(process.env.DATABASE_URL)
  : new SqliteDatabase(process.env.DATABASE_PATH || "./data/archipel.sqlite", true);
console.table(
  db
    .prepare(
      "SELECT u.username,b.issuer,b.subject FROM oidc_bindings b JOIN users u ON u.id=b.user_id ORDER BY u.username",
    )
    .all(),
);
db.close();
