import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store, Problem } from "../src/store.js";
import { loadConfig } from "../src/config.js";
import { sqliteOnly } from "./sqlite-only.js";

function fixture() {
  const store = new Store(":memory:");
  const alice = store.loginIdentity("https://id.example", "alice", "alice", []);
  const bob = store.loginIdentity("https://id.example", "bob", "bob", []);
  const charlie = store.loginIdentity(
    "https://id.example",
    "charlie",
    "charlie",
    [],
  );
  return { store, alice, bob, charlie };
}
const denied = (fn: () => unknown, status = 403) =>
  assert.throws(
    fn,
    (error: unknown) => error instanceof Problem && error.status === status,
  );
const channelInput = (extra = {}) => ({
  name: "general",
  description: "The community",
  mode: "timeline",
  visibility: "public",
  admission: "open",
  ...extra,
});

test("OIDC identity uses issuer and subject; matching names never link accounts", () => {
  const { store, alice } = fixture();
  const again = store.loginIdentity(
    "https://id.example",
    "alice",
    "renamed",
    [],
  );
  assert.equal(again.id, alice.id);
  assert.equal(again.username, "alice");
  const different = store.loginIdentity(
    "https://other.example",
    "alice",
    "alice",
    [],
  );
  assert.notEqual(different.id, alice.id);
  assert.notEqual(different.username, alice.username);
  store.close();
});
test("public viewing does not grant posting; joining does", () => {
  const { store, alice, bob } = fixture();
  const c = store.createChannel(alice, channelInput());
  assert.deepEqual(store.messages(bob, c.id), []);
  denied(() => store.post(bob, c.id, { body: "Unjoined" }));
  store.join(bob, c.id);
  store.join(bob, c.id);
  const m = store.post(bob, c.id, { body: "Hello" });
  assert.equal(store.messages(alice, c.id)[0].id, m.id);
  store.close();
});
test("restricted channels protect details and history; admission alone is not membership", () => {
  const { store, alice, bob } = fixture();
  const c = store.createChannel(
    alice,
    channelInput({ visibility: "members", admission: "allowlist" }),
  );
  assert.deepEqual(store.listChannels(bob), []);
  denied(() => store.join(bob, c.id));
  denied(() => store.details(bob, c.id));
  denied(() => store.messages(bob, c.id));
  store.setMember(alice, c.id, bob.id, { rule: "allow" });
  assert.equal(store.listChannels(bob)[0].can_join, true);
  denied(() => store.messages(bob, c.id));
  store.join(bob, c.id);
  store.post(bob, c.id, { body: "Members only" });
  assert.equal(store.messages(alice, c.id).length, 1);
  store.close();
});
test("a block removes membership and overrides an allowlist and public access", () => {
  const { store, alice, bob } = fixture();
  const c = store.createChannel(alice, channelInput());
  store.join(bob, c.id);
  store.setMember(alice, c.id, bob.id, { rule: "block" });
  assert.equal(store.role(c.id, bob.id), null);
  assert.equal(store.listChannels(bob).length, 0);
  denied(() => store.join(bob, c.id));
  denied(() => store.messages(bob, c.id));
  denied(() => store.post(bob, c.id, { body: "Blocked" }));
  store.close();
});
test("moderators manage members but cannot change ownership or appoint moderators", () => {
  const { store, alice, bob, charlie } = fixture();
  const c = store.createChannel(alice, channelInput());
  store.join(bob, c.id);
  store.join(charlie, c.id);
  store.setMember(alice, c.id, bob.id, { role: "moderator" });
  denied(() => store.setMember(bob, c.id, alice.id, { remove: true }));
  denied(() => store.setMember(bob, c.id, bob.id, { role: "owner" }));
  denied(() => store.setMember(bob, c.id, charlie.id, { role: "moderator" }));
  store.setMember(bob, c.id, charlie.id, { rule: "block" });
  denied(() => store.join(charlie, c.id));
  denied(() => store.leave(alice, c.id), 409);
  store.close();
});
test("invalid compound membership changes leave policy unchanged", () => {
  const { store, alice, bob } = fixture();
  const c = store.createChannel(alice, channelInput());
  denied(
    () =>
      store.setMember(alice, c.id, bob.id, {
        rule: "allow",
        role: "moderator",
      }),
    409,
  );
  assert.equal(store.rule(c.id, bob.id), null);
  store.close();
});
test("a channel's roles let members remove, ban and delete without being moderators", () => {
  const { store, alice, bob, charlie } = fixture();
  const dana = store.loginIdentity("https://id.example", "dana", "dana", []);
  const c = store.createChannel(alice, channelInput({ show_members: false }));
  for (const u of [bob, charlie, dana]) store.join(u, c.id);
  const mine = (u: typeof bob) => store.listChannels(u).find((l) => l.id === c.id)!;
  denied(() => store.createChannelRole(bob, c.id, { name: "Helper" }));
  const helper = store.createChannelRole(alice, c.id, {
    name: "Helper",
    kick_members: true,
    delete_messages: true,
  });
  assert.deepEqual(
    [helper.kick_members, helper.ban_members, helper.ban_instances, helper.delete_messages, helper.members],
    [true, false, false, true, 0],
  );
  denied(() => store.createChannelRole(alice, c.id, { name: "helper" }), 409);
  denied(() => store.createChannelRole(alice, c.id, { name: "Odd", kick_members: "yes" }), 400);
  denied(() => store.createChannelRole(alice, c.id, { name: "Odd", admin: true }), 400);
  denied(() => store.setMember(bob, c.id, bob.id, { channel_role: helper.id }));
  denied(() => store.setMember(alice, c.id, bob.id, { channel_role: "missing" }), 404);
  assert.equal(mine(bob).sees_members, false);
  store.setMember(alice, c.id, bob.id, { channel_role: helper.id });
  assert.deepEqual(mine(bob).channel_role, { id: helper.id, name: "Helper" });
  assert.deepEqual(mine(bob).permissions, {
    allow_access: false,
    kick_members: true,
    ban_members: false,
    ban_instances: false,
    delete_messages: true,
  });
  assert.equal(mine(alice).permissions.ban_instances, true);
  assert.equal(mine(charlie).permissions.kick_members, false);
  // Whoever may remove members sees who they are, and which of them hold a role.
  assert.equal(mine(bob).sees_members, true);
  assert.deepEqual(
    store.details(bob, c.id).members.find((u) => u.id === bob.id)!.channel_role,
    { id: helper.id, name: "Helper" },
  );
  assert.equal(store.channelRoles(alice, c.id)[0].members, 1);
  denied(() => store.channelRoles(bob, c.id));
  const spam = store.post(charlie, c.id, { body: "Spam" });
  denied(() => store.deleteMessage(dana, spam.id));
  store.deleteMessage(bob, spam.id);
  assert.ok(store.message(spam.id).deleted_at);
  // The role allows removing, and nothing a moderator does besides.
  denied(() => store.setMember(bob, c.id, charlie.id, { rule: "block" }));
  denied(() => store.setMember(bob, c.id, charlie.id, { rule: "allow" }));
  denied(() => store.setMember(bob, c.id, charlie.id, { remove: true, see_members: true }));
  denied(() => store.setMember(bob, c.id, alice.id, { remove: true }));
  denied(() => store.rules(bob, c.id));
  store.setMember(bob, c.id, charlie.id, { remove: true });
  assert.equal(store.role(c.id, charlie.id), null);
  store.join(charlie, c.id);
  // Role holders do not reach each other, or moderators.
  store.setMember(alice, c.id, dana.id, { channel_role: helper.id });
  denied(() => store.setMember(bob, c.id, dana.id, { remove: true }));
  store.setMember(alice, c.id, dana.id, { role: "moderator" });
  assert.equal(store.channelRoles(alice, c.id)[0].members, 1);
  denied(() => store.setMember(bob, c.id, dana.id, { remove: true }));
  denied(() => store.setMember(alice, c.id, dana.id, { channel_role: helper.id }), 409);
  store.setMember(dana, c.id, bob.id, { remove: true });
  store.join(bob, c.id);
  assert.equal(store.channelRole(c.id, bob.id), undefined);
  store.setMember(alice, c.id, bob.id, { channel_role: helper.id });
  // Banning is its own grant, and lifting a ban goes with it.
  store.updateChannelRole(alice, c.id, helper.id, { kick_members: false, ban_members: true });
  denied(() => store.setMember(bob, c.id, charlie.id, { remove: true }));
  store.setMember(bob, c.id, charlie.id, { rule: "block" });
  denied(() => store.join(charlie, c.id));
  store.setMember(alice, c.id, dana.id, { rule: "allow" });
  assert.deepEqual(store.rules(bob, c.id).map((r) => r.rule), ["block"]);
  assert.equal(store.rules(alice, c.id).length, 2);
  denied(() => store.setMember(bob, c.id, dana.id, { rule: "clear" }));
  store.setMember(bob, c.id, charlie.id, { rule: "clear" });
  store.join(charlie, c.id);
  // Without the role, or once it is deleted, they are a member like any other.
  const other = store.post(charlie, c.id, { body: "Kept" });
  store.setMember(alice, c.id, bob.id, { channel_role: null });
  denied(() => store.deleteMessage(bob, other.id));
  store.setMember(alice, c.id, bob.id, { channel_role: helper.id });
  store.deleteChannelRole(alice, c.id, helper.id);
  denied(() => store.deleteMessage(bob, other.id));
  assert.equal(mine(bob).channel_role, null);
  const again = store.createChannelRole(alice, c.id, { name: "Helper" });
  // Someone following from another instance holds a role too, but does not moderate, and loses it with the follow.
  const far = "https://far.example/actors/users/erin";
  store.db.prepare("INSERT INTO users(id,username,display_name,created_at,remote_actor) VALUES(?,?,?,?,?)").run("erin", "erin@far.example", "Erin", new Date().toISOString(), far);
  denied(() => store.setMember(alice, c.id, "erin", { channel_role: again.id }), 409);
  store.db.prepare("INSERT INTO federation_follows VALUES(?,?,?,'accepted')").run(c.id, far, "https://far.example/follows/1");
  store.setMember(alice, c.id, "erin", { channel_role: again.id });
  assert.equal(store.channelRole(c.id, "erin")?.id, again.id);
  assert.equal(store.channelRoles(alice, c.id)[0].members, 1);
  assert.deepEqual(store.details(alice, c.id).members.find((u) => u.id === "erin")!.channel_role, { id: again.id, name: "Helper" });
  denied(() => store.setMember(alice, c.id, "erin", { role: "moderator" }), 409);
  store.followEnded(c.id, far);
  assert.equal(store.channelRole(c.id, "erin"), undefined);
  assert.equal(store.channelRoles(alice, c.id)[0].members, 0);
  store.db.prepare("DELETE FROM federation_follows WHERE channel_id=?").run(c.id);
  // A role held in a channel followed from here is offered as its home told it, short of banning
  // instances. Nothing is applied here, and it ends with the membership.
  store.db
    .prepare("INSERT INTO channels(id,name,description,mode,visibility,admission,owner_id,created_at,remote_actor,federation_enabled) VALUES('away','away@far.example','','timeline','members','allowlist','erin',?,'https://far.example/actors/channels/away',1)")
    .run(new Date().toISOString());
  const away = store.channel("away");
  store.keepHeldRole("away", bob.id, { name: "Helper", permissions: ["kick_members", "ban_instances"] });
  assert.equal(store.heldRole("away", bob.id), undefined);
  store.db.prepare("INSERT INTO memberships VALUES('away',?,'member')").run(bob.id);
  assert.deepEqual(store.channelInfo(bob, away).channel_role, { id: "", name: "Helper" });
  assert.deepEqual(store.channelInfo(bob, away).permissions, { allow_access: false, kick_members: true, ban_members: false, ban_instances: false, delete_messages: false });
  assert.equal(store.channelCan(charlie, away, "kick_members"), false);
  denied(() => store.setMember(bob, "away", "erin", { remove: true }));
  denied(() => store.instanceBans(bob, "away"));
  store.keepHeldRole("away", bob.id, null);
  assert.equal(store.channelCan(bob, away, "kick_members"), false);
  store.db.prepare("DELETE FROM memberships WHERE channel_id='away'").run();
  store.db.prepare("DELETE FROM channels WHERE id='away'").run();
  store.deleteChannel(alice, c.id);
  store.close();
});
test("a channel bans instances and XMPP servers by address, for those its roles allow", () => {
  const { store, alice, bob } = fixture();
  const c = store.createChannel(alice, channelInput());
  store.join(bob, c.id);
  const ban = (who: typeof bob, instance: unknown, banned: unknown = true) =>
    store.banInstance(who, c.id, { instance, banned }).map((b) => b.instance);
  denied(() => ban(bob, "spam.example"));
  denied(() => store.instanceBans(bob, c.id));
  const role = store.createChannelRole(alice, c.id, { name: "Gatekeeper", ban_instances: true });
  store.setMember(alice, c.id, bob.id, { channel_role: role.id });
  assert.deepEqual(ban(bob, " Spam.Example "), ["https://spam.example"]);
  assert.deepEqual(ban(bob, "https://spam.example/actors/users/1"), ["https://spam.example"]);
  assert.deepEqual(ban(alice, "xmpp:eve@Chat.Spam.Example"), ["https://spam.example", "xmpp:chat.spam.example"]);
  assert.equal(store.instanceBanned(c.id, "https://spam.example/actors/users/2"), true);
  assert.equal(store.instanceBanned(c.id, "https://fine.example/actors/users/2"), false);
  assert.equal(store.instanceBanned(c.id, "xmpp:mallory@chat.spam.example"), true);
  assert.equal(store.instanceBanned(c.id, "xmpp:mallory@spam.example"), false);
  denied(() => ban(alice, store.baseUrl), 400);
  denied(() => ban(alice, "not an address"), 400);
  denied(() => ban(alice, "spam.example", "yes"), 400);
  assert.deepEqual(ban(bob, "spam.example", false), ["xmpp:chat.spam.example"]);
  assert.equal(store.instanceBanned(c.id, "https://spam.example/actors/users/2"), false);
  store.close();
});
test("topical messages require same-channel topics and same-topic parents", () => {
  const { store, alice } = fixture();
  const c = store.createChannel(alice, channelInput({ mode: "topical" }));
  const other = store.createChannel(
    alice,
    channelInput({ name: "another", mode: "topical" }),
  );
  const t1 = store.createTopic(alice, c.id, "Planning"),
    t2 = store.createTopic(alice, c.id, "Build");
  const foreign = store.createTopic(alice, other.id, "Elsewhere");
  denied(() => store.post(alice, c.id, { body: "No topic" }), 400);
  denied(
    () =>
      store.post(alice, c.id, { body: "Wrong topic", topic_id: foreign.id }),
    400,
  );
  const root = store.post(alice, c.id, { body: "Plan", topic_id: t1.id });
  denied(
    () =>
      store.post(alice, c.id, {
        body: "Cross topic",
        topic_id: t2.id,
        parent_id: root.id,
      }),
    400,
  );
  assert.equal(
    store.post(alice, c.id, {
      body: "Same topic",
      topic_id: t1.id,
      parent_id: root.id,
    }).parent_id,
    root.id,
  );
  store.close();
});
test("timeline messages can reply to a message in their channel", () => {
  const { store, alice } = fixture();
  const c = store.createChannel(alice, channelInput());
  const other = store.createChannel(alice, channelInput({ name: "another" }));
  const first = store.post(alice, c.id, { body: "A question" });
  assert.equal(
    store.post(alice, c.id, { body: "An answer", parent_id: first.id }).parent_id,
    first.id,
  );
  denied(() => store.post(alice, other.id, { body: "Elsewhere", parent_id: first.id }), 400);
  denied(() => store.post(alice, c.id, { body: "Titled", title: "No" }), 400);
  store.close();
});
test("a channel can keep its member list and handles to its moderators and those they allow", () => {
  const { store, alice, bob } = fixture();
  const c = store.createChannel(alice, channelInput());
  store.join(bob, c.id);
  store.post(alice, c.id, { body: "From the owner" });
  store.post(bob, c.id, { body: "From a member" });
  assert.equal(store.details(bob, c.id).members.length, 2);
  assert.equal(store.messages(bob, c.id)[0].username, "alice");
  // Only the owner decides; the choices are booleans.
  denied(() => store.setPrivacy(bob, c.id, { show_members: false }));
  denied(() => store.setPrivacy(alice, c.id, { show_members: "no" }), 400);
  const set = store.setPrivacy(alice, c.id, { show_members: false, hide_handles: true });
  assert.deepEqual([set.show_members, set.hide_handles, set.sees_members, set.sees_handles], [0, 1, true, true]);
  // A member is shown nobody, and names without handles, except their own.
  let seen = store.details(bob, c.id);
  assert.deepEqual([seen.sees_members, seen.sees_handles, seen.members.length], [false, false, 0]);
  let [first, second] = store.messages(bob, c.id);
  assert.deepEqual([first.username, first.author_actor_url, first.display_name], ["", null, "alice"]);
  assert.equal(second.username, "bob");
  assert.equal(store.inbox(bob).find((m) => m.kind === "channel")?.username, "");
  // The owner still sees everyone, with handles.
  assert.deepEqual(store.details(alice, c.id).members.map((m) => m.username), ["alice", "bob"]);
  assert.equal(store.messages(alice, c.id)[1].username, "bob");
  // Each can be allowed on its own, by those who manage the channel.
  denied(() => store.setMember(bob, c.id, bob.id, { see_members: true }));
  denied(() => store.setMember(alice, c.id, bob.id, { see_members: "yes" }), 400);
  store.setMember(alice, c.id, bob.id, { see_members: true });
  seen = store.details(bob, c.id);
  assert.deepEqual([seen.sees_members, seen.sees_handles], [true, false]);
  assert.deepEqual(seen.members.map((m) => [m.username, m.actor_url === null]), [["", true], ["bob", false]]);
  store.setMember(alice, c.id, bob.id, { see_handles: true });
  assert.deepEqual(store.details(bob, c.id).members.map((m) => m.username), ["alice", "bob"]);
  assert.equal(store.messages(bob, c.id)[0].username, "alice");
  assert.equal(store.details(alice, c.id).members[1].see_handles, true);
  store.setMember(alice, c.id, bob.id, { see_members: false });
  assert.equal(store.details(bob, c.id).members.length, 0);
  // What was allowed ends with the membership.
  store.leave(bob, c.id);
  store.join(bob, c.id);
  [first] = store.messages(bob, c.id);
  assert.equal(first.username, "");
  store.setPrivacy(alice, c.id, { show_members: true, hide_handles: false });
  assert.equal(store.details(bob, c.id).members.length, 2);
  store.deleteChannel(alice, c.id);
  // A channel can start that way.
  const quiet = store.createChannel(alice, channelInput({ name: "quiet", show_members: false, hide_handles: true }));
  assert.deepEqual([quiet.show_members, quiet.hide_handles], [0, 1]);
  denied(() => store.createChannel(alice, channelInput({ name: "wrong", hide_handles: "yes" })), 400);
  store.close();
});
test("threads retain nested structure after deletion and reject cross-channel parents", () => {
  const { store, alice, bob } = fixture();
  const c = store.createChannel(alice, channelInput({ mode: "threaded" }));
  const other = store.createChannel(
    alice,
    channelInput({ name: "elsewhere", mode: "threaded" }),
  );
  denied(() => store.post(alice, c.id, { body: "Untitled root" }), 400);
  const root = store.post(alice, c.id, { title: "A thread", body: "Welcome" });
  const reply = store.post(alice, c.id, {
    body: "A reply",
    parent_id: root.id,
  });
  const nested = store.post(alice, c.id, {
    body: "Nested",
    parent_id: reply.id,
  });
  denied(
    () =>
      store.post(alice, other.id, {
        body: "Foreign parent",
        parent_id: root.id,
      }),
    400,
  );
  denied(() => store.deleteMessage(bob, root.id));
  store.deleteMessage(alice, root.id);
  assert.equal(store.message(root.id).body, "");
  assert.equal(store.message(reply.id).parent_id, root.id);
  assert.equal(store.message(nested.id).parent_id, reply.id);
  assert.equal(store.messages(alice, c.id).length, 3);
  store.close();
});
test("social disclosure defaults off and withdrawn claims disappear on next login", () => {
  const { store, alice } = fixture();
  const withSocial = store.loginIdentity(
    "https://id.example",
    "alice",
    "alice",
    [{ handle: "@alice@social.example" }],
  );
  assert.deepEqual(store.profile(withSocial).verified_socials, []);
  assert.equal(store.profile(withSocial, true).verified_socials.length, 1);
  store.updateProfile(alice, { display_name: "Alice", share_socials: true });
  assert.equal(store.profile(store.user(alice.id)).verified_socials.length, 1);
  store.loginIdentity("https://id.example", "alice", "alice", []);
  assert.deepEqual(store.profile(store.user(alice.id)).verified_socials, []);
  store.close();
});
test("administrators inspect restricted chats, audit removals, and revoke suspended sessions", () => {
  const { store, alice, bob } = fixture();
  const admin = store.loginIdentity(
    "https://id.example",
    "admin",
    "admin",
    [],
    true,
  );
  const c = store.createChannel(
    alice,
    channelInput({ visibility: "members", admission: "allowlist" }),
  );
  const m = store.post(alice, c.id, { body: "Inspect me" });
  assert.equal(store.messages(admin, c.id).length, 1);
  store.deleteMessage(admin, m.id);
  const session = store.createSession(bob.id);
  denied(() => store.ban(alice, bob.id, true));
  store.ban(admin, bob.id, true);
  assert.equal(store.session(session.token), null);
  denied(() => store.createSession(bob.id));
  assert.equal(
    store.db
      .prepare(
        "SELECT COUNT(*) AS n FROM audit WHERE action IN ('message.delete','user.ban')",
      )
      .get()?.n,
    2,
  );
  store.close();
});
test("database restart preserves identities, membership, messages and sessions", () => {
  const directory = mkdtempSync(join(tmpdir(), "archipel-test-")),
    path = join(directory, "db.sqlite");
  let store = new Store(path);
  const user = store.loginIdentity("https://id.example", "alice", "alice", []);
  const c = store.createChannel(user, channelInput()),
    m = store.post(user, c.id, { body: "Survives restart" });
  const session = store.createSession(user.id);
  store.close();
  store = new Store(path);
  assert.equal(store.session(session.token)?.user.id, user.id);
  assert.equal(store.role(c.id, user.id), "owner");
  assert.equal(store.messages(store.user(user.id), c.id)[0].id, m.id);
  store.close();
  rmSync(directory, { recursive: true });
});

