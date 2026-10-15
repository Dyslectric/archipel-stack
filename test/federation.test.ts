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
import { openEvent } from "../src/instance-feed.js";
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

test("sender deadline crossing with no active deliveries settles instead of waiting forever",async t=>{
  const f=await instance(t);
  const times=[0,999,1000];let calls=0;
  t.mock.method(Date,"now",()=>times[Math.min(calls++,times.length-1)]);
  await Promise.race([f.fed.tick(),new Promise((_,fail)=>setTimeout(()=>fail(new Error("Sender stalled on an empty race")),100))]);
  t.mock.restoreAll();
  await f.fed.tick();
});
async function instance(t: TestContext, env: Record<string, string> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "archipel-federation-"));
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const config = loadConfig({
    DEV_AUTH: "true",
    FEDERATION_CHANNEL_TRANSPORT: "off",
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
  const legacy = (value: Federation) => {
    if (env.TEST_LEGACY_CHANNEL_FEED !== "true") return;
    const original = value.publicActor.bind(value);
    value.publicActor = (kind,id) => {const doc=original(kind,id);if(doc.channelEvents){delete doc.channelEvents.instanceStream;delete doc.channelEvents.instanceBatches;}return doc;};
  };
  legacy(fed);
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
      void result.fed.channelFeed.close();
      result.store.close();
      result.store = new Store(config.databasePath, origin);
      liveApp = createApp(config, result.store);
      result.fed = liveApp.locals.federation as Federation; legacy(result.fed);
    },
  };
  t.after(async () => {
    await result.fed.channelFeed.close();
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

for (const transport of ["batch","stream"] as const) test(`instance ${transport} multiplexes public and private channels with epoch rotation and replay`, async t => {
  const env={FEDERATION_CHANNEL_TRANSPORT:transport,FEDERATION_PEER_SEND_RATE:"0"};
  const a=await instance(t,env),b=await instance(t,env),c=await instance(t,env);
  const publicRoom=channel(a,{name:"public"}),privateRoom=channel(a,{name:"private",visibility:"members",admission:"open"});
  const pub=await b.fed.subscribe(b.bob,a.fed.channelActor(publicRoom)),priv=await b.fed.subscribe(b.bob,a.fed.channelActor(privateRoom));
  await drain(a,b);
  const start=Number(a.store.db.prepare("SELECT tail FROM federation_instance_state").get()!.tail);
  a.store.post(a.alice,publicRoom.id,{body:"Public multiplexed"});
  a.store.post(a.alice,privateRoom.id,{body:"Secret multiplexed"});
  const page=a.fed.channelFeed.instance.page(start), first=page.events.find(e=>e.channel===a.fed.channelActor(privateRoom))!;
  assert.ok(first.encrypted); assert.equal(first.payload,undefined);assert.ok(!JSON.stringify(first).includes("Secret multiplexed"));
  const bActor=b.fed.publicActor("users",b.bob.id),key=a.fed.channelFeed.instance.key(bActor,privateRoom.id,first.epoch);
  assert.match(openEvent(a.origin,first,key.secret).activity!,/Secret multiplexed/);
  assert.throws(()=>openEvent(a.origin,{...first,channelSeq:first.channelSeq+1},key.secret));
  assert.throws(()=>openEvent(a.origin,{...first,channel:page.events.find(e=>e.channel!==first.channel)!.channel},key.secret));
  assert.deepEqual(a.fed.channelFeed.instance.page(start).events,page.events,"all listeners receive the same immutable ciphertext");
  await b.fed.tick();await waitUntil(()=>b.store.messages(b.bob,priv.channel.id).some(m=>m.body==="Secret multiplexed"));
  assert.equal(b.store.messages(b.bob,pub.channel.id)[0].body,"Public multiplexed");
  assert.equal(b.store.db.prepare("SELECT COUNT(*) AS n FROM federation_instance_cursors").get()!.n,1);
  if(transport==="stream")assert.equal(b.fed.channelFeed.instance.stats.connections,1,"one connection for both channels");
  const csub=await c.fed.subscribe(c.bob,a.fed.channelActor(privateRoom));await drain(a,b,c);
  const cActor=c.fed.publicActor("users",c.bob.id);
  assert.throws(()=>a.fed.channelFeed.instance.key(cActor,privateRoom.id,first.epoch),/epoch/);
  a.store.post(a.alice,privateRoom.id,{body:"Next epoch"});
  const second=a.fed.channelFeed.instance.page(page.cursor).events.at(-1)!;
  assert.ok(second.epoch>first.epoch);assert.throws(()=>openEvent(a.origin,second,key.secret));
  await b.fed.tick();await c.fed.tick();await waitUntil(()=>c.store.messages(c.bob,csub.channel.id).some(m=>m.body==="Next epoch"));
  a.fed.decideFollow(a.alice,privateRoom.id,c.fed.userActor(c.bob),"blocked");
  a.store.post(a.alice,privateRoom.id,{body:"Revoked epoch"});
  const revoked=a.fed.channelFeed.instance.page(second.seq).events.at(-1)!;
  assert.ok(revoked.epoch>second.epoch);assert.throws(()=>a.fed.channelFeed.instance.key(cActor,privateRoom.id,revoked.epoch),/denied/);
  await b.fed.channelFeed.close();b.restart();await b.fed.tick();
  await waitUntil(()=>b.store.messages(b.bob,priv.channel.id).some(m=>m.body==="Revoked epoch"));
  assert.equal(b.fed.channelFeed.instance.stats.retries,0);
});

test("durable instance intake continues while one channel's materializer is stalled", async t=>{
  const env={FEDERATION_CHANNEL_TRANSPORT:"stream",FEDERATION_PEER_SEND_RATE:"0"};
  const a=await instance(t,env),b=await instance(t,env),one=channel(a,{name:"one"}),two=channel(a,{name:"two"});
  const sub1=await b.fed.subscribe(b.bob,a.fed.channelActor(one)),sub2=await b.fed.subscribe(b.bob,a.fed.channelActor(two));await drain(a,b);
  const actor=b.fed.actor.bind(b.fed);let release!:()=>void;const stalled=new Promise<void>(resolve=>release=resolve);
  t.mock.method(b.fed,"actor",async(id:string,refresh?:boolean)=>{if(id===a.fed.channelActor(one))await stalled;return actor(id,refresh);});
  t.after(()=>release());
  a.store.post(a.alice,one.id,{body:"Waiting on metadata"});a.store.post(a.alice,two.id,{body:"Independent import"});
  await waitUntil(()=>b.store.messages(b.bob,sub2.channel.id).some(m=>m.body==="Independent import"));
  assert.ok(b.store.db.prepare("SELECT seq FROM federation_instance_incoming WHERE channel_actor=? AND state='pending'").get(a.fed.channelActor(one)));
  const cursor=Number(b.store.db.prepare("SELECT cursor FROM federation_instance_cursors").get()!.cursor);
  assert.ok(cursor>=2);assert.equal(b.store.messages(b.bob,sub1.channel.id).length,0);
  release();await waitUntil(()=>b.store.messages(b.bob,sub1.channel.id).some(m=>m.body==="Waiting on metadata"));
  const invalid={type:"InstanceEvents" as const,origin:a.origin,after:cursor,cursor:cursor+2,events:[{seq:cursor+2,channel:a.fed.channelActor(one),channelSeq:2,epoch:1,payload:{activity:null,actors:[]}}]};
  assert.throws(()=>b.fed.channelFeed.instance.stage(a.origin,invalid),/sequence/);
  assert.equal(Number(b.store.db.prepare("SELECT cursor FROM federation_instance_cursors").get()!.cursor),cursor);
});

test("instance blocks rotate private keys and channel deletion leaves a contiguous opaque feed",async t=>{
  const env={FEDERATION_CHANNEL_TRANSPORT:"batch",FEDERATION_PEER_SEND_RATE:"0"};
  const a=await instance(t,env),b=await instance(t,env),home=channel(a,{visibility:"members",admission:"open"});
  await b.fed.subscribe(b.bob,a.fed.channelActor(home));await drain(a,b);
  a.store.post(a.alice,home.id,{body:"Before instance block"});
  const first=a.fed.channelFeed.instance.page(0).events.at(-1)!,who=b.fed.publicActor("users",b.bob.id),key=a.fed.channelFeed.instance.key(who,home.id,first.epoch);
  a.fed.block(a.alice,{kind:"instance",target:b.origin,blocked:true});
  a.store.post(a.alice,home.id,{body:"After instance block"});
  const next=a.fed.channelFeed.instance.page(first.seq).events.at(-1)!;
  assert.ok(next.epoch>first.epoch);assert.throws(()=>openEvent(a.origin,next,key.secret));
  assert.throws(()=>a.fed.channelFeed.instance.key(who,home.id,next.epoch),/denied/);
  a.store.deleteChannel(a.alice,home.id);
  const deleted=a.fed.channelFeed.instance.page(0);assert.deepEqual(deleted.events.map(e=>e.seq),[1,2]);
  assert.ok(!JSON.stringify(deleted).includes("Before instance block"));
});

test("instance admission routing stays cached and rejoining recovers an expired origin cursor",async t=>{
  const env={FEDERATION_CHANNEL_TRANSPORT:"batch",FEDERATION_PEER_SEND_RATE:"0"};
  const a=await instance(t,env),b=await instance(t,env),home=channel(a),actor=a.fed.channelActor(home);
  const sub=await b.fed.subscribe(b.bob,actor);await drain(a,b);
  const prepare=b.store.db.prepare.bind(b.store.db);let routingWrites=0;
  t.mock.method(b.store.db,"prepare",(sql:string,options?:any)=>{if(sql.startsWith("INSERT OR IGNORE INTO federation_channel_cursors"))routingWrites++;return prepare(sql,options);});
  await b.fed.tick();await b.fed.tick();assert.equal(routingWrites,0,"unchanged subscriptions do not rebuild channel routing");t.mock.restoreAll();
  a.store.post(a.alice,home.id,{body:"Before retained horizon"});
  a.store.db.prepare("UPDATE federation_instance_state SET floor=1").run();
  await b.fed.tick();assert.match(b.store.db.prepare("SELECT error FROM federation_instance_cursors").get()!.error,/expired/);
  b.fed.unsubscribe(b.bob,sub.channel.id);await drain(b,a);
  await b.fed.subscribe(b.bob,actor);await drain(b,a);
  a.store.post(a.alice,home.id,{body:"After fresh admission"});await b.fed.tick();
  assert.ok(b.store.messages(b.bob,sub.channel.id).some(m=>m.body==="After fresh admission"));
  assert.equal(b.store.db.prepare("SELECT error FROM federation_instance_cursors").get()!.error,null);
});

test("a replacement Follow after a lost Undo starts from a fresh origin boundary",async t=>{
  const env={FEDERATION_CHANNEL_TRANSPORT:"batch",FEDERATION_PEER_SEND_RATE:"0"};
  const a=await instance(t,env),b=await instance(t,env),home=channel(a),actor=a.fed.channelActor(home);
  const sub=await b.fed.subscribe(b.bob,actor);await drain(a,b);
  a.store.post(a.alice,home.id,{body:"Before retained horizon"});
  a.store.db.prepare("UPDATE federation_instance_state SET floor=1").run();
  await b.fed.tick();assert.match(b.store.db.prepare("SELECT error FROM federation_instance_cursors").get()!.error,/expired/);
  // The home never hears an Undo: its follower row survives with the old Follow and boundary.
  const before=Number(a.store.db.prepare("SELECT instance_start FROM federation_follows").get()!.instance_start);
  b.store.db.prepare("DELETE FROM federation_subscriptions WHERE channel_id=?").run(sub.channel.id);
  await b.fed.subscribe(b.bob,actor);await drain(b,a);
  const after=Number(a.store.db.prepare("SELECT instance_start FROM federation_follows").get()!.instance_start);
  assert.ok(after>before,`replacement Follow kept the old origin boundary ${before}`);
  a.store.post(a.alice,home.id,{body:"After replacement"});await b.fed.tick();
  assert.ok(b.store.messages(b.bob,sub.channel.id).some(m=>m.body==="After replacement"));
});

async function waitUntil(predicate: () => boolean, timeout = 5000) {
  const end = Date.now() + timeout;
  while (!predicate()) { if (Date.now() >= end) assert.fail("Channel stream did not settle"); await new Promise(done => setTimeout(done, 25)); }
}
for (const transport of ["batch", "stream"] as const) test(`channel ${transport} consumes once per peer, preserves edits/deletes and resumes after restart`, async t => {
  const env = { TEST_LEGACY_CHANNEL_FEED: "true", FEDERATION_CHANNEL_TRANSPORT: transport, FEDERATION_PEER_SEND_RATE: "0" };
  const a = await instance(t, env), b = await instance(t, env), c = await instance(t);
  const home = channel(a), actor = a.fed.channelActor(home);
  const history = t.mock.method(a.fed, "history", a.fed.history.bind(a.fed));
  const roster = t.mock.method(a.fed, "roster", a.fed.roster.bind(a.fed));
  const sub = await b.fed.subscribe(b.bob, actor); await b.fed.subscribe(b.alice, actor);
  await c.fed.subscribe(c.bob, actor); await drain(a, b, c);
  assert.equal(history.mock.callCount(), 2, "one initial history fetch per peer, including the legacy follower");
  assert.equal(roster.mock.callCount(), 2, "one initial roster fetch per peer");
  const message = a.store.post(a.alice, home.id, { body: "One channel event" });
  assert.equal(a.store.db.prepare("SELECT COUNT(*) AS n FROM federation_channel_events").get()!.n, 1);
  const deliveries = a.store.db.prepare("SELECT d.recipient FROM federation_deliveries d JOIN federation_outgoing o ON o.id=d.activity_id WHERE o.purpose='relay'").all();
  assert.deepEqual(deliveries.map(r => r.recipient), [c.fed.userActor(c.bob)]);
  await a.fed.tick(); await b.fed.tick();
  await waitUntil(() => b.store.messages(b.bob, sub.channel.id).some(m => m.body === "One channel event"));
  assert.equal(b.store.db.prepare("SELECT COUNT(*) AS n FROM federation_channel_cursors").get()!.n, 1);
  a.store.editMessage(a.alice, message.id, { body: "Edited channel event", expected_edited_at: null });
  await b.fed.tick(); await waitUntil(() => b.store.messages(b.bob, sub.channel.id)[0].body === "Edited channel event");
  a.store.deleteMessage(a.alice, message.id);
  await b.fed.tick(); await waitUntil(() => !!b.store.db.prepare("SELECT deleted_at FROM messages WHERE remote_object=?").get(`${a.origin}/objects/messages/${message.id}`)?.deleted_at);
  await b.fed.channelFeed.close(); b.restart();
  a.store.post(a.alice, home.id, { body: "Replay after restart" });
  await b.fed.tick(); await waitUntil(() => b.store.messages(b.bob, sub.channel.id).some(m => m.body === "Replay after restart"));
  assert.equal(Number(b.store.db.prepare("SELECT cursor FROM federation_channel_cursors").get()!.cursor), 4);
  assert.equal(b.store.db.prepare("SELECT COUNT(*) AS n FROM federation_incoming WHERE id IN (SELECT activity_id FROM federation_channel_events)").get()!.n, 0);
});

test("channel event checkpoints roll back with failed imports, policy skips advance, and old admission cannot resume", async t => {
  const env = { TEST_LEGACY_CHANNEL_FEED: "true", FEDERATION_CHANNEL_TRANSPORT: "batch", FEDERATION_PEER_SEND_RATE: "0" };
  const a = await instance(t, env), b = await instance(t, env), home = channel(a), actor = a.fed.channelActor(home);
  const sub = await b.fed.subscribe(b.bob, actor); await drain(a, b);
  const message = a.store.post(a.alice, home.id, { body: "Atomic import" });
  const page = a.fed.channelFeed.page(b.fed.publicActor("users", b.bob.id), home.id, 0), event = page.events[0];
  const checkpoint = { channel: actor, follow: page.follow, after: 0, cursor: 1 };
  const original = b.store.db.prepare.bind(b.store.db);
  t.mock.method(b.store.db, "prepare", (sql: string, options?: any) => {
    if (sql.startsWith("UPDATE federation_channel_cursors SET cursor=")) throw new Error("Injected checkpoint failure");
    return original(sql, options);
  });
  await assert.rejects(b.fed.receiveChannelEvent(a.fed.publicActor("channels", home.id), event.activity, checkpoint), /Injected/);
  t.mock.restoreAll();
  assert.equal(b.store.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE body='Atomic import'").get()!.n, 0);
  assert.equal(Number(b.store.db.prepare("SELECT cursor FROM federation_channel_cursors").get()!.cursor), 0);
  await b.fed.tick(); assert.equal(b.store.messages(b.bob, sub.channel.id)[0].body, message.body);
  a.store.post(a.alice, home.id, { body: "Cancelled by author policy" });
  grant(a.store, a.alice, a.alice.id, { federation_send: false });
  await b.fed.tick(); assert.equal(Number(b.store.db.prepare("SELECT cursor FROM federation_channel_cursors").get()!.cursor), 2);
  assert.equal(b.store.messages(b.bob, sub.channel.id).length, 1);
  const peer = b.fed.userActor(b.bob);
  a.fed.decideFollow(a.store.user(a.alice.id), home.id, peer, "blocked");
  assert.throws(() => a.fed.channelFeed.page(b.fed.publicActor("users", b.bob.id), home.id, 2), /denied/);
  await drain(a, b); assert.equal(b.store.db.prepare("SELECT COUNT(*) AS n FROM federation_channel_cursors").get()!.n, 0);
});

test("channel retention reports expired cursors instead of silently losing events", async t => {
  const env = { TEST_LEGACY_CHANNEL_FEED: "true", FEDERATION_CHANNEL_TRANSPORT: "batch", FEDERATION_PEER_SEND_RATE: "0" };
  const a = await instance(t, env), b = await instance(t, env), home = channel(a), actor = a.fed.channelActor(home);
  await b.fed.subscribe(b.bob, actor); await drain(a, b);
  a.store.post(a.alice, home.id, { body: "Expired event" });
  a.store.db.prepare("UPDATE federation_channel_state SET floor=1 WHERE channel_id=?").run(home.id);
  assert.throws(() => a.fed.channelFeed.page(b.fed.publicActor("users", b.bob.id), home.id, 0), (error: unknown) => error instanceof Problem && error.status === 410);
  await b.fed.tick(); assert.equal(b.fed.channelFeed.stats.gaps, 1);
  assert.match(b.store.db.prepare("SELECT error FROM federation_channel_cursors").get()!.error, /expired/);
});

test("channel stream decodes split Unicode with CRLF framing and optional data spacing", async t => {
  const env = { TEST_LEGACY_CHANNEL_FEED: "true", FEDERATION_CHANNEL_TRANSPORT: "stream", FEDERATION_PEER_SEND_RATE: "0" };
  const a = await instance(t, env), b = await instance(t, env), home = channel(a), actor = a.fed.channelActor(home);
  const sub = await b.fed.subscribe(b.bob, actor); await drain(a, b);
  await b.fed.channelFeed.close(); b.restart();
  a.store.post(a.alice, home.id, { body: "Split 🦀 stream" });
  t.mock.method(a.fed.channelFeed, "open", async (...[_req, res, follower, id, after]: Parameters<typeof a.fed.channelFeed.open>) => {
    const page = a.fed.channelFeed.page(follower, id, after);
    const frame = Buffer.from(`data:${JSON.stringify(page)}\r\n\r\n`);
    const at = frame.indexOf(Buffer.from("🦀")) + 2;
    res.setHeader("Content-Type", "text/event-stream"); res.write(frame.subarray(0, at));
    await new Promise(done => setTimeout(done, 10)); res.end(frame.subarray(at));
  });
  await b.fed.tick(); await waitUntil(() => b.store.messages(b.bob, sub.channel.id).some(m => m.body === "Split 🦀 stream"));
  assert.equal(Number(b.store.db.prepare("SELECT cursor FROM federation_channel_cursors").get()!.cursor), 1);
});

test("a local author block skips its channel event without withholding other authors", async t => {
  const env = { TEST_LEGACY_CHANNEL_FEED: "true", FEDERATION_CHANNEL_TRANSPORT: "batch", FEDERATION_PEER_SEND_RATE: "0" };
  const a = await instance(t, env), b = await instance(t, env), c = await instance(t, env), home = channel(a), actor = a.fed.channelActor(home);
  const sub = await b.fed.subscribe(b.bob, actor), authorSub = await c.fed.subscribe(c.bob, actor); await drain(a, b, c);
  b.fed.block(b.alice, { kind: "actor", target: c.fed.userActor(c.bob), blocked: true });
  await c.fed.remotePost(c.bob, authorSub.channel.id, { body: "Locally blocked author" });
  await c.fed.tick();
  a.store.post(a.alice, home.id, { body: "Allowed author after blocked event" });
  await b.fed.tick();
  assert.deepEqual(b.store.messages(b.bob, sub.channel.id).map(m => m.body), ["Allowed author after blocked event"]);
  assert.equal(Number(b.store.db.prepare("SELECT cursor FROM federation_channel_cursors").get()!.cursor), 2);
  assert.equal(b.fed.channelFeed.stats.skipped, 1);
  assert.equal(b.fed.channelFeed.stats.retries, 0);
});

test("a valid idle channel page clears a recovered network error", async t => {
  const env = { TEST_LEGACY_CHANNEL_FEED: "true", FEDERATION_CHANNEL_TRANSPORT: "batch", FEDERATION_PEER_SEND_RATE: "0" };
  const a = await instance(t, env), b = await instance(t, env), home = channel(a);
  await b.fed.subscribe(b.bob, a.fed.channelActor(home)); await drain(a, b);
  b.store.db.prepare("UPDATE federation_channel_cursors SET error='Previous network failure',retry_at=0").run();
  await b.fed.tick();
  assert.equal(b.store.db.prepare("SELECT error FROM federation_channel_cursors").get()!.error, null);
});

test("channel retention preserves published actor keys after author grants are revoked", async t => {
  const env = { TEST_LEGACY_CHANNEL_FEED: "true", FEDERATION_CHANNEL_TRANSPORT: "batch", FEDERATION_PEER_SEND_RATE: "0" };
  const a = await instance(t, env), b = await instance(t, env), home = channel(a);
  await b.fed.subscribe(b.bob, a.fed.channelActor(home)); await drain(a, b);
  a.store.post(a.alice, home.id, { body: "Historical proof" });
  a.store.db.prepare("UPDATE federation_channel_events SET created_at=?").run(Date.now() - 8 * 86400000);
  grant(a.store, a.alice, a.alice.id, Object.fromEntries(Object.keys(permissions).map(key => [key, false])));
  await a.fed.channelFeed.close(); a.restart();
  a.fed.channelFeed.page(b.fed.publicActor("users", b.bob.id), home.id, 1);
  assert.equal(a.store.db.prepare("SELECT COUNT(*) AS n FROM federation_channel_events").get()!.n, 0);
  assert.equal(a.fed.publicActor("users", a.alice.id).id, a.fed.userActor(a.alice));
  assert.equal(a.store.db.prepare("SELECT COUNT(*) AS n FROM federation_outgoing WHERE user_id=?").get(a.alice.id)!.n, 1);
});

async function memberApi(i: Awaited<ReturnType<typeof instance>>, username: string, path: string, body: unknown) {
  const login = await fetch(`${i.origin}/api/dev-login`, { method: "POST", headers: { Origin: i.origin, "Content-Type": "application/json" }, body: JSON.stringify({ username }) });
  const cookie = login.headers.getSetCookie().map(c => c.split(";")[0]).join("; ");
  const session = await fetch(`${i.origin}/api/session`, { headers: { Cookie: cookie } }).then(r => r.json());
  return fetch(i.origin + path, { method: "POST", headers: { Origin: i.origin, Cookie: cookie, "Content-Type": "application/json", "X-CSRF-Token": session.csrf }, body: JSON.stringify(body) });
}

test("private channel access and invitations work by remote address and by a federated role", async t => {
  const a = await instance(t), b = await instance(t), c = await instance(t);
  const home = channel(a, { visibility: "members", admission: "allowlist" });
  a.store.post(a.alice, home.id, { body: "Private history" });
  const actor = a.fed.channelActor(home);
  // Granting access before a follow sends no invitation, and does not create membership.
  const access = await memberApi(a, "alice", `/api/channels/${home.id}/access`, { address: `@bob@${new URL(b.origin).host}` });
  assert.equal(access.status, 200, await access.text());
  const helper = await a.fed.resolveMember(b.fed.userActor(b.bob));
  assert.equal(a.store.rule(home.id, helper.id), "allow");
  assert.equal(a.store.db.prepare("SELECT COUNT(*) AS n FROM direct_messages").get()!.n, 0);
  const sub = await b.fed.subscribe(b.bob, actor);
  await drain(a, b);
  assert.equal(b.store.role(sub.channel.id, b.bob.id), "member");
  const role = a.store.createChannelRole(a.alice, home.id, { name: "Host", allow_access: true });
  a.store.setMember(a.alice, home.id, helper.id, { channel_role: role.id });
  await drain(a, b);
  assert.equal(b.store.channelInfo(b.bob, b.store.channel(sub.channel.id)).permissions.allow_access, true);
  // A pending private follower is admitted as soon as an authorized invitation grants access.
  const waiting = await c.fed.subscribe(c.bob, actor);
  await drain(a, b, c);
  assert.equal(c.store.role(waiting.channel.id, c.bob.id), null);
  const invite = await memberApi(b, "bob", `/api/channels/${sub.channel.id}/invitations`, { address: c.fed.userActor(c.bob) });
  assert.equal(invite.status, 201, await invite.text());
  await drain(b, a, c);
  assert.equal(c.store.role(waiting.channel.id, c.bob.id), "member");
  assert.equal(c.store.messages(c.bob, waiting.channel.id)[0].body, "Private history");
  const message = c.store.db.prepare("SELECT body FROM direct_messages WHERE user_id=? AND direction='incoming'").get(c.bob.id)!;
  assert.match(String(message.body), /You're invited to #general/);
  assert.ok(String(message.body).includes(encodeURIComponent(actor)));
  // Independent grants also work through the home without sending an invitation.
  const grantAccess = await memberApi(b, "bob", `/api/channels/${sub.channel.id}/access`, { address: c.fed.userActor(c.alice) });
  assert.equal(grantAccess.status, 200, await grantAccess.text());
  await drain(b, a, c);
  const allowed = await a.fed.resolveMember(c.fed.userActor(c.alice));
  assert.equal(a.store.rule(home.id, allowed.id), "allow");
  assert.equal(c.store.db.prepare("SELECT COUNT(*) AS n FROM direct_messages WHERE user_id=?").get(c.alice.id)!.n, 0);
  // A queued request is rechecked by the home after role revocation.
  const late = await b.fed.resolveMember(a.fed.userActor(a.bob));
  b.fed.allowAccess(b.bob, b.store.channel(sub.channel.id), late);
  a.store.updateChannelRole(a.alice, home.id, role.id, { allow_access: false });
  await b.fed.tick();
  assert.equal(a.store.rule(home.id, a.bob.id), null);
  assert.equal(b.store.db.prepare("SELECT status FROM federation_deliveries ORDER BY id DESC LIMIT 1").get()!.status, "failed");
  b.store.db.prepare("DELETE FROM federation_deliveries WHERE status='failed'").run();
  await drain(a, b, c);
  const refused = await memberApi(b, "bob", `/api/channels/${sub.channel.id}/invitations`, { address: c.fed.userActor(c.alice) });
  assert.equal(refused.status, 403);
});

test("media authenticates subscribers through their home, including a third file server and immediate revocation", async t => {
  const a = await instance(t), b = await instance(t), c = await instance(t);
  const home = channel(a), actor = a.fed.channelActor(home);
  const bSub = await b.fed.subscribe(b.bob, actor);
  await c.fed.subscribe(c.bob, actor);
  await drain(a, b, c);
  const bytes = Buffer.from(image, "base64");
  const own = a.store.addAttachment(a.alice, bytes, "home.png");
  a.store.post(a.alice, home.id, { body: `![home](${own.url})` });
  await drain(a, b, c);
  const signed = (i: typeof a, user: typeof a.alice, url: string, method: "GET" | "HEAD" = "GET", extra = {}) =>
    fetch(url, { method, headers: { ...signedHeaders(new URL(url), method, i.fed.userActor(user), i.fed.keys().private_key), ...extra } });
  const sessions = new Map<string, string>();
  const proxy = (i: typeof a, user: typeof a.alice, url: string, method = "GET", extra = {}, download = false) => {
    const key = i.origin + user.id;
    if (!sessions.has(key)) sessions.set(key, i.store.createSession(user.id).token);
    return fetch(`${i.origin}/api/media?url=${encodeURIComponent(url)}${download ? "&download=1" : ""}`, {
      method, headers: { Cookie: `archipel=${sessions.get(key)}`, ...extra },
    });
  };
  assert.equal((await fetch(own.url)).status, 401);
  assert.equal((await fetch(`${c.origin}/api/media?url=${encodeURIComponent(own.url)}`)).status, 401);
  assert.equal((await signed(b, b.alice, own.url)).status, 403);
  assert.equal((await proxy(c, c.alice, own.url)).status, 403);
  const received = await proxy(c, c.bob, own.url);
  assert.equal(received.status, 200);
  assert.equal(received.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(Buffer.from(await received.arrayBuffer()), bytes);
  assert.equal((await signed(b, b.bob, own.url, "HEAD")).status, 200);
  const tampered = signedHeaders(new URL(own.url), "GET", b.fed.userActor(b.bob), c.fed.keys().private_key);
  assert.equal((await fetch(own.url, { headers: tampered })).status, 401);

  // The uploader lives on B, the channel on A, and the viewer on C.
  const videoBytes = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.alloc(16)]);
  const foreign = b.store.addAttachment(b.bob, videoBytes, "peer.mp4");
  await b.fed.remotePost(b.bob, bSub.channel.id, { body: `![peer](${foreign.url})` });
  await drain(a, b, c);
  const range = await proxy(c, c.bob, foreign.url, "GET", { Range: "bytes=2-5" });
  assert.equal(range.status, 206);
  assert.equal(range.headers.get("content-range"), `bytes 2-5/${videoBytes.length}`);
  assert.deepEqual(Buffer.from(await range.arrayBuffer()), videoBytes.subarray(2, 6));
  const head = await proxy(a, a.alice, foreign.url, "HEAD");
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-length"), String(videoBytes.length));
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  const download = await proxy(c, c.bob, foreign.url, "GET", {}, true);
  assert.match(download.headers.get("content-disposition")!, /^attachment;/);
  const beyond = await proxy(c, c.bob, foreign.url, "GET", { Range: `bytes=${videoBytes.length}-` });
  assert.equal(beyond.status, 416);
  assert.equal(beyond.headers.get("content-range"), `bytes */${videoBytes.length}`);
  assert.equal((await proxy(c, c.bob, `${b.origin}/health`)).status, 400);
  b.fed.block(b.alice, { kind: "instance", target: a.origin, blocked: true });
  assert.equal((await proxy(a, a.alice, foreign.url)).status, 403);
  b.fed.block(b.alice, { kind: "instance", target: a.origin, blocked: false });

  const waiting = channel(a, { name: "waiting", visibility: "members", admission: "allowlist" });
  const pendingFile = a.store.addAttachment(a.alice, bytes, "pending.png");
  a.store.post(a.alice, waiting.id, { body: `![pending](${pendingFile.url})` });
  await c.fed.subscribe(c.bob, a.fed.channelActor(waiting));
  await drain(a, b, c);
  assert.equal((await signed(c, c.bob, pendingFile.url)).status, 403);

  // Reposting a private upload URL into a different channel cannot grant access.
  a.store.join(a.bob, home.id);
  const privateChannel = a.store.createChannel(a.alice, { name: "private", description: "", mode: "timeline", visibility: "members", admission: "allowlist" });
  const secret = a.store.addAttachment(a.alice, bytes, "secret.png");
  a.store.post(a.alice, privateChannel.id, { body: `![secret](${secret.url})` });
  a.store.post(a.bob, home.id, { body: `![copied](${secret.url})` });
  await drain(a, b, c);
  assert.equal((await signed(c, c.bob, secret.url)).status, 403);
  assert.equal((await proxy(c, c.bob, secret.url)).status, 403);

  const follower = a.store.db.prepare("SELECT id FROM users WHERE remote_actor=?").get(c.fed.userActor(c.bob))!;
  a.store.setMember(a.alice, home.id, follower.id, { remove: true });
  // C's cached accepted subscription and messages still exist, but A has revoked it.
  assert.equal((await proxy(c, c.bob, own.url)).status, 403);
  assert.equal((await proxy(c, c.bob, foreign.url)).status, 403);
  assert.equal((await signed(c, c.bob, foreign.url, "HEAD")).status, 403);
  assert.equal((await signed(c, c.bob, foreign.url, "GET", { Range: "bytes=0-2" })).status, 403);
  assert.equal((await proxy(a, a.alice, foreign.url)).status, 200);

  await drain(a, b, c);
  await c.fed.subscribe(c.bob, actor);
  await drain(a, b, c);
  assert.equal((await proxy(c, c.bob, foreign.url)).status, 200);
  a.store.banInstance(a.alice, home.id, { instance: c.origin, banned: true });
  assert.equal((await proxy(c, c.bob, foreign.url)).status, 403);

  // Deleting at the authoritative home takes effect before B receives the deletion.
  const message = a.store.db.prepare("SELECT id FROM messages WHERE instr(body,?)>0").get(foreign.url)!;
  a.store.deleteMessage(a.alice, message.id);
  assert.equal((await proxy(a, a.alice, foreign.url)).status, 403);
});

test("direct media is authenticated and private to its participants", async t => {
  const a = await instance(t), b = await instance(t);
  const file = a.store.addAttachment(a.bob, Buffer.from(image, "base64"), "direct.png");
  await a.fed.sendDirect(a.bob, b.fed.userActor(b.bob), `![private](${file.url})`);
  await drain(a, b);
  const ask = (user: typeof b.bob) => fetch(file.url, {
    headers: signedHeaders(new URL(file.url), "GET", b.fed.userActor(user), b.fed.keys().private_key),
  });
  assert.equal((await fetch(file.url)).status, 401);
  assert.equal((await ask(b.alice)).status, 403);
  assert.equal((await ask(b.bob)).status, 200);
  const session = b.store.createSession(b.bob.id);
  const url = `${b.origin}/api/media?url=${encodeURIComponent(file.url)}`;
  const request = () => fetch(url, { headers: { Cookie: `archipel=${session.token}` } });
  assert.equal((await request()).status, 200);
  b.store.setUserBlock(b.bob, a.fed.userActor(a.bob), true);
  assert.equal((await request()).status, 403);
});

test("removing or banning a follower, or banning their instance, ends the follow until it is lifted", async (t) => {
  const a = await instance(t), b = await instance(t);
  const home = channel(a), actor = a.fed.channelActor(home);
  const follower = () =>
    a.store.details(a.alice, home.id).members.find((u) => u.actor_url === b.fed.userActor(b.bob));
  const follow = async () => {
    const sub = await b.fed.subscribe(b.bob, actor);
    await drain(a, b);
    return b.store.role(sub.channel.id, b.bob.id);
  };
  assert.equal(await follow(), "member");
  // Removed: the follow ends there too, and they can come back.
  a.store.setMember(a.alice, home.id, follower()!.id, { remove: true });
  await drain(a, b);
  assert.equal(follower(), undefined);
  assert.equal(b.fed.subscriptions(b.bob)[0].status, "rejected");
  assert.equal(await follow(), "member");
  // Banned: asking again is refused until the ban is lifted.
  const banned = follower()!.id;
  a.store.setMember(a.alice, home.id, banned, { rule: "block" });
  await drain(a, b);
  assert.equal(await follow(), null);
  a.store.setMember(a.alice, home.id, banned, { rule: "clear" });
  assert.equal(await follow(), "member");
  // The whole instance: nothing more is relayed to it, and nobody there gets in.
  a.store.post(a.alice, home.id, { body: "Queued before the ban" });
  a.store.banInstance(a.alice, home.id, { instance: b.origin, banned: true });
  await drain(a, b);
  assert.equal(follower(), undefined);
  assert.equal(b.store.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE body='Queued before the ban'").get()!.n, 0);
  assert.equal(await follow(), null);
  const other = await b.fed.subscribe(b.alice, actor);
  await drain(a, b);
  assert.equal(b.store.role(other.channel.id, b.alice.id), null);
  assert.equal(a.store.db.prepare("SELECT COUNT(*) AS n FROM federation_follows").get()!.n, 0);
  a.store.banInstance(a.alice, home.id, { instance: b.origin, banned: false });
  assert.equal(await follow(), "member");
});

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

test("channel announcements share one inbox POST and peer allowance while preserving every follower row", async t => {
  const a = await instance(t), b = await instance(t), c = await instance(t);
  const home = channel(a), address = a.fed.channelActor(home);
  const sub = await b.fed.subscribe(b.bob, address);
  await b.fed.subscribe(b.alice, address); await c.fed.subscribe(c.bob, address);
  await drain(a, b, c);
  let bRequests = 0, cRequests = 0;
  b.server.on("request", req => { if ((req.url === "/federation/inbox" || req.url === "/inbox")) bRequests++; });
  c.server.on("request", req => { if ((req.url === "/federation/inbox" || req.url === "/inbox")) cRequests++; });
  a.config.federationPeerSendRate = 1;
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() + 60001 });
  a.store.post(a.alice, home.id, { body: "First shared announcement" });
  a.store.post(a.alice, home.id, { body: "Second shared announcement" });
  await a.fed.tick();
  assert.deepEqual([bRequests, cRequests], [1, 1], JSON.stringify(a.store.db.prepare("SELECT status,error FROM federation_deliveries WHERE status!='sent'").all()));
  const status = () => a.store.db.prepare("SELECT d.status,d.attempts FROM federation_deliveries d JOIN federation_outgoing o ON o.id=d.activity_id WHERE o.purpose='relay' ORDER BY d.id").all();
  assert.deepEqual(status().map(r => `${r.status}:${r.attempts}`), ["sent:1", "sent:1", "sent:1", "pending:0", "pending:0", "pending:0"]);
  assert.deepEqual(b.store.messages(b.bob, sub.channel.id).map(m => m.body), ["First shared announcement"]);
  t.mock.timers.tick(60001); await a.fed.tick();
  assert.deepEqual([bRequests, cRequests], [2, 2]);
  assert.ok(status().every(r => r.status === "sent" && r.attempts === 1));
  assert.deepEqual(b.store.messages(b.bob, sub.channel.id).map(m => m.body), ["First shared announcement", "Second shared announcement"]);
});

test("shared-inbox retries survive restart and hold later announcements behind each follower's head", async t => {
  const a = await instance(t), b = await instance(t), home = channel(a);
  const sub = await b.fed.subscribe(b.bob, a.fed.channelActor(home));
  await b.fed.subscribe(b.alice, a.fed.channelActor(home)); await drain(a, b);
  let requests = 0;
  b.server.on("request", req => { if ((req.url === "/federation/inbox" || req.url === "/inbox")) requests++; });
  b.offline(true); a.store.post(a.alice, home.id, { body: "Retried first" }); await a.fed.tick();
  assert.equal(requests, 1);
  const first = a.store.db.prepare("SELECT d.attempts,d.next_attempt,d.status FROM federation_deliveries d JOIN federation_outgoing o ON o.id=d.activity_id WHERE o.purpose='relay'").all();
  assert.equal(first.length, 2); assert.ok(first.every(r => r.status === "pending" && r.attempts === 1));
  assert.equal(first[0].next_attempt, first[1].next_attempt);
  a.restart(); b.offline(false); a.store.post(a.alice, home.id, { body: "Ordered second" });
  await a.fed.tick(); assert.equal(requests, 1); assert.equal(b.store.messages(b.bob, sub.channel.id).length, 0);
  a.store.db.prepare("UPDATE federation_deliveries SET next_attempt=0 WHERE status='pending'").run();
  await a.fed.tick(); assert.equal(requests, 3, JSON.stringify(a.store.db.prepare("SELECT status,error FROM federation_deliveries WHERE status!='sent'").all()));
  assert.deepEqual(b.store.messages(b.bob, sub.channel.id).map(m => m.body), ["Retried first", "Ordered second"]);
});

test("unchanged actor revalidation shares concurrent fetches, keeps the one-minute TTL, and avoids timestamp-only commits", async t => {
  const a = await instance(t), b = await instance(t), id = b.fed.userActor(b.bob);
  await a.fed.actor(id);
  const old = a.store.db.prepare("SELECT fetched_at FROM federation_actors WHERE id=?").get(id)!.fetched_at;
  let fetches = 0;
  b.server.on("request", req => { if (req.url === `/actors/users/${b.bob.id}`) fetches++; });
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() + 60001 });
  await Promise.all(Array.from({ length: 8 }, () => a.fed.actor(id)));
  assert.equal(fetches, 1);
  assert.equal(a.store.db.prepare("SELECT fetched_at FROM federation_actors WHERE id=?").get(id)!.fetched_at, old);
  await a.fed.actor(id); assert.equal(fetches, 1);
  t.mock.timers.tick(60001); await a.fed.actor(id); assert.equal(fetches, 2);
  b.store.db.prepare("UPDATE users SET display_name='New remote name' WHERE id=?").run(b.bob.id);
  assert.equal((await a.fed.actor(id, true)).name, "New remote name");
  assert.equal(fetches, 3);
  assert.equal((await a.fed.actor(id)).name, "New remote name");
  assert.ok(a.store.db.prepare("SELECT fetched_at FROM federation_actors WHERE id=?").get(id)!.fetched_at > old);
  a.fed.block(a.alice, { kind: "instance", target: b.origin, blocked: true });
  await assert.rejects(a.fed.actor(id), Problem);
});

