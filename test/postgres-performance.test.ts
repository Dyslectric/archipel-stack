import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { PostgresDatabase } from "../src/db.js";
import { Store } from "../src/store.js";
import { WriteBatch } from "../src/write-batch.js";

const postgres = process.env.ARCHIPEL_TEST_POSTGRES;
const options = { skip: postgres ? false : "needs ARCHIPEL_TEST_POSTGRES" };
function fixture() {
  const db = new PostgresDatabase(postgres!, `p_${randomBytes(10).toString("hex")}`, true);
  const store = new Store(db); store.initializeRegistration("open");
  const alice = store.loginIdentity("test", "alice", "Alice", [], true);
  const channel = store.createChannel(alice, { name: "general", mode: "timeline", visibility: "members", admission: "open" });
  return { db, store, alice, channel };
}

test("PostgreSQL batches avoid per-statement savepoints without weakening ordinary recovery", options, t => {
  const f = fixture(); t.after(() => f.store.close());
  const before = f.db.statistics();
  f.db.transaction(() => f.db.savepoint(() => {
    f.db.prepare("SELECT id FROM users WHERE id=?").get(f.alice.id);
    f.db.prepare("INSERT INTO instance_settings VALUES(?,?)").run("batch-proof", "yes");
  }, { atomic: true }));
  assert.equal(f.db.statistics().statements - before.statements, 6); // begin, operation savepoint, two queries, release, commit
  f.db.transaction(() => {
    assert.throws(() => f.db.prepare("INSERT INTO instance_settings VALUES('batch-proof','duplicate')").run(), /duplicate/);
    f.db.prepare("INSERT INTO instance_settings VALUES('after-error','yes')").run();
  });
  assert.equal(f.db.prepare("SELECT value FROM instance_settings WHERE key='after-error'").get()!.value, "yes");
});

test("PostgreSQL storage failure in a write batch rolls back every operation and permits the next batch", options, async t => {
  const f = fixture(); t.after(() => f.store.close()); const writes = new WriteBatch(f.store);
  const results = await Promise.allSettled([
    writes.run(() => f.store.post(f.alice, f.channel.id, { body: "Must be rolled back" })),
    writes.run(() => f.db.prepare("INSERT INTO users(id,username,display_name,created_at) VALUES(?,?,?,'now')").run(f.alice.id, "duplicate", "Duplicate")),
  ]);
  assert.ok(results.every(r => r.status === "rejected"));
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM messages").get()!.n, 0);
  await assert.rejects(writes.run(() => {
    try { f.db.prepare("INSERT INTO users(id,username,display_name,created_at) VALUES(?,?,?,'now')").run(f.alice.id, "duplicate", "Duplicate"); } catch {}
    // Catching a SQL failure must not acknowledge an aborted transaction.
  }), /transaction is aborted/);
  await writes.run(() => f.store.post(f.alice, f.channel.id, { body: "Next durable batch" }));
  assert.equal(f.store.messages(f.alice, f.channel.id)[0].body, "Next durable batch");
});

test("PostgreSQL first/count calls transfer bounded results while preserving counts", options, t => {
  const f = fixture(); t.after(() => f.store.close()); const before = f.db.statistics();
  assert.equal(f.db.prepare("SELECT n FROM generate_series(1,10000) AS g(n)").get()!.n, 1);
  assert.equal(f.db.prepare("INSERT INTO instance_settings SELECT 'entry-'||n,'yes' FROM generate_series(1,100) AS g(n) RETURNING key").run().changes, 100);
  assert.equal(f.db.statistics().transferredRows - before.transferredRows, 1);
  assert.equal(f.db.prepare("SELECT 'a; b' AS value; -- a valid trailing comment").get()!.value, "a; b");
});

test("PostgreSQL page metadata costs stay bounded as the number of authors grows", options, t => {
  const f = fixture(); t.after(() => f.store.close());
  f.store.post(f.alice, f.channel.id, { body: "First author" });
  let before = f.db.statistics(); f.store.messages(f.alice, f.channel.id);
  const small = f.db.statistics().queries - before.queries;
  f.store.transaction(() => {
    for (let i = 0; i < 30; i++) {
      const user = f.store.loginIdentity("test", `user-${i}`, `User ${i}`, []);
      f.store.join(user, f.channel.id); f.store.post(user, f.channel.id, { body: `Author ${i}` });
    }
  });
  before = f.db.statistics(); const page = f.store.messages(f.alice, f.channel.id);
  assert.equal(page.length, 31);
  assert.equal(f.db.statistics().queries - before.queries, small);
});
