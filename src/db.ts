// Where the instance keeps what it knows: a SQLite file beside it, or a PostgreSQL server.
// Everything else writes SQLite's SQL and reads rows back the same way from either.
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import pg from "pg";
import {
  MessageChannel,
  Worker,
  receiveMessageOnPort,
  type MessagePort,
} from "node:worker_threads";

export type Row = Record<string, any>;
type Value = null | number | bigint | string | Uint8Array;
export interface Statement {
  get(...values: Value[]): Row | undefined;
  all(...values: Value[]): Row[];
  run(...values: Value[]): { changes: number };
  iterate(...values: Value[]): IterableIterator<Row>;
}
// A table that was written to, and for a watched table what its changed rows say of who is concerned.
export interface Change {
  table: string;
  rows: Row[];
}
// The columns of a changed row that tell whose screen the change is on.
export const watched: Record<string, string[]> = {
  messages: ["channel_id"],
  topics: ["channel_id"],
  channel_roster: ["channel_id"],
  message_reactions: ["message_id"],
  direct_messages: ["user_id"],
  read_marks: ["user_id"],
  conversation_prefs: ["user_id"],
  sidebar_layouts: ["user_id"],
  closed_conversations: ["user_id"],
  contact_names: ["user_id"],
  user_blocks: ["user_id"],
  personal_emojis: ["user_id"],
  push_subscriptions: ["user_id"],
  xmpp_credentials: ["user_id"],
  xmpp_remote_rooms: ["user_id"],
  xmpp_remote_messages: ["subscription_id"],
  federation_outgoing: ["user_id"],
  federation_deliveries: ["activity_id"],
  instance_settings: ["key"],
};
const writes =
  /^\s*(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM)\s+"?(\w+)"?/i;

const migrationsUrl = new URL("../migrations/", import.meta.url);
const migrations = () =>
  readdirSync(migrationsUrl)
    .map((file) => ({ file, version: Number(/^(\d+)_.*\.sql$/.exec(file)?.[1]) }))
    .filter((m) => m.version)
    .sort((a, b) => a.version - b.version);

export abstract class Database {
  abstract readonly dialect: "sqlite" | "postgres";
  /** Told what was written once it is committed: never of what was rolled back. */
  onChange?: (changes: Change[]) => void;
  /** Subscribe to committed writes made by native processes sharing this schema. */
  async listenExternalChanges() { return false; }
  private depth = 0;
  private pending: Change[] = [];
  private savepointNumber = 0;
  private atomicOperations = 0;
  protected get statementRecovery() { return this.atomicOperations === 0; }
  private cacheEpoch = 0;
  private revisions = new Map<string, number>();
  revision(key: string) { return `${this.cacheEpoch}:${this.revisions.get(key) || 0}`; }
  externalRevision() { return 0; }
  protected invalidateCaches() { this.cacheEpoch++; this.revisions.clear(); }
  protected abstract rows(sql: string, values: Value[]): Row[];
  protected abstract first(sql: string, values: Value[]): Row | undefined;
  protected abstract change(sql: string, values: Value[]): number;
  protected abstract begin(): void;
  protected abstract commit(): void;
  protected abstract rollback(): void;
  /** Runs statements that take no values, such as a migration file. */
  abstract exec(sql: string): void;
  abstract close(): void;
  /** The schema's version: the number of the last migration applied. */
  abstract version(): number;
  /** The highest number a table's counting column has given out, even to rows since removed. */
  abstract sequence(table: string): number;

