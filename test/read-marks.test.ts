import { test } from "node:test";
import assert from "node:assert/strict";
import { Store, Problem } from "../src/store.js";
import { SqliteDatabase } from "../src/db.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReadMarks } from "../src/read-marks.js";
import { WriteBatch } from "../src/write-batch.js";

function fixture() {
  const store = new Store(":memory:", "https://example.test");
  store.initializeRegistration("open");
  const alice = store.loginIdentity("test", "alice", "alice", [], true);
  const bob = store.loginIdentity("test", "bob", "bob", []);
  const channel = store.createChannel(alice, { name: "read-batch", mode: "timeline", visibility: "members", admission: "open" });
  store.join(bob, channel.id);
  const message = store.post(alice, channel.id, { body: "Commit before acknowledgement" });
  return { store, alice, bob, channel, message, reads: new ReadMarks(store) };
}

test("read requests in one burst commit together before any acknowledgement and reject only invalid policy/input", async t => {
  const f = fixture(); t.after(() => f.store.close());
  const notifications: unknown[] = [];
  f.store.db.onChange = changes => notifications.push(changes);
  const a = f.reads.mark(f.alice, { target: f.channel.id, seq: f.message.seq });
  const b = f.reads.mark(f.bob, { target: f.channel.id, seq: f.message.seq });
  const invalid = f.reads.mark(f.bob, { target: f.channel.id, seq: -1 });
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS count FROM read_marks WHERE seq=?").get(f.message.seq)!.count, 0);
  const result = await Promise.allSettled([a, b, invalid]);
  assert.deepEqual(result.map(r => r.status), ["fulfilled", "fulfilled", "rejected"]);
  assert.equal(notifications.length, 1);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS count FROM read_marks WHERE seq=?").get(f.message.seq)!.count, 2);
  assert.ok(result[2].status === "rejected" && result[2].reason instanceof Problem);
});

test("read batching rechecks suspension and membership at apply time", async t => {
  const f = fixture(); t.after(() => f.store.close());
  const pending = f.reads.mark(f.bob, { target: f.channel.id, seq: f.message.seq });
  f.store.ban(f.alice, f.bob.id, true);
  await assert.rejects(pending, (error: unknown) => error instanceof Problem && error.status === 403);
  assert.notEqual(f.store.db.prepare("SELECT seq FROM read_marks WHERE user_id=? AND target=?").get(f.bob.id, f.channel.id)?.seq, f.message.seq);
});

test("storage failure rolls back the whole read batch and acknowledges no successful update", async t => {
  const f = fixture(); t.after(() => f.store.close());
  const original = f.store.db.prepare.bind(f.store.db);
  t.mock.method(f.store.db, "prepare", (sql: string, options = {}) => {
    const statement = original(sql, options);
    if (!sql.startsWith("INSERT INTO read_marks")) return statement;
    return { ...statement, run: (...args: Parameters<typeof statement.run>) => {
      if (args[0] === f.bob.id) throw new Error("Storage failure");
      return statement.run(...args);
    } };
  });
  const result = await Promise.allSettled([
    f.reads.mark(f.alice, { target: f.channel.id, seq: f.message.seq }),
    f.reads.mark(f.bob, { target: f.channel.id, seq: f.message.seq }),
  ]);
  assert.ok(result.every(r => r.status === "rejected"));
  assert.equal(original("SELECT COUNT(*) AS count FROM read_marks WHERE seq=?").get(f.message.seq)!.count, 0);
});

test("a refused operation rolls back its writes and notices while another operation commits in the same batch", async t => {
  const f = fixture(); t.after(() => f.store.close());
  const refusedChannel = f.store.createChannel(f.alice, { name: "refused-only", mode: "timeline", visibility: "members", admission: "open" });
  const writes = new WriteBatch(f.store), notifications: any[] = [];
  f.store.db.onChange = changes => notifications.push(changes);
  const refused = writes.run(() => {
    f.store.post(f.alice, refusedChannel.id, { body: "Rolled back policy failure" });
    throw new Problem(403, "Refused after a tentative write");
  });
  const valid = writes.run(() => f.store.post(f.bob, f.channel.id, { body: "Durably committed valid request" }));
  const result = await Promise.allSettled([refused, valid]);
  assert.deepEqual(result.map(r => r.status), ["rejected", "fulfilled"]);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS count FROM messages WHERE body='Rolled back policy failure'").get()!.count, 0);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS count FROM messages WHERE body='Durably committed valid request'").get()!.count, 1);
  assert.equal(notifications.length, 1);
  const messages = notifications[0].filter((change: any) => change.table === "messages");
  assert.ok(messages.length > 0);
  assert.ok(messages.every((change: any) => change.rows.every((row: any) => row.channel_id === f.channel.id)));
});

test("shared message records invalidate on edits and keep reader-specific blocks, reactions and access live", t => {
  const f = fixture(); t.after(() => f.store.close());
  const before = f.store.messages(f.bob, f.channel.id);
  before[0].body = "Client-side mutation must not affect a cached record";
  assert.equal(f.store.messages(f.alice, f.channel.id)[0].body, "Commit before acknowledgement");
  f.store.editMessage(f.alice, f.message.id, { body: "Immediately visible edit", expected_edited_at: null });
  assert.equal(f.store.messages(f.bob, f.channel.id)[0].body, "Immediately visible edit");
  const peer = `${f.store.baseUrl}/actors/users/${f.alice.id}`;
  f.store.setUserBlock(f.bob, peer, true);
  assert.match(f.store.messages(f.bob, f.channel.id)[0].body, /hidden because you blocked/);
  assert.equal(f.store.messages(f.alice, f.channel.id)[0].body, "Immediately visible edit");
  f.store.setUserBlock(f.bob, peer, false);
  f.store.react(f.bob, f.message.id, { emoji: "thumbsup", on: true });
  assert.equal((f.store.messages(f.bob, f.channel.id)[0] as any).reactions[0].mine, true);
  assert.equal((f.store.messages(f.alice, f.channel.id)[0] as any).reactions[0].mine, false);
  f.store.leave(f.bob, f.channel.id);
  assert.throws(() => f.store.messages(f.bob, f.channel.id), Problem);
});

test("message cache observes committed changes from a separate SQLite connection", t => {
  const directory = mkdtempSync(join(tmpdir(), "archipel-cache-")), path = join(directory, "db.sqlite");
  const store = new Store(new SqliteDatabase(path), "https://example.test");
  const second = new SqliteDatabase(path);
  t.after(() => { second.close(); store.close(); rmSync(directory, { recursive: true }); });
  store.initializeRegistration("open");
  const alice = store.loginIdentity("test", "alice", "alice", [], true);
  const channel = store.createChannel(alice, { name: "external", mode: "timeline", visibility: "members", admission: "open" });
  const message = store.post(alice, channel.id, { body: "Before external change" });
  assert.equal(store.messages(alice, channel.id)[0].body, "Before external change");
  second.prepare("UPDATE messages SET body='External committed change' WHERE id=?").run(message.id);
  assert.equal(store.messages(alice, channel.id)[0].body, "External committed change");
});
