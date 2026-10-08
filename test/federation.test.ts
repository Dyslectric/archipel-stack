import { grant } from "./roles.js";
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, Problem } from "../src/store.js";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { Federation } from "../src/federation.js";
import { Mirrors } from "../src/mirrors.js";
import {
  peerUrl,
  publicAddress,
  signedHeaders,
  peerRequest,
} from "../src/federation-net.js";

const permissions = {
  federation_send: true,
  federation_receive: true,
  federation_subscribe: true,
  federation_post: true,
};
const image =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=";
async function instance(t: TestContext, env: Record<string, string> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "archipel-federation-"));
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const config = loadConfig({
    DEV_AUTH: "true",
    BASE_URL: origin,
    DATABASE_PATH: join(directory, "db.sqlite"),
    ...env,
  });
  const store = new Store(join(directory, "db.sqlite"), origin);
  const app = createApp(config, store);
  let liveApp = app,
    offline = false;
  server.on("request", (req, res) => {
    if (offline) {
      res.writeHead(503).end();
    } else liveApp(req, res);
  });
  const fed = app.locals.federation as Federation;
  const mirrors = app.locals.mirrors as Mirrors;
  const alice = store.loginIdentity(
    "urn:archipel:development",
    "alice",
    "alice",
    [],
    true,
  );
  const bob = store.loginIdentity("urn:archipel:development", "bob", "bob", []);
  fed.setEnabled(alice, true);
  grant(fed.store, alice, alice.id, permissions);
  grant(fed.store, alice, bob.id, permissions);
  const result = {
    server,
    origin,
    config,
    store,
    fed,
    mirrors,
    alice: store.user(alice.id),
    bob: store.user(bob.id),
    offline(value: boolean) {
      offline = value;
    },
    restart() {
      result.store.close();
      result.store = new Store(config.databasePath, origin);
      liveApp = createApp(config, result.store);
      result.fed = liveApp.locals.federation as Federation;
    },
  };
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    result.store.close();
    rmSync(directory, { recursive: true });
  });
  return result;
}
async function drain(...instances: Awaited<ReturnType<typeof instance>>[]) {
  for (let step = 0; step < 5; step++)
    for (const i of instances) await i.fed.tick();
  for (const i of instances) {
    const failed = i.store.db
      .prepare(
        "SELECT d.status,d.error,o.purpose FROM federation_deliveries d JOIN federation_outgoing o ON o.id=d.activity_id WHERE d.status IN ('failed','pending')",
      )
      .all();
    assert.deepEqual(failed, [], JSON.stringify(failed));
  }
}
function channel(i: Awaited<ReturnType<typeof instance>>, extra = {}) {
  const c = i.store.createChannel(i.alice, {
    name: "general",
    description: "Federated conversation",
    mode: "timeline",
    visibility: "public",
    admission: "open",
    ...extra,
  });
  i.fed.setChannel(i.alice, c.id, true);
  return i.store.channel(c.id);
}

test("delivery honours the configured overall and per-peer send rates", async (t) => {
  const a = await instance(t, { FEDERATION_SEND_RATE: "2", FEDERATION_PEER_SEND_RATE: "3" });
  const b = await instance(t), c = await instance(t);
  const statuses = (origin: string) =>
    a.store.db
      .prepare("SELECT status,attempts FROM federation_deliveries WHERE recipient LIKE ? ORDER BY id")
      .all(`${origin}/%`)
      .map((d) => `${d.status}:${d.attempts}`);
  for (let n = 0; n < 5; n++)
    await a.fed.sendDirect(a.bob, `${b.origin}/actors/users/${b.bob.id}`, `Message ${n}`);
  await a.fed.tick();
  assert.deepEqual(statuses(b.origin), ["sent:1", "sent:1", "pending:0", "pending:0", "pending:0"]);
  await a.fed.sendDirect(a.bob, `${c.origin}/actors/users/${c.bob.id}`, "Other peer");
  await a.fed.tick();
  // The peer allowance is spent after three; the other peer is not held behind it.
  assert.deepEqual(statuses(b.origin), ["sent:1", "sent:1", "sent:1", "pending:0", "pending:0"]);
  assert.deepEqual(statuses(c.origin), ["sent:1"]);
  await a.fed.tick();
  assert.deepEqual(statuses(b.origin), ["sent:1", "sent:1", "sent:1", "pending:0", "pending:0"]);
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() + 60001 });
  await a.fed.tick();
  await a.fed.tick();
  assert.deepEqual(statuses(b.origin), ["sent:1", "sent:1", "sent:1", "sent:1", "sent:1"]);
  assert.equal(b.fed.directMessages(b.bob).length, 5);
});

test("personal remote blocks reject incoming messages and cancel queued sends until unblocked", async (t) => {
  const a = await instance(t), b = await instance(t);
  const aPeer = `${a.origin}/actors/users/${a.bob.id}`;
  const bPeer = `${b.origin}/actors/users/${b.bob.id}`;
  await a.fed.sendDirect(a.bob, bPeer, "Queued before block");
  a.store.setUserBlock(a.bob, bPeer, true);
  await a.fed.tick();
  assert.deepEqual(b.fed.directMessages(b.bob), []);
  await assert.rejects(() => a.fed.sendDirect(a.bob, bPeer, "Blocked outgoing"), (e: unknown) => e instanceof Problem && e.status === 403);
  await b.fed.sendDirect(b.bob, aPeer, "Blocked incoming");
  await b.fed.tick();
  assert.equal(a.store.db.prepare("SELECT COUNT(*) AS n FROM direct_messages WHERE direction='incoming'").get()?.n, 0);
  a.store.setUserBlock(a.bob, bPeer, false);
  await b.fed.sendDirect(b.bob, aPeer, "After unblock");
  await a.fed.sendDirect(a.bob, bPeer, "Reply after unblock");
  await a.fed.tick();
  await b.fed.tick();
  assert.ok(a.fed.directMessages(a.bob).some((m) => m.body === "After unblock"));
  assert.ok(b.fed.directMessages(b.bob).some((m) => m.body === "Reply after unblock"));
});

