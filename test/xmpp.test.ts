import { test } from "node:test";
import assert from "node:assert/strict";
import { Store, Problem } from "../src/store.js";
import { Xmpp } from "../src/xmpp.js";
import { loadConfig } from "../src/config.js";
import { createApp } from "../src/app.js";
import { Federation } from "../src/federation.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const secret = "s".repeat(43);
function fixture() {
  const store = new Store(":memory:");
  const config = loadConfig({ DEV_AUTH: "true", XMPP_DOMAIN: "chat.example", XMPP_BRIDGE_SECRET: secret });
  const xmpp = new Xmpp(store, config);
  const alice = store.loginIdentity("urn:archipel:development", "alice", "alice", [], true);
  const bob = store.loginIdentity("urn:archipel:development", "bob", "bob", []);
  const a = xmpp.issue(alice, "Desktop"), b = xmpp.issue(bob, "Phone");
  const room = store.createChannel(alice, { name: "general", mode: "timeline", visibility: "members", admission: "open" });
  const input = (who = a) => ({ from: `${who.jid}/test`, credential: who.id });
  return { store, config, xmpp, alice, bob, a, b, room, input, roomJid: `general@${xmpp.rooms}` };
}
function denied(fn: () => unknown, status = 403) {
  assert.throws(fn, e => e instanceof Problem && e.status === status);
}
test("XMPP configuration requires explicit valid domain and private bridge secret", () => {
  for (const domain of ["Chat.Example", "-chat.example", "chat..example", "chat.example:5222", "chat.example/room"])
    assert.throws(() => loadConfig({ XMPP_DOMAIN: domain, XMPP_BRIDGE_SECRET: secret }), /XMPP_DOMAIN/);
  assert.throws(() => loadConfig({ XMPP_DOMAIN: "chat.example" }), /XMPP_BRIDGE_SECRET/);
});

