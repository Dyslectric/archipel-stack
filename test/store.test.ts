import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store, Problem } from "../src/store.js";
import { loadConfig } from "../src/config.js";

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
    store.directory(alice).some((u) => u.id === pending.id),
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

test("version-one databases upgrade without losing membership and persist community settings", (t) => {
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

test("version-two emoji messages keep their image metadata through the federation migration", (t) => {
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
  assert.equal(store.db.prepare("PRAGMA user_version").get()?.user_version, 17);
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

test("personal blocks persist across restarts and upgrade an existing version 4 database", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "archipel-blocks-"));
  const path = join(directory, "db.sqlite");
  let store = new Store(path);
  const alice = store.loginIdentity("https://id.example", "alice", "alice", []);
  const bob = store.loginIdentity("https://id.example", "bob", "bob", []);
  store.db.exec("DROP TABLE message_reactions; ALTER TABLE channels DROP COLUMN reactions; DROP TABLE channel_roster; DROP TABLE channel_grants; ALTER TABLE channels DROP COLUMN show_members; ALTER TABLE channels DROP COLUMN hide_handles; DROP TABLE push_subscriptions; DROP TABLE conversation_prefs; DROP INDEX messages_parent; DROP TABLE attachments; DROP TABLE user_roles; DROP TABLE roles; DROP TABLE mirror_sources; DROP TABLE channel_mirrors; DROP TABLE channel_bridge_seen; DROP TABLE channel_bridges; DROP TABLE xmpp_remote_messages; DROP TABLE xmpp_remote_rooms; DROP TABLE remote_avatars; DROP TABLE xmpp_avatar_requests; DROP TABLE contact_names; DROP TABLE xmpp_direct_ids; DROP TABLE xmpp_message_ids; DROP TABLE xmpp_incoming; DROP TABLE xmpp_events; DROP TABLE xmpp_credentials; DROP TABLE xmpp_accounts; DROP INDEX direct_messages_xmpp_source; ALTER TABLE direct_messages DROP COLUMN xmpp_source_id; DROP TABLE user_avatars; DROP TABLE user_blocks; PRAGMA user_version=4;");
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

test("profile picture migration preserves identities and pictures survive restarting", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "archipel-avatars-"));
  const path = join(directory, "db.sqlite");
  let store = new Store(path);
  const alice = store.loginIdentity("https://id.example", "alice", "alice", []);
  store.db.exec("DROP TABLE message_reactions; ALTER TABLE channels DROP COLUMN reactions; DROP TABLE channel_roster; DROP TABLE channel_grants; ALTER TABLE channels DROP COLUMN show_members; ALTER TABLE channels DROP COLUMN hide_handles; DROP TABLE push_subscriptions; DROP TABLE conversation_prefs; DROP INDEX messages_parent; DROP TABLE attachments; DROP TABLE user_roles; DROP TABLE roles; DROP TABLE mirror_sources; DROP TABLE channel_mirrors; DROP TABLE channel_bridge_seen; DROP TABLE channel_bridges; DROP TABLE xmpp_remote_messages; DROP TABLE xmpp_remote_rooms; DROP TABLE remote_avatars; DROP TABLE xmpp_avatar_requests; DROP TABLE contact_names; DROP TABLE xmpp_direct_ids; DROP TABLE xmpp_message_ids; DROP TABLE xmpp_incoming; DROP TABLE xmpp_events; DROP TABLE xmpp_credentials; DROP TABLE xmpp_accounts; DROP INDEX direct_messages_xmpp_source; ALTER TABLE direct_messages DROP COLUMN xmpp_source_id; DROP TABLE user_avatars; PRAGMA user_version=5;");
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
  });
  assert.deepEqual(saved, {
    dms: { collapsed: false, items: [], groups: [] },
    channels: {
      collapsed: true,
      items: ["a"],
      groups: [{ id: "g1", name: "Work", collapsed: false, items: ["b"] }],
    },
    xmpp: { collapsed: false, items: [], groups: [] },
  });
  assert.deepEqual(store.overview(alice).layout, saved);
  assert.equal(store.overview(bob).layout, null);
  denied(
    () => store.setLayout(alice, { dms: { groups: [{ id: "g", name: "" }] } }),
    400,
  );
  store.close();
});

test("version 9 avatar migration preserves pictures and XMPP cursors and remote caches survive restart", t => {
  const directory = mkdtempSync(join(tmpdir(), "archipel-remote-avatars-"));
  const path = join(directory, "db.sqlite");
  let store = new Store(path);
  const alice = store.loginIdentity("https://id.example", "alice", "alice", []);
  const image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=";
  store.setAvatar(alice, image);
  store.db.prepare("INSERT INTO xmpp_events(seq,kind,object_id) VALUES(50,'Direct','old-message')").run();
  store.db.exec("DROP TABLE message_reactions; ALTER TABLE channels DROP COLUMN reactions; DROP TABLE channel_roster; DROP TABLE channel_grants; ALTER TABLE channels DROP COLUMN show_members; ALTER TABLE channels DROP COLUMN hide_handles; DROP TABLE push_subscriptions; DROP TABLE conversation_prefs; DROP INDEX messages_parent; DROP TABLE attachments; DROP TABLE user_roles; DROP TABLE roles; DROP TABLE mirror_sources; DROP TABLE channel_mirrors; DROP TABLE channel_bridge_seen; DROP TABLE channel_bridges; DROP TABLE xmpp_remote_messages; DROP TABLE xmpp_remote_rooms; DROP TABLE remote_avatars; DROP TABLE xmpp_avatar_requests; PRAGMA user_version=9");
  store.close(); store = new Store(path);
  assert.equal(store.db.prepare("PRAGMA user_version").get()?.user_version, 17);
  assert.equal(Buffer.from(store.avatarImage(alice.id).image).toString("base64"), image);
  assert.equal(store.db.prepare("SELECT seq FROM xmpp_events WHERE object_id='old-message'").get()?.seq, 50);
  const next = store.db.prepare("INSERT INTO xmpp_events(kind,object_id) VALUES('Profile',?)").run(alice.id);
  assert.ok(Number(next.lastInsertRowid) > 50);
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
    tag: `thread:${kept.id}`, title: "#threads › Kept thread", from: "alice", url: `/#/c/${threads.id}`,
  });
  store.setPref(bob, { target: threads.id, notify: false });
  assert.equal(store.channelNotice(bob.id, kept), null);
  store.setPref(bob, { target: `thread:${kept.id}`, notify: true });
  assert.equal(store.channelNotice(bob.id, kept)?.tag, `thread:${kept.id}`);
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
  assert.deepEqual(store.directNotice(direct), { tag: `dm:${direct.peer}`, title: "alice", from: null, url: `/#/dm/${alice.id}` });
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