test("profile pictures are exported, cached and updated for federated direct conversations", async t => {
  const a = await instance(t), b = await instance(t);
  a.store.setAvatar(a.alice, image);
  // Some peers replace picture bytes at a stable URL instead of versioning it.
  const originalActor = a.fed.publicActor.bind(a.fed);
  a.fed.publicActor = (kind, id) => {
    const document = originalActor(kind, id);
    if (document.icon) document.icon.url = document.icon.url.split("?")[0];
    return document;
  };
  const actor = a.fed.publicActor("users", a.alice.id);
  assert.equal(actor.icon.mediaType, "image/png");
  const publicImage = await fetch(actor.icon.url);
  assert.equal(publicImage.status, 200);
  assert.deepEqual(Buffer.from(await publicImage.arrayBuffer()), Buffer.from(image, "base64"));
  await b.fed.sendDirect(b.bob, a.fed.userActor(a.alice), "Hello with a picture");
  const peer = a.fed.userActor(a.alice);
  const cachedUrl = b.store.peerInfo(peer).avatar_url!;
  assert.match(cachedUrl, /^\/api\/remote-avatars\//);
  assert.deepEqual(Buffer.from(b.store.remoteAvatarImage(cachedUrl.split("/").at(-1)!.split("?")[0]).image), Buffer.from(image, "base64"));
  await drain(a, b);
  await a.fed.sendDirect(a.alice, b.fed.userActor(b.bob), "Reply with my picture");
  await drain(a, b);
  assert.equal(b.store.directHistory(b.bob, peer).messages.at(-1)?.avatar_url, cachedUrl);
  b.store.setContactName(b.bob, peer, "My friend");
  const changed = Buffer.from(image, "base64"); changed[changed.length - 1] ^= 1;
  a.store.setAvatar(a.alice, changed.toString("base64"));
  await drain(a, b);
  assert.notEqual(b.store.peerInfo(peer).avatar_url, cachedUrl);
  assert.equal(b.store.peerInfo(peer, b.bob).display_name, "My friend");
  b.restart();
  assert.ok(b.store.peerInfo(peer).avatar_url);
  a.store.removeAvatar(a.alice);
  await drain(a, b);
  assert.equal(b.store.peerInfo(peer).avatar_url, null);
  assert.equal(b.store.directHistory(b.bob, peer).messages.at(-1)?.avatar_url, null);
  assert.equal((await fetch(actor.icon.url)).status, 404);
  a.fed.setEnabled(a.alice, false);
  assert.equal((await fetch(actor.icon.url)).status, 403);
});

test("channel profile updates propagate home and remote author pictures across three instances", async t => {
  const a = await instance(t), b = await instance(t), c = await instance(t);
  const home = channel(a);
  const subB = await b.fed.subscribe(b.bob, `#general@${new URL(a.origin).host}`);
  const subC = await c.fed.subscribe(c.bob, `#general@${new URL(a.origin).host}`);
  await drain(a, b, c);
  a.store.post(a.alice, home.id, { body: "From home" });
  await drain(a, b, c);
  a.store.setAvatar(a.alice, image);
  await drain(a, b, c);
  assert.ok(b.store.messages(b.bob, subB.channel.id).find(m => m.body === "From home")?.avatar_url);
  assert.ok(c.store.messages(c.bob, subC.channel.id).find(m => m.body === "From home")?.avatar_url);
  await b.fed.remotePost(b.bob, subB.channel.id, { body: "From remote author" });
  await drain(a, b, c);
  b.store.setAvatar(b.bob, image);
  await drain(a, b, c);
  assert.ok(a.store.messages(a.alice, home.id).find(m => m.body === "From remote author")?.avatar_url);
  assert.ok(c.store.messages(c.bob, subC.channel.id).find(m => m.body === "From remote author")?.avatar_url);
  b.store.removeAvatar(b.bob);
  await drain(a, b, c);
  assert.equal(c.store.messages(c.bob, subC.channel.id).find(m => m.body === "From remote author")?.avatar_url, null);
});

test("foreign, invalid and oversized optional profile pictures cannot bypass fetch limits or break messaging", async t => {
  const a = await instance(t), b = await instance(t);
  const original = a.fed.publicActor.bind(a.fed);
  let iconUrl = "https://127.0.0.1/private-avatar";
  a.fed.publicActor = (kind, id) => ({ ...original(kind, id), icon: { type: "Image", url: iconUrl } });
  const peer = a.fed.userActor(a.alice);
  await b.fed.actor(peer, true);
  assert.equal(b.store.peerInfo(peer).avatar_url, null);
  iconUrl = peer; // Same-origin JSON must never be served as an avatar.
  await b.fed.actor(peer, true);
  assert.equal(b.store.peerInfo(peer).avatar_url, null);
  iconUrl = `${a.origin}/federation/avatars/${a.alice.id}`;
  a.store.db.prepare("INSERT INTO user_avatars VALUES(?,?,?,?)").run(a.alice.id, "too-large", "image/png", Buffer.concat([Buffer.from(image, "base64"), Buffer.alloc(2097152)]));
  await b.fed.actor(peer, true);
  assert.equal(b.store.peerInfo(peer).avatar_url, null);
  await b.fed.sendDirect(b.bob, peer, "Avatar failure does not break chat");
  await drain(a, b);
  assert.equal(a.store.directHistory(a.alice, b.fed.userActor(b.bob)).messages[0].body, "Avatar failure does not break chat");
  const url = new URL(`${b.origin}/federation/inbox`);
  const activity = JSON.stringify({ id: `${a.origin}/forged-profile`, type: "Update", actor: peer, object: { type: "Person", id: a.fed.userActor(a.bob) } });
  const response = await fetch(url, { method: "POST", headers: signedHeaders(url, "POST", peer, a.fed.keys().private_key, activity), body: activity });
  assert.equal(response.status, 403);
});

test("two real instances subscribe, exchange signed messages, edit, delete, and deduplicate", async (t) => {
  const a = await instance(t),
    b = await instance(t);
  const home = channel(a);
  a.store.post(a.alice, home.id, { body: "Before joining" });
  const sub = await b.fed.subscribe(
    b.bob,
    `#general@${new URL(a.origin).host}`,
  );
  await drain(a, b);
  assert.equal(b.store.role(sub.channel.id, b.bob.id), "member");
  assert.equal(
    b.store.messages(b.bob, sub.channel.id)[0].body,
    "Before joining",
  );
  a.store.post(a.alice, home.id, { body: "Hello from home" });
  await drain(a, b);
  assert.equal(
    b.store.messages(b.bob, sub.channel.id).at(-1)?.body,
    "Hello from home",
  );
  await b.fed.remotePost(b.bob, sub.channel.id, { body: "Hello from remote" });
  await drain(a, b);
  const remote = b.store.messages(b.bob, sub.channel.id).at(-1)!;
  assert.equal(remote.body, "Hello from remote");
  assert.equal(remote.author_id, b.bob.id);
  assert.equal(
    a.store.messages(a.alice, home.id).at(-1)?.body,
    "Hello from remote",
  );
  const homeCopy = a.store.messages(a.alice, home.id).at(-1)!;
  const session = a.store.createSession(a.bob.id);
  grant(a.fed.store, a.alice, a.bob.id, {
    ...permissions,
    federation_receive: false,
  });
  assert.equal(
    (
      await fetch(`${a.origin}/objects/messages/${homeCopy.id}`, {
        headers: { cookie: `archipel=${session.token}` },
      })
    ).status,
    403,
  );
  assert.equal(
    a.store
      .messages(a.store.user(a.bob.id), home.id)
      .some((m) => m.id === homeCopy.id),
    false,
  );
  await b.fed.editRemote(b.bob, remote.id, {
    body: "Edited from remote",
    expected_edited_at: null,
  });
  await drain(a, b);
  assert.equal(
    a.store.messages(a.alice, home.id).at(-1)?.body,
    "Edited from remote",
  );
  assert.equal(b.store.message(remote.id).body, "Edited from remote");
  const outgoing = b.store.db
    .prepare(
      "SELECT * FROM federation_outgoing WHERE purpose='post' ORDER BY created_at DESC LIMIT 1",
    )
    .get() as { activity: string; signer: string };
  const url = new URL(`${a.origin}/federation/inbox`);
  await peerRequest(
    url,
    b.config,
    signedHeaders(
      url,
      "POST",
      outgoing.signer,
      b.fed.keys().private_key,
      outgoing.activity,
    ),
    outgoing.activity,
  );
  assert.equal(a.store.messages(a.alice, home.id).length, 3);
  b.fed.deleteRemote(b.bob, remote.id);
  await drain(a, b);
  assert.ok(a.store.messages(a.alice, home.id).at(-1)?.deleted_at);
  assert.ok(b.store.message(remote.id).deleted_at);
  b.fed.unsubscribe(b.bob, sub.channel.id);
  await drain(a, b);
  assert.equal(b.store.role(sub.channel.id, b.bob.id), null);
});

test("private channels wait for home approval and block queued content after access is revoked", async (t) => {
  const a = await instance(t),
    b = await instance(t);
  const home = channel(a, { visibility: "members", admission: "allowlist" });
  a.store.post(a.alice, home.id, { body: "Restricted history" });
  const sub = await b.fed.subscribe(b.bob, a.fed.channelActor(home));
  await drain(a, b);
  assert.equal(b.store.role(sub.channel.id, b.bob.id), null);
  assert.throws(() => b.store.messages(b.bob, sub.channel.id), Problem);
  const follower = b.fed.userActor(b.bob);
  a.fed.decideFollow(a.alice, home.id, follower, "accepted");
  await drain(a, b);
  assert.equal(
    b.store.messages(b.bob, sub.channel.id)[0].body,
    "Restricted history",
  );
  a.store.post(a.alice, home.id, { body: "Queued secret" });
  a.fed.decideFollow(a.alice, home.id, follower, "blocked");
  await drain(a, b);
  assert.equal(
    b.store.db
      .prepare("SELECT COUNT(*) AS n FROM messages WHERE body='Queued secret'")
      .get()?.n,
    0,
  );
  assert.equal(b.store.role(sub.channel.id, b.bob.id), null);
});

test("all four user controls are enforced for direct messages, subscriptions, remote posting and reads", async (t) => {
  const a = await instance(t),
    b = await instance(t),
    home = channel(a);
  const denied = {
    ...permissions,
    federation_send: false,
    federation_receive: false,
    federation_subscribe: false,
    federation_post: false,
  };
  grant(b.fed.store, b.alice, b.bob.id, denied);
  await assert.rejects(
    b.fed.subscribe(b.bob, a.fed.channelActor(home)),
    Problem,
  );
  await assert.rejects(
    b.fed.sendDirect(b.bob, a.fed.userActor(a.bob), "Denied"),
    Problem,
  );
  assert.throws(
    () => grant(b.fed.store, b.bob, b.bob.id, permissions),
    Problem,
  );
  grant(b.fed.store, b.alice, b.bob.id, permissions);
  const sub = await b.fed.subscribe(
    b.store.user(b.bob.id),
    a.fed.channelActor(home),
  );
  await drain(a, b);
  grant(b.fed.store, b.alice, b.bob.id, {
    ...permissions,
    federation_post: false,
  });
  await assert.rejects(
    b.fed.remotePost(b.bob, sub.channel.id, { body: "Denied post" }),
    Problem,
  );
  grant(b.fed.store, b.alice, b.bob.id, permissions);
  await b.fed.sendDirect(b.bob, a.fed.userActor(a.bob), "Private hello");
  await drain(a, b);
  assert.equal(a.fed.directMessages(a.bob)[0].body, "Private hello");
  grant(a.fed.store, a.alice, a.bob.id, {
    ...permissions,
    federation_receive: false,
  });
  assert.deepEqual(a.fed.directMessages(a.store.user(a.bob.id)), []);
  await b.fed.sendDirect(b.bob, a.fed.userActor(a.bob), "Cannot receive");
  await b.fed.tick();
  assert.equal(
    a.store.db
      .prepare(
        "SELECT COUNT(*) AS n FROM direct_messages WHERE body='Cannot receive'",
      )
      .get()?.n,
    0,
  );
  const local = b.store.createChannel(b.bob, {
    name: "local-chat",
    mode: "timeline",
    visibility: "public",
    admission: "open",
  });
  grant(b.fed.store, b.alice, b.bob.id, denied);
  b.store.post(b.store.user(b.bob.id), local.id, { body: "Local still works" });
  assert.equal(
    b.store.messages(b.store.user(b.bob.id), local.id)[0].body,
    "Local still works",
  );
});

test("queued deliveries persist and recheck disabled users and blocked instances before a retry", async (t) => {
  const a = await instance(t),
    b = await instance(t);
  await b.fed.sendDirect(
    b.bob,
    a.fed.userActor(a.bob),
    "Cancelled before send",
  );
  grant(b.fed.store, b.alice, b.bob.id, {
    ...permissions,
    federation_send: false,
  });
  await b.fed.tick();
  assert.equal(
    b.store.db
      .prepare(
        "SELECT status FROM federation_deliveries ORDER BY id DESC LIMIT 1",
      )
      .get()?.status,
    "cancelled",
  );
  assert.deepEqual(a.fed.directMessages(a.bob), []);
  grant(b.fed.store, b.alice, b.bob.id, permissions);
  await b.fed.sendDirect(b.bob, a.fed.userActor(a.bob), "Blocked peer");
  b.fed.block(b.alice, { kind: "instance", target: a.origin, blocked: true });
  await b.fed.tick();
  assert.equal(
    b.store.db
      .prepare(
        "SELECT status FROM federation_deliveries ORDER BY id DESC LIMIT 1",
      )
      .get()?.status,
    "cancelled",
  );
});

test("channel inbox hides cached remote content when federation or instance access is revoked", async (t) => {
  const a = await instance(t), b = await instance(t);
  const home = channel(a);
  const sub = await b.fed.subscribe(b.bob, `#general@${new URL(a.origin).host}`);
  await drain(a, b);
  a.store.post(a.alice, home.id, { body: "Remote unread content" });
  await drain(a, b);
  assert.ok(b.store.inbox(b.bob).some(m => m.body === "Remote unread content"));
  b.fed.setEnabled(b.alice, false);
  assert.equal(b.store.inbox(b.bob).filter(m => m.kind === "channel").length, 0);
  assert.throws(() => b.store.messages(b.bob, sub.channel.id), (e: unknown) => e instanceof Problem && e.status === 403);
  b.fed.setEnabled(b.alice, true);
  b.fed.block(b.alice, { kind: "instance", target: a.origin, blocked: true });
  assert.equal(b.store.inbox(b.bob).filter(m => m.kind === "channel").length, 0);
  b.fed.block(b.alice, { kind: "instance", target: a.origin, blocked: false });
  assert.ok(b.store.inbox(b.bob).some(m => m.body === "Remote unread content"));
});

test("personal uploads and adopted remote emoji are copied, scoped, renamed and frozen in older messages", async (t) => {
  const a = await instance(t),
    b = await instance(t);
  a.store.addEmoji(a.alice, { name: "island", image });
  const adopted = (await b.fed.adoptEmoji(b.bob, {
    instance: a.origin,
    source_name: "island",
    name: "my_island",
  }))!;
  assert.equal(
    adopted.source_url,
    `${a.origin}/federation/emojis/${a.store.emojis()[0].id}/image`,
  );
  assert.deepEqual(
    Buffer.from(b.store.emojiImage(adopted.id).image),
    Buffer.from(image, "base64"),
  );
  const local = b.store.createChannel(b.bob, {
    name: "personal",
    mode: "timeline",
    visibility: "public",
    admission: "open",
  });
  const posted = b.store.post(b.bob, local.id, { body: "Saved :my_island:" });
  b.store.renamePersonalEmoji(b.bob, adopted.id, "new_island");
  assert.equal(
    JSON.parse(b.store.message(posted.id).emoji_tags)[0].name,
    "my_island",
  );
  assert.equal(b.store.personalEmojis(b.bob)[0].name, "new_island");
  assert.deepEqual(b.store.personalEmojis(b.alice), []);
  assert.throws(
    () => b.store.renamePersonalEmoji(b.alice, adopted.id, "stolen"),
    Problem,
  );
  const upload = b.store.adoptEmoji(b.bob, "my_upload", image, "local-upload")!;
  assert.equal(b.store.personalEmojis(b.bob).length, 2);
  assert.throws(
    () => b.store.adoptEmoji(b.bob, "my_upload", image, "local-upload"),
    Problem,
  );
  b.store.removePersonalEmoji(b.bob, upload.id);
});

test("production federation rejects unsafe URL schemes and private/reserved targets", () => {
  const config = loadConfig({ BASE_URL: "https://chat.example" });
  for (const address of [
    "127.0.0.1",
    "10.0.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "::1",
    "::ffff:127.0.0.1",
    "fc00::1",
    "fe80::1",
  ])
    assert.equal(publicAddress(address), false, address);
  assert.equal(publicAddress("8.8.8.8"), true);
  for (const url of [
    "http://example.org",
    "https://127.0.0.1",
    "https://[::1]",
    "https://10.0.0.1",
    "https://name:secret@example.org",
    "file:///etc/passwd",
    "https://example.org/#fragment",
  ])
    assert.throws(() => peerUrl(url, config), Problem, url);
});

test("user and channel handles resolve separately even when their local names match", async (t) => {
  const a = await instance(t),
    b = await instance(t);
  const home = channel(a, { name: "bob" });
  assert.equal(
    (await b.fed.resolve(`bob@${new URL(a.origin).host}`)).id,
    a.fed.userActor(a.bob),
  );
  assert.equal(
    (await b.fed.resolve(`#bob@${new URL(a.origin).host}`)).id,
    a.fed.channelActor(home),
  );
});

test("message origin remains verifiable across a three-instance channel relay", async (t) => {
  const a = await instance(t),
    b = await instance(t),
    c = await instance(t),
    home = channel(a, { mode: "threaded" });
  const first = await b.fed.subscribe(b.bob, a.fed.channelActor(home));
  const second = await c.fed.subscribe(c.bob, a.fed.channelActor(home));
  await drain(a, b, c);
  await b.fed.remotePost(b.bob, first.channel.id, {
    title: "Remote thread",
    body: "From the real origin",
  });
  await drain(a, b, c);
  const seen = c.store.messages(c.bob, second.channel.id)[0];
  assert.equal(seen.body, "From the real origin");
  assert.equal(
    c.store.user(seen.author_id).remote_actor,
    b.fed.userActor(b.bob),
  );
  await c.fed.remotePost(c.bob, second.channel.id, {
    body: "Third instance reply",
    parent_id: seen.id,
  });
  await drain(a, b, c);
  assert.equal(
    b.store.messages(b.bob, first.channel.id).at(-1)?.parent_id,
    b.store.messages(b.bob, first.channel.id)[0].id,
  );
});

test("signed inbox rejects unsigned, stale, altered and author-forged requests and conflicting activity IDs", async (t) => {
  const a = await instance(t),
    b = await instance(t);
  await b.fed.sendDirect(
    b.bob,
    a.fed.userActor(a.bob),
    "Authenticated original",
  );
  const row = b.store.db
    .prepare("SELECT * FROM federation_outgoing WHERE purpose='direct'")
    .get() as { activity: string; signer: string };
  const url = new URL(`${a.origin}/federation/inbox`);
  async function request(body: string, headers: Record<string, string> = {}) {
    return fetch(url, {
      method: "POST",
      headers: { "content-type": "application/activity+json", ...headers },
      body,
    });
  }
  assert.equal((await request(row.activity)).status, 401);
  assert.equal(
    (
      await request(
        row.activity,
        signedHeaders(
          url,
          "POST",
          row.signer,
          b.fed.keys().private_key,
          row.activity,
          new Date(Date.now() - 10 * 60000).toUTCString(),
        ),
      )
    ).status,
    401,
  );
  const altered = JSON.parse(row.activity);
  altered.object.content = "Forged body";
  assert.equal(
    (
      await request(
        JSON.stringify(altered),
        signedHeaders(
          url,
          "POST",
          row.signer,
          b.fed.keys().private_key,
          row.activity,
        ),
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await request(
        JSON.stringify(altered),
        signedHeaders(
          url,
          "POST",
          row.signer,
          b.fed.keys().private_key,
          JSON.stringify(altered),
        ),
      )
    ).status,
    401,
  );
  await drain(a, b);
  const conflict = JSON.stringify({
    ...JSON.parse(row.activity),
    extra: "conflicting activity",
  });
  assert.equal(
    (
      await request(
        conflict,
        signedHeaders(
          url,
          "POST",
          row.signer,
          b.fed.keys().private_key,
          conflict,
        ),
      )
    ).status,
    409,
  );
  assert.equal(a.fed.directMessages(a.bob).length, 1);
});

test("network retries and signing keys survive restart and deliver when the peer recovers", async (t) => {
  const a = await instance(t),
    b = await instance(t);
  await b.fed.sendDirect(b.bob, a.fed.userActor(a.bob), "Survives an outage");
  const key = b.fed.keys().public_key;
  a.offline(true);
  await b.fed.tick();
  assert.equal(
    b.store.db.prepare("SELECT status FROM federation_deliveries").get()
      ?.status,
    "pending",
  );
  assert.equal(
    b.store.db.prepare("SELECT attempts FROM federation_deliveries").get()
      ?.attempts,
    1,
  );
  b.restart();
  assert.equal(b.fed.keys().public_key, key);
  assert.equal(
    b.store.db.prepare("SELECT status FROM federation_deliveries").get()
      ?.status,
    "pending",
  );
  a.offline(false);
  b.store.db.prepare("UPDATE federation_deliveries SET next_attempt=0").run();
  await drain(a, b);
  assert.equal(a.fed.directMessages(a.bob)[0].body, "Survives an outage");
});

test("later deliveries wait for an earlier retry to preserve conversation order", async (t) => {
  const a = await instance(t),
    b = await instance(t);
  await b.fed.sendDirect(b.bob, a.fed.userActor(a.bob), "First in order");
  a.offline(true);
  await b.fed.tick();
  a.offline(false);
  await b.fed.sendDirect(b.bob, a.fed.userActor(a.bob), "Second in order");
  await b.fed.tick();
  assert.deepEqual(a.fed.directMessages(a.bob), []);
  b.store.db.prepare("UPDATE federation_deliveries SET next_attempt=0").run();
  await drain(a, b);
  assert.deepEqual(
    a.fed.directMessages(a.bob).map((m) => m.body),
    ["First in order", "Second in order"],
  );
});

test("topical federation preserves home topics and reply relationships", async (t) => {
  const a = await instance(t),
    b = await instance(t),
    home = channel(a, { mode: "topical" });
  const topic = a.store.createTopic(a.alice, home.id, "Planning");
  a.store.post(a.alice, home.id, {
    body: "Home topic root",
    topic_id: topic.id,
  });
  const sub = await b.fed.subscribe(b.bob, a.fed.channelActor(home));
  await drain(a, b);
  const root = b.store.messages(b.bob, sub.channel.id)[0];
  await b.fed.remotePost(b.bob, sub.channel.id, {
    body: "Remote topical reply",
    topic_id: root.topic_id,
    parent_id: root.id,
  });
  await drain(a, b);
  const reply = a.store.messages(a.alice, home.id).at(-1)!;
  assert.equal(reply.topic_id, topic.id);
  assert.equal(reply.parent_id, a.store.messages(a.alice, home.id)[0].id);
  await assert.rejects(
    b.fed.remotePost(b.bob, sub.channel.id, { body: "Missing topic" }),
    Problem,
  );
});

test("cached foreign channel messages are hidden when receiving is denied and revocation withdraws subscription", async (t) => {
  const a = await instance(t),
    b = await instance(t),
    home = channel(a);
  const sub = await b.fed.subscribe(b.bob, a.fed.channelActor(home));
  await drain(a, b);
  a.store.post(a.alice, home.id, { body: "Foreign history" });
  await drain(a, b);
  grant(b.fed.store, b.alice, b.bob.id, {
    ...permissions,
    federation_receive: false,
  });
  assert.throws(
    () => b.store.messages(b.store.user(b.bob.id), sub.channel.id),
    Problem,
  );
  await drain(a, b);
  assert.equal(a.fed.followers(a.alice, home.id).length, 0);
});

test("personal emoji travel with a federated message and use cached local image URLs at the receiver", async (t) => {
  const a = await instance(t),
    b = await instance(t),
    home = channel(a);
  a.store.adoptEmoji(a.alice, "personal_wave", image, "local-upload");
  const sub = await b.fed.subscribe(b.bob, a.fed.channelActor(home));
  await drain(a, b);
  a.store.post(a.alice, home.id, { body: "Personal :personal_wave:" });
  await drain(a, b);
  const received = b.store.messages(b.bob, sub.channel.id).at(-1)!;
  const tags = JSON.parse(received.emoji_tags);
  assert.equal(tags[0].name, "personal_wave");
  assert.match(tags[0].url, /^\/api\/emojis\//);
  assert.deepEqual(
    Buffer.from(b.store.emojiImage(tags[0].id).image),
    Buffer.from(image, "base64"),
  );
});

test("new subscriptions preserve replies to deleted parents and parents outside bounded history", async (t) => {
  const a = await instance(t),
    b = await instance(t),
    home = channel(a, { mode: "threaded" });
  const root = a.store.post(a.alice, home.id, {
    title: "Older thread",
    body: "Earlier root",
  });
  for (let index = 0; index < 105; index++)
    a.store.post(a.alice, home.id, {
      body: `Reply ${index}`,
      parent_id: root.id,
    });
  const sub = await b.fed.subscribe(b.bob, a.fed.channelActor(home));
  await drain(a, b);
  const placeholder = b.store.db
    .prepare(
      "SELECT id FROM messages WHERE channel_id=? AND history_placeholder=1",
    )
    .get(sub.channel.id) as { id: string };
  assert.ok(placeholder);
  assert.match(
    b.store.message(placeholder.id).body,
    /outside the cached history/,
  );
  await b.fed.remotePost(b.bob, sub.channel.id, {
    body: "Reply to the earlier parent",
    parent_id: placeholder.id,
  });
  await drain(a, b);
  assert.equal(a.store.messages(a.alice, home.id).at(-1)?.parent_id, root.id);
  a.store.editMessage(a.alice, root.id, {
    title: "Updated older thread",
    body: "Root now available",
    expected_edited_at: null,
  });
  await drain(a, b);
  assert.equal(b.store.message(placeholder.id).history_placeholder, 0);
  assert.equal(b.store.message(placeholder.id).body, "Root now available");
  const restricted = channel(a, { name: "deleted-parent", mode: "topical" });
  const topic = a.store.createTopic(a.alice, restricted.id, "History");
  const deleted = a.store.post(a.alice, restricted.id, {
    body: "Removed root",
    topic_id: topic.id,
  });
  a.store.post(a.alice, restricted.id, {
    body: "Surviving reply",
    topic_id: topic.id,
    parent_id: deleted.id,
  });
  a.store.deleteMessage(a.alice, deleted.id);
  const second = await b.fed.subscribe(b.bob, a.fed.channelActor(restricted));
  await drain(a, b);
  const imported = b.store.messages(b.bob, second.channel.id);
  assert.ok(imported[0].deleted_at);
  assert.equal(imported[1].parent_id, imported[0].id);
  assert.equal(imported[1].topic_id, imported[0].topic_id);
});

test("an offline peer with a backlog cannot prevent delivery to another peer", async (t) => {
  const a = await instance(t),
    b = await instance(t),
    c = await instance(t);
  await b.fed.sendDirect(b.bob, a.fed.userActor(a.bob), "Offline head");
  a.offline(true);
  await b.fed.tick();
  for (let index = 0; index < 25; index++)
    await b.fed.sendDirect(b.bob, a.fed.userActor(a.bob), `Waiting ${index}`);
  await b.fed.sendDirect(
    b.bob,
    c.fed.userActor(c.bob),
    "Independent recipient",
  );
  await b.fed.tick();
  assert.equal(c.fed.directMessages(c.bob)[0].body, "Independent recipient");
});
test("a followed channel keeps from its readers what its home keeps from its members, and timeline replies cross", async (t) => {
  const a = await instance(t),
    b = await instance(t);
  const home = channel(a),
    host = new URL(a.origin).host;
  a.store.setPrivacy(a.alice, home.id, { show_members: false });
  const sub = await b.fed.subscribe(b.bob, `#general@${host}`);
  await drain(a, b);
  const first = a.store.post(a.alice, home.id, { body: "A question" });
  await drain(a, b);
  const copy = () => b.store.details(b.bob, sub.channel.id);
  assert.deepEqual([copy().sees_members, copy().members.length], [false, 0]);
  assert.equal(b.store.messages(b.bob, sub.channel.id)[0].username.startsWith("alice"), true);
  a.store.setPrivacy(a.alice, home.id, { show_members: true, hide_handles: true });
  await drain(a, b);
  assert.deepEqual([copy().sees_members, copy().sees_handles], [true, false]);
  assert.equal(b.store.messages(b.bob, sub.channel.id)[0].username, "");
  const question = b.store.messages(b.bob, sub.channel.id)[0];
  await b.fed.remotePost(b.bob, sub.channel.id, { body: "An answer", parent_id: question.id });
  await drain(a, b);
  assert.equal(a.store.messages(a.alice, home.id).at(-1)?.parent_id, first.id);
  assert.equal(b.store.messages(b.bob, sub.channel.id).at(-1)?.parent_id, question.id);
});
test("renaming a home channel renames its remote copies and deleting it ends their subscriptions", async (t) => {
  const a = await instance(t),
    b = await instance(t);
  const home = channel(a),
    host = new URL(a.origin).host;
  const sub = await b.fed.subscribe(b.bob, `#general@${host}`);
  await drain(a, b);
  await b.fed.remotePost(b.bob, sub.channel.id, { body: "Hello from remote" });
  await drain(a, b);
  a.store.renameChannel(a.alice, home.id, "lobby");
  await drain(a, b);
  assert.equal(b.store.channel(sub.channel.id).name, `lobby@${host}`);
  assert.equal((await b.fed.resolve(`#lobby@${host}`)).id, a.fed.channelActor(home));
  await assert.rejects(b.fed.resolve(`#general@${host}`));
  a.store.post(a.alice, home.id, { body: "Still here" });
  await drain(a, b);
  assert.equal(b.store.messages(b.bob, sub.channel.id).at(-1)?.body, "Still here");
  // A post that hadn't left yet must not be delivered for a channel that no longer exists.
  a.store.post(a.alice, home.id, { body: "Never sent" });
  a.store.deleteChannel(a.alice, home.id);
  await drain(a, b);
  assert.throws(() => a.store.channel(home.id), /Channel not found/);
  assert.equal(
    a.store.db.prepare("SELECT COUNT(*) AS n FROM federation_follows").get()!.n,
    0,
  );
  assert.equal(b.store.role(sub.channel.id, b.bob.id), null);
  assert.equal(b.fed.subscriptions(b.bob)[0].status, "rejected");
  assert.equal(
    b.store.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE body='Never sent'").get()!.n,
    0,
  );
});

test("a mirror copies followed channels for its owner, stays read-only until opened, and outlives its sources", async (t) => {
  const a = await instance(t),
    b = await instance(t),
    c = await instance(t);
  const settings = { name: "archive", description: "", visibility: "members", admission: "allowlist" };
  const home = channel(a),
    schism = channel(c, { name: "splinter" });
  a.store.post(a.alice, home.id, { body: "Before the mirror" });
  const followed = await b.fed.subscribe(b.bob, `#general@${new URL(a.origin).host}`);
  const second = await b.fed.subscribe(b.bob, `#splinter@${new URL(c.origin).host}`);
  await drain(a, b, c);
  const local = b.store.createChannel(b.bob, { ...settings, name: "here", mode: "timeline" });
  const mirror = b.mirrors.create(b.bob, settings);
  assert.equal(mirror.mirror, "read-only");
  assert.equal(mirror.mode, "timeline");
  const bodies = () => b.store.messages(b.bob, mirror.id).map((m) => m.body);
  const failing = (fn: () => unknown, status: number) =>
    assert.throws(fn, (e: unknown) => e instanceof Problem && e.status === status);
  // Only what is hosted elsewhere and followed by the owner can be a source.
  failing(() => b.mirrors.addSource(b.bob, mirror.id, { kind: "channel", source: local.id }), 400);
  failing(() => b.mirrors.addSource(b.alice, mirror.id, { kind: "channel", source: followed.channel.id }), 403);
  failing(() => b.mirrors.addSource(b.bob, local.id, { kind: "channel", source: followed.channel.id }), 404);
  b.mirrors.addSource(b.bob, mirror.id, { kind: "channel", source: followed.channel.id });
  failing(() => b.mirrors.addSource(b.bob, mirror.id, { kind: "channel", source: followed.channel.id }), 409);
  assert.deepEqual(bodies(), ["Before the mirror"]);
  // Several sources feed one mirror; nothing is sent to any of them.
  const queued = () => b.store.db.prepare("SELECT COUNT(*) AS n FROM federation_outgoing").get()!.n;
  const before = queued();
  b.mirrors.addSource(b.bob, mirror.id, { kind: "channel", source: second.channel.id });
  const removed = a.store.post(a.alice, home.id, { body: "From the first" });
  c.store.post(c.alice, schism.id, { body: "From the second" });
  await drain(a, b, c);
  assert.deepEqual(bodies(), ["Before the mirror", "From the first", "From the second"]);
  assert.equal(queued(), before);
  assert.equal(b.store.messages(b.bob, mirror.id)[1].author_actor_url, a.fed.userActor(a.alice));
  // Read-only for everyone until the owner opens it; then a fork that keeps receiving.
  failing(() => b.store.post(b.bob, mirror.id, { body: "Too early" }), 403);
  failing(() => b.mirrors.setWritable(b.alice, local.id, true), 404);
  failing(() => b.fed.setChannel(b.bob, mirror.id, true), 400);
  assert.equal(b.mirrors.setWritable(b.bob, mirror.id, true).writable, true);
  b.store.post(b.bob, mirror.id, { body: "Written in the fork" });
  await drain(a, b, c);
  assert.equal(a.store.messages(a.alice, home.id).some((m) => m.body === "Written in the fork"), false);
  // The owner moderates: a removal at the source does not reach the copy, and the owner can remove it here.
  a.store.deleteMessage(a.alice, removed.id);
  await drain(a, b, c);
  assert.equal(bodies()[1], "From the first");
  b.store.deleteMessage(b.bob, b.store.messages(b.bob, mirror.id)[2].id);
  assert.ok(b.store.messages(b.bob, mirror.id)[2].deleted_at);
  // Pausing a source holds its place; resuming catches up; removing it ends it.
  const [first] = b.mirrors.sources(b.bob, mirror.id).sources;
  assert.deepEqual([first.name, first.state, first.active], [`#general@${new URL(a.origin).host}`, "following", true]);
  b.mirrors.setSource(b.bob, mirror.id, first.id, { active: false });
  a.store.post(a.alice, home.id, { body: "While paused" });
  await drain(a, b, c);
  assert.equal(bodies().includes("While paused"), false);
  b.mirrors.setSource(b.bob, mirror.id, first.id, { active: true });
  assert.equal(bodies().at(-1), "While paused");
  // The mirror keeps everything once the owner stops following, or the source goes away.
  b.fed.unsubscribe(b.bob, followed.channel.id);
  await drain(a, b, c);
  a.store.deleteChannel(a.alice, home.id);
  await drain(a, b, c);
  assert.equal(b.mirrors.sources(b.bob, mirror.id).sources[0].state, "left");
  assert.equal(bodies().length, 5);
  b.mirrors.removeSource(b.bob, mirror.id, first.id);
  b.store.deleteChannel(b.bob, mirror.id);
  assert.equal(b.store.db.prepare("SELECT COUNT(*) AS n FROM mirror_sources").get()!.n, 0);
});

test("mirrors of topical and threaded channels keep their topics, titles and replies", async (t) => {
  const a = await instance(t),
    b = await instance(t);
  const host = new URL(a.origin).host;
  const settings = { description: "", visibility: "members", admission: "allowlist" };
  const threads = channel(a, { name: "threads", mode: "threaded" }),
    topics = channel(a, { name: "topics", mode: "topical" });
  const root = a.store.post(a.alice, threads.id, { title: "A thread", body: "Root" });
  const gone = a.store.post(a.alice, threads.id, { body: "Removed before mirroring", parent_id: root.id });
  a.store.post(a.alice, threads.id, { body: "Under the removed reply", parent_id: gone.id });
  a.store.deleteMessage(a.alice, gone.id);
  const news = a.store.createTopic(a.alice, topics.id, "News");
  a.store.post(a.alice, topics.id, { topic_id: news.id, body: "In a topic" });
  const followedThreads = await b.fed.subscribe(b.bob, `#threads@${host}`),
    followedTopics = await b.fed.subscribe(b.bob, `#topics@${host}`);
  await drain(a, b);
  const threaded = b.mirrors.create(b.bob, { ...settings, name: "threads-copy", mode: "threaded" }),
    topical = b.mirrors.create(b.bob, { ...settings, name: "topics-copy", mode: "topical" });
  assert.equal(threaded.mode, "threaded");
  // A mirror takes sources of its own format only.
  assert.throws(
    () => b.mirrors.addSource(b.bob, threaded.id, { kind: "channel", source: followedTopics.channel.id }),
    (e: unknown) => e instanceof Problem && e.status === 400,
  );
  b.mirrors.addSource(b.bob, threaded.id, { kind: "channel", source: followedThreads.channel.id });
  b.mirrors.addSource(b.bob, topical.id, { kind: "channel", source: followedTopics.channel.id });
  a.store.post(a.alice, threads.id, { body: "A later reply", parent_id: root.id });
  a.store.post(a.alice, topics.id, { topic_id: news.id, body: "Later in the topic" });
  await drain(a, b);
  const tree = b.store.messages(b.bob, threaded.id);
  const at = (body: string) => tree.find((m) => m.body === body)!;
  assert.equal(at("Root").title, "A thread");
  assert.equal(at("Root").parent_id, null);
  const removed = tree.find((m) => m.deleted_at)!;
  // A reply removed before the owner followed arrives without its place in the thread, here as there.
  assert.equal(removed.parent_id, null);
  assert.equal(at("Under the removed reply").parent_id, removed.id);
  assert.equal(at("A later reply").parent_id, at("Root").id);
  const details = b.store.details(b.bob, topical.id);
  assert.deepEqual((details.topics as { title: string }[]).map((topic) => topic.title), ["News"]);
  const inTopic = b.store.messages(b.bob, topical.id);
  assert.deepEqual(inTopic.map((m) => m.body), ["In a topic", "Later in the topic"]);
  assert.ok(inTopic.every((m) => m.topic_id === (details.topics as { id: string }[])[0].id));
  // Once opened, members reply inside the copied structure.
  b.mirrors.setWritable(b.bob, threaded.id, true);
  const reply = b.store.post(b.bob, threaded.id, { body: "Forked reply", parent_id: at("Root").id });
  assert.equal(reply.parent_id, at("Root").id);
});
