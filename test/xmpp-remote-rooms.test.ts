import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store, Problem } from "../src/store.js";
import { Xmpp } from "../src/xmpp.js";
import { Mirrors } from "../src/mirrors.js";
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
  store.db.exec("DROP TABLE push_subscriptions; DROP TABLE conversation_prefs; DROP INDEX messages_parent; DROP TABLE xmpp_remote_messages; DROP TABLE xmpp_remote_rooms; DROP TABLE attachments; DROP TABLE user_roles; DROP TABLE roles; DROP TABLE mirror_sources; DROP TABLE channel_mirrors; DROP TABLE channel_bridge_seen; DROP TABLE channel_bridges; PRAGMA user_version=10");
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

test("room messages keep a disclosed sender address and blocks hide by address or by room nickname", t => {
  const f = fixture(); t.after(() => f.store.close()); f.joined();
  f.receive({ kind: "message", from: `${address}/Carol`, id: "c1", body: "Known", real_jid: "Carol@Remote.Example" });
  f.receive({ kind: "message", from: `${address}/Dave`, id: "d1", body: "Anonymous" });
  f.receive({ kind: "message", from: `${address}/Eve`, id: "e1", body: "Odd address", real_jid: "not a jid" });
  const seen = () => f.rooms.history(f.alice, f.subscription.id).messages.map(m => [m.sender_jid, m.blocked, m.body]);
  assert.deepEqual(seen(), [["carol@remote.example", false, "Known"], [null, false, "Anonymous"], [null, false, "Odd address"]]);
  f.store.setUserBlock(f.alice, "xmpp:carol@remote.example", true);
  f.store.setUserBlock(f.alice, `xmpp:${address}/Dave`, true);
  const hidden = "This message is hidden because you blocked this user.";
  assert.deepEqual(seen().map(m => m[2]), [hidden, hidden, "Odd address"]);
  assert.deepEqual(f.store.overview(f.alice).user_blocks, [`xmpp:${address}/Dave`, "xmpp:carol@remote.example"].sort());
  // A nickname block is scoped to its room and never becomes a contact or a direct-message block.
  assert.equal(f.xmpp.remoteAccess(f.alice, `xmpp:${address}`).blocked, null);
  denied(() => f.store.setUserBlock(f.alice, "xmpp:not a room/Dave", true), 400);
  f.store.setUserBlock(f.alice, `xmpp:${address}/Dave`, false);
  assert.deepEqual(seen().map(m => m[2]), [hidden, "Anonymous", "Odd address"]);
});