test("live session metadata renews only when due and never caches account suspension", t => {
  const {store,bob}=fixture();t.after(()=>store.close());
  const issued=store.createSession(bob.id),fresh=store.session(issued.token)!;
  assert.equal(fresh.csrf,issued.csrf);assert.equal(fresh.user.id,bob.id);
  assert.equal(store.renewSession(issued.token,fresh.expiresAt),false);
  store.db.prepare("UPDATE sessions SET expires_at=? WHERE user_id=?").run(Date.now()+3600000,bob.id);
  const due=store.session(issued.token)!;
  assert.equal(store.renewSession(issued.token,due.expiresAt),true);
  const renewed=store.session(issued.token)!;
  assert.ok(renewed.expiresAt>Date.now()+6*86400000);
  assert.equal(store.renewSession(issued.token,renewed.expiresAt),false);
  store.db.prepare("UPDATE users SET display_name='Current account' WHERE id=?").run(bob.id);
  assert.equal(store.session(issued.token)!.user.display_name,"Current account");
  store.db.prepare("UPDATE users SET banned=1 WHERE id=?").run(bob.id);
  denied(()=>store.session(issued.token));
  store.db.prepare("UPDATE users SET banned=0 WHERE id=?").run(bob.id);
  store.logout(issued.token);
  assert.equal(store.session(issued.token),null);
  assert.equal(store.renewSession(issued.token,due.expiresAt),false);
});
test("message pages are bounded and cursors preserve chronological order", () => {
  const { store, alice } = fixture();
  const c = store.createChannel(alice, channelInput());
  for (let i = 0; i < 105; i++) store.post(alice, c.id, { body: String(i) });
  const page = store.messages(alice, c.id);
  assert.equal(page.length, 100);
  assert.equal(page[0].body, "5");
  const previous = store.messages(alice, c.id, page[0].seq);
  assert.equal(previous.length, 5);
  assert.equal(previous[4].body, "4");
  store.close();
});
test("development auth cannot be enabled on a public listener or origin", () => {
  assert.throws(() => loadConfig({ DEV_AUTH: "true", HOST: "0.0.0.0" }));
  assert.throws(() =>
    loadConfig({ DEV_AUTH: "true", BASE_URL: "https://chat.example" }),
  );
  assert.throws(() => loadConfig({ BASE_URL: "http://chat.example" }));
  assert.throws(() => loadConfig({ OIDC_ISSUER: "https://id.example" }));
  assert.equal(loadConfig({ DEV_AUTH: "true" }).devAuth, true);
});

