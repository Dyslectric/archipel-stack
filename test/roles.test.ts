import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Store, Problem } from "../src/store.js";
import { Federation } from "../src/federation.js";
import { Xmpp } from "../src/xmpp.js";
import { loadConfig } from "../src/config.js";

const denied = (fn: () => unknown, status = 403) =>
  assert.throws(fn, (e: unknown) => e instanceof Problem && e.status === status);
const channel = (name: string) => ({ name, description: "", mode: "timeline", visibility: "public", admission: "open" });
function fixture() {
  const store = new Store(":memory:");
  const config = loadConfig({ DEV_AUTH: "true", XMPP_DOMAIN: "chat.example", XMPP_BRIDGE_SECRET: "s".repeat(43) });
  const fed = new Federation(store, config), xmpp = new Xmpp(store, config);
  const alice = store.loginIdentity("urn:archipel:development", "alice", "alice", [], true);
  const bob = store.loginIdentity("urn:archipel:development", "bob", "bob", []);
  fed.setEnabled(alice, true);
  return { store, fed, xmpp, alice, bob };
}

test("everyone starts on the default role, which allows local use and no federation", t => {
  const f = fixture(); t.after(() => f.store.close());
  const [role] = f.store.roles(f.alice);
  assert.deepEqual({ name: role.name, is_default: role.is_default, members: role.members }, { name: "Member", is_default: true, members: 2 });
  const profile = f.store.profile(f.bob, true) as Record<string, unknown>;
  assert.deepEqual(profile.instance_role, { id: role.id, name: "Member" });
  for (const grant of ["create_channels", "federate_channels", "direct_messages", "attachments", "xmpp_rooms"]) assert.equal(profile[grant], true);
  for (const grant of ["federation_send", "federation_receive", "federation_subscribe", "federation_post"]) assert.equal(profile[grant], false);
  assert.equal("instance_role" in f.store.profile(f.bob), false);
  denied(() => f.store.roles(f.bob));
  denied(() => f.store.createRole(f.bob, { name: "Mine" }));
  denied(() => f.store.setUserRole(f.bob, f.bob.id, role.id));
});

test("a role's grants gate channel creation, channel federation, direct messages and room joining", t => {
  const f = fixture(); t.after(() => f.store.close());
  const guest = f.store.createRole(f.alice, { name: "Guest", create_channels: false, federate_channels: false, direct_messages: false, xmpp_rooms: false, attachments: false });
  const open = f.store.createChannel(f.bob, channel("before"));
  f.store.setUserRole(f.alice, f.bob.id, guest.id);
  assert.equal(f.store.roles(f.alice).find(r => r.id === guest.id)!.members, 1);
  denied(() => f.store.createChannel(f.bob, channel("after")));
  denied(() => f.fed.setChannel(f.bob, open.id, true));
  denied(() => f.store.sendDirect(f.bob, f.alice.id, "Hello"));
  denied(() => f.xmpp.sendDirect(f.bob, "xmpp:alice@chat.example", "Hello"));
  denied(() => f.store.addAttachment(f.bob, Buffer.from("x"), "x.png"));
  // What others write still arrives, and the conversation says why it cannot be answered.
  f.store.sendDirect(f.alice, f.bob.id, "Can you read this?");
  const history = f.store.directHistory(f.bob, `${f.store.baseUrl}/actors/users/${f.alice.id}`);
  assert.equal(history.messages.length, 1);
  assert.match(history.conversation.blocked!, /role does not allow sending direct messages/);
  // Posting in channels is not a role matter.
  assert.equal(f.store.post(f.bob, open.id, { body: "Still here" }).body, "Still here");
  f.store.setUserRole(f.alice, f.bob.id, null);
  assert.equal(f.store.createChannel(f.bob, channel("after")).name, "after");
  assert.equal(f.fed.setChannel(f.bob, open.id, true).federation_enabled, 1);
  f.store.sendDirect(f.bob, f.alice.id, "Hello");
});

test("federation grants follow the role through edits, reassignment, default changes and deletion", t => {
  const f = fixture(); t.after(() => f.store.close());
  const flags = (id: string) => { const u = f.store.user(id); return [u.federation_send, u.federation_receive, u.federation_subscribe, u.federation_post].join(""); };
  const federated = f.store.createRole(f.alice, { name: "Federated", federation_send: true, federation_receive: true, federation_subscribe: true, federation_post: true });
  assert.equal(flags(f.bob.id), "0000");
  f.store.setUserRole(f.alice, f.bob.id, federated.id);
  assert.equal(flags(f.bob.id), "1111");
  f.store.updateRole(f.alice, federated.id, { federation_post: false });
  assert.equal(flags(f.bob.id), "1110");
  assert.equal(flags(f.alice.id), "0000");
  // Making it the default moves newcomers and nobody else: accounts on the old default keep it by name.
  f.store.updateRole(f.alice, federated.id, { is_default: true });
  assert.equal(flags(f.alice.id), "0000");
  assert.equal(flags(f.bob.id), "1110");
  const carol = f.store.loginIdentity("urn:archipel:development", "charlie", "charlie", []);
  assert.equal(flags(carol.id), "1110");
  const member = f.store.roles(f.alice).find(r => r.name === "Member")!;
  assert.deepEqual([member.is_default, member.members], [false, 1]);
  denied(() => f.store.deleteRole(f.alice, federated.id), 409);
  denied(() => f.store.updateRole(f.alice, federated.id, { is_default: false }), 400);
  // Deleting a role returns its accounts to the default one.
  f.store.deleteRole(f.alice, member.id);
  assert.equal(flags(f.alice.id), "1110");
  denied(() => f.store.createRole(f.alice, { name: "federated" }), 409);
  denied(() => f.store.createRole(f.alice, { name: "Odd", federation_send: "yes" }), 400);
  denied(() => f.store.updateRole(f.alice, federated.id, { admin: true }), 400);
  denied(() => f.store.setUserRole(f.alice, f.bob.id, "missing"), 404);
});

test("upgrading turns per-account federation switches into roles without changing anyone's access", t => {
  const store = new Store(":memory:"); t.after(() => store.close());
  const alice = store.loginIdentity("urn:archipel:development", "alice", "alice", [], true);
  const bob = store.loginIdentity("urn:archipel:development", "bob", "bob", []);
  const carol = store.loginIdentity("urn:archipel:development", "charlie", "charlie", []);
  store.db.exec("DROP TABLE attachments; DROP TABLE user_roles; DROP TABLE roles; ALTER TABLE xmpp_remote_rooms DROP COLUMN attempts; ALTER TABLE xmpp_remote_rooms DROP COLUMN retry_at; PRAGMA user_version=12");
  store.db.prepare("UPDATE users SET federation_send=1,federation_receive=1,federation_subscribe=1,federation_post=1 WHERE id=?").run(bob.id);
  store.db.prepare("UPDATE users SET federation_receive=1,federation_subscribe=1 WHERE id=?").run(carol.id);
  store.db.exec(readFileSync(new URL("../migrations/013_roles_attachments.sql", import.meta.url), "utf8"));
  const names = Object.fromEntries(store.roles(alice).map(r => [r.name, r.members]));
  assert.deepEqual(names, { Member: 1, Federated: 1, "Federated (receive, subscribe)": 1 });
  assert.equal(store.roleOf(store.user(carol.id)).federation_receive, 1);
  assert.equal(store.roleOf(store.user(carol.id)).federation_send, 0);
  assert.equal(store.user(bob.id).federation_post, 1);
});