test("XMPP ports default to standard listeners and configured client ports are advertised", () => {
  const f = fixture();
  assert.equal(f.config.xmppClientPort, 5222);
  assert.equal(f.config.xmppServerPort, 5269);
  assert.equal(f.xmpp.status(f.alice).port, 5222);
  const env = { DEV_AUTH: "true", XMPP_DOMAIN: "chat.example", XMPP_BRIDGE_SECRET: secret, XMPP_CLIENT_PORT: "55222", XMPP_SERVER_PORT: "55269" };
  const config = loadConfig(env);
  assert.equal(new Xmpp(f.store, config).status(f.alice).port, 55222);
  assert.equal(config.xmppServerPort, 55269);
  for (const key of ["XMPP_CLIENT_PORT", "XMPP_SERVER_PORT"]) {
    for (const value of ["0", "65536", "-1", "5222.5", "5e3", "0x1466", "invalid"]) {
      assert.throws(() => loadConfig({ ...env, [key]: value }), new RegExp(key));
    }
    assert.doesNotThrow(() => loadConfig({ ...env, [key]: "65535" }));
  }
  assert.throws(() => loadConfig({ ...env, XMPP_SERVER_PORT: "55222" }), /ports must differ/);
  f.store.close();
});
test("app credentials use explicit stable account bindings and are revocable without linking matching OIDC names", () => {
  const f = fixture();
  assert.deepEqual(f.xmpp.verify({ username: "alice", password: f.a.password }), { valid: true, credential: f.a.id });
  assert.equal(f.xmpp.verify({ username: "bob", password: f.a.password }).valid, false);
  assert.equal(f.xmpp.verify({ username: "alice", password: "wrong" }).valid, false);
  const other = f.store.loginIdentity("https://other.example", "alice", "alice", []);
  assert.notEqual(f.xmpp.jid(other), f.a.jid);
  assert.equal(f.store.db.prepare("SELECT digest FROM xmpp_credentials WHERE id=?").get(f.a.id)?.digest === f.a.password, false);
  f.xmpp.revoke(f.bob, f.a.id); // Cannot revoke another user's password.
  assert.equal(f.xmpp.verify({ username: "alice", password: f.a.password }).valid, true);
  f.xmpp.revoke(f.alice, f.a.id);
  assert.equal(f.xmpp.verify({ username: "alice", password: f.a.password }).valid, false);
  denied(() => f.xmpp.operation({ ...f.input(), operation: "check" }), 401);
  f.store.close();
});
test("bindings, credentials, content and outbox survive restart; domain/auth-policy changes cannot silently rebind accounts", t => {
  const directory = mkdtempSync(join(tmpdir(), "archipel-xmpp-persistence-"));
  const path = join(directory, "archive.sqlite");
  const config = loadConfig({ DEV_AUTH: "true", XMPP_DOMAIN: "chat.example", XMPP_BRIDGE_SECRET: secret });
  let store = new Store(path), xmpp = new Xmpp(store, config);
  const alice = store.loginIdentity("urn:archipel:development", "alice", "alice", [], true);
  const credential = xmpp.issue(alice, "Persistent client");
  const channel = store.createChannel(alice, { name: "persisted", mode: "timeline", visibility: "members", admission: "open" });
  const post = { from: `${credential.jid}/desktop`, credential: credential.id, operation: "post", id: "persisted-post", to: `persisted@${xmpp.rooms}`, body: "Persisted content" };
  xmpp.operation(post);
  store.close();
  store = new Store(path); xmpp = new Xmpp(store, config);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  assert.equal(xmpp.verify({ username: "alice", password: credential.password }).valid, true);
  assert.equal(xmpp.jid(store.user(alice.id)), credential.jid);
  xmpp.operation(post);
  assert.equal(store.messages(alice, channel.id).length, 1);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM xmpp_events").get()?.n, 1);
  assert.throws(() => new Xmpp(store, { ...config, xmppDomain: "different.example" }), /XMPP_DOMAIN/);
  store.applyAuthPolicy("https://new-issuer.example", [], false);
  assert.equal(xmpp.verify({ username: "alice", password: credential.password }).valid, false);
});
test("XMPP joins, writes, discovery and archive reads enforce admission, channel rules and shared content", () => {
  const f = fixture(), to = f.roomJid;
  f.xmpp.operation({ ...f.input(f.b), operation: "join", to });
  const post = { ...f.input(f.b), operation: "post", id: "native-1", to, body: "From an XMPP client" };
  const result = f.xmpp.operation(post) as { id: string };
  assert.equal(f.store.messages(f.alice, f.room.id)[0].id, result.id);
  assert.deepEqual(f.xmpp.operation(post), result);
  denied(() => f.xmpp.operation({ ...post, body: "Different content" }), 409);
  f.store.post(f.alice, f.room.id, { body: "From the browser" });
  const archive = f.xmpp.archive(f.bob, { room: to, max: 1, before: "" });
  assert.equal(archive.messages[0].body, "From the browser");
  assert.equal(archive.count, 2);
  assert.equal(f.xmpp.archive(f.bob, { room: to, before: archive.first }).messages[0].id, result.id);
  const corrected = { ...f.input(f.b), operation: "post", id: "native-2", to, body: "Corrected", replace: result.id };
  f.xmpp.operation(corrected);
  assert.equal(f.store.messages(f.alice, f.room.id)[0].body, "Corrected");
  denied(() => f.xmpp.operation({ ...corrected, ...f.input(), id: "wrong-author" }));
  f.store.setMember(f.alice, f.room.id, f.bob.id, { rule: "block" });
  denied(() => f.xmpp.operation({ ...f.input(f.b), operation: "archive", room: to }));
  denied(() => f.xmpp.operation({ ...post, id: "blocked" }));
  assert.equal(f.xmpp.status(f.bob).channels!.length, 0);
  f.store.db.prepare("UPDATE users SET admission_status='pending' WHERE id=?").run(f.bob.id);
  denied(() => f.xmpp.status(f.bob));
  f.store.close();
});
test("live projection filters personal blocks, evicts revoked members and disconnects revoked credentials", () => {
  const f = fixture();
  f.store.join(f.bob, f.room.id);
  f.store.post(f.alice, f.room.id, { body: "Hidden from Bob" });
  f.store.setUserBlock(f.bob, `${f.store.baseUrl}/actors/users/${f.alice.id}`, true);
  const input = { after: 0, sessions: [{ jid: `${f.b.jid}/test`, credential: f.b.id }], occupants: [{ jid: `${f.b.jid}/test`, room: f.roomJid }] };
  assert.match(f.xmpp.sync(input).messages[0].body, /hidden/);
  f.store.setMember(f.alice, f.room.id, f.bob.id, { remove: true });
  const result = f.xmpp.sync(input);
  assert.equal(result.messages.length, 0);
  assert.equal(result.kick.length, 1);
  f.xmpp.revoke(f.bob, f.b.id);
  assert.deepEqual(f.xmpp.sync(input).disconnect, [`${f.b.jid}/test`]);
  f.store.close();
});
test("direct messages share browser history and XMPP identities retain independent protocol provenance", () => {
  const f = fixture();
  f.xmpp.operation({ ...f.input(), operation: "direct", to: f.b.jid, body: "Local native DM", id: "dm-1" });
  assert.equal(f.store.directHistory(f.bob, `${f.store.baseUrl}/actors/users/${f.alice.id}`).messages[0].body, "Local native DM");
  f.store.setUserBlock(f.bob, `${f.store.baseUrl}/actors/users/${f.alice.id}`, true);
  denied(() => f.xmpp.operation({ ...f.input(), operation: "direct", to: f.b.jid, body: "blocked", id: "dm-2" }));
  denied(() => f.xmpp.sendDirect(f.alice, "other@remote.example", "No federation"));
  f.store.db.prepare("INSERT OR REPLACE INTO instance_settings VALUES('federation_enabled','true')").run();
  f.store.db.prepare("UPDATE users SET federation_send=1,federation_receive=1 WHERE id=?").run(f.alice.id);
  f.xmpp.sendDirect(f.alice, "other@remote.example", "Remote native DM");
  f.xmpp.operation({ operation: "direct", from: "other@remote.example/device", to: f.a.jid, body: "Remote reply", id: "remote-1" });
  const history = f.store.directHistory(f.alice, "xmpp:other@remote.example");
  assert.equal(history.messages.length, 2);
  assert.equal(history.messages[1].author_actor_url, "xmpp:other@remote.example");
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM federation_outgoing").get()?.n, 0);
  f.store.setUserBlock(f.alice, "xmpp:other@remote.example", true);
  denied(() => f.xmpp.operation({ operation: "direct", from: "other@remote.example", to: f.a.jid, body: "blocked", id: "remote-2" }));
  const deliveries = f.xmpp.sync({ after: 0, sessions: [], occupants: [] });
  assert.equal(deliveries.messages.length, 0);
  f.store.close();
});
test("the internal adapter requires its own bearer secret and browser credential APIs require session/CSRF", async t => {
  const f = fixture(), app = createApp(f.config, f.store);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  t.after(() => { server.closeAllConnections(); server.close(); f.store.close(); });
  const post = (key: string) => fetch(`${origin}/internal/xmpp/auth`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ username: "alice", password: f.a.password }),
  });
  assert.equal((await post("incorrect")).status, 401);
  assert.equal((await post(secret)).status, 200);
  assert.equal((await fetch(`${origin}/api/xmpp`)).status, 401);
  const login = await fetch(`${origin}/api/dev-login`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: f.config.baseUrl }, body: JSON.stringify({ username: "alice" }),
  });
  const cookie = login.headers.getSetCookie()[0].split(";")[0], session = await login.json();
  assert.equal((await fetch(`${origin}/api/xmpp/credentials`, { method: "POST", headers: { Cookie: cookie, Origin: f.config.baseUrl, "Content-Type": "application/json" }, body: '{"label":"new"}' })).status, 403);
  assert.equal((await fetch(`${origin}/api/xmpp/credentials`, { method: "POST", headers: { Cookie: cookie, Origin: f.config.baseUrl, "Content-Type": "application/json", "X-CSRF-Token": session.csrf }, body: '{"label":"new"}' })).status, 201);
});