test("configuration changes revoke stale administrator grants and development sessions", () => {
  const { store, alice } = fixture();
  const admin = store.loginIdentity(
    "https://id.example",
    "admin",
    "admin",
    [],
    true,
  );
  const dev = store.loginIdentity(
    "urn:archipel:development",
    "alice",
    "dev-alice",
    [],
    true,
  );
  const adminSession = store.createSession(admin.id),
    devSession = store.createSession(dev.id);
  store.applyAuthPolicy("https://id.example", [], false);
  assert.equal(store.session(adminSession.token)?.user.admin, 0);
  assert.equal(store.session(devSession.token), null);
  store.applyAuthPolicy("https://id.example", ["admin"], false);
  assert.equal(store.session(adminSession.token)?.user.admin, 1);
  assert.equal(store.user(alice.id).admin, 0);
  store.close();
});

test("authors edit messages with conflicts checked and replies kept intact", () => {
  const { store, alice, bob } = fixture();
  const c = store.createChannel(alice, channelInput({ mode: "threaded" }));
  store.join(bob, c.id);
  const root = store.post(alice, c.id, {
    body: "Original",
    title: "Original title",
  });
  const reply = store.post(bob, c.id, { body: "Reply", parent_id: root.id });
  denied(() =>
    store.editMessage(bob, root.id, {
      body: "Forged",
      expected_edited_at: null,
    }),
  );
  const updated = store.editMessage(alice, root.id, {
    body: "Fixed :smile:",
    title: "Fixed title",
    expected_edited_at: null,
  });
  assert.equal(updated.body, "Fixed :smile:");
  assert.equal(updated.title, "Fixed title");
  assert.ok(updated.edited_at);
  assert.equal(updated.seq, root.seq);
  assert.equal(updated.created_at, root.created_at);
  assert.equal(store.message(reply.id).parent_id, root.id);
  denied(
    () =>
      store.editMessage(alice, root.id, {
        body: "Stale",
        expected_edited_at: null,
      }),
    409,
  );
  denied(
    () =>
      store.editMessage(alice, root.id, {
        body: "Move",
        channel_id: "elsewhere",
        expected_edited_at: updated.edited_at,
      }),
    400,
  );
  denied(
    () =>
      store.editMessage(bob, reply.id, {
        body: "Reply",
        title: "Invalid",
        expected_edited_at: null,
      }),
    400,
  );
  denied(
    () =>
      store.editMessage(alice, root.id, {
        body: " ",
        expected_edited_at: updated.edited_at,
      }),
    400,
  );
  store.deleteMessage(alice, root.id);
  denied(
    () =>
      store.editMessage(alice, root.id, {
        body: "Resurrect",
        expected_edited_at: updated.edited_at,
      }),
    409,
  );
  store.close();
});

