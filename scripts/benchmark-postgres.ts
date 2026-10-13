// Targeted PostgreSQL path measurements, not an end-to-end user-capacity test.
import { performance } from "node:perf_hooks";
import { randomBytes, createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { PostgresDatabase } from "../src/db.js";
import { Store } from "../src/store.js";
import { WriteBatch } from "../src/write-batch.js";

const url = process.env.ARCHIPEL_TEST_POSTGRES;
if (!url) throw new Error("Set ARCHIPEL_TEST_POSTGRES to an isolated test database.");
const current = { PostgresDatabase, Store, WriteBatch };
const baseline = process.env.ARCHIPEL_POSTGRES_BASELINE;
const results: unknown[] = [];
for (const [label, modules] of [
  ...(baseline ? [["before", {
    ...await import(pathToFileURL(resolve(baseline, "src/db.js")).href),
    ...await import(pathToFileURL(resolve(baseline, "src/store.js")).href),
    ...await import(pathToFileURL(resolve(baseline, "src/write-batch.js")).href),
  }] as const] : []), ["after", current] as const,
]) {
  const db = new modules.PostgresDatabase(url, `bench_${randomBytes(10).toString("hex")}`, true);
  const store = new modules.Store(db, "https://benchmark.example");
  try {
    store.initializeRegistration("open");
    const alice = store.loginIdentity("bench", "alice", "Alice", [], true);
    const channel = store.createChannel(alice, { name: "general", mode: "timeline", visibility: "members", admission: "open" });
    store.transaction(() => {
      for (let i = 0; i < 100; i++) {
        const user = store.loginIdentity("bench", `user-${i}`, `User ${i}`, []);
        store.join(user, channel.id); store.post(user, channel.id, { body: `Message from author ${i}` });
      }
    });
    store.messages(alice, channel.id);
    const prepare = db.prepare.bind(db); let queries = 0;
    db.prepare = (sql: string, options = {}) => {
      const statement = prepare(sql, options);
      return { ...statement,
        get: (...args: Parameters<typeof statement.get>) => { queries++; return statement.get(...args); },
        all: (...args: Parameters<typeof statement.all>) => { queries++; return statement.all(...args); },
        run: (...args: Parameters<typeof statement.run>) => { queries++; return statement.run(...args); },
      };
    };
    let at = performance.now();
    for (let n = 0; n < 30; n++) store.messages(alice, channel.id);
    const pages = { iterations: 30, authors: 100, elapsedMs: performance.now() - at, logicalQueries: queries };
    queries = 0; const writes = new modules.WriteBatch(store);
    at = performance.now();
    await Promise.all(Array.from({ length: 30 }, (_, i) => writes.run(() => store.post(alice, channel.id, { body: `Batch ${i}` }))));
    const posts = { count: 30, elapsedMs: performance.now() - at, logicalQueries: queries };
    results.push({ label, pages, posts });
  } finally { store.close(); }
}
const sourceRoot = process.cwd();
const sources = Object.fromEntries(["src/db.ts", "src/pg-worker.ts", "src/store.ts", "src/write-batch.ts"].map(file =>
  [file, createHash("sha256").update(readFileSync(resolve(sourceRoot, file))).digest("hex")]));
const report = { time: new Date().toISOString(), node: process.version, results, sources,
  limitations: ["Same workstation and isolated PostgreSQL test server; sequential before/after microbenchmarks.",
    "Logical queries count adapter calls, excluding worker-internal savepoint statements; wall time includes database/network/IPC.",
    "Page reads have 100 distinct authors and are outside a transaction. Posts use one durable batch; no federation hooks or HTTP/SSE.",
    "These measurements do not establish 3000-user FWDXP capacity."] };
const output = process.env.ARCHIPEL_POSTGRES_REPORT;
if (output) writeFileSync(output, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
