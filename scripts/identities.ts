import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync(
  process.env.DATABASE_PATH || "./data/archipel.sqlite",
  { readOnly: true },
);
console.table(
  db
    .prepare(
      "SELECT u.username,b.issuer,b.subject FROM oidc_bindings b JOIN users u ON u.id=b.user_id ORDER BY u.username",
    )
    .all(),
);
db.close();