test("invite-only identities have a private persistent review status and fresh provider claims", () => {
  const { store, alice } = fixture();
  const admin = store.loginIdentity(
    "https://id.example",
    "admin",
    "admin",
    [],
    true,
  );
  store.setRegistration(admin, "invite_only");
  const pending = store.loginIdentity(
    "https://id.example",
    "applicant",
    "applicant",
    [{ provider: "mastodon", handle: "@applicant@social.example" }],
  );
  assert.equal(pending.admission_status, "pending");
  assert.equal(store.user(alice.id).admission_status, "approved");
  const session = store.createSession(pending.id);
  assert.equal(store.session(session.token)?.user.id, pending.id);
  denied(() => store.listChannels(pending));
  denied(() => store.directory(pending));
  denied(() => store.createChannel(pending, channelInput()));
  denied(() => store.applications(alice));
  denied(() => store.reviewApplication(alice, pending.id, "approved"));
  assert.equal(
    store.directory(admin).some((u) => u.id === pending.id),
    false,
  );
  assert.equal(store.applications(admin)[0].verified_socials.length, 1);
  assert.deepEqual(store.profile(pending).verified_socials, []);
  store.reviewApplication(admin, pending.id, "rejected");
  assert.equal(
    store.loginIdentity("https://id.example", "applicant", "applicant", [])
      .admission_status,
    "rejected",
  );
  assert.deepEqual(store.applications(admin)[0].verified_socials, []);
  store.setRegistration(admin, "open");
  assert.equal(store.user(pending.id).admission_status, "rejected");
  store.reviewApplication(admin, pending.id, "approved");
  assert.deepEqual(store.listChannels(store.session(session.token)!.user), []);
  assert.deepEqual(store.applications(admin), []);
  assert.equal(store.user(pending.id).share_socials, 0);
  store.close();
});

test("configured administrators bypass pending admission, including on an existing application", () => {
  const store = new Store(":memory:");
  store.initializeRegistration("invite_only");
  const pending = store.loginIdentity(
    "https://id.example",
    "admin",
    "admin",
    [],
  );
  store.applyAuthPolicy("https://id.example", ["admin"], false);
  assert.equal(store.user(pending.id).admission_status, "approved");
  assert.equal(store.user(pending.id).admin, 1);
  const other = store.loginIdentity(
    "https://id.example",
    "other-admin",
    "other",
    [],
    true,
  );
  assert.equal(other.admission_status, "approved");
  store.close();
});

test("version-one databases upgrade without losing membership and persist community settings", sqliteOnly, (t) => {
  const directory = mkdtempSync(join(tmpdir(), "archipel-migration-")),
    path = join(directory, "db.sqlite");
  t.after(() => rmSync(directory, { recursive: true }));
  const legacy = new DatabaseSync(path);
  legacy.exec(
    readFileSync(
      new URL("../migrations/001_initial.sql", import.meta.url),
      "utf8",
    ),
  );
  legacy
    .prepare(
      "INSERT INTO users(id,username,display_name,created_at) VALUES('old','old','Old member',?)",
    )
    .run(new Date().toISOString());
  legacy.close();
  let store = new Store(path);
  assert.equal(store.user("old").admission_status, "approved");
  const admin = store.loginIdentity(
    "https://id.example",
    "admin",
    "admin",
    [],
    true,
  );
  store.setRegistration(admin, "invite_only");
  const pending = store.loginIdentity("https://id.example", "new", "new", []);
  const image =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=";
  const emoji = store.addEmoji(admin, { name: "island", image })!;
  const channel = store.createChannel(admin, channelInput());
  const original = store.post(admin, channel.id, { body: "Original" });
  store.editMessage(admin, original.id, {
    body: "Changed",
    expected_edited_at: null,
  });
  store.close();
  store = new Store(path);
  store.initializeRegistration("open");
  assert.equal(store.registrationMode(), "invite_only");
  assert.equal(store.user(pending.id).admission_status, "pending");
  assert.equal(store.emojiImage(emoji.id).mime, "image/png");
  assert.equal(store.message(original.id).body, "Changed");
  assert.ok(store.message(original.id).edited_at);
  store.close();
});

test("version-two emoji messages keep their image metadata through the federation migration", sqliteOnly, (t) => {
  const directory = mkdtempSync(join(tmpdir(), "archipel-emoji-upgrade-")),
    path = join(directory, "db.sqlite");
  const legacy = new DatabaseSync(path);
  legacy.exec(
    readFileSync(
      new URL("../migrations/001_initial.sql", import.meta.url),
      "utf8",
    ),
  );
  legacy.exec(
    readFileSync(
      new URL("../migrations/002_community.sql", import.meta.url),
      "utf8",
    ),
  );
  legacy.exec(
    "INSERT INTO users(id,username,display_name,created_at) VALUES('author','author','Author','2026-10-07T00:00:00Z'); INSERT INTO channels VALUES('chat','chat','','timeline','public','open','author','2026-10-07T00:00:00Z'); INSERT INTO messages(id,channel_id,author_id,body,created_at) VALUES('message','chat','author','Saved :island:','2026-10-07T00:00:00Z');",
  );
  legacy
    .prepare("INSERT INTO custom_emojis VALUES(?,?,?,?,?,?)")
    .run(
      "island",
      "asset",
      "image/png",
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=",
        "base64",
      ),
      "author",
      "2026-10-07T00:00:00Z",
    );
  legacy.close();
  const store = new Store(path);
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true });
  });
  assert.deepEqual(JSON.parse(store.message("message").emoji_tags), [
    { id: "asset", name: "island", url: "/api/emojis/asset/image" },
  ]);
  assert.equal(store.user("author").federation_send, 0);
  assert.equal(store.db.version(), 29);
});