  get inTransaction() {
    return this.depth > 0;
  }
  // Silent writes are reserved for bookkeeping that does not change a rendered view.
  prepare(sql: string, options: { notify?: boolean } = {}): Statement {
    const table = writes.exec(sql)?.[1].toLowerCase(),
      columns =
        table && !/\bRETURNING\b/i.test(sql) ? watched[table] : undefined;
    return {
      get: (...values) => this.first(sql, values),
      all: (...values) => this.rows(sql, values),
      iterate: (...values) => this.rows(sql, values)[Symbol.iterator](),
      run: (...values) => {
        if (!table || options.notify === false) return { changes: this.change(sql, values) };
        let rows: Row[] = [],
          changes: number;
        if (columns) {
          rows = this.rows(
            `${sql.replace(/;\s*$/, "")} RETURNING ${columns.map((c) => `${table}.${c}`).join(",")}`,
            values,
          );
          changes = rows.length;
        } else changes = this.change(sql, values);
        if (changes) {
          if (this.depth) this.pending.push({ table, rows });
          else this.tell([{ table, rows }]);
        }
        return { changes };
      },
    };
  }
  transaction<T>(fn: () => T): T {
    if (this.depth) return fn();
    this.begin();
    this.depth++;
    let value: T;
    try {
      value = fn();
      this.commit();
    } catch (error) {
      this.pending = [];
      this.depth--;
      try {
        this.rollback();
      } catch {
        /* The failure that undid the transaction is the one to report. */
      }
      throw error;
    }
    this.depth--;
    const changes = this.pending;
    this.pending = [];
    if (changes.length) this.tell(changes);
    return value;
  }
  /** Isolates one operation inside a shared transaction, including its notices.
   * Atomic operations rely on this boundary instead of per-statement PostgreSQL
   * recovery. SQL failures must escape; swallowing one still prevents release
   * and commit of the aborted transaction. Ordinary operations retain recovery.
   */
  savepoint<T>(fn: () => T, options: { atomic?: boolean } = {}): T {
    if (!this.depth) return this.transaction(fn);
    // Sequential operations reuse their depth's name and prepared statements.
    // Nested savepoints still receive distinct names until their scope exits.
    const name = `archipel_s${++this.savepointNumber}`, before = this.pending.length;
    try {
      this.exec(`SAVEPOINT ${name}`);
      if (options.atomic) this.atomicOperations++;
      let value: T;
      try { value = fn(); } finally { if (options.atomic) this.atomicOperations--; }
      this.exec(`RELEASE ${name}`); return value;
    } catch (error) {
      this.pending.length = before;
      try { this.exec(`ROLLBACK TO ${name}`); this.exec(`RELEASE ${name}`); } catch {}
      throw error;
    } finally { this.savepointNumber--; }
  }
  private tell(changes: Change[]) {
    const keys = new Set<string>();
    for (const change of changes) {
      keys.add(change.table);
      for (const row of change.rows) if (row.channel_id) keys.add(`${change.table}:${row.channel_id}`);
    }
    for (const key of keys) this.revisions.set(key, (this.revisions.get(key) || 0) + 1);
    try {
      this.onChange?.(changes);
    } catch {
      /* Telling browsers of a change never undoes or fails the change. */
    }
  }
  /** Committed work from an independent native worker refreshes local viewers. */
  notifyExternal(changes: Change[]) { this.tell(changes); }
  /** Brings the schema up to this application's version. */
  migrate() {
    if(this.dialect!=="postgres")return this.migrateLocked();
    const db=this as unknown as PostgresDatabase;
    db.native("SELECT pg_advisory_lock(hashtextextended(current_schema()||':archipel-schema',0))");
    try{this.migrateLocked();}finally{db.native("SELECT pg_advisory_unlock(hashtextextended(current_schema()||':archipel-schema',0))");}
  }
  private migrateLocked() {
    const all = migrations(),
      latest = all.at(-1)!.version,
      version = this.version();
    if (version > latest)
      throw new Error("Database is newer than this application");
    if (this.dialect === "postgres" && version === 0) {
      // A new PostgreSQL database starts as a copy of a new SQLite one, so both begin the same.
      const blank = new SqliteDatabase(":memory:");
      try {
        blank.migrate();
        copyToPostgres(blank, this as unknown as PostgresDatabase);
      } finally {
        blank.close();
      }
      return;
    }
    for (const { file, version: number } of all)
      if (number > version)
        this.transaction(() =>
          this.exec(readFileSync(new URL(file, migrationsUrl), "utf8")),
        );
  }
}

