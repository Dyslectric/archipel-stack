import { grant } from "./roles.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Store, Problem } from "../src/store.js";
import { Xmpp } from "../src/xmpp.js";
import { Federation } from "../src/federation.js";
import { loadConfig } from "../src/config.js";

const all = { federation_send: true, federation_receive: true, federation_subscribe: true, federation_post: true };
const none = { federation_send: false, federation_receive: false, federation_subscribe: false, federation_post: false };
const peer = "other@remote.example", stream = `${peer}/phone`;
function fixture() {
  const store = new Store(":memory:");
  const config = loadConfig({ DEV_AUTH: "true", XMPP_DOMAIN: "chat.example", XMPP_BRIDGE_SECRET: "s".repeat(43) });
  const xmpp = new Xmpp(store, config), fed = new Federation(store, config);
  const alice = store.loginIdentity("urn:archipel:development", "alice", "alice", [], true);
  const bob = store.loginIdentity("urn:archipel:development", "bob", "bob", []);
  fed.setEnabled(alice, true);
  grant(fed.store, alice, alice.id, all);
  const a = xmpp.issue(alice, "Desktop"), b = xmpp.issue(bob, "Phone");
  const plaza = store.createChannel(alice, { name: "plaza", mode: "timeline", visibility: "public", admission: "open" });
  fed.setChannel(alice, plaza.id, true);
  const room = `plaza@${xmpp.rooms}`;
  const from = (operation: string, extra = {}) => ({ operation, from: stream, to: room, s2s: true, stream: "s2s-1", ...extra });
  const remote = () => store.db.prepare("SELECT id FROM users WHERE remote_actor=?").get(`xmpp:${peer}`) as { id: string } | undefined;
  const sync = (extra: { jid: string; room: string }[] = []) => xmpp.sync({ after: 0,
    sessions: [{ jid: `${a.jid}/test`, credential: a.id }, { jid: `${b.jid}/test`, credential: b.id }],
    occupants: [{ jid: stream, room }, ...extra] });
  return { store, config, xmpp, fed, alice, bob, a, b, plaza, room, from, remote, sync };
}
function denied(fn: () => unknown, status = 403) {
  assert.throws(fn, e => e instanceof Problem && e.status === status);
}

test("foreign occupants are admitted only over s2s into federated public rooms that current policy allows", () => {
  const f = fixture();
  denied(() => f.xmpp.operation({ ...f.from("join"), s2s: undefined }));
  assert.equal(f.remote(), undefined);

  const local = f.store.createChannel(f.alice, { name: "local", mode: "timeline", visibility: "public", admission: "open" });
  denied(() => f.xmpp.operation(f.from("join", { to: `local@${f.xmpp.rooms}` })));
  const members = f.store.createChannel(f.alice, { name: "members", mode: "timeline", visibility: "members", admission: "open" });
  f.fed.setChannel(f.alice, members.id, true);
  denied(() => f.xmpp.operation(f.from("join", { to: `members@${f.xmpp.rooms}` })));
  const invite = f.store.createChannel(f.alice, { name: "invite", mode: "timeline", visibility: "public", admission: "allowlist" });
  f.fed.setChannel(f.alice, invite.id, true);
  denied(() => f.xmpp.operation(f.from("join", { to: `invite@${f.xmpp.rooms}` })));
  denied(() => f.xmpp.operation(f.from("read", { to: `invite@${f.xmpp.rooms}` })));
  assert.equal(f.remote(), undefined, "A refused join must not leave an identity behind");
  assert.equal(local.role, "owner");

  f.fed.setEnabled(f.alice, false);
  denied(() => f.xmpp.operation(f.from("join")));
  f.fed.setEnabled(f.alice, true);
  f.fed.block(f.alice, { kind: "instance", target: "https://remote.example", blocked: true });
  denied(() => f.xmpp.operation(f.from("join")));
  denied(() => f.xmpp.operation(f.from("read")));
  f.fed.block(f.alice, { kind: "instance", target: "https://remote.example", blocked: false });

  // What the room is goes with the answer, so the adapter can describe a room nobody is in yet.
  assert.deepEqual(f.xmpp.operation(f.from("read")), { valid: true, name: "plaza", description: f.plaza.description });
  const joined = f.xmpp.operation(f.from("join")) as { name: string; history: unknown[] };
  assert.equal(joined.name, "plaza");
  assert.deepEqual(joined.history, []);
  const user = f.store.user(f.remote()!.id);
  assert.equal(user.remote_actor, `xmpp:${peer}`);
  assert.equal(user.username, peer);
  assert.equal(f.store.role(f.plaza.id, user.id), "member");
  f.xmpp.operation(f.from("join"));
  assert.equal(f.store.details(f.alice, f.plaza.id).members.filter(m => m.actor_url === `xmpp:${peer}`).length, 1);
  // Local-only operations stay closed to a foreign sender.
  for (const operation of ["check", "rooms", "direct-unknown", "remote-room-check", "avatar-hash"]) denied(() => f.xmpp.operation(f.from(operation)));
  denied(() => f.xmpp.operation(f.from("archive")));
  // An invitation rule admits a known identity to an invitation-only federated room.
  f.store.setMember(f.alice, invite.id, user.id, { rule: "allow" });
  f.xmpp.operation(f.from("join", { to: `invite@${f.xmpp.rooms}` }));
  assert.equal(f.store.role(invite.id, user.id), "member");
  denied(() => f.store.setMember(f.alice, invite.id, user.id, { role: "moderator" }), 400);
  f.store.close();
});

