import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { Push } from "../src/push.js";
import type { Config } from "../src/config.js";

function fixture() {
  const store = new Store(":memory:", "https://example.test");
  store.initializeRegistration("open");
  const alice = store.loginIdentity("test", "alice", "Alice", [], true),
    bob = store.loginIdentity("test", "bob", "Bob", []),
    carol = store.loginIdentity("test", "carol", "Carol", []);
  const channel = store.createChannel(alice, { name: "pushed", mode: "timeline", visibility: "members", admission: "open" });
  store.join(bob, channel.id); store.join(carol, channel.id);
  const subscribe = (id: string) => {
    const token = store.createSession(id).token, row = store.db.prepare("SELECT token_hash FROM sessions ORDER BY rowid DESC LIMIT 1").get()!;
    store.db.prepare("INSERT INTO push_subscriptions VALUES(?,?,?,?,?,?)").run(`https://push.example/${id}`, id, row.token_hash, "k", "a", new Date().toISOString());
    return token;
  };
  const push = new Push(store, { baseUrl: "https://example.test" } as Config), sent: string[] = [];
  (push as any).send = async (to: { endpoint: string }) => { sent.push(to.endpoint); return true; };
  return { store, alice, bob, carol, channel, subscribe, push, sent };
}

test("members with Archipel Web open are not pushed what they can already see", async t => {
  const f = fixture(); t.after(() => { f.push.stop(); f.store.close(); });
  f.subscribe(f.bob.id); f.subscribe(f.carol.id);
  await f.push.tick();
  f.push.live = (user) => user === f.bob.id;
  f.store.post(f.alice, f.channel.id, { body: "Seen live by Bob" });
  await f.push.tick();
  assert.deepEqual(f.sent, [`https://push.example/${f.carol.id}`]);
});

test("the worker stops while nobody is subscribed and skips what was said meanwhile", async t => {
  const f = fixture(); t.after(() => { f.push.stop(); f.store.close(); });
  f.push.start();
  assert.ok((f.push as any).timer, "started");
  await f.push.tick();
  assert.equal((f.push as any).timer, undefined, "no subscriptions: the worker stops");
  f.store.post(f.alice, f.channel.id, { body: "Nobody listening" });
  const keys = { p256dh: Buffer.alloc(65, 4).toString("base64url"), auth: Buffer.alloc(16, 1).toString("base64url") };
  f.push.subscribe(f.bob, f.store.createSession(f.bob.id).token, { endpoint: "https://push.example/bob", keys });
  assert.ok((f.push as any).timer, "a subscription wakes it");
  await f.push.tick();
  assert.deepEqual(f.sent, [], "messages from while it slept are not news");
  f.store.post(f.alice, f.channel.id, { body: "Now listening" });
  await f.push.tick();
  assert.deepEqual(f.sent, ["https://push.example/bob"]);
});