test("direct messages reach both members, and only the reader's own are news to them", () => {
  const { store, alice, bob, charlie } = fixture();
  const local = (id: string) => `${store.baseUrl}/actors/users/${id}`;
  assert.equal(store.localRecipient("@BOB"), bob.id);
  assert.equal(store.localRecipient(local(bob.id)), bob.id);
  assert.equal(store.localRecipient("bob@elsewhere.example"), null);
  denied(() => store.localRecipient("nobody"), 404);
  denied(() => store.sendDirect(alice, alice.id, "To myself"), 400);
  store.sendDirect(alice, bob.id, "Hello Bob");
  store.sendDirect(bob, alice.id, "Hello Alice");
  assert.deepEqual(
    store.directHistory(bob, local(alice.id)).messages.map((m) => [
      m.username,
      m.body,
    ]),
    [
      ["alice", "Hello Bob"],
      ["bob", "Hello Alice"],
    ],
  );
  assert.deepEqual(store.directHistory(charlie, local(alice.id)).messages, []);
  assert.deepEqual(store.conversations(charlie), []);
  const [conversation] = store.conversations(bob);
  assert.equal(conversation.username, "alice");
  assert.equal(conversation.unread, 1);
  assert.deepEqual(
    store.inbox(bob).map((m) => [m.kind, m.body]),
    [["dm", "Hello Bob"]],
  );
  store.markRead(bob, { target: `dm:${local(alice.id)}` });
  assert.equal(store.conversations(bob)[0].unread, 0);
  assert.deepEqual(store.inbox(bob), []);
  store.close();
});
test("a closed direct conversation stays away until it is reopened or written in again", () => {
  const { store, alice, bob, charlie } = fixture();
  const local = (id: string) => `${store.baseUrl}/actors/users/${id}`;
  store.sendDirect(alice, bob.id, "Hello Bob");
  store.sendDirect(charlie, bob.id, "Hello from Charlie");
  denied(() => store.setDirectClosed(bob, local(alice.id), "yes"), 400);
  denied(() => store.setDirectClosed(charlie, local(alice.id), true), 404);
  assert.deepEqual(store.setDirectClosed(bob, local(alice.id), true), { peer: local(alice.id), closed: true });
  assert.deepEqual(store.conversations(bob).map((c) => c.username), ["charlie"]);
  assert.deepEqual(store.inbox(bob).map((m) => m.body), ["Hello from Charlie"]);
  assert.deepEqual(store.closedConversations(bob).map((c) => c.username), ["alice"]);
  // Only the reader who closed it: the other side still has theirs, and the messages are kept.
  assert.deepEqual(store.conversations(alice).map((c) => c.username), ["bob"]);
  assert.deepEqual(store.closedConversations(alice), []);
  assert.equal(store.directHistory(bob, local(alice.id)).messages.length, 1);
  store.setDirectClosed(bob, local(alice.id), false);
  assert.deepEqual(store.conversations(bob).map((c) => [c.username, c.unread]), [["charlie", 1], ["alice", 1]]);
  assert.deepEqual(store.closedConversations(bob), []);
  store.setDirectClosed(bob, local(alice.id), true);
  store.sendDirect(alice, bob.id, "Are you there?");
  assert.deepEqual(store.conversations(bob).map((c) => c.username), ["alice", "charlie"]);
  assert.deepEqual(store.closedConversations(bob), []);
  store.setDirectClosed(bob, local(alice.id), true);
  store.sendDirect(bob, alice.id, "Here I am");
  assert.equal(store.conversations(bob)[0].username, "alice");
  store.close();
});
test("the inbox holds what was said in joined channels since the reader last looked", () => {
  const { store, alice, bob, charlie } = fixture();
  const c = store.createChannel(alice, channelInput());
  store.post(alice, c.id, { body: "Before Bob joined" });
  store.join(bob, c.id);
  assert.deepEqual(store.overview(bob).unread, {});
  const first = store.post(alice, c.id, { body: "First" });
  store.post(alice, c.id, { body: "Second" });
  store.post(bob, c.id, { body: "Bob's own" });
  assert.deepEqual(store.overview(bob).unread, { [c.id]: 2 });
  assert.deepEqual(store.overview(charlie).unread, {});
  assert.deepEqual(
    store.inbox(bob).map((m) => m.body),
    ["Second", "First"],
  );
  store.markRead(bob, { target: c.id, seq: first.seq });
  assert.deepEqual(
    store.inbox(bob).map((m) => m.body),
    ["Second"],
  );
  denied(() => store.markRead(charlie, { target: c.id }));
  store.post(alice, c.id, { body: "Third" });
  store.markRead(bob, { all: "dms" });
  assert.equal(store.overview(bob).unread[c.id], 2);
  store.markRead(bob, { all: "channels" });
  assert.deepEqual(store.overview(bob).unread, {});
  store.close();
});
test("personal blocks stop direct messages, redact channel content and preserve other readers and replies", () => {
  const { store, alice, bob, charlie } = fixture();
  const peer = `${store.baseUrl}/actors/users/${alice.id}`;
  const bobPeer = `${store.baseUrl}/actors/users/${bob.id}`;
  const c = store.createChannel(alice, channelInput({ mode: "threaded" }));
  store.join(bob, c.id);
  store.join(charlie, c.id);
  const root = store.post(alice, c.id, { body: "Hidden content", title: "Hidden title" });
  const reply = store.post(charlie, c.id, { body: "Visible reply", parent_id: root.id });
  store.sendDirect(alice, bob.id, "Previous direct message");
  store.setUserBlock(bob, peer, true);
  store.setUserBlock(bob, peer, true);
  assert.deepEqual(store.userBlocks(bob), [peer]);
  assert.deepEqual(store.userBlocks(charlie), []);
  denied(() => store.sendDirect(alice, bob.id, "Blocked incoming"));
  denied(() => store.sendDirect(bob, alice.id, "Blocked outgoing"));
  store.sendDirect(alice, charlie.id, "Other people still receive messages");
  const hidden = store.messages(bob, c.id)[0];
  assert.equal(hidden.id, root.id);
  assert.equal(hidden.body, "This message is hidden because you blocked this user.");
  assert.equal(hidden.title, "Hidden thread");
  assert.equal(store.messages(bob, c.id)[1].parent_id, root.id);
  assert.equal(store.messages(charlie, c.id)[0].body, "Hidden content");
  assert.equal(store.message(root.id).body, "Hidden content");
  assert.equal(store.conversations(bob)[0].unread, 0);
  assert.deepEqual(store.overview(bob).unread, { [c.id]: 1 });
  assert.deepEqual(store.inbox(bob).map((m) => m.id), [reply.id]);
  assert.equal(store.directHistory(bob, peer).messages[0].body, "Previous direct message");
  denied(() => store.setUserBlock(bob, bobPeer, true), 400);
  denied(() => store.setUserBlock(bob, peer, "true"), 400);
  store.setUserBlock(bob, peer, false);
  assert.equal(store.messages(bob, c.id)[0].body, "Hidden content");
  assert.equal(store.messages(bob, c.id)[0].title, "Hidden title");
  store.sendDirect(alice, bob.id, "Allowed again");
  store.sendDirect(bob, alice.id, "Reply again");
  store.close();
});

test("personal blocks persist across restarts and upgrade an existing version 4 database", sqliteOnly, (t) => {
  const directory = mkdtempSync(join(tmpdir(), "archipel-blocks-"));
  const path = join(directory, "db.sqlite");
  let store = new Store(path);
  const alice = store.loginIdentity("https://id.example", "alice", "alice", []);
  const bob = store.loginIdentity("https://id.example", "bob", "bob", []);
  store.db.exec("DROP TABLE channel_held_roles; DROP TABLE channel_instance_bans; DROP TABLE channel_member_roles; DROP TABLE channel_roles; DROP TABLE reaction_emojis; ALTER TABLE channels DROP COLUMN reaction_bans; DROP TABLE device_flows; DROP TABLE closed_conversations; ALTER TABLE channels DROP COLUMN optional_titles; DROP TABLE message_reactions; ALTER TABLE channels DROP COLUMN reactions; DROP TABLE channel_roster; DROP TABLE channel_grants; ALTER TABLE channels DROP COLUMN show_members; ALTER TABLE channels DROP COLUMN hide_handles; DROP TABLE push_subscriptions; DROP TABLE conversation_prefs; DROP INDEX messages_parent; DROP TABLE attachments; DROP TABLE user_roles; DROP TABLE roles; DROP TABLE mirror_sources; DROP TABLE channel_mirrors; DROP TABLE channel_bridge_seen; DROP TABLE channel_bridges; DROP TABLE xmpp_remote_messages; DROP TABLE xmpp_remote_rooms; DROP TABLE remote_avatars; DROP TABLE xmpp_avatar_requests; DROP TABLE contact_names; DROP TABLE xmpp_direct_ids; DROP TABLE xmpp_message_ids; DROP TABLE xmpp_incoming; DROP TABLE xmpp_events; DROP TABLE xmpp_credentials; DROP TABLE xmpp_accounts; DROP INDEX direct_messages_xmpp_source; ALTER TABLE direct_messages DROP COLUMN xmpp_source_id; DROP TABLE user_avatars; DROP TABLE user_blocks; PRAGMA user_version=4;");
  store.close();
  store = new Store(path);
  const peer = `${store.baseUrl}/actors/users/${alice.id}`;
  store.setUserBlock(bob, peer, true);
  store.close();
  store = new Store(path);
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  assert.deepEqual(store.userBlocks(bob), [peer]);
  denied(() => store.sendDirect(alice, bob.id, "Still blocked"));
});

test("profile pictures are shared through profiles, messages and DMs and invalid replacements preserve them", () => {
  const { store, alice, bob } = fixture();
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=";
  assert.equal(store.profile(alice).avatar_url, null);
  const uploaded = store.setAvatar(alice, png);
  assert.ok(uploaded.avatar_url);
  assert.equal(store.profile(alice).avatar_url, uploaded.avatar_url);
  assert.equal(store.profile(bob).avatar_url, null);
  const c = store.createChannel(alice, channelInput());
  store.post(alice, c.id, { body: "With picture" });
  assert.equal(store.messages(bob, c.id)[0].avatar_url, uploaded.avatar_url);
  store.sendDirect(alice, bob.id, "With picture privately");
  const peer = `${store.baseUrl}/actors/users/${alice.id}`;
  assert.equal(store.conversations(bob)[0].avatar_url, uploaded.avatar_url);
  assert.equal(store.directHistory(bob, peer).messages[0].avatar_url, uploaded.avatar_url);
  store.updateRole(store.loginIdentity("https://id.example", "admin", "admin", [], true), "member", { list_members: true });
  assert.equal(store.directory(bob).find((u) => u.id === alice.id)?.avatar_url, uploaded.avatar_url);
  assert.equal(store.avatarImage(alice.id).mime, "image/png");
  assert.equal(Buffer.from(store.avatarImage(alice.id).image).toString("base64"), png);
  denied(() => store.setAvatar(alice, Buffer.from('<svg onload="alert(1)"></svg>').toString("base64")), 400);
  denied(() => store.setAvatar(alice, Buffer.alloc(2097153).toString("base64")), 400);
  assert.equal(store.avatarUrl(alice.id), uploaded.avatar_url);
  const replacement = store.setAvatar(alice, png);
  assert.notEqual(replacement.avatar_url, uploaded.avatar_url);
  store.removeAvatar(alice);
  assert.equal(store.avatarUrl(alice.id), null);
  assert.equal(store.messages(bob, c.id)[0].avatar_url, null);
  denied(() => store.avatarImage(alice.id), 404);
  store.close();
});