test("foreign occupants read bounded join history, live messages and the room archive under author grants and tombstones", () => {
  const f = fixture();
  grant(f.fed.store, f.alice, f.bob.id, all);
  f.store.join(f.bob, f.plaza.id);
  const first = f.store.post(f.alice, f.plaza.id, { body: "First" });
  f.store.post(f.bob, f.plaza.id, { body: "From Bob" });
  const removed = f.store.post(f.alice, f.plaza.id, { body: "Soon removed" });
  f.store.deleteMessage(f.alice, removed.id);
  f.store.post(f.alice, f.plaza.id, { body: "Latest" });
  // An author whose send grant was withdrawn no longer leaves the instance.
  grant(f.fed.store, f.alice, f.bob.id, { ...all, federation_send: false });

  const history = (f.xmpp.operation(f.from("join", { history: 25 })) as { history: { body: string; from: string; to: string; id: string }[] }).history;
  assert.deepEqual(history.map(m => m.body), ["First", "This message was removed.", "Latest"]);
  assert.equal(history[0].from, `${f.room}/alice`);
  assert.equal(history[0].to, stream);
  assert.equal(history[0].id, first.id);
  assert.deepEqual((f.xmpp.operation(f.from("join", { history: 1 })) as { history: { body: string }[] }).history.map(m => m.body), ["Latest"]);
  assert.equal((f.xmpp.operation(f.from("join", { history: 5000 })) as { history: unknown[] }).history.length, 3);
  assert.equal((f.xmpp.operation(f.from("join", { history: 0 })) as { history: unknown[] }).history.length, 0);

  const live = f.sync().messages.filter(m => m.to === stream);
  assert.deepEqual(live.map(m => m.body), ["First", "This message was removed.", "This message was removed.", "Latest"]);
  assert.deepEqual(f.sync().kick, []);
  const archive = f.xmpp.operation(f.from("archive", { room: f.room })) as { messages: { body: string; to: string }[]; count: number };
  assert.equal(archive.count, 3);
  assert.equal(archive.messages[0].to, stream);
  denied(() => f.xmpp.operation(f.from("archive", { room: `missing@${f.xmpp.rooms}` })), 404);
  denied(() => f.xmpp.operation({ ...f.from("archive", { room: f.room }), from: "stranger@remote.example/x" }));
  f.store.close();
});

test("foreign posts are archived with a remote author before distribution, deduplicated and kept out of ActivityPub", () => {
  const f = fixture();
  const post = f.from("post", { id: "m1", body: "Hello from another server", origin_id: "origin-1" });
  denied(() => f.xmpp.operation(post));
  f.xmpp.operation(f.from("join"));
  denied(() => f.xmpp.operation({ ...post, s2s: undefined }));
  // An ActivityPub follower of the same channel must not be sent XMPP-authored content.
  f.store.db.prepare("INSERT INTO federation_follows VALUES(?,?,?,'accepted')").run(f.plaza.id, "https://ap.example/actors/users/1", "https://ap.example/follows/1");
  const saved = f.xmpp.operation(post) as { id: string };
  assert.deepEqual(f.xmpp.operation(post), saved);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE channel_id=?").get(f.plaza.id)!.n, 1);
  denied(() => f.xmpp.operation({ ...post, body: "Different content" }), 409);
  denied(() => f.xmpp.operation({ ...post, id: "m2", replace: "m1", body: "Corrected" }), 400);
  denied(() => f.xmpp.operation({ ...post, id: "m3", body: "" }), 400);

  const view = f.store.messages(f.alice, f.plaza.id)[0];
  assert.equal(view.body, "Hello from another server");
  assert.equal(view.username, peer);
  assert.equal(view.author_actor_url, `xmpp:${peer}`);
  assert.equal(view.author_id, f.remote()!.id);
  assert.equal(f.store.overview(f.alice).unread[f.plaza.id], 1);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM federation_outgoing").get()!.n, 0);

  const delivered = f.sync([{ jid: `${f.a.jid}/test`, room: f.room }]).messages;
  assert.equal(delivered.length, 2);
  for (const message of delivered) {
    assert.equal(message.from, `${f.room}/${peer}`);
    assert.equal(message.id, saved.id);
    assert.equal(message.stanza_id, "m1");
    assert.equal(message.origin_id, "origin-1");
  }
  // Moderators remove foreign messages; the tombstone reaches every occupant and no ActivityPub relay is queued.
  f.store.deleteMessage(f.alice, saved.id);
  const tombstones = f.sync([{ jid: `${f.a.jid}/test`, room: f.room }]).messages.filter(m => m.replace);
  assert.deepEqual(tombstones.map(m => [m.to, m.body, m.replace]), [[stream, "This message was removed.", "m1"], [`${f.a.jid}/test`, "This message was removed.", "m1"]]);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM federation_outgoing").get()!.n, 0);
  f.store.close();
});