test("administrator instance URL blocks apply to XMPP send, receive, archive and queued delivery", () => {
  const f = fixture(), fed = new Federation(f.store, f.config);
  fed.setEnabled(f.alice, true);
  fed.setPermissions(f.alice, f.alice.id, { federation_send: true, federation_receive: true, federation_subscribe: false, federation_post: false });
  f.xmpp.sendDirect(f.alice, "other@remote.example", "Queued outgoing");
  const incoming = { operation: "direct", from: "other@remote.example/phone", to: f.a.jid, body: "Incoming", id: "before-block" };
  f.xmpp.operation(incoming);
  assert.equal(f.xmpp.archive(f.alice, {}).messages.length, 2);
  fed.block(f.alice, { kind: "instance", target: "https://remote.example:8443/actors/users/anyone", blocked: true });
  denied(() => f.xmpp.sendDirect(f.alice, "other@remote.example", "Blocked outgoing"));
  denied(() => f.xmpp.operation({ ...incoming, id: "after-block" }));
  assert.equal(f.xmpp.archive(f.alice, {}).messages.length, 0);
  assert.equal(f.store.directHistory(f.alice, "xmpp:other@remote.example").messages.length, 0);
  assert.equal(f.store.inbox(f.alice).length, 0);
  assert.equal(f.xmpp.sync({ after: 0, sessions: [{ jid: `${f.a.jid}/test`, credential: f.a.id }], occupants: [] }).messages.length, 0);
  fed.block(f.alice, { kind: "instance", target: "https://remote.example:8443", blocked: false });
  assert.equal(f.xmpp.archive(f.alice, {}).messages.length, 2);
  f.store.close();
});