test("peer discovery reuses its validated connection and rechecks URL policy before any reuse", async t => {
  const a = await instance(t), b = await instance(t), url = new URL(b.fed.userActor(b.bob));
  const sockets = new Set();
  b.server.on("request", req => { if (req.url === url.pathname) sockets.add(req.socket); });
  const first = await peerRequest(url, a.config, { accept: "application/activity+json" });
  const second = await peerRequest(url, a.config, { accept: "application/activity+json" });
  assert.equal(first.status, 200); assert.equal(second.status, 200);
  assert.equal(sockets.size, 1);
  await assert.rejects(peerRequest(url, loadConfig({ BASE_URL: "https://production.example", HOST: "0.0.0.0" }),
    { accept: "application/activity+json" }), Problem);
  assert.equal(sockets.size, 1);
});

test("large channel announcements retain every delivery row without expanding the wire audience", async t => {
  const a = await instance(t), home = channel(a), actor = a.fed.channelActor(home);
  a.store.transaction(() => {
    for (let i = 0; i < 1400; i++) a.store.db.prepare("INSERT INTO federation_follows(channel_id,actor,follow_id,status) VALUES(?,?,?,'accepted')")
      .run(home.id, `https://large-peer.example/actors/users/${String(i).padStart(36,"0")}`, `follow-${i}`);
  });
  a.store.post(a.alice, home.id, { body: "A small message in a large channel" });
  const row = a.store.db.prepare("SELECT id,activity FROM federation_outgoing WHERE purpose='relay'").get()!;
  const activity = JSON.parse(String(row.activity));
  assert.deepEqual(activity.to, [actor]);
  assert.ok(Buffer.byteLength(String(row.activity)) < 65536);
  assert.equal(a.store.db.prepare("SELECT COUNT(*) AS n FROM federation_deliveries WHERE activity_id=?").get(row.id)!.n, 1400);
});