test("personal blocks and receive grants hide foreign authors from local readers", () => {
  const f = fixture();
  f.store.join(f.bob, f.plaza.id);
  f.xmpp.operation(f.from("join"));
  f.xmpp.operation(f.from("post", { id: "m1", body: "Visible to grantees" }));
  const bobRoom = [{ jid: `${f.b.jid}/test`, room: f.room }];
  // Bob has no receive grant: neither the browser, live delivery nor the archive show foreign authors.
  assert.equal(f.store.messages(f.bob, f.plaza.id).length, 0);
  assert.equal(f.store.overview(f.bob).unread[f.plaza.id], undefined);
  assert.equal(f.store.inbox(f.bob).length, 0);
  assert.equal(f.sync(bobRoom).messages.filter(m => m.to === `${f.b.jid}/test`).length, 0);
  assert.equal((f.xmpp.archive(f.bob, { room: f.room }) as { count: number }).count, 0);
  grant(f.fed.store, f.alice, f.bob.id, { ...none, federation_receive: true });
  assert.equal(f.store.messages(f.bob, f.plaza.id)[0].body, "Visible to grantees");
  assert.equal(f.store.overview(f.bob).unread[f.plaza.id], 1);
  assert.equal(f.sync(bobRoom).messages.find(m => m.to === `${f.b.jid}/test`)!.body, "Visible to grantees");
  assert.equal((f.xmpp.archive(f.store.user(f.bob.id), { room: f.room }) as { count: number }).count, 1);
  // A personal block redacts the foreign author exactly like a local one.
  f.store.setUserBlock(f.bob, `xmpp:${peer}`, true);
  assert.match(f.store.messages(f.bob, f.plaza.id)[0].body, /hidden because you blocked/);
  assert.equal(f.store.overview(f.bob).unread[f.plaza.id], undefined);
  assert.match(f.sync(bobRoom).messages.find(m => m.to === `${f.b.jid}/test`)!.body, /hidden because you blocked/);
  assert.match((f.xmpp.archive(f.store.user(f.bob.id), { room: f.room }) as { messages: { body: string }[] }).messages[0].body, /hidden because you blocked/);
  assert.equal(f.sync().messages.find(m => m.to === stream)!.body, "Visible to grantees");
  f.store.close();
});

test("policy changes evict foreign occupants instead of treating them as sessionless local accounts", () => {
  const f = fixture();
  const kicked = () => f.sync().kick;
  const evicted = [{ room: f.room, jid: stream }];
  assert.deepEqual(kicked(), evicted, "An occupant Archipel Server never admitted is evicted");
  f.xmpp.operation(f.from("join"));
  const id = f.remote()!.id;
  assert.deepEqual(kicked(), []);
  assert.deepEqual(f.sync().disconnect, []);

  f.store.setMember(f.alice, f.plaza.id, id, { remove: true });
  assert.deepEqual(kicked(), evicted);
  denied(() => f.xmpp.operation(f.from("post", { id: "removed", body: "No longer a member" })));
  denied(() => f.xmpp.operation(f.from("archive", { room: f.room })));
  f.xmpp.operation(f.from("join"));
  assert.deepEqual(kicked(), []);

  f.store.setMember(f.alice, f.plaza.id, id, { rule: "block" });
  assert.deepEqual(kicked(), evicted);
  denied(() => f.xmpp.operation(f.from("join")));
  denied(() => f.xmpp.operation(f.from("read")));
  f.store.setMember(f.alice, f.plaza.id, id, { rule: "clear" });
  f.xmpp.operation(f.from("join"));

  f.store.ban(f.alice, id, true);
  assert.deepEqual(kicked(), evicted);
  denied(() => f.xmpp.operation(f.from("join")));
  f.store.ban(f.alice, id, false);

  f.fed.block(f.alice, { kind: "instance", target: "https://remote.example", blocked: true });
  assert.deepEqual(kicked(), evicted);
  denied(() => f.xmpp.operation(f.from("post", { id: "blocked", body: "Blocked domain" })));
  f.fed.block(f.alice, { kind: "instance", target: "https://remote.example", blocked: false });

  f.fed.setChannel(f.alice, f.plaza.id, false);
  assert.deepEqual(kicked(), evicted);
  f.fed.setChannel(f.alice, f.plaza.id, true);

  f.fed.setEnabled(f.alice, false);
  assert.deepEqual(kicked(), evicted);
  denied(() => f.xmpp.operation(f.from("post", { id: "disabled", body: "Federation off" })));
  f.fed.setEnabled(f.alice, true);
  assert.deepEqual(kicked(), []);
  assert.ok(f.xmpp.operation(f.from("post", { id: "restored", body: "Access restored" })));
  f.store.close();
});