test("native stanza IDs deduplicate within streams and corrections resolve the right resource and room", () => {
  const f = fixture();
  const first = { ...f.input(), stream: "desktop-stream", operation: "post", to: f.roomJid, id: "1", body: "Desktop post" };
  const a = f.xmpp.operation(first) as { id: string };
  assert.deepEqual(f.xmpp.operation(first), a);
  const second = { ...first, from: `${f.a.jid}/phone`, stream: "phone-stream", body: "Phone post" };
  const b = f.xmpp.operation(second) as { id: string };
  assert.notEqual(a.id, b.id);
  const third = { ...first, stream: "reconnected-stream", body: "Reconnected post" };
  const c = f.xmpp.operation(third) as { id: string };
  assert.notEqual(a.id, c.id);
  f.xmpp.operation({ ...second, id: "2", replace: "1", body: "Phone correction" });
  assert.equal(f.store.message(b.id).body, "Phone correction");
  assert.equal(f.store.message(a.id).body, "Desktop post");
  denied(() => f.xmpp.operation({ ...first, stream: "another-stream", id: "3", replace: "1", body: "Ambiguous" }), 409);
  f.xmpp.operation({ ...first, stream: "another-stream", id: "3", replace: a.id, body: "Unambiguous" });
  assert.equal(f.store.message(a.id).body, "Unambiguous");
  const room = f.store.createChannel(f.alice, { name: "second", mode: "timeline", visibility: "members", admission: "open" });
  const inRoom = { ...first, stream: "room-stream", to: `second@${f.xmpp.rooms}`, body: "Second room" };
  const d = f.xmpp.operation(inRoom) as { id: string };
  f.xmpp.operation({ ...inRoom, stream: "new-room-stream", id: "2", replace: "1", body: "Second room corrected" });
  assert.equal(f.store.message(d.id).channel_id, room.id);
  assert.equal(f.store.message(d.id).body, "Second room corrected");
  const dm = { ...f.input(), operation: "direct", to: f.b.jid, stream: "desktop-stream", id: "4", body: "Desktop DM" };
  f.xmpp.operation(dm); f.xmpp.operation(dm);
  f.xmpp.operation({ ...dm, stream: "phone-stream", body: "Phone DM" });
  assert.equal(f.store.directHistory(f.bob, `${f.store.baseUrl}/actors/users/${f.alice.id}`).messages.length, 2);
  f.store.close();
});

test("removing an edited message projects a distinct stable tombstone ID", () => {
  const f = fixture();
  const message = f.store.post(f.alice, f.room.id, { body: "Original" });
  const edited = f.store.editMessage(f.alice, message.id, { body: "Edited", expected_edited_at: null });
  const correction = f.xmpp.channelDelivery(f.alice, edited, `${f.a.jid}/test`, "Update");
  f.store.deleteMessage(f.alice, message.id);
  const removed = f.store.message(message.id);
  const tombstone = f.xmpp.channelDelivery(f.alice, removed, `${f.a.jid}/test`, "Delete");
  assert.notEqual(correction.id, tombstone.id);
  assert.equal(tombstone.replace, message.id);
  assert.equal(tombstone.body, "This message was removed.");
  assert.equal(f.xmpp.channelDelivery(f.alice, removed, `${f.a.jid}/test`, "Delete").id, tombstone.id);
  f.store.close();
});

