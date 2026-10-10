// Copies an instance from its SQLite file into an empty PostgreSQL database.
//   npm run migrate:postgres            reads DATABASE_PATH, writes to DATABASE_URL
//   npm run migrate:postgres -- --from ./data/archipel.sqlite --to postgres://user:pass@host/db
// Stop the instance first. The SQLite file is left as it was, apart from being brought up to
// this version's schema; nothing reaches PostgreSQL unless all of it does.
import { existsSync } from "node:fs";
import { PostgresDatabase, SqliteDatabase, copyToPostgres } from "../src/db.js";

const args = process.argv.slice(2),
  option = (name: string) => {
    const at = args.indexOf(name);
    return at < 0 ? undefined : args[at + 1];
  },
  from = option("--from") || process.env.DATABASE_PATH || "./data/archipel.sqlite",
  to = option("--to") || process.env.DATABASE_URL || "";
const fail = (message: string) => {
  console.error(message);
  process.exit(1);
};
if (!/^postgres(ql)?:\/\/./.test(to))
  fail("Name the PostgreSQL database with DATABASE_URL or --to postgres://user:password@host/database.");
if (!existsSync(from)) fail(`There is no SQLite database at ${from}. Set DATABASE_PATH or pass --from.`);

const source = new SqliteDatabase(from);
let target: PostgresDatabase | undefined;
try {
  source.migrate();
  target = new PostgresDatabase(to);
  if (target.version())
    fail("The PostgreSQL database already holds an Archipel Server instance. Migrate into an empty database.");
  const copied = new Map<string, number>();
  copyToPostgres(source, target, (table, rows) => {
    copied.set(table, rows);
    if (rows) console.log(`${table}: ${rows}`);
  });
  // What arrived is counted again on the other side before anyone is told it worked.
  for (const [table, rows] of copied) {
    const found = Number(target.native(`SELECT COUNT(*) AS n FROM "${table}"`)[0].n);
    if (found !== rows) fail(`${table} holds ${found} rows in PostgreSQL but ${rows} in SQLite.`);
  }
  console.log(
    `Copied ${[...copied.values()].reduce((a, b) => a + b, 0)} rows in ${copied.size} tables. ` +
      "Start the instance with DATABASE_URL set to use them; the SQLite file is no longer read and can be kept as a backup.",
  );
} catch (error) {
  fail(`Migration failed, and PostgreSQL was left as it was: ${(error as Error).message}`);
} finally {
  source.close();
  target?.close();
}