test("shared-inbox consolidation cancels a revoked follower without cancelling an allowed follower", async t => {
  const a = await instance(t), b = await instance(t), home = channel(a);
  const sub = await b.fed.subscribe(b.bob, a.fed.channelActor(home));
  await b.fed.subscribe(b.alice, a.fed.channelActor(home)); await drain(a, b);
  a.store.post(a.alice, home.id, { body: "One remaining follower" });
  a.fed.decideFollow(a.alice, home.id, b.fed.userActor(b.bob), "blocked");
  await drain(a, b);
  const rows = a.store.db.prepare("SELECT d.recipient,d.status FROM federation_deliveries d JOIN federation_outgoing o ON o.id=d.activity_id WHERE o.purpose='relay'").all();
  assert.equal(rows.find(r => r.recipient === b.fed.userActor(b.bob))?.status, "cancelled");
  assert.equal(rows.find(r => r.recipient === b.fed.userActor(b.alice))?.status, "sent");
  assert.throws(() => b.store.messages(b.bob, sub.channel.id), Problem);
  assert.equal(b.store.messages(b.alice, sub.channel.id)[0].body, "One remaining follower");
});

test("followers on the same origin with different advertised inboxes are delivered separately", async t => {
  const a = await instance(t), b = await instance(t), home = channel(a);
  const sub = await b.fed.subscribe(b.bob, a.fed.channelActor(home));
  await b.fed.subscribe(b.alice, a.fed.channelActor(home)); await drain(a, b);
  const actor = await a.fed.actor(b.fed.userActor(b.alice));
  actor.inbox += "?recipient=alice";
  a.store.db.prepare("UPDATE federation_actors SET document=?,fetched_at=? WHERE id=?")
    .run(JSON.stringify(actor), Date.now(), actor.id);
  const requests: string[] = [];
  b.server.on("request", req => { if (req.url?.startsWith("/federation/inbox") || req.url?.startsWith("/inbox")) requests.push(req.url.replace(/^\/federation/, "")); });
  a.store.post(a.alice, home.id, { body: "Separate inbox endpoints" }); await a.fed.tick();
  assert.deepEqual(requests.sort(), ["/inbox", "/inbox?recipient=alice"], JSON.stringify(a.store.db.prepare("SELECT status,error FROM federation_deliveries WHERE status!='sent'").all()));
  assert.equal(b.store.messages(b.bob, sub.channel.id).length, 1);
});