test("a bridged channel repeats members in the room as themselves and takes in the room once per message", t => {
  const store = new Store(":memory:"), xmpp = new Xmpp(store, config), rooms = xmpp.remoteRooms;
  t.after(() => store.close());
  const alice = store.loginIdentity("urn:archipel:development", "alice", "alice", [], true);
  const bob = store.loginIdentity("urn:archipel:development", "bob", "bob", []);
  const carol = store.loginIdentity("urn:archipel:development", "carol", "carol", []);
  store.db.prepare("INSERT OR REPLACE INTO instance_settings VALUES('federation_enabled','true')").run();
  store.db.prepare("UPDATE users SET federation_receive=1,federation_subscribe=1,federation_send=1,federation_post=1 WHERE id!=?").run(carol.id);
  const channel = store.createChannel(alice, { name: "lounge", mode: "timeline", visibility: "public", admission: "open" });
  const threads = store.createChannel(alice, { name: "threads", mode: "threaded", visibility: "public", admission: "open" });
  store.join(bob, channel.id); store.join(carol, channel.id);
  denied(() => rooms.setBridge(bob, channel.id, address));
  denied(() => rooms.setBridge(alice, threads.id, address), 400);
  denied(() => rooms.setBridge(alice, channel.id, `general@${xmpp.rooms}`), 400);
  assert.equal(rooms.setBridge(alice, channel.id, address).room, address);
  assert.equal(store.channelInfo(bob, store.channel(channel.id)).bridge_room, address);
  const other = store.createChannel(alice, { name: "other", mode: "timeline", visibility: "public", admission: "open" });
  denied(() => rooms.setBridge(alice, other.id, address), 409);
  // Occupants made for the bridge are not rooms their members chose to join.
  assert.deepEqual(rooms.list(alice), []);
  const sessions = () => Object.fromEntries(rooms.sync({ active: active() }).desired.map(d => [d.nick, d.session]));
  let live: string[] = [];
  const active = () => live;
  const hear = (nick: string, input: Record<string, unknown>) => rooms.receive({ session: sessions()[nick], from: `${address}/${nick}`, ...input });
  const enter = (nick: string) => { live = Object.values(sessions()); hear(nick, { kind: "state", state: "joined", role: "participant" }); };
  enter("alice");
  const bodies = () => store.messages(alice, channel.id).map(m => [m.username, m.body]);

  // Out: each author has their own occupant; those without grants stay local.
  const posted = store.post(bob, channel.id, { body: "From Bob" });
  store.post(carol, channel.id, { body: "Carol stays local" });
  assert.deepEqual(Object.keys(sessions()).sort(), ["alice", "bob"]);
  assert.deepEqual(rooms.list(bob), []);
  enter("bob");
  const out = rooms.sync({ active: active() }).messages;
  assert.deepEqual(out.map(m => m.body), ["From Bob"]);
  rooms.dispatched({ session: out[0].session, id: out[0].id });
  // The echo reaches every occupant and is not taken back in.
  for (const nick of ["alice", "bob"]) hear(nick, { kind: "message", from: `${address}/bob`, id: out[0].id, origin_id: out[0].id, stable_id: "s1", body: "From Bob" });
  assert.deepEqual(bodies(), [["bob", "From Bob"], ["carol", "Carol stays local"]]);
  assert.equal(store.db.prepare("SELECT status FROM xmpp_remote_messages WHERE relay_of=?").get(posted.id)?.status, "confirmed");

  // In: heard by both occupants, stored once, attributed by address or by room nickname.
  for (const nick of ["alice", "bob"]) {
    hear(nick, { kind: "message", from: `${address}/Dana`, id: "d1", stable_id: "s2", body: "Hello from Dana", real_jid: "dana@remote.example" });
    hear(nick, { kind: "message", from: `${address}/Erin`, id: "e1", body: "Hello from Erin" });
  }
  assert.deepEqual(bodies().slice(2), [["dana@remote.example", "Hello from Dana"], [`${address}/Erin`, "Hello from Erin"]]);
  const authors = store.messages(alice, channel.id).slice(2).map(m => m.author_actor_url);
  assert.deepEqual(authors, ["xmpp:dana@remote.example", `xmpp:${address}/Erin`]);
  assert.equal(store.overview(carol).unread[channel.id], 1); // Bob only: Carol may not receive federated authors.
  assert.equal(store.overview(bob).unread[channel.id], 3);
  // Local XMPP clients in the channel's own room are told too; nothing loops back out.
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM xmpp_events WHERE kind='Create'").get()!.n, 4);
  assert.deepEqual(rooms.sync({ active: active() }).messages, []);
  // Personal blocks apply to bridged authors, by address or by nickname in that room.
  store.setUserBlock(bob, `xmpp:${address}/Erin`, true);
  assert.match(store.messages(bob, channel.id).at(-1)!.body, /hidden because you blocked/);
  // An administrator's block keeps an identity out of the channel altogether.
  store.db.prepare("INSERT INTO federation_blocks VALUES('xmpp:mallory@remote.example','actor')").run();
  hear("alice", { kind: "message", from: `${address}/Mallory`, id: "m1", body: "Blocked", real_jid: "mallory@remote.example" });
  assert.equal(bodies().length, 4);
  // Someone's private subscription to the room never feeds a channel they don't run.
  store.db.prepare("UPDATE users SET federation_receive=1,federation_subscribe=1 WHERE id=?").run(carol.id);
  rooms.join(carol, { room: address, nick: "carol" });
  enter("carol");
  hear("carol", { kind: "message", from: `${address}/Dana`, id: "d2", body: "Only Carol heard this", real_jid: "dana@remote.example" });
  assert.equal(bodies().length, 4);
  assert.equal(rooms.history(carol, rooms.list(carol)[0].id).messages.length, 1);

  // Removing the bridge retires the occupants it made and stops both directions.
  assert.equal(rooms.removeBridge(alice, channel.id).room, null);
  assert.deepEqual(Object.keys(sessions()), ["carol"]);
  store.post(bob, channel.id, { body: "After the bridge" });
  assert.deepEqual(Object.keys(sessions()), ["carol"]);
  rooms.setBridge(alice, channel.id, address);
  store.deleteChannel(alice, channel.id);
  assert.deepEqual(Object.keys(sessions()), ["carol"]);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM channel_bridges").get()!.n, 0);
});