test("profile picture migration preserves identities and pictures survive restarting", sqliteOnly, (t) => {
  const directory = mkdtempSync(join(tmpdir(), "archipel-avatars-"));
  const path = join(directory, "db.sqlite");
  let store = new Store(path);
  const alice = store.loginIdentity("https://id.example", "alice", "alice", []);
  store.db.exec("DROP TABLE channel_held_roles; DROP TABLE channel_instance_bans; DROP TABLE channel_member_roles; DROP TABLE channel_roles; DROP TABLE reaction_emojis; ALTER TABLE channels DROP COLUMN reaction_bans; DROP TABLE device_flows; DROP TABLE closed_conversations; ALTER TABLE channels DROP COLUMN optional_titles; DROP TABLE message_reactions; ALTER TABLE channels DROP COLUMN reactions; DROP TABLE channel_roster; DROP TABLE channel_grants; ALTER TABLE channels DROP COLUMN show_members; ALTER TABLE channels DROP COLUMN hide_handles; DROP TABLE push_subscriptions; DROP TABLE conversation_prefs; DROP INDEX messages_parent; DROP TABLE attachments; DROP TABLE user_roles; DROP TABLE roles; DROP TABLE mirror_sources; DROP TABLE channel_mirrors; DROP TABLE channel_bridge_seen; DROP TABLE channel_bridges; DROP TABLE xmpp_remote_messages; DROP TABLE xmpp_remote_rooms; DROP TABLE remote_avatars; DROP TABLE xmpp_avatar_requests; DROP TABLE contact_names; DROP TABLE xmpp_direct_ids; DROP TABLE xmpp_message_ids; DROP TABLE xmpp_incoming; DROP TABLE xmpp_events; DROP TABLE xmpp_credentials; DROP TABLE xmpp_accounts; DROP INDEX direct_messages_xmpp_source; ALTER TABLE direct_messages DROP COLUMN xmpp_source_id; DROP TABLE user_avatars; PRAGMA user_version=5;");
  store.close();
  store = new Store(path);
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=";
  const uploaded = store.setAvatar(alice, png);
  store.close();
  store = new Store(path);
  t.after(() => { store.close(); rmSync(directory, { recursive: true }); });
  assert.equal(store.profile(store.user(alice.id)).avatar_url, uploaded.avatar_url);
  assert.equal(Buffer.from(store.avatarImage(alice.id).image).toString("base64"), png);
});

test("a sidebar layout is kept per member and cleaned on the way in", () => {
  const { store, alice, bob } = fixture();
  assert.equal(store.overview(alice).layout, null);
  const saved = store.setLayout(alice, {
    channels: {
      collapsed: true,
      items: ["a", "a", 7],
      groups: [{ id: "g1", name: " Work ", items: ["b"], extra: true }],
    },
    order: ["xmpp", "nowhere", "xmpp"],
    merged: "yes",
  });
  assert.deepEqual(saved, {
    dms: { collapsed: false, items: [], groups: [] },
    channels: {
      collapsed: true,
      items: ["a"],
      groups: [{ id: "g1", name: "Work", collapsed: false, items: ["b"] }],
    },
    xmpp: { collapsed: false, items: [], groups: [] },
    order: ["xmpp", "dms", "channels"],
    merged: false,
  });
  assert.equal(store.setLayout(alice, { ...saved, merged: true }).merged, true);
  store.setLayout(alice, saved);
  assert.deepEqual(store.overview(alice).layout, saved);
  assert.equal(store.overview(bob).layout, null);
  denied(
    () => store.setLayout(alice, { dms: { groups: [{ id: "g", name: "" }] } }),
    400,
  );
  store.close();
});