test("authorization is checked again after asynchronous inbox discovery for a shared announcement", async t => {
  const a = await instance(t), b = await instance(t), home = channel(a);
  await b.fed.subscribe(b.bob, a.fed.channelActor(home));
  await b.fed.subscribe(b.alice, a.fed.channelActor(home)); await drain(a, b);
  const original = a.fed.actor.bind(a.fed); let revoked = false, requests = 0;
  t.mock.method(a.fed, "actor", async (id: string, refresh = false) => {
    const actor = await original(id, refresh);
    if (!revoked) { revoked = true; grant(a.store, a.alice, a.alice.id, { ...permissions, federation_send: false }); }
    return actor;
  });
  b.server.on("request", req => { if ((req.url === "/federation/inbox" || req.url === "/inbox")) requests++; });
  a.store.post(a.alice, home.id, { body: "Revoked during discovery" }); await a.fed.tick();
  assert.equal(requests, 0);
  const rows = a.store.db.prepare("SELECT d.status FROM federation_deliveries d JOIN federation_outgoing o ON o.id=d.activity_id WHERE o.purpose='relay'").all();
  assert.equal(rows.length, 2); assert.ok(rows.every(r => r.status === "cancelled"));
});

test("a slow delivery does not hold an independent recipient or allow its own later message to overtake", async t => {
  const a = await instance(t), b = await instance(t), c = await instance(t);
  let release!: () => void, reached!: () => void;
  const gate = new Promise<void>(done => { release = done; });
  const arrived = new Promise<void>(done => { reached = done; });
  const slow = b.fed.receive.bind(b.fed), fast = c.fed.receive.bind(c.fed);
  t.mock.method(b.fed, "receive", async (...args: Parameters<typeof slow>) => { await gate; await slow(...args); });
  t.mock.method(c.fed, "receive", async (...args: Parameters<typeof fast>) => { await fast(...args); reached(); });
  await a.fed.sendDirect(a.bob, b.fed.userActor(b.bob), "Slow first");
  await a.fed.sendDirect(a.bob, b.fed.userActor(b.bob), "Ordered second");
  await a.fed.sendDirect(a.bob, c.fed.userActor(c.bob), "Independent fast");
  const job = a.fed.tick();
  let deadline!: NodeJS.Timeout;
  try {
    await Promise.race([arrived, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error("Independent delivery was held behind a slow peer")), 2000); })]);
    assert.deepEqual(c.fed.directMessages(c.bob).map(m => m.body), ["Independent fast"]);
    assert.equal(b.fed.directMessages(b.bob).length, 0);
    assert.deepEqual(a.store.db.prepare("SELECT attempts,status FROM federation_deliveries WHERE recipient=? ORDER BY id").all(b.fed.userActor(b.bob))
      .map(r => `${r.status}:${r.attempts}`), ["pending:0", "pending:0"]);
  } finally { clearTimeout(deadline); release(); await job; }
  assert.deepEqual(b.fed.directMessages(b.bob).map(m => m.body), ["Slow first", "Ordered second"]);
});