test("a mirror copies a room the owner joined, attributing authors as the room discloses them", t => {
  const f = fixture(); t.after(() => f.store.close()); f.joined();
  const mirrors = new Mirrors(f.store, f.xmpp);
  f.receive({ kind: "message", from: `${address}/Carol`, id: "c1", body: "Already archived", real_jid: "carol@remote.example" });
  const mirror = mirrors.create(f.alice, { name: "archive", description: "", visibility: "members", admission: "allowlist" });
  denied(() => mirrors.addSource(f.bob, mirror.id, { kind: "xmpp", source: f.subscription.id }));
  denied(() => mirrors.addSource(f.alice, mirror.id, { kind: "xmpp", source: "missing" }), 404);
  denied(() => f.rooms.setBridge(f.alice, mirror.id, address), 400);
  const [source] = mirrors.addSource(f.alice, mirror.id, { kind: "xmpp", source: f.subscription.id }).sources;
  assert.deepEqual([source.name, source.state], [address, "joined"]);
  f.receive({ kind: "message", from: `${address}/Dave`, id: "d1", body: "Anonymous" });
  // The owner's own room message is copied once the room confirms it, in order.
  const own = f.rooms.post(f.alice, f.subscription.id, "From the owner");
  f.receive({ kind: "message", from: `${address}/Carol`, id: "c2", body: "After the owner", real_jid: "carol@remote.example" });
  const seen = () => f.store.messages(f.alice, mirror.id).map(m => [m.author_actor_url.replace(/^http.*$/, "local"), m.body]);
  assert.deepEqual(seen(), [["xmpp:carol@remote.example", "Already archived"], [`xmpp:${address}/Dave`, "Anonymous"]]);
  f.rooms.dispatched({ session: f.session, id: own.id });
  f.receive({ kind: "message", id: own.id, origin_id: own.id, body: "From the owner" });
  assert.deepEqual(seen().slice(2), [["local", "From the owner"], ["xmpp:carol@remote.example", "After the owner"]]);
  // Nothing is said in the room on the mirror's behalf, even once it is a fork.
  mirrors.setWritable(f.alice, mirror.id, true);
  f.store.post(f.alice, mirror.id, { body: "Fork only" });
  assert.deepEqual(f.rooms.sync({ active: [f.session] }).messages, []);
  // Leaving the room stops the source; the copies stay.
  f.rooms.leave(f.alice, f.subscription.id);
  assert.equal(mirrors.sources(f.alice, mirror.id).sources[0].state, "left");
  assert.equal(seen().length, 5);
});

test("a room that drops its occupants is joined again with backoff, and a kick or refusal is final", t => {
  const f = fixture(); t.after(() => f.store.close());
  const row = () => f.store.db.prepare("SELECT state,attempts,retry_at FROM xmpp_remote_rooms WHERE id=?").get(f.subscription.id) as { state: string; attempts: number; retry_at: number | null };
  const due = () => f.store.db.prepare("UPDATE xmpp_remote_rooms SET retry_at=1 WHERE id=?").run(f.subscription.id);
  const wanted = () => f.rooms.sync({}).desired.map(r => r.session);
  f.joined();
  // The other server restarted: the room says goodbye with a shutdown code, or the path to it fails.
  f.receive({ kind: "state", state: "left", codes: ["110", "332"] });
  assert.deepEqual([row().state, row().attempts], ["left", 1]);
  assert.ok(row().retry_at! > Date.now() && row().retry_at! <= Date.now() + 5000);
  assert.equal(f.rooms.list(f.alice)[0].reconnecting, true);
  assert.deepEqual(wanted(), []);
  due();
  assert.deepEqual(wanted(), [f.session]);
  assert.deepEqual([row().state, row().retry_at], ["joining", null]);
  // It is still down: each failure waits longer, up to ten minutes.
  f.receive({ kind: "state", state: "error", condition: "remote-server-not-found", error: "remote-server-not-found" });
  assert.equal(row().attempts, 2);
  assert.ok(row().retry_at! > Date.now() + 5000 && row().retry_at! <= Date.now() + 10000);
  f.store.db.prepare("UPDATE xmpp_remote_rooms SET attempts=40 WHERE id=?").run(f.subscription.id);
  f.receive({ kind: "state", state: "error", condition: "remote-server-timeout" });
  assert.ok(row().retry_at! > Date.now() + 590000 && row().retry_at! <= Date.now() + 600000);
  due(); wanted();
  f.joined();
  assert.deepEqual([row().state, row().attempts, row().retry_at], ["joined", 0, null]);
  assert.equal(f.rooms.list(f.alice)[0].reconnecting, false);
  // A session the room silently forgot is found by the adapter's ping and joined again too.
  f.receive({ kind: "state", state: "error", condition: "dropped" });
  assert.equal(row().attempts, 1);
  due(); wanted(); f.joined();
  // Kicked, banned or refused: joining again is the member's decision.
  f.receive({ kind: "state", state: "left", codes: ["110", "307"] });
  assert.deepEqual([row().state, row().retry_at], ["left", null]);
  assert.deepEqual(wanted(), []);
  f.rooms.join(f.alice, { room: address, nick: "Alice", reconnect: true });
  const again = f.rooms.sync({}).desired[0].session;
  f.rooms.receive({ session: again, from: `${address}/Alice`, kind: "state", state: "error", condition: "forbidden", error: "forbidden" });
  assert.deepEqual([row().state, row().retry_at], ["error", null]);
  // Leaving ends any pending attempt.
  f.rooms.join(f.alice, { room: address, nick: "Alice", reconnect: true });
  const last = f.rooms.sync({}).desired[0].session;
  f.rooms.receive({ session: last, from: `${address}/Alice`, kind: "state", state: "error", condition: "service-unavailable" });
  assert.ok(row().retry_at);
  f.rooms.leave(f.alice, f.subscription.id);
  assert.equal(row().retry_at, null);
  f.store.db.prepare("UPDATE xmpp_remote_rooms SET retry_at=1 WHERE id=?").run(f.subscription.id);
  assert.deepEqual(wanted(), []);
});
