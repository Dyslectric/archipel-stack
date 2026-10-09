import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, Problem } from "../src/store.js";
import { sqliteOnly } from "./sqlite-only.js";

test("remote contact names are personal and cover DM history, sidebar and inbox without changing addresses", t => {
  const store = new Store(":memory:");
  t.after(() => store.close());
  const alice = store.loginIdentity("https://id.example", "alice", "alice", []);
  const bob = store.loginIdentity("https://id.example", "bob", "bob", []);
  const peer = "xmpp:other@remote.test";
  store.xmppHooks = {profile() {}, message() {}, direct() {}, access: () => ({incoming:true,outgoing:true,blocked:null})};
  store.db.prepare("INSERT INTO direct_messages(id,user_id,peer,direction,body,created_at) VALUES(?,?,?,'incoming','Hello',?)")
    .run("incoming", alice.id, peer, new Date().toISOString());
  assert.equal(store.setContactName(alice, peer, "  Remote Friend  ").display_name, "Remote Friend");
  assert.equal(store.setContactName(bob, peer, "Other Bob knows").display_name, "Other Bob knows");
  const history = store.directHistory(alice, peer);
  assert.equal(history.conversation.display_name, "Remote Friend");
  assert.equal(history.messages[0].display_name, "Remote Friend");
  assert.equal(history.messages[0].author_actor_url, peer);
  assert.equal(history.messages[0].username, "other@remote.test");
  assert.equal(store.conversations(alice)[0].display_name, "Remote Friend");
  assert.equal(store.inbox(alice)[0].display_name, "Remote Friend");
  assert.equal(store.peerInfo(peer).display_name, "other@remote.test");
  store.setUserBlock(alice, peer, true);
  assert.deepEqual(store.userBlocks(alice), [peer]);
  assert.ok(store.directHistory(alice, peer).conversation.blocked);
  store.setContactName(alice, peer, "");
  assert.equal(store.peerInfo(peer, alice).display_name, "other@remote.test");
  assert.equal(store.peerInfo(peer, bob).display_name, "Other Bob knows");
});

test("ActivityPub contact names apply to channel authors and membership without rewriting advertised profiles", t => {
  const store = new Store(":memory:");
  t.after(() => store.close());
  const alice = store.loginIdentity("https://id.example", "alice", "alice", []);
  const bob = store.loginIdentity("https://id.example", "bob", "bob", []);
  const remote = store.loginIdentity("https://id.example", "remote", "remote", []);
  const peer = "https://remote.example/users/remote";
  store.db.prepare("UPDATE users SET remote_actor=?,display_name='Published Name' WHERE id=?").run(peer, remote.id);
  const channel = store.createChannel(alice, {name:"general",mode:"timeline",visibility:"public",admission:"open"});
  store.join(bob, channel.id); store.join(remote, channel.id);
  const message = store.post(remote, channel.id, {body:"Hello from elsewhere"});
  store.setContactName(alice, peer, "My Friend");
  assert.equal(store.messages(alice, channel.id)[0].display_name, "My Friend");
  assert.equal(store.messages(bob, channel.id)[0].display_name, "Published Name");
  assert.equal(store.inbox(alice)[0].display_name, "My Friend");
  assert.equal(store.details(alice, channel.id).members.find(u => u.id === remote.id)?.display_name, "My Friend");
  assert.equal(store.profile(store.user(remote.id)).display_name, "Published Name");
  assert.equal(store.message(message.id).display_name, "Published Name");
  store.db.prepare("UPDATE users SET display_name='Updated Published Name' WHERE id=?").run(remote.id);
  assert.equal(store.peerInfo(peer, alice).display_name, "My Friend");
  store.setContactName(alice, peer, null);
  assert.equal(store.peerInfo(peer, alice).display_name, "Updated Published Name");
});

test("contact names validate input, preserve existing names on errors and reject local users", t => {
  const store = new Store(":memory:"); t.after(() => store.close());
  const alice = store.loginIdentity("https://id.example", "alice", "alice", []);
  const peer = "xmpp:other@remote.test";
  store.setContactName(alice, peer, "Original");
  for (const [address, name] of [[peer, "a".repeat(81)], [peer, 1], [peer, undefined], ["javascript:bad", "Test"], [`${store.baseUrl}/actors/users/${alice.id}`, "Test"]]) {
    assert.throws(() => store.setContactName(alice, address, name), e => e instanceof Problem && e.status === 400);
  }
  store.db.prepare("INSERT INTO instance_settings VALUES('xmpp_domain','local.test')").run();
  assert.throws(() => store.setContactName(alice, "xmpp:alice@local.test", "Test"), e => e instanceof Problem && e.status === 400);
  assert.equal(store.peerInfo(peer, alice).display_name, "Original");
  store.db.prepare("UPDATE users SET banned=1 WHERE id=?").run(alice.id);
  assert.throws(() => store.setContactName(alice, peer, "Changed"), e => e instanceof Problem && e.status === 403);
});

test("upgrading version seven preserves the archive and contact names survive restart", sqliteOnly, t => {
  const directory = mkdtempSync(join(tmpdir(), "archipel-contact-names-")), path = join(directory, "db.sqlite");
  t.after(() => rmSync(directory, {recursive:true,force:true}));
  let store = new Store(path);
  const alice = store.loginIdentity("https://id.example", "alice", "alice", []);
  const peer = "xmpp:other@remote.test";
  store.db.prepare("INSERT INTO direct_messages(id,user_id,peer,direction,body,created_at) VALUES(?,?,?,'incoming','Saved history',?)")
    .run("saved", alice.id, peer, new Date().toISOString());
  store.db.exec("DROP TABLE closed_conversations; ALTER TABLE channels DROP COLUMN optional_titles; DROP TABLE message_reactions; ALTER TABLE channels DROP COLUMN reactions; DROP TABLE channel_roster; DROP TABLE channel_grants; ALTER TABLE channels DROP COLUMN show_members; ALTER TABLE channels DROP COLUMN hide_handles; DROP TABLE push_subscriptions; DROP TABLE conversation_prefs; DROP INDEX messages_parent; DROP TABLE attachments; DROP TABLE user_roles; DROP TABLE roles; DROP TABLE mirror_sources; DROP TABLE channel_mirrors; DROP TABLE channel_bridge_seen; DROP TABLE channel_bridges; DROP TABLE xmpp_remote_messages; DROP TABLE xmpp_remote_rooms; DROP TABLE remote_avatars; DROP TABLE xmpp_avatar_requests; DROP TABLE contact_names; PRAGMA user_version=7"); store.close();
  store = new Store(path);
  assert.equal(store.db.version(), 19);
  store.setContactName(alice, peer, "Saved name"); store.close();
  store = new Store(path);
  try {
    assert.equal(store.peerInfo(peer, alice).display_name, "Saved name");
    assert.equal(store.db.prepare("SELECT body FROM direct_messages WHERE id='saved'").get()?.body, "Saved history");
  } finally { store.close(); }
});