test("personal remote blocks reject incoming messages and cancel queued sends until unblocked", async (t) => {
  const a = await instance(t), b = await instance(t);
  const aPeer = `${a.origin}/actors/users/${a.bob.id}`;
  const bPeer = `${b.origin}/actors/users/${b.bob.id}`;
  await a.fed.sendDirect(a.bob, bPeer, "Queued before block");
  assert.equal((a.store.directHistory(a.bob, bPeer).messages[0] as { queued?: boolean }).queued, true);
  assert.equal(a.fed.directMessages(a.bob)[0].queued, true);
  a.store.setUserBlock(a.bob, bPeer, true);
  await a.fed.tick();
  assert.equal((a.store.directHistory(a.bob, bPeer).messages[0] as { failed?: string }).failed, "You blocked this user.");
  assert.equal(a.fed.directMessages(a.bob)[0].failed, "You blocked this user.");
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
  const delivered = a.store.directHistory(a.bob, bPeer).messages.find(m => m.body === "Reply after unblock")!;
  assert.equal("queued" in delivered, false);
});

test("pending channel posts preserve topics and parents, expose failures only to their author, and disappear on echo", async (t) => {
  const a = await instance(t), b = await instance(t);
  for (const mode of ["timeline", "topical", "threaded"]) {
    const home = channel(a, { name: `pending-${mode}`, mode });
    const topic = mode === "topical" ? a.store.createTopic(a.alice, home.id, "Updates") : null;
    a.store.post(a.alice, home.id, {
      body: `Root in ${mode}`, ...(topic ? { topic_id: topic.id } : {}),
      ...(mode === "threaded" ? { title: "A thread" } : {}),
    });
    const sub = await b.fed.subscribe(b.bob, a.fed.channelActor(home));
    await drain(a, b);
    const parent = b.store.messages(b.bob, sub.channel.id)[0];
    const waiting = await b.fed.remotePost(b.bob, sub.channel.id, {
      body: `Reply in ${mode}`, parent_id: parent.id,
      ...(parent.topic_id ? { topic_id: parent.topic_id } : {}),
    });
    assert.equal(waiting.parent_id, parent.id);
    assert.equal(waiting.topic_id, parent.topic_id);
    assert.deepEqual(b.fed.pendingPosts(b.bob, sub.channel.id), [waiting]);
    for (const status of ["failed", "cancelled"]) {
      b.store.db.prepare("UPDATE federation_deliveries SET status=?,error='Peer refused the message' WHERE activity_id IN (SELECT id FROM federation_outgoing WHERE channel_id=? AND purpose='post')").run(status, sub.channel.id);
      assert.equal(b.fed.pendingPosts(b.bob, sub.channel.id)[0].failed, "Peer refused the message");
      assert.deepEqual(b.fed.pendingPosts(b.alice, sub.channel.id), []);
    }
    b.store.db.prepare("UPDATE federation_deliveries SET status='pending',error=NULL WHERE activity_id IN (SELECT id FROM federation_outgoing WHERE channel_id=? AND purpose='post')").run(sub.channel.id);
    await drain(a, b);
    assert.deepEqual(b.fed.pendingPosts(b.bob, sub.channel.id), []);
    assert.equal(b.store.messages(b.bob, sub.channel.id).filter(m => m.body === `Reply in ${mode}`).length, 1);
  }
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
  const waiting = await b.fed.remotePost(b.bob, sub.channel.id, { body: "Hello from remote" });
  // Until the home instance sends it back, the author sees it as a message still being sent.
  assert.equal(waiting.queued, true);
  assert.deepEqual(b.fed.pendingPosts(b.bob, sub.channel.id), [waiting]);
  assert.deepEqual(b.fed.pendingPosts(b.alice, sub.channel.id), []);
  assert.ok(!b.store.messages(b.bob, sub.channel.id).some(m => m.body === "Hello from remote"));
  await drain(a, b);
  assert.deepEqual(b.fed.pendingPosts(b.bob, sub.channel.id), []);
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

test("a role held from another instance deletes, removes and bans through the channel's home, which alone decides", async (t) => {
  const a = await instance(t), b = await instance(t);
  const home = channel(a), actor = a.fed.channelActor(home);
  const sub = await b.fed.subscribe(b.bob, actor), copy = sub.channel.id;
  const follow = async () => {
    await b.fed.subscribe(b.alice, actor);
    await drain(a, b);
    return b.store.role(copy, b.alice.id);
  };
  assert.equal(await follow(), "member");
  // Each side knows the other's people by its own ids.
  const known = (i: typeof a, address: string) =>
    (i.store.db.prepare("SELECT id FROM users WHERE remote_actor=?").get(address) as { id: string }).id;
  const bobAtHome = known(a, b.fed.userActor(b.bob)),
    ownerAway = known(b, a.fed.userActor(a.alice));
  const said = async (body: string) => {
    const message = a.store.post(a.alice, home.id, { body });
    await drain(a, b);
    return {
      home: message.id,
      away: (b.store.db.prepare("SELECT id FROM messages WHERE channel_id=? AND body=?").get(copy, body) as { id: string }).id,
    };
  };
  const mine = () => b.store.channelInfo(b.bob, b.store.channel(copy));
  const denied = (action: () => unknown) =>
    assert.throws(action, (e: unknown) => e instanceof Problem && e.status === 403);
  // What this instance sent for Bob and the home would not have.
  const refused = async () => {
    for (let step = 0; step < 5; step++) for (const i of [a, b]) await i.fed.tick();
    const left = b.store.db
      .prepare("SELECT d.status FROM federation_deliveries d JOIN federation_outgoing o ON o.id=d.activity_id WHERE o.purpose='moderate' AND d.status!='sent'")
      .all();
    assert.deepEqual(left.map((d) => d.status), ["failed"]);
    b.store.db.prepare("DELETE FROM federation_deliveries WHERE status='failed'").run();
  };
  const everything = ["allow_access", "kick_members", "ban_members", "ban_instances", "delete_messages"] as const;

  // Without a role nothing is offered, and saying here that Bob holds one moves nothing at the home.
  const first = await said("Not Bob's to remove");
  denied(() => b.fed.deleteRemote(b.bob, first.away));
  denied(() => b.fed.moderateRemote(b.bob, copy, b.alice.id, { remove: true }));
  b.store.keepHeldRole(copy, b.bob.id, { name: "Claimed", permissions: [...everything] });
  b.fed.deleteRemote(b.bob, first.away);
  await refused();
  b.fed.moderateRemote(b.bob, copy, b.alice.id, { rule: "block" });
  await refused();
  assert.equal(a.store.message(first.home).deleted_at, null);
  assert.equal(a.store.rule(home.id, known(a, b.fed.userActor(b.alice))), null);

  // The owner gives the role: the home tells Bob's instance, replacing what it had.
  const helper = a.store.createChannelRole(a.alice, home.id, { name: "Helper", delete_messages: true, ban_instances: true });
  a.store.setMember(a.alice, home.id, bobAtHome, { channel_role: helper.id });
  await drain(a, b);
  assert.deepEqual(mine().channel_role, { id: "", name: "Helper" });
  // Banning instances stays with the home, whatever the role says.
  assert.deepEqual(mine().permissions, { allow_access: false, kick_members: false, ban_members: false, ban_instances: false, delete_messages: true });
  denied(() => b.store.deleteMessage(b.bob, first.away));
  b.fed.deleteRemote(b.bob, first.away);
  await drain(a, b);
  assert.ok(a.store.message(first.home).deleted_at);
  assert.ok(b.store.message(first.away).deleted_at);
  // What the role does not allow is refused here, and by the home when sent anyway.
  denied(() => b.fed.moderateRemote(b.bob, copy, b.alice.id, { remove: true }));
  denied(() => b.fed.moderateRemote(b.bob, copy, b.alice.id, { remove: true, role: "moderator" }));
  b.store.keepHeldRole(copy, b.bob.id, { name: "Helper", permissions: [...everything] });
  b.fed.moderateRemote(b.bob, copy, b.alice.id, { remove: true });
  await refused();
  assert.equal(b.store.role(copy, b.alice.id), "member");

  // A changed role reaches its holders. It removes and bans members, not the owner.
  a.store.updateChannelRole(a.alice, home.id, helper.id, { kick_members: true, ban_members: true });
  await drain(a, b);
  assert.deepEqual(mine().permissions, { allow_access: false, kick_members: true, ban_members: true, ban_instances: false, delete_messages: true });
  // Whoever may remove or ban is shown the members a channel keeps to itself, and the list says
  // again what role each of this instance's subscribers holds.
  a.store.setPrivacy(a.alice, home.id, { show_members: false });
  await drain(a, b);
  b.store.keepHeldRole(copy, b.bob.id, { name: "Claimed", permissions: [...everything] });
  await b.fed.refreshRoster(b.bob, copy);
  assert.equal(b.store.details(b.bob, copy).members.length, 3);
  assert.equal(mine().channel_role?.name, "Helper");
  a.store.setPrivacy(a.alice, home.id, { show_members: true });
  await drain(a, b);
  b.fed.moderateRemote(b.bob, copy, ownerAway, { remove: true });
  await refused();
  b.fed.moderateRemote(b.bob, copy, b.alice.id, { remove: true });
  await drain(a, b);
  assert.equal(b.store.role(copy, b.alice.id), null);
  assert.equal(await follow(), "member");
  b.fed.moderateRemote(b.bob, copy, b.alice.id, { rule: "block" });
  await drain(a, b);
  assert.equal(await follow(), null);
  b.fed.moderateRemote(b.bob, copy, b.alice.id, { rule: "clear" });
  await drain(a, b);
  assert.equal(await follow(), "member");
  // Someone else who holds a role is out of its reach, as at home.
  a.store.setMember(a.alice, home.id, known(a, b.fed.userActor(b.alice)), { channel_role: helper.id });
  await drain(a, b);
  b.fed.moderateRemote(b.bob, copy, b.alice.id, { remove: true });
  await refused();
  assert.equal(b.store.role(copy, b.alice.id), "member");

  // Taking the role back ends it on both sides.
  const second = await said("Still here");
  a.store.setMember(a.alice, home.id, bobAtHome, { channel_role: null });
  await drain(a, b);
  assert.equal(mine().channel_role, null);
  denied(() => b.fed.deleteRemote(b.bob, second.away));
  b.store.keepHeldRole(copy, b.bob.id, { name: "Helper", permissions: [...everything] });
  b.fed.deleteRemote(b.bob, second.away);
  await refused();
  assert.equal(a.store.message(second.home).deleted_at, null);

  // So does the end of the follow, and following again does not bring it back.
  a.store.setMember(a.alice, home.id, bobAtHome, { channel_role: helper.id });
  await drain(a, b);
  assert.equal(mine().permissions.delete_messages, true);
  b.fed.unsubscribe(b.bob, copy);
  await drain(a, b);
  assert.equal(a.store.channelRole(home.id, bobAtHome), undefined);
  assert.equal(b.store.heldRole(copy, b.bob.id), undefined);
  await b.fed.subscribe(b.bob, actor);
  await drain(a, b);
  assert.equal(b.store.role(copy, b.bob.id), "member");
  assert.equal(mine().channel_role, null);
  denied(() => b.fed.deleteRemote(b.bob, second.away));
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
test("reactions cross instances in both directions and follow the home channel's setting", async (t) => {
  const a = await instance(t),
    b = await instance(t);
  const home = channel(a),
    host = new URL(a.origin).host;
  const sub = await b.fed.subscribe(b.bob, `#general@${host}`);
  await drain(a, b);
  const first = a.store.post(a.alice, home.id, { body: "React to me" });
  await drain(a, b);
  const copy = () => b.store.messages(b.bob, sub.channel.id)[0] as unknown as { id: string; reactions: unknown };
  b.fed.remoteReact(b.bob, copy().id, { emoji: "tada", on: true });
  await drain(a, b);
  assert.deepEqual((a.store.messages(a.alice, home.id)[0] as unknown as { reactions: unknown }).reactions, [{ emoji: "tada", count: 1, mine: false }]);
  assert.deepEqual(copy().reactions, [{ emoji: "tada", count: 1, mine: true }]);
  a.store.react(a.alice, first.id, { emoji: "tada", on: true });
  await drain(a, b);
  assert.deepEqual(copy().reactions, [{ emoji: "tada", count: 2, mine: true }]);
  b.fed.remoteReact(b.bob, copy().id, { emoji: "tada", on: false });
  await drain(a, b);
  assert.deepEqual(copy().reactions, [{ emoji: "tada", count: 1, mine: false }]);
  a.store.setReactions(a.alice, home.id, false);
  await drain(a, b);
  assert.throws(() => b.fed.remoteReact(b.bob, copy().id, { emoji: "tada", on: true }), /turned off/);
});
test("a custom emoji of the reader's own instance is a reaction in a followed channel, until its home removes or bans it", async (t) => {
  const a = await instance(t),
    b = await instance(t);
  const home = channel(a),
    host = new URL(a.origin).host;
  const sub = await b.fed.subscribe(b.bob, `#general@${host}`);
  await drain(a, b);
  const first = a.store.post(a.alice, home.id, { body: "React to me" });
  await drain(a, b);
  type Seen = { emoji: string; count: number; mine: boolean; url?: string }[];
  const copy = () => b.store.messages(b.bob, sub.channel.id)[0] as unknown as { id: string; reactions: Seen },
    atHome = () => a.store.reactionsOf(a.alice, first.id) as Seen;
  assert.throws(() => b.fed.remoteReact(b.bob, copy().id, { emoji: "island", on: true }), /not available/);
  b.store.addEmoji(b.alice, { name: "island", image });
  b.fed.remoteReact(b.bob, copy().id, { emoji: "island", on: true });
  await drain(a, b);
  // Its home has no emoji of that name: it keeps the picture that came along, and so can its members use it.
  assert.deepEqual(atHome().map(({ url: _, ...r }) => r), [{ emoji: "island", count: 1, mine: false }]);
  assert.equal(a.store.emojiImage(atHome()[0].url!.split("/").at(-2)!).mime, "image/png");
  assert.match(copy().reactions[0].url!, /^\/api\/emojis\/[^/]+\/image$/);
  a.store.react(a.alice, first.id, { emoji: "island", on: true });
  await drain(a, b);
  assert.deepEqual(copy().reactions.map((r) => [r.emoji, r.count, r.mine]), [["island", 2, true]]);
  // A moderator at home takes it off for everyone, wherever they read.
  assert.throws(() => b.store.clearReaction(b.alice, copy().id, "island"), /home instance/);
  a.store.clearReaction(a.alice, first.id, "island");
  await drain(a, b);
  assert.deepEqual([atHome(), copy().reactions], [[], []]);
  // Banned at home, it is gone from the copies and refused before it is sent.
  b.fed.remoteReact(b.bob, copy().id, { emoji: "island", on: true });
  b.fed.remoteReact(b.bob, copy().id, { emoji: "tada", on: true });
  await drain(a, b);
  assert.equal(copy().reactions.length, 2);
  a.store.banReaction(a.alice, home.id, { emoji: "island", banned: true });
  await drain(a, b);
  assert.deepEqual(copy().reactions.map((r) => r.emoji), ["tada"]);
  assert.deepEqual(b.store.channelInfo(b.bob, b.store.channel(sub.channel.id)).reaction_bans, ["island"]);
  assert.throws(() => b.fed.remoteReact(b.bob, copy().id, { emoji: "island", on: true }), /banned/);
});
test("untitled threads cross instances where the home channel makes titles optional", async (t) => {
  const a = await instance(t),
    b = await instance(t);
  const home = channel(a, { mode: "threaded" });
  const sub = await b.fed.subscribe(b.bob, a.fed.channelActor(home));
  await drain(a, b);
  const here = () => b.store.channel(sub.channel.id);
  assert.equal(here().optional_titles, 0);
  await assert.rejects(b.fed.remotePost(b.bob, sub.channel.id, { body: "No title yet" }), /structure/);
  a.store.setOptionalTitles(a.alice, home.id, true);
  await drain(a, b);
  assert.equal(here().optional_titles, 1);
  a.store.post(a.alice, home.id, { body: "Untitled at home" });
  await b.fed.remotePost(b.bob, sub.channel.id, { body: "Untitled from afar" });
  await drain(a, b);
  for (const [store, reader, id] of [[a.store, a.alice, home.id], [b.store, b.bob, sub.channel.id]] as const)
    assert.deepEqual(
      store.messages(reader, id).map((m) => [m.body, m.title]).sort(),
      [["Untitled at home", null], ["Untitled from afar", null]],
    );
  a.store.setOptionalTitles(a.alice, home.id, false);
  await drain(a, b);
  assert.equal(here().optional_titles, 0);
  await assert.rejects(b.fed.remotePost(b.bob, sub.channel.id, { body: "Too late" }), /structure/);
});
test("a federated channel lists its members on every instance, unless its home keeps the list", async (t) => {
  const a = await instance(t),
    b = await instance(t),
    c = await instance(t);
  const home = channel(a),
    host = new URL(a.origin).host;
  a.store.join(a.bob, home.id);
  const sub = await b.fed.subscribe(b.bob, `#general@${host}`);
  await drain(a, b);
  const list = (i: typeof a, id: string) =>
    i.store.details(i.bob, id).members.map((u) => `${u.actor_url}|${u.role}|${u.held}`).sort();
  const everyone = (...extra: string[]) =>
    [`${a.fed.userActor(a.alice)}|owner|`, `${a.fed.userActor(a.bob)}|member|`, `${b.fed.userActor(b.bob)}|member|`, ...extra].sort();
  const held = (rows: string[], origin: string) => rows.map((row) => row + row.startsWith(origin));
  // The home lists its followers, and the follower was told who is at the home when accepted.
  assert.deepEqual(list(a, home.id), held(everyone(), a.origin));
  assert.deepEqual(list(b, sub.channel.id), held(everyone(), b.origin));
  assert.equal(b.store.details(b.bob, sub.channel.id).member_count, 3);
  // Someone following from a third instance appears at the second once it asks again.
  const third = await c.fed.subscribe(c.bob, `#general@${host}`);
  await drain(a, c);
  assert.equal(list(b, sub.channel.id).length, 3);
  await b.fed.refreshRoster(b.bob, sub.channel.id);
  const all = everyone(`${c.fed.userActor(c.bob)}|member|`);
  assert.deepEqual(list(b, sub.channel.id), held(all, b.origin));
  assert.deepEqual(list(c, third.channel.id), held(all, c.origin));
  // The home is not asked again within the minute.
  a.store.leave(a.bob, home.id);
  await b.fed.refreshRoster(b.bob, sub.channel.id);
  assert.equal(list(b, sub.channel.id).length, 4);
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() + 60001 });
  await b.fed.refreshRoster(b.bob, sub.channel.id);
  assert.equal(list(b, sub.channel.id).length, 3);
  // Only an accepted follower is told, and nobody is while the home keeps the list.
  const url = new URL(`${a.fed.channelActor(home)}/members`);
  const ask = (i: typeof a, user: typeof a.bob) =>
    fetch(url, { headers: signedHeaders(url, "GET", i.fed.userActor(user), i.fed.keys().private_key) }).then((r) => r.status);
  assert.deepEqual([await ask(b, b.bob), await ask(b, b.alice)], [200, 403]);
  a.store.setPrivacy(a.alice, home.id, { show_members: false });
  await drain(a, b, c);
  assert.equal(await ask(b, b.bob), 403);
  assert.equal(b.store.details(b.bob, sub.channel.id).members.length, 0);
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

test("an administrator's sending pace replaces the configured one, survives a restart and is bounded", async (t) => {
  const a = await instance(t, { FEDERATION_SEND_RATE: "2", FEDERATION_PEER_SEND_RATE: "0", FEDERATION_SEND_INTERVAL: "250" });
  const b = await instance(t);
  const sent = () =>
    a.store.db.prepare("SELECT COUNT(*) AS n FROM federation_deliveries WHERE status='sent'").get()!.n;
  assert.deepEqual(a.fed.sending(), { batch: 2, interval: 250 });
  for (let n = 0; n < 6; n++)
    await a.fed.sendDirect(a.bob, `${b.origin}/actors/users/${b.bob.id}`, `Message ${n}`);
  await a.fed.tick();
  assert.equal(sent(), 2);
  let told = 0;
  a.fed.paceChanged = () => told++;
  assert.throws(() => a.fed.setSending(a.bob, { batch: 3, interval: 5000 }), /administrator/i);
  for (const input of [{ batch: 0, interval: 1000 }, { batch: 1001, interval: 1000 }, { batch: 1.5, interval: 1000 },
    { batch: 3, interval: 99 }, { batch: 3, interval: 600001 }, { batch: "3", interval: 1000 }, { batch: 3 }])
    assert.throws(() => a.fed.setSending(a.alice, input), /whole number/);
  assert.equal(told, 0);
  assert.deepEqual(a.fed.setSending(a.alice, { batch: 3, interval: 5000 }).sending, { batch: 3, interval: 5000 });
  assert.equal(told, 1);
  await a.fed.tick();
  assert.equal(sent(), 5);
  a.restart();
  assert.deepEqual(a.fed.sending(), { batch: 3, interval: 5000 });
  await a.fed.tick();
  assert.equal(sent(), 6);
});