test("version 8 migration preserves native IDs and archive correction references", t => {
  const directory = mkdtempSync(join(tmpdir(), "archipel-xmpp-scope-migration-"));
  const path = join(directory, "archive.sqlite");
  let store = new Store(path);
  const config = loadConfig({ DEV_AUTH: "true", XMPP_DOMAIN: "chat.example", XMPP_BRIDGE_SECRET: secret });
  let xmpp = new Xmpp(store, config);
  const alice = store.loginIdentity("urn:archipel:development", "alice", "alice", [], true);
  const credential = xmpp.issue(alice, "Desktop");
  const room = store.createChannel(alice, { name: "legacy", mode: "timeline", visibility: "members", admission: "open" });
  const input = { from: `${credential.jid}/desktop`, credential: credential.id, operation: "post", to: `legacy@${xmpp.rooms}`, id: "old-id", body: "Old content" };
  const result = xmpp.operation(input) as { id: string };
  store.db.exec("DROP TABLE remote_avatars; DROP TABLE xmpp_avatar_requests; DROP INDEX xmpp_message_ids_sender; ALTER TABLE xmpp_message_ids DROP COLUMN scope; CREATE UNIQUE INDEX legacy_stanza_ids ON xmpp_message_ids(sender,stanza_id); PRAGMA user_version=8");
  store.close(); store = new Store(path); xmpp = new Xmpp(store, config);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  assert.equal(store.db.prepare("PRAGMA user_version").get()?.user_version, 10);
  assert.equal(xmpp.archive(alice, { room: input.to }).messages[0].stanza_id, "old-id");
  xmpp.operation({ ...input, stream: "new-stream", id: "new-id", replace: "old-id", body: "Migrated correction" });
  assert.equal(store.message(result.id).body, "Migrated correction");
  xmpp.operation({ ...input, stream: "new-stream", body: "Reused ID" });
  assert.equal(store.messages(alice, room.id).length, 2);
});

test("XMPP avatar reads, writes, cache responses and queued requests obey current account and federation policy", () => {
  const f = fixture();
  const image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=";
  f.store.setAvatar(f.alice, image);
  const card = f.xmpp.vcard({ ...f.input(f.b), to: f.a.jid });
  assert.equal(card.avatar?.image, image);
  assert.equal(card.name, f.alice.display_name);
  assert.match(card.avatar!.hash, /^[0-9a-f]{40}$/);
  denied(() => f.xmpp.vcard({ from: "other@remote.example/phone", to: f.a.jid }));
  f.store.db.prepare("UPDATE instance_settings SET value='true' WHERE key='federation_enabled'").run();
  f.store.db.prepare("INSERT OR REPLACE INTO instance_settings VALUES('federation_enabled','true')").run();
  f.store.db.prepare("UPDATE users SET federation_send=1,federation_receive=1 WHERE id=?").run(f.alice.id);
  assert.equal(f.xmpp.vcard({ from: "other@remote.example/phone", to: f.a.jid }).avatar?.image, image);
  const peer = "xmpp:other@remote.example";
  f.xmpp.requestAvatar(f.alice, peer);
  const sync = f.xmpp.sync({ after: 0, sessions: [], occupants: [] });
  assert.equal(sync.profiles[0].jid, f.a.jid);
  const request = sync.avatar_requests[0];
  assert.equal(request.peer, peer.slice(5));
  denied(() => f.xmpp.cacheAvatar({ ...request, requester: f.b.jid, image }));
  denied(() => f.xmpp.cacheAvatar({ ...request, attempt: request.attempt - 1, image }));
  denied(() => f.xmpp.cacheAvatar({ ...request, image: "PHN2Zz48L3N2Zz4=" }), 400);
  f.xmpp.cacheAvatar({ ...request, image: image.match(/.{1,20}/g)!.join("\n") });
  assert.ok(f.store.peerInfo(peer).avatar_url);
  f.store.setContactName(f.alice, peer, "Friend");
  f.xmpp.operation({ operation: "avatar-refresh", from: "other@remote.example/phone", to: f.a.jid, photo: "" });
  assert.equal(f.store.peerInfo(peer).avatar_url, null);
  assert.equal(f.store.peerInfo(peer, f.alice).display_name, "Friend");
  denied(() => f.xmpp.cacheAvatar({ ...request, image })); // A stale response cannot resurrect a removed picture.
  f.store.setUserBlock(f.alice, peer, true);
  f.xmpp.requestAvatar(f.alice, peer, true);
  assert.equal(f.xmpp.sync({ after: 0, sessions: [], occupants: [] }).avatar_requests.length, 0);
  denied(() => f.xmpp.vcard({ from: "other@remote.example/phone", to: f.a.jid }));
  denied(() => f.xmpp.cacheAvatar({ ...f.input(f.b), operation: "set", to: f.a.jid, image }));
  f.xmpp.cacheAvatar({ ...f.input(f.b), operation: "set", image });
  assert.ok(f.store.avatarUrl(f.bob.id));
  f.xmpp.revoke(f.bob, f.b.id);
  denied(() => f.xmpp.cacheAvatar({ ...f.input(f.b), operation: "set", image: null }), 401);
  f.store.close();
});
