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
  t.after(() => rmSync(directory, { recursive: true }));
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
  t.after(() => store.close());
  assert.deepEqual(JSON.parse(store.message("message").emoji_tags), [
    { id: "asset", name: "island", url: "/api/emojis/asset/image" },
  ]);
  assert.equal(store.user("author").federation_send, 0);
  assert.equal(store.db.prepare("PRAGMA user_version").get()?.user_version, 3);
});