export class SqliteDatabase extends Database {
  readonly dialect = "sqlite";
  readonly raw: DatabaseSync;
  private statements = new Map<string, StatementSync>();
  constructor(path: string, readOnly = false) {
    super();
    if (path !== ":memory:" && !readOnly)
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.raw = new DatabaseSync(path, { readOnly });
    this.raw.exec(
      readOnly
        ? "PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;"
        : "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;",
    );
  }
  private statement(sql: string) {
    let statement = this.statements.get(sql);
    if (!statement) {
      // Statements built around lists of values come in endless shapes; the common ones return.
      if (this.statements.size >= 400) this.statements.clear();
      this.statements.set(sql, (statement = this.raw.prepare(sql)));
    }
    return statement;
  }
  protected rows(sql: string, values: Value[]) {
    return this.statement(sql).all(...values) as Row[];
  }
  protected first(sql: string, values: Value[]) {
    return this.statement(sql).get(...values) as Row | undefined;
  }
  protected change(sql: string, values: Value[]) {
    return Number(this.statement(sql).run(...values).changes);
  }
  protected begin() {
    this.raw.exec("BEGIN IMMEDIATE");
  }
  protected commit() {
    this.raw.exec("COMMIT");
  }
  protected rollback() {
    this.raw.exec("ROLLBACK");
  }
  exec(sql: string) {
    // A changed schema leaves no prepared statement to be trusted.
    if (!/^(?:SAVEPOINT|RELEASE|ROLLBACK TO) archipel_s\d+$/.test(sql)) { this.statements.clear(); this.invalidateCaches(); }
    this.raw.exec(sql);
  }
  close() {
    this.statements.clear();
    this.raw.close();
  }
  externalRevision() { return Number(this.statement("PRAGMA data_version").get()!.data_version); }
  version() {
    return Number(this.raw.prepare("PRAGMA user_version").get()!.user_version);
  }
  sequence(table: string) {
    return Number(
      this.raw.prepare("SELECT seq FROM sqlite_sequence WHERE name=?").get(table)
        ?.seq ?? 0,
    );
  }
}