test("version 9 avatar migration preserves pictures and XMPP cursors and remote caches survive restart", sqliteOnly, t => {
  const directory = mkdtempSync(join(tmpdir(), "archipel-remote-avatars-"));
  const path = join(directory, "db.sqlite");
  let store = new Store(path);
  const alice = store.loginIdentity("https://id.example", "alice", "alice", []);
  const image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=";
  store.setAvatar(alice, image);
  store.db.prepare("INSERT INTO xmpp_events(seq,kind,object_id) VALUES(50,'Direct','old-message')").run();
  store.db.exec("DROP TABLE channel_held_roles; DROP TABLE channel_instance_bans; DROP TABLE channel_member_roles; DROP TABLE channel_roles; DROP TABLE reaction_emojis; ALTER TABLE channels DROP COLUMN reaction_bans; DROP TABLE device_flows; DROP TABLE closed_conversations; ALTER TABLE channels DROP COLUMN optional_titles; DROP TABLE message_reactions; ALTER TABLE channels DROP COLUMN reactions; DROP TABLE channel_roster; DROP TABLE channel_grants; ALTER TABLE channels DROP COLUMN show_members; ALTER TABLE channels DROP COLUMN hide_handles; DROP TABLE push_subscriptions; DROP TABLE conversation_prefs; DROP INDEX messages_parent; DROP TABLE attachments; DROP TABLE user_roles; DROP TABLE roles; DROP TABLE mirror_sources; DROP TABLE channel_mirrors; DROP TABLE channel_bridge_seen; DROP TABLE channel_bridges; DROP TABLE xmpp_remote_messages; DROP TABLE xmpp_remote_rooms; DROP TABLE remote_avatars; DROP TABLE xmpp_avatar_requests; PRAGMA user_version=9");
  store.close(); store = new Store(path);
  assert.equal(store.db.version(), 29);
  assert.equal(Buffer.from(store.avatarImage(alice.id).image).toString("base64"), image);
  assert.equal(store.db.prepare("SELECT seq FROM xmpp_events WHERE object_id='old-message'").get()?.seq, 50);
  store.db.prepare("INSERT INTO xmpp_events(kind,object_id) VALUES('Profile',?)").run(alice.id);
  assert.ok(store.db.sequence("xmpp_events") > 50);
  const peer = "xmpp:other@remote.test";
  store.cacheRemoteAvatar(peer, image, peer);
  const url = store.peerInfo(peer).avatar_url;
  store.setContactName(alice, peer, "Friend");
  store.close(); store = new Store(path);
  t.after(() => { store.close(); rmSync(directory, { recursive: true }); });
  assert.equal(store.peerInfo(peer).avatar_url, url);
  assert.equal(store.peerInfo(peer, alice).display_name, "Friend");
  store.cacheRemoteAvatar(peer, null, "");
  assert.equal(store.peerInfo(peer).avatar_url, null);
});
test("owners rename and delete channels; deletion removes the conversation without touching others", () => {
  const { store, alice, bob, charlie } = fixture();
  const c = store.createChannel(alice, channelInput({ mode: "threaded" }));
  const other = store.createChannel(bob, channelInput({ name: "other" }));
  store.join(bob, c.id);
  store.setMember(alice, c.id, bob.id, { role: "moderator" });
  denied(() => store.renameChannel(bob, c.id, "lobby"));
  denied(() => store.deleteChannel(bob, c.id));
  denied(() => store.deleteChannel(charlie, c.id));
  denied(() => store.renameChannel(alice, c.id, "other"), 409);
  denied(() => store.renameChannel(alice, c.id, "No spaces"), 400);
  assert.equal(store.renameChannel(alice, c.id, "Lobby").name, "lobby");
  assert.equal(store.renameChannel(alice, c.id, "lobby").name, "lobby");
  assert.equal(store.createChannel(charlie, channelInput()).name, "general");
  const root = store.post(alice, c.id, { title: "Thread", body: "Root" });
  store.post(bob, c.id, { body: "Reply", parent_id: root.id });
  store.setMember(alice, c.id, charlie.id, { rule: "block" });
  const kept = store.post(bob, other.id, { body: "Kept" });
  store.deleteChannel(alice, c.id);
  denied(() => store.channel(c.id), 404);
  denied(() => store.message(root.id), 404);
  assert.deepEqual(
    store.listChannels(bob).map((channel) => channel.name),
    ["general", "other"],
  );
  assert.deepEqual(store.overview(bob).unread, {});
  assert.equal(store.message(kept.id).body, "Kept");
  for (const table of ["memberships", "channel_rules", "messages"])
    assert.equal(
      store.db
        .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE channel_id=?`)
        .get(c.id)!.n,
      0,
    );
  assert.equal(store.createChannel(alice, channelInput({ name: "lobby" })).name, "lobby");
  store.close();
});
test("mentions-only notifications match handles and replies, with topic overrides and ordinary unread counts", () => {
  const { store, alice, bob } = fixture();
  const channel = store.createChannel(alice, channelInput({ mode: "topical" }));
  store.join(bob, channel.id);
  const topic = store.createTopic(alice, channel.id, "News");
  assert.deepEqual(store.setPref(bob, { target: channel.id, notify: "mentions" }), {
    [channel.id]: { hidden: false, notify: "mentions" },
  });
  assert.equal(store.prefList(bob)[0].notify, "mentions");
  for (const [body, expected] of [
    ["Hello @bob", true], ["(@BoB), can you help?", true], ["Thanks @bob.", true],
    ["Hello everyone", false], ["Hello @bobby", false], ["Hello @bob-other", false],
    ["mail@bob.example", false], ["Hello @bob@elsewhere.example", false], ["Hello @bob.example", false],
  ] as const) {
    const message = store.post(alice, channel.id, { body, topic_id: topic.id });
    assert.equal(!!store.channelNotice(bob.id, message), expected, body);
  }
  const own = store.post(bob, channel.id, { body: "A question", topic_id: topic.id });
  const answer = store.post(alice, channel.id, { body: "An answer", parent_id: own.id, topic_id: topic.id });
  assert.ok(store.channelNotice(bob.id, answer));
  assert.equal(store.channelNotice(bob.id, own), null);
  assert.equal(store.overview(bob).unread[channel.id], 10);
  const ordinary = store.post(alice, channel.id, { body: "General news", topic_id: topic.id });
  store.setPref(bob, { target: `topic:${topic.id}`, notify: true });
  assert.ok(store.channelNotice(bob.id, ordinary));
  store.setPref(bob, { target: `topic:${topic.id}`, notify: "mentions" });
  assert.equal(store.channelNotice(bob.id, ordinary), null);
  assert.equal(store.prefs(bob)[`topic:${topic.id}`].notify, "mentions");
  store.setPref(bob, { target: `topic:${topic.id}`, notify: null });
  assert.ok(store.channelNotice(bob.id, answer));
  store.setPref(bob, { target: `topic:${topic.id}`, hidden: true });
  assert.equal(store.channelNotice(bob.id, answer), null);
  denied(() => store.setPref(bob, { target: `dm:${alice.id}`, notify: "mentions" }), 400);
  denied(() => store.setPref(bob, { target: channel.id, notify: "invalid" }), 400);
  store.setPref(bob, { target: channel.id, notify: true });
  assert.equal(store.prefs(bob)[channel.id], undefined);
  store.close();
});

test("hidden topics and threads leave what is new, and each part of a channel decides whether it notifies", () => {
  const { store, alice, bob, charlie } = fixture();
  const topical = store.createChannel(alice, channelInput({ name: "topics", mode: "topical" }));
  const threads = store.createChannel(alice, channelInput({ name: "threads", mode: "threaded" }));
  for (const c of [topical, threads]) store.join(bob, c.id);
  const news = store.createTopic(alice, topical.id, "News"),
    noise = store.createTopic(alice, topical.id, "Noise");
  store.post(alice, topical.id, { body: "Worth reading", topic_id: news.id });
  const loud = store.post(alice, topical.id, { body: "Chatter", topic_id: noise.id });
  const kept = store.post(alice, threads.id, { body: "Kept", title: "Kept thread" });
  const dull = store.post(alice, threads.id, { body: "Dull", title: "Dull thread" });
  const reply = store.post(alice, threads.id, { body: "More of it", parent_id: dull.id });
  const deeper = store.post(alice, threads.id, { body: "And more", parent_id: reply.id });
  assert.deepEqual(store.overview(bob).unread, { [topical.id]: 2, [threads.id]: 4 });

  // Only topics and threads hide, and only for members.
  denied(() => store.setPref(bob, { target: topical.id, hidden: true }), 400);
  denied(() => store.setPref(bob, { target: `thread:${reply.id}`, hidden: true }), 400);
  denied(() => store.setPref(bob, { target: `topic:${noise.id}` }), 400);
  denied(() => store.setPref(bob, { target: "topic:missing", hidden: true }), 404);
  denied(() => store.setPref(charlie, { target: `topic:${noise.id}`, hidden: true }));
  assert.deepEqual(store.setPref(bob, { target: `topic:${noise.id}`, hidden: true }), {
    [`topic:${noise.id}`]: { hidden: true, notify: null },
  });
  store.setPref(bob, { target: `thread:${dull.id}`, hidden: true });
  assert.deepEqual(store.overview(bob).unread, { [topical.id]: 1, [threads.id]: 1 });
  assert.deepEqual(store.inbox(bob).map((m) => m.body).sort(), ["Kept", "Worth reading"]);
  assert.deepEqual(store.overview(alice).prefs, {});
  // The hidden thread still arrives, marked all the way down, so it can be shown again.
  assert.deepEqual(
    store.messages(bob, threads.id).map((m) => [m.body, !!(m as { hidden_thread?: boolean }).hidden_thread]),
    [["Kept", false], ["Dull", true], ["More of it", true], ["And more", true]],
  );
  assert.ok(store.messages(alice, threads.id).every((m) => !("hidden_thread" in m)));

  // Quiet: the author, what is hidden, and what was turned off; a part's choice beats its channel's.
  assert.equal(store.channelNotice(alice.id, loud), null);
  assert.equal(store.channelNotice(charlie.id, loud), null);
  assert.equal(store.channelNotice(bob.id, loud), null);
  assert.equal(store.channelNotice(bob.id, deeper), null);
  assert.deepEqual(store.channelNotice(bob.id, kept), {
    tag: `thread:${kept.id}`, title: "#threads › Kept thread", from: "alice", text: "Kept", icon: null, url: `/#/c/${threads.id}`,
  });
  store.setPref(bob, { target: threads.id, notify: false });
  assert.equal(store.channelNotice(bob.id, kept), null);
  store.setPref(bob, { target: `thread:${kept.id}`, notify: true });
  assert.equal(store.channelNotice(bob.id, kept)?.tag, `thread:${kept.id}`);
  // A notification shows the author's picture, and what was said on one short line.
  const pictured = store.setAvatar(alice, "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=");
  const long = store.post(alice, threads.id, { body: `Look\n\nhere ${"x".repeat(300)}`, parent_id: kept.id });
  const told = store.channelNotice(bob.id, long)!;
  assert.equal(told.icon, pictured.avatar_url);
  assert.ok(told.text.startsWith("Look here x") && told.text.endsWith("…") && told.text.length === 240);
  store.removeAvatar(alice);
  store.setPref(bob, { target: `thread:${dull.id}`, hidden: false });
  assert.equal(store.channelNotice(bob.id, deeper), null); // the channel is off, and this thread follows it
  store.setPref(bob, { target: threads.id, notify: true });
  assert.equal(store.channelNotice(bob.id, deeper)?.title, "#threads › Dull thread");
  store.setPref(bob, { target: `topic:${noise.id}`, hidden: false, notify: false });
  assert.equal(store.channelNotice(bob.id, loud), null);
  assert.equal(store.overview(bob).unread[topical.id], 2);
  assert.deepEqual(
    store.prefList(bob).map((p) => [p.kind, p.channel?.name, p.title, p.hidden, p.notify]),
    [["thread", "threads", "Kept thread", false, true], ["topic", "topics", "Noise", false, false]],
  );
  // What has been read is not news.
  store.markRead(bob, { target: threads.id });
  assert.equal(store.channelNotice(bob.id, kept), null);

  store.sendDirect(alice, bob.id, "Hello");
  const direct = store.db.prepare("SELECT seq,user_id,peer FROM direct_messages WHERE user_id=? AND direction='incoming'").get(bob.id) as { seq: number; user_id: string; peer: string };
  assert.deepEqual(store.directNotice(direct), { tag: `dm:${direct.peer}`, title: `alice (@alice@${new URL(direct.peer).host})`, from: null, text: "Hello", icon: null, url: `/#/dm/${alice.id}` });
  // A thread without a title is named by how it began.
  const open = store.createChannel(alice, channelInput({ name: "loose", mode: "threaded", optional_titles: true }));
  store.join(bob, open.id);
  const bare = store.post(alice, open.id, { body: `It began ${"y".repeat(60)}` });
  const later = store.channelNotice(bob.id, store.post(alice, open.id, { body: "And went on", parent_id: bare.id }))!;
  assert.ok(later.title.startsWith("#loose › It began y") && later.title.endsWith("…"));
  assert.equal(later.text, "And went on");
  denied(() => store.setPref(bob, { target: `dm:${direct.peer}`, hidden: true }), 400);
  store.setPref(bob, { target: `dm:${direct.peer}`, notify: false });
  assert.equal(store.directNotice(direct), null);
  store.setPref(bob, { target: `dm:${direct.peer}`, notify: true });
  store.markRead(bob, { target: `dm:${direct.peer}` });
  assert.equal(store.directNotice(direct), null);

  store.deleteChannel(alice, topical.id);
  assert.deepEqual(Object.keys(store.prefs(bob)), [`thread:${kept.id}`]);
  store.close();
});
test("threaded channels can make thread titles optional, at creation or later", () => {
  const { store, alice, bob, charlie } = fixture();
  const c = store.createChannel(alice, channelInput({ mode: "threaded" }));
  store.join(bob, c.id);
  store.join(charlie, c.id);
  store.setMember(alice, c.id, bob.id, { role: "moderator" });
  assert.equal(c.optional_titles, 0);
  denied(() => store.post(alice, c.id, { body: "Untitled" }), 400);
  denied(() => store.post(alice, c.id, { body: "Blank", title: "  " }), 400);
  denied(() => store.setOptionalTitles(charlie, c.id, true));
  denied(() => store.setOptionalTitles(alice, c.id, "yes"), 400);
  assert.equal(store.setOptionalTitles(bob, c.id, true).optional_titles, 1);
  const bare = store.post(charlie, c.id, { body: "Untitled" });
  assert.equal(bare.title, null);
  assert.equal(store.post(charlie, c.id, { body: "Blank", title: "  " }).title, null);
  const titled = store.post(charlie, c.id, { body: "Named", title: "A name" });
  // A title can be added to a thread, and taken off again while titles are optional.
  let edited = store.editMessage(charlie, bare.id, { body: "Untitled", title: "Now named", expected_edited_at: null });
  assert.equal(edited.title, "Now named");
  edited = store.editMessage(charlie, bare.id, { body: "Untitled", title: "", expected_edited_at: edited.edited_at });
  assert.equal(edited.title, null);
  // Required again: untitled threads stay as they are, titled ones keep a title.
  store.setOptionalTitles(alice, c.id, false);
  denied(() => store.post(charlie, c.id, { body: "Untitled again" }), 400);
  assert.equal(store.editMessage(charlie, bare.id, { body: "Still untitled", title: "", expected_edited_at: edited.edited_at }).title, null);
  denied(() => store.editMessage(charlie, titled.id, { body: "Named", title: "", expected_edited_at: null }), 400);
  // Only threaded channels have the setting.
  const open = store.createChannel(alice, channelInput({ name: "open-threads", mode: "threaded", optional_titles: true }));
  assert.equal(open.optional_titles, 1);
  assert.equal(store.post(alice, open.id, { body: "Untitled" }).title, null);
  denied(() => store.createChannel(alice, channelInput({ name: "wrong-titles", mode: "threaded", optional_titles: "yes" })), 400);
  const line = store.createChannel(alice, channelInput({ name: "a-timeline", optional_titles: true }));
  assert.equal(line.optional_titles, 0);
  denied(() => store.setOptionalTitles(alice, line.id, true), 400);
  store.close();
});
test("members react to messages; moderators turn reactions off and on", () => {
  const { store, alice, bob, charlie } = fixture();
  const c = store.createChannel(alice, channelInput());
  store.join(bob, c.id);
  store.join(charlie, c.id);
  store.setMember(alice, c.id, bob.id, { role: "moderator" });
  const m = store.post(alice, c.id, { body: "Hello" });
  assert.equal(store.channelInfo(alice, store.channel(c.id)).reactions, 1);
  store.react(bob, m.id, { emoji: "tada", on: true });
  store.react(bob, m.id, { emoji: "tada", on: true });
  store.react(charlie, m.id, { emoji: "tada", on: true });
  store.react(charlie, m.id, { emoji: "+1", on: true });
  denied(() => store.react(charlie, m.id, { emoji: "not_an_emoji", on: true }), 400);
  const seen = (u: typeof alice) =>
    (store.messages(u, c.id)[0] as unknown as { reactions: unknown }).reactions;
  assert.deepEqual(seen(bob), [
    { emoji: "tada", count: 2, mine: true },
    { emoji: "+1", count: 1, mine: false },
  ]);
  store.react(bob, m.id, { emoji: "tada", on: false });
  assert.deepEqual(seen(alice), [
    { emoji: "tada", count: 1, mine: false },
    { emoji: "+1", count: 1, mine: false },
  ]);
  denied(() => store.setReactions(charlie, c.id, false));
  store.setReactions(bob, c.id, false);
  denied(() => store.react(charlie, m.id, { emoji: "tada", on: true }));
  store.setReactions(alice, c.id, true);
  store.react(charlie, m.id, { emoji: "tada", on: false });
  store.deleteChannel(alice, c.id);
  store.close();
});
test("moderators take a reaction off a message for everyone and ban an emoji from a channel", () => {
  const { store, alice, bob, charlie } = fixture();
  const c = store.createChannel(alice, channelInput());
  store.join(bob, c.id);
  store.join(charlie, c.id);
  store.setMember(alice, c.id, bob.id, { role: "moderator" });
  const m = store.post(alice, c.id, { body: "Hello" }),
    second = store.post(alice, c.id, { body: "Again" });
  const seen = (id = m.id) => store.reactionsOf(alice, id);
  for (const emoji of ["tada", "eggplant"]) {
    store.react(bob, m.id, { emoji, on: true });
    store.react(charlie, m.id, { emoji, on: true });
  }
  store.react(charlie, second.id, { emoji: "eggplant", on: true });
  denied(() => store.clearReaction(charlie, m.id, "eggplant"));
  assert.deepEqual(store.clearReaction(bob, m.id, "eggplant"), [{ emoji: "tada", count: 2, mine: true }]);
  // Taken off one message, it can be given again; banned, it is gone from the channel and stays out.
  store.react(charlie, m.id, { emoji: "eggplant", on: true });
  denied(() => store.banReaction(charlie, c.id, { emoji: "eggplant", banned: true }));
  denied(() => store.banReaction(bob, c.id, { emoji: ":eggplant:", banned: true }), 400);
  assert.deepEqual(store.banReaction(bob, c.id, { emoji: "eggplant", banned: true }).reaction_bans, ["eggplant"]);
  assert.deepEqual(seen(), [{ emoji: "tada", count: 2, mine: false }]);
  assert.deepEqual(seen(second.id), []);
  denied(() => store.react(charlie, m.id, { emoji: "eggplant", on: true }));
  assert.deepEqual(store.banReaction(alice, c.id, { emoji: "eggplant", banned: false }).reaction_bans, []);
  store.react(charlie, m.id, { emoji: "eggplant", on: true });
  assert.equal((seen() as unknown[]).length, 2);
  // A ban holds in messages too. However the emoji is written, it is refused in new ones and left
  // out of those already there, which are stored whole and read as before once the ban is lifted.
  const dinner = store.post(charlie, c.id, { body: "Dinner :eggplant: and \u{1F346} tonight" }),
    only = store.post(charlie, c.id, { body: ":eggplant:" });
  const said = (id: string) => store.messages(alice, c.id).find((x) => x.id === id)!.body;
  store.banReaction(bob, c.id, { emoji: "eggplant", banned: true });
  assert.equal(said(dinner.id), "Dinner  and  tonight");
  assert.equal(said(only.id), "This message was only emoji that are banned here.");
  assert.equal(store.message(dinner.id).body, "Dinner :eggplant: and \u{1F346} tonight");
  denied(() => store.post(charlie, c.id, { body: "An :eggplant: again" }));
  denied(() => store.post(charlie, c.id, { body: "An \u{1F346} again" }));
  denied(() => store.editMessage(charlie, dinner.id, { body: ":eggplant:", expected_edited_at: null }));
  assert.equal(store.post(charlie, c.id, { body: "A :tada: is fine" }).body, "A :tada: is fine");
  store.banReaction(bob, c.id, { emoji: "eggplant", banned: false });
  assert.equal(said(dinner.id), "Dinner :eggplant: and \u{1F346} tonight");
  // An administrator's ban holds in every channel and in direct messages, under any name of the emoji.
  const admin = store.loginIdentity("https://id.example", "admin", "admin", [], true);
  denied(() => store.banEmoji(alice, { emoji: "+1", banned: true }));
  store.react(charlie, m.id, { emoji: "thumbsup", on: true });
  const direct = store.sendDirect(bob, charlie.id, "Well done :+1:");
  assert.deepEqual(store.banEmoji(admin, { emoji: "+1", banned: true }), ["+1"]);
  assert.ok(!(seen() as { emoji: string }[]).some((r) => r.emoji === "thumbsup"));
  denied(() => store.react(charlie, m.id, { emoji: "thumbsup", on: true }));
  denied(() => store.post(charlie, c.id, { body: "Agreed :thumbsup:" }));
  denied(() => store.sendDirect(bob, charlie.id, "Agreed \u{1F44D}"));
  assert.equal(
    store.directHistory(bob, direct.peer).messages.find((x) => x.body.startsWith("Well done"))!.body,
    "Well done",
  );
  assert.deepEqual(store.banEmoji(admin, { emoji: "+1", banned: false }), []);
  assert.equal(store.post(charlie, c.id, { body: "Agreed :thumbsup:" }).body, "Agreed :thumbsup:");
  store.deleteChannel(alice, c.id);
  store.close();
});
test("instance emoji can be renamed by admins; emoji cached from another server can be kept personally or for the instance", () => {
  const { store, bob } = fixture();
  const alice = store.loginIdentity("https://id.example", "boss", "boss", [], true);
  const image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=";
  store.addEmoji(alice, { name: "ripple", image });
  store.addEmoji(alice, { name: "occupied", image });
  denied(() => store.renameEmoji(bob, "ripple", "greeting"));
  denied(() => store.renameEmoji(alice, "ripple", "occupied"), 409);
  denied(() => store.renameEmoji(alice, "ripple", "tada"), 400);
  denied(() => store.renameEmoji(alice, "missing", "missing_two"), 404);
  assert.equal(store.renameEmoji(alice, "ripple", "greeting")?.name, "greeting");
  assert.ok(!store.emojis().some((e) => e.name === "ripple"));
  store.db.prepare("INSERT INTO remote_emoji_cache VALUES('remote1','https://far.example/e.png','image/png',?)").run(Buffer.from(image, "base64"));
  denied(() => store.adoptCachedEmoji(bob, "nope", { name: "x", scope: "personal" }), 404);
  denied(() => store.adoptCachedEmoji(bob, "remote1", { name: "farway", scope: "instance" }));
  assert.equal(store.adoptCachedEmoji(bob, "remote1", { name: "farway", scope: "personal" })?.name, "farway");
  assert.deepEqual(store.emojiCatalog(bob).map((e) => e.name).sort(), ["farway", "greeting", "occupied"]);
  assert.equal(store.adoptCachedEmoji(alice, "remote1", { name: "farway", scope: "instance" })?.name, "farway");
  // Another member's own emoji on this instance can be kept too; one's own cannot be kept twice.
  const bobs = store.personalEmojis(bob).find((e) => e.name === "farway")!;
  denied(() => store.adoptCachedEmoji(bob, bobs.id, { name: "again", scope: "personal" }), 409);
  assert.equal(store.adoptCachedEmoji(alice, bobs.id, { name: "from_bob", scope: "personal" })?.name, "from_bob");
  store.close();
});
