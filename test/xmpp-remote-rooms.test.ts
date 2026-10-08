import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store, Problem } from "../src/store.js";
import { Xmpp } from "../src/xmpp.js";
import { loadConfig } from "../src/config.js";

const config = loadConfig({ DEV_AUTH: "true", XMPP_DOMAIN: "chat.example", XMPP_BRIDGE_SECRET: "s".repeat(43) });
const address = "lounge@muc.remote.example";
function fixture() {
  const store = new Store(":memory:"), xmpp = new Xmpp(store, config);
  const alice = store.loginIdentity("urn:archipel:development", "alice", "alice", [], true);
  const bob = store.loginIdentity("urn:archipel:development", "bob", "bob", []);
  store.db.prepare("INSERT OR REPLACE INTO instance_settings VALUES('federation_enabled','true')").run();
  store.db.prepare("UPDATE users SET federation_receive=1,federation_subscribe=1,federation_send=1,federation_post=1").run();
  const rooms = xmpp.remoteRooms;
  const subscription = rooms.join(alice, { room: address, nick: "Alice" });
  const session = rooms.sync({}).desired[0].session;
  const receive = (input: Record<string, unknown>) => rooms.receive({ session, from: `${address}/Alice`, ...input });
  const joined = () => receive({ kind: "state", state: "joined", role: "participant" });
  return { store, xmpp, rooms, alice, bob, subscription, session, receive, joined };
}
const denied = (fn: () => unknown, status = 403) => assert.throws(fn, e => e instanceof Problem && e.status === status);

test("external rooms isolate account histories and enforce read, subscribe, send and posting grants", t => {
  const f = fixture(); t.after(() => f.store.close());
  assert.equal(f.rooms.list(f.bob).length, 0);
  denied(() => f.rooms.history(f.bob, f.subscription.id), 404);
  denied(() => f.rooms.leave(f.bob, f.subscription.id), 404);
  denied(() => f.rooms.post(f.alice, f.subscription.id, "Too early"));
  f.joined();
  f.receive({ kind: "state", state: "joined", role: "visitor" });
  denied(() => f.rooms.post(f.alice, f.subscription.id, "No speaking role"));
  f.joined();
  for (const permission of ["federation_subscribe", "federation_receive", "federation_post", "federation_send"]) {
    f.store.db.prepare(`UPDATE users SET ${permission}=0 WHERE id=?`).run(f.alice.id);
    denied(() => f.rooms.post(f.alice, f.subscription.id, "Denied"));
    if (["federation_subscribe", "federation_receive"].includes(permission)) denied(() => f.rooms.history(f.alice, f.subscription.id));
    f.store.db.prepare(`UPDATE users SET ${permission}=1 WHERE id=?`).run(f.alice.id);
  }
  const queued = f.rooms.post(f.alice, f.subscription.id, "Queued before moderation");
  f.receive({ kind: "state", state: "joined", role: "visitor" });
  denied(() => f.rooms.dispatched({ session: f.session, id: queued.id }));
  assert.equal(f.rooms.history(f.alice, f.subscription.id).messages[0].status, "failed");
  f.store.setUserBlock(f.alice, `xmpp:${address}`, true);
  denied(() => f.rooms.history(f.alice, f.subscription.id));
  assert.equal(f.rooms.sync({ active: [f.session] }).desired.length, 0);
  f.rooms.leave(f.alice, f.subscription.id); // leaving is always possible
});

test("foreign room echoes confirm browser posts without duplication and retain room nickname provenance", t => {
  const f = fixture(); t.after(() => f.store.close()); f.joined();
  const outgoing = f.rooms.post(f.alice, f.subscription.id, "Hello");
  const sync = f.rooms.sync({ active: [f.session] });
  assert.deepEqual(sync.messages, [{ session: f.session, id: outgoing.id, body: "Hello" }]);
  f.rooms.dispatched({ session: f.session, id: outgoing.id });
  assert.equal(f.rooms.sync({ active: [f.session] }).messages.length, 0);
  f.receive({ kind: "message", id: outgoing.id, stable_id: "remote-stable", body: "Hello" });
  f.receive({ kind: "message", id: outgoing.id, stable_id: "remote-stable", body: "Hello" });
  f.receive({ kind: "message", from: `${address}/host`, id: "host-1", body: "Earlier", stamp: "2026-10-01T12:00:00Z" });
  f.receive({ kind: "message", from: `${address}/host`, id: "host-1", body: "Earlier", stamp: "2026-10-01T12:00:00Z" });
  const page = f.rooms.history(f.alice, f.subscription.id);
  assert.equal(page.messages.length, 2);
  assert.equal(page.messages[0].status, "confirmed");
  assert.equal(page.messages[1].sender, `${address}/host`);
  assert.equal(page.messages[1].created_at, "2026-10-01T12:00:00.000Z");
  denied(() => f.receive({ kind: "message", from: "attacker@elsewhere.example/nick", body: "Spoofed" }));
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM direct_messages").get()?.n, 0);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM channels").get()?.n, 0);
});