// ---- SQLite's SQL, said the way PostgreSQL understands it ----
// Text between quotes is set aside first, so nothing below mistakes a message for a statement.
function mask(sql: string) {
  const literals: string[] = [];
  let out = "";
  for (let i = 0; i < sql.length; ) {
    const c = sql[i];
    if (c === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
    } else if (c === "'") {
      let end = i + 1;
      while (end < sql.length && (sql[end] !== "'" || sql[end + 1] === "'"))
        end += sql[end] === "'" ? 2 : 1;
      literals.push(sql.slice(i, end + 1));
      out += `\u0001${literals.length - 1}\u0001`;
      i = end + 1;
    } else if (c === '"') {
      const close = sql.indexOf('"', i + 1),
        end = close < 0 ? sql.length - 1 : close;
      out += sql.slice(i, end + 1);
      i = end + 1;
    } else {
      out += c;
      i++;
    }
  }
  return { text: out, literals };
}
// The arguments of the call whose opening bracket is at `open`, and where it closes.
function call(text: string, open: number) {
  const args: string[] = [];
  let depth = 0,
    from = open + 1;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")" && !--depth) {
      args.push(text.slice(from, i));
      return { args, end: i };
    } else if (text[i] === "," && depth === 1) {
      args.push(text.slice(from, i));
      from = i + 1;
    }
  }
  throw new Error("Unbalanced SQL.");
}
function statementToPostgres(text: string, literals: string[], counter: { n: number }) {
  if (/^\s*PRAGMA\b/i.test(text)) {
    const version = /^\s*PRAGMA\s+user_version\s*=\s*(\d+)/i.exec(text);
    return version ? `UPDATE archipel_schema SET version=${version[1]}` : "";
  }
  if (/^\s*INSERT\s+OR\s+REPLACE\b/i.test(text))
    throw new Error("INSERT OR REPLACE has no PostgreSQL equivalent; name the conflict.");
  text = text.replace(/\?/g, () => `$${++counter.n}`);
  // A bare value has no type of its own where nothing beside it gives it one.
  text = text.replace(/(\$\d+)(?=\s+(?:IS|LIKE|NOT\s+LIKE)\b)/gi, "$1::text");
  if (/^\s*INSERT\s+OR\s+IGNORE\b/i.test(text)) {
    text = text.replace(/^(\s*INSERT)\s+OR\s+IGNORE\b/i, "$1");
    const returning = text.search(/\sRETURNING\s/i);
    text =
      returning < 0
        ? `${text} ON CONFLICT DO NOTHING`
        : `${text.slice(0, returning)} ON CONFLICT DO NOTHING${text.slice(returning)}`;
  }
  text = text
    .replace(/\binstr\s*\(/gi, "strpos(")
    .replace(/\bIN\s*\(\s*\)/gi, "IN (SELECT NULL WHERE FALSE)")
    .replace(/\browid\b/gi, "ctid");
  // MAX and MIN of several values, where PostgreSQL keeps those names for whole columns.
  for (let at = 0; ; ) {
    const found = /\b(MAX|MIN)\s*\(/gi;
    found.lastIndex = at;
    const match = found.exec(text);
    if (!match) break;
    at = match.index + match[0].length;
    if (call(text, at - 1).args.length > 1)
      text = `${text.slice(0, match.index)}${match[1].toUpperCase() === "MAX" ? "GREATEST" : "LEAST"}(${text.slice(at)}`;
  }
  for (;;) {
    const match = /\bjson_extract\s*\(/i.exec(text);
    if (!match) break;
    const open = match.index + match[0].length - 1,
      { args, end } = call(text, open),
      path = /^\s*\u0001(\d+)\u0001\s*$/.exec(args[1] || ""),
      keys = path && /^'\$((?:\.\w+)+)'$/.exec(literals[Number(path[1])]);
    if (!keys) throw new Error("Unsupported json_extract path.");
    literals[Number(path![1])] = `'{${keys[1].slice(1).split(".").join(",")}}'`;
    text = `${text.slice(0, match.index)}((${args[0]})::jsonb #>> ${args[1].trim()})${text.slice(end + 1)}`;
  }
  if (/^\s*(CREATE|ALTER)\s+TABLE\b/i.test(text))
    text = text
      .replace(
        /\bINTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT\b/gi,
        "BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY",
      )
      .replace(/\bINTEGER\b/gi, "BIGINT")
      .replace(/\bBLOB\b/gi, "BYTEA")
      // Compared byte by byte, as SQLite does, whatever locale the server was set up with.
      .replace(/\bTEXT\b([^,()]*?)\s+COLLATE\s+NOCASE\b/gi, 'CITEXT COLLATE "C"$1')
      .replace(/\bTEXT\b/gi, 'TEXT COLLATE "C"')
      // Checked as each statement ends, but able to wait for a whole copy to arrive.
      .replace(
        /\bREFERENCES\s+"?\w+"?\s*\(\s*\w+\s*\)(?:\s+ON\s+DELETE\s+(?:CASCADE|RESTRICT|SET\s+NULL|NO\s+ACTION))?/gi,
        "$& DEFERRABLE",
      );
  return text;
}
const translated = new Map<string, string>();
export function toPostgres(sql: string) {
  let known = translated.get(sql);
  if (known !== undefined) return known;
  const { text, literals } = mask(sql),
    counter = { n: 0 };
  known = text
    .split(";")
    .map((statement) => statementToPostgres(statement, literals, counter))
    .filter((statement) => statement.trim())
    .join(";\n")
    .replace(/\u0001(\d+)\u0001/g, (_all, index) => literals[Number(index)]);
  if (translated.size >= 1000) translated.clear();
  translated.set(sql, known);
  return known;
}

export class PostgresDatabase extends Database {
  readonly dialect = "postgres";
  private worker: Worker;
  private port: MessagePort;
  private flag: Int32Array;
  private closed = false;
  private externalClient?: pg.Client;
  private externalReady?: Promise<boolean>;
  private externalRetry?: NodeJS.Timeout;
  private externalConnected = false;
  private externalChannel?: string;
  /** With a schema, the instance keeps to it instead of the database's default one. */
  constructor(
    private url: string,
    private schema: string | null = null,
    private temporary = false,
  ) {
    super();
    const { port1, port2 } = new MessageChannel(),
      shared = new SharedArrayBuffer(4),
      source = import.meta.url.endsWith(".ts");
    this.flag = new Int32Array(shared);
    this.port = port1;
    this.worker = new Worker(
      new URL(source ? "./pg-worker.ts" : "./pg-worker.js", import.meta.url),
      {
        workerData: { port: port2, shared, url, schema },
        transferList: [port2],
        execArgv: source ? ["--import", "tsx"] : [],
      },
    );
    this.worker.unref();
    try {
      this.ask({ op: "connect" });
      if (schema) {
        this.ask({op:"query",text:"SELECT pg_advisory_lock(hashtextextended($1,0))",values:[`${schema}:archipel-schema`],tx:false});
        try{this.ask({ op: "exec", text: `CREATE SCHEMA IF NOT EXISTS "${schema}"`, tx: false });}
        finally{this.ask({op:"query",text:"SELECT pg_advisory_unlock(hashtextextended($1,0))",values:[`${schema}:archipel-schema`],tx:false});}
      }
    } catch (error) {
      void this.worker.terminate();
      throw error;
    }
  }
  private ask(request: Record<string, unknown>) {
    if (this.closed) throw new Error("The database is closed.");
    Atomics.store(this.flag, 0, 0);
    this.port.postMessage(request);
    // The answer is waited for here: statements run one after another, as SQLite's do.
    if (Atomics.wait(this.flag, 0, 0, 120000) === "timed-out")
      throw new Error("The database did not answer.");
    const answer = receiveMessageOnPort(this.port)?.message as
      | { rows?: Row[]; count?: number; statistics?: { statements: number; queries: number; transferredRows: number }; error?: { message: string; code?: string; detail?: string } }
      | undefined;
    if (!answer) throw new Error("The database connection stopped.");
    if (answer.error)
      throw Object.assign(new Error(answer.error.message), {
        code: answer.error.code,
        detail: answer.error.detail,
      });
    return answer;
  }
  private query(sql: string, values: Value[], result: "rows" | "first" | "count" = "rows") {
    let text = toPostgres(sql);
    // Bound read-only SELECTs on the database server, not after materializing
    // and transferring their entire result. CTEs and writes retain their SQL.
    if (result === "first" && /^\s*SELECT\b/i.test(text) && !/;|--|\/\*/.test(text))
      text = `SELECT * FROM (${text}) AS archipel_first LIMIT 1`;
    return this.ask({
      op: "query",
      text, result, recover: this.statementRecovery,
      // PostgreSQL keeps no NUL characters in text.
      values: values.map((v) =>
        typeof v === "string" && v.includes("\0") ? v.replaceAll("\0", "") : v,
      ),
      tx: this.inTransaction,
    });
  }
  protected rows(sql: string, values: Value[]) {
    return this.query(sql, values).rows!;
  }
  protected first(sql: string, values: Value[]) {
    return this.query(sql, values, "first").rows![0];
  }
  protected change(sql: string, values: Value[]) {
    return this.query(sql, values, "count").count!;
  }
  protected begin() {
    this.ask({ op: "begin" });
  }
  protected commit() {
    this.ask({ op: "commit" });
  }
  protected rollback() {
    this.ask({ op: "rollback" });
  }
  exec(sql: string) {
    if (!/^(?:SAVEPOINT|RELEASE|ROLLBACK TO) archipel_s\d+$/.test(sql)) this.invalidateCaches();
    const text = toPostgres(sql);
    if (text.trim()) this.ask({ op: "exec", text, tx: this.inTransaction });
  }
  /** Runs PostgreSQL's own SQL, untranslated. */
  native(text: string, values: Value[] = []) {
    this.invalidateCaches();
    return this.ask({ op: "query", text, values, recover: this.statementRecovery, tx: this.inTransaction }).rows!;
  }
  statistics() { return this.ask({ op: "statistics" }).statistics!; }
  override async listenExternalChanges(): Promise<boolean> {
    if (this.closed) return Promise.reject(new Error("The database is closed."));
    if (this.externalReady) return this.externalReady;
    if(!this.externalChannel) {
      const schema = String(this.native("SELECT current_schema() AS name")[0].name);
      this.externalChannel = `archipel_native_${createHash("sha256").update(schema).digest("hex").slice(0,32)}`;
    }
    const channel=this.externalChannel;
    const ready = (async()=> {
      const listener = new pg.Client({connectionString:this.url,application_name:"archipel-notices"});
      this.externalClient=listener;
      let lost=false;
      const disconnected=()=>{
        if (lost || this.closed || this.externalClient!==listener) return;
        lost=true;this.externalClient=undefined;this.externalReady=undefined;
        void listener.end().catch(()=>{});
        this.externalRetry=setTimeout(()=>{
          this.externalRetry=undefined;
          void this.listenExternalChanges().catch(()=>{});
        },1000);this.externalRetry.unref();
      };
      listener.on("error",disconnected);listener.on("end",disconnected);
      listener.on("notification",notice=>{
        if (notice.channel!==channel || !notice.payload || this.closed) return;
        try {
          const changes=JSON.parse(notice.payload) as Change[];
          if (!Array.isArray(changes) || changes.some(c=>!c || !["messages","topics","read_marks","federation_outgoing","federation_follows","remote_avatars","users","sessions","audit"].includes(c.table) || !Array.isArray(c.rows))) return;
          this.notifyExternal(changes);
        } catch { /* Invalid notifications never grant access or reveal content. */ }
      });
      try { await listener.connect();await listener.query(`LISTEN "${channel}"`); }
      catch(error) { disconnected();throw error; }
      if (this.closed) { await listener.end().catch(()=>{});return false; }
      // A reconnect may have missed notices. Existing SSE logic turns this
      // unknown table into a reconciliation notice; API access is rechecked.
      if (this.externalConnected) this.notifyExternal([{table:"external_reconnect",rows:[]}]);
      this.externalConnected=true;
      return true;
    })();
    this.externalReady=ready;
    return ready;
  }
  close() {
    if (this.closed) return;
    try {
      if (this.schema && this.temporary)
        this.ask({ op: "exec", text: `DROP SCHEMA "${this.schema}" CASCADE`, tx: false });
      this.ask({ op: "close" });
    } catch {
      /* A connection already gone is closed. */
    }
    this.closed = true;
    if (this.externalRetry) clearTimeout(this.externalRetry);
    void this.externalClient?.end().catch(()=>{});
    this.externalClient=undefined;
    void this.worker.terminate();
  }
  version() {
    return this.native("SELECT to_regclass('archipel_schema') AS found")[0].found
      ? Number(this.native("SELECT version FROM archipel_schema")[0]?.version ?? 0)
      : 0;
  }
  /** The sequence behind a table's counting column. */
  counter(table: string) {
    return this.native(
      "SELECT pg_get_serial_sequence(quote_ident(table_name),column_name) AS name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=$1 AND is_identity='YES'",
      [table],
    )[0]?.name as string | undefined;
  }
  sequence(table: string) {
    const counter = this.counter(table);
    if (!counter) return 0;
    const { last_value, is_called } = this.native(
      `SELECT last_value,is_called FROM ${counter}`,
    )[0];
    return is_called ? Number(last_value) : 0;
  }
}

/**
 * Fills an empty PostgreSQL database with everything in a SQLite one: its tables, what is in
 * them, and where their counters had got to. All of it arrives, or none of it does.
 */
export function copyToPostgres(
  from: SqliteDatabase,
  to: PostgresDatabase,
  progress?: (table: string, rows: number) => void,
) {
  if (to.version())
    throw new Error("The PostgreSQL database already holds an Archipel Server instance.");
  const schema = from.raw
      .prepare(
        "SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid",
      )
      .all() as { type: string; name: string; sql: string }[],
    tables = schema.filter((s) => s.type === "table"),
    // A table is made after the ones it refers to.
    ordered: typeof tables = [],
    place = (table: (typeof tables)[number], path: string[]) => {
      if (ordered.includes(table)) return;
      if (path.includes(table.name))
        throw new Error(`Tables refer to each other in a circle: ${path.join(", ")}`);
      for (const [, name] of mask(table.sql).text.matchAll(/\bREFERENCES\s+"?(\w+)"?/gi)) {
        const other = tables.find((t) => t.name === name);
        if (other && other !== table) place(other, [...path, table.name]);
      }
      ordered.push(table);
    };
  for (const table of tables) place(table, []);
  // Names used insensitively to case need the type that compares them so.
  try {
    to.native("CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA public");
  } catch (error) {
    if (!to.native("SELECT 1 FROM pg_extension WHERE extname='citext'").length)
      throw new Error(
        `The citext extension could not be enabled: ${(error as Error).message}`,
      );
  }
  to.transaction(() => {
    to.native("CREATE TABLE archipel_schema (version BIGINT NOT NULL)");
    for (const table of ordered) to.exec(table.sql);
    to.native("SET CONSTRAINTS ALL DEFERRED");
    for (const table of ordered) {
      const columns = (
          from.raw.prepare(`PRAGMA table_info("${table.name}")`).all() as { name: string }[]
        ).map((c) => c.name),
        insert = `INSERT INTO "${table.name}"(${columns.map((c) => `"${c}"`).join(",")}) VALUES`;
      let batch: Value[] = [],
        rows = 0,
        bytes = 0,
        count = 0;
      const flush = () => {
        if (!rows) return;
        let n = 0;
        to.native(
          `${insert}${Array.from({ length: rows }, () => `(${columns.map(() => `$${++n}`).join(",")})`).join(",")}`,
          batch,
        );
        batch = [];
        rows = bytes = 0;
      };
      for (const row of from.raw.prepare(`SELECT * FROM "${table.name}"`).iterate()) {
        for (const column of columns) {
          let value = row[column] as Value;
          if (typeof value === "string") {
            if (value.includes("\0")) value = value.replaceAll("\0", "");
            bytes += value.length;
          } else if (value instanceof Uint8Array) bytes += value.length;
          batch.push(value);
        }
        rows++;
        count++;
        if (rows >= 500 || batch.length > 20000 || bytes > 8_000_000) flush();
      }
      flush();
      progress?.(table.name, count);
    }
    // Every reference is checked now that all the rows are in.
    to.native("SET CONSTRAINTS ALL IMMEDIATE");
    for (const index of schema.filter((s) => s.type === "index")) to.exec(index.sql);
    for (const { name, seq } of from.raw
      .prepare("SELECT name,seq FROM sqlite_sequence")
      .all() as { name: string; seq: number }[])
      if (tables.some((t) => t.name === name))
        to.native("SELECT setval($1::regclass,$2,$3)", [
          to.counter(name)!,
          Math.max(1, Number(seq)),
          Number(seq) > 0 ? "true" : "false",
        ]);
    to.native("INSERT INTO archipel_schema VALUES($1)", [from.version()]);
  });
}

const postgresUrl = /^postgres(?:ql)?:\/\//;
/** Opens the database a path or a postgres:// address names. */
export function openDatabase(target: string): Database {
  if (postgresUrl.test(target)) return new PostgresDatabase(target);
  // The test suite can be pointed at a PostgreSQL server: every database it opens is then a
  // schema of its own there, and one opened in memory is dropped when it is closed.
  const tests = process.env.ARCHIPEL_TEST_POSTGRES;
  if (tests)
    return target === ":memory:"
      ? new PostgresDatabase(tests, `t_${randomBytes(12).toString("hex")}`, true)
      : new PostgresDatabase(
          tests,
          `f_${createHash("sha256").update(target).digest("hex").slice(0, 24)}`,
        );
  return new SqliteDatabase(target);
}