test("leave/rejoin invalidates stale callbacks and policy revocation cancels queued messages", t => {
  const f = fixture(); t.after(() => f.store.close()); f.joined();
  const outgoing = f.rooms.post(f.alice, f.subscription.id, "Queued");
  f.rooms.leave(f.alice, f.subscription.id);
  denied(() => f.receive({ kind: "message", body: "After leaving" }), 404);
  assert.equal(f.rooms.history(f.alice, f.subscription.id).messages[0].status, "failed");
  f.rooms.join(f.alice, { room: address, nick: "New nick" });
  denied(() => f.receive({ kind: "state", state: "joined", role: "participant" }), 404);
  const newSession = f.rooms.sync({}).desired[0].session;
  assert.notEqual(newSession, f.session);
  f.rooms.receive({ session: newSession, from: `${address}/New nick`, kind: "state", state: "joined", role: "participant" });
  f.rooms.post(f.alice, f.subscription.id, "Will be cancelled");
  f.store.db.prepare("INSERT INTO federation_blocks VALUES(?,'instance')").run("https://muc.remote.example");
  assert.equal(f.rooms.sync({ active: [newSession] }).desired.length, 0);
  assert.equal(f.store.db.prepare("SELECT status FROM xmpp_remote_messages WHERE id=?").get(outgoing.id)?.status, "failed");
  denied(() => f.rooms.receive({ session: newSession, from: `${address}/host`, kind: "message", body: "Blocked" }));
});

test("remote room validation, role errors, pagination and native checks follow current credentials", t => {
  const f = fixture(); t.after(() => f.store.close());
  for (const room of ["bad", "room@channels.chat.example", "room@chat.example", `${address}/nick`]) denied(() => f.rooms.join(f.alice, { room, nick: "alice" }), 400);
  denied(() => f.rooms.join(f.alice, { room: address, nick: "bad/nick" }), 400);
  f.receive({ kind: "state", state: "error", error: "not-authorized" });
  assert.equal(f.rooms.list(f.alice)[0].error, "not-authorized");
  assert.equal(f.rooms.sync({}).desired.length, 0);
  f.joined();
  for (let i = 0; i < 105; i++) f.receive({ kind: "message", from: `${address}/host`, id: String(i), body: String(i) });
  const page = f.rooms.history(f.alice, f.subscription.id);
  assert.equal(page.messages.length, 100); assert.equal(page.more, true);
  assert.equal(f.rooms.history(f.alice, f.subscription.id, page.messages[0].seq).messages.length, 5);
  const credential = f.xmpp.issue(f.alice, "Native");
  const input = { from: `${credential.jid}/desktop`, credential: credential.id, to: address, operation: "remote-room-check" };
  assert.deepEqual(f.xmpp.operation(input), { valid: true });
  f.xmpp.revoke(f.alice, credential.id);
  denied(() => f.xmpp.operation(input), 401);
});

test("external subscriptions and archives survive a version ten upgrade and restart", t => {
  const directory = mkdtempSync(join(tmpdir(), "archipel-external-rooms-"));
  const path = join(directory, "db.sqlite");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let store = new Store(path);
  const alice = store.loginIdentity("urn:archipel:development", "alice", "alice", [], true);
  store.db.exec("DROP TABLE xmpp_remote_messages; DROP TABLE xmpp_remote_rooms; PRAGMA user_version=10");
  store.close(); store = new Store(path);
  let xmpp = new Xmpp(store, config);
  store.db.prepare("INSERT OR REPLACE INTO instance_settings VALUES('federation_enabled','true')").run();
  store.db.prepare("UPDATE users SET federation_receive=1,federation_subscribe=1 WHERE id=?").run(alice.id);
  const room = xmpp.remoteRooms.join(alice, { room: address, nick: "alice" });
  const session = xmpp.remoteRooms.sync({}).desired[0].session;
  xmpp.remoteRooms.receive({ session, from: `${address}/host`, kind: "message", body: "Saved", id: "persist" });
  store.close(); store = new Store(path); xmpp = new Xmpp(store, config);
  assert.equal(xmpp.remoteRooms.sync({}).desired[0].session, session);
  assert.equal(xmpp.remoteRooms.history(alice, room.id).messages[0].body, "Saved");
  store.close();
});
