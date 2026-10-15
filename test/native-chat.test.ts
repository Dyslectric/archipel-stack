import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { randomBytes,randomUUID,verify } from "node:crypto";
import pg from "pg";
import { PostgresDatabase } from "../src/db.js";
import { Store } from "../src/store.js";
import { NativeChat } from "../src/native-chat.js";
import { loadConfig } from "../src/config.js";
import { createApp } from "../src/app.js";
import { Federation } from "../src/federation.js";
import { grant } from "./roles.js";
import { signedHeaders } from "../src/federation-net.js";
import {readFileSync,readdirSync} from "node:fs";
import {createHash} from "node:crypto";

const url = process.env.ARCHIPEL_TEST_POSTGRES;
const binary = resolve(process.env.ARCHIPEL_NATIVE_BINARY || `native/target/release/archipel-chat${process.platform==="win32"?".exe":""}`);
const skip = { skip: !url || !existsSync(binary) ? "needs ARCHIPEL_TEST_POSTGRES and a built native binary" : false };
const secret = "native-test-secret-"+"n".repeat(43);
async function fixture(t: TestContext, workers=4, connections=2, base="http://127.0.0.1:8799",transport="off") {
  const schema = `native_${randomBytes(10).toString("hex")}`;
  const db = new PostgresDatabase(url!,schema,true), store = new Store(db,base);
  store.initializeRegistration("open");
  const alice = store.loginIdentity("urn:archipel:development","alice","Alice",[],true);
  const bob = store.loginIdentity("urn:archipel:development","bob","Bob",[]);
  const channel = store.createChannel(alice,{name:"general",mode:"timeline",visibility:"members",admission:"open"});
  store.join(bob,channel.id); const session = store.createSession(bob.id);
  const aliceSession=store.createSession(alice.id);
  const child = spawn(binary,[],{windowsHide:true,stdio:["ignore","pipe","pipe"],env:{...process.env,FEDERATION_CHANNEL_TRANSPORT:transport,DEV_AUTH:"true",DATABASE_URL:url,NATIVE_SCHEMA:schema,BASE_URL:store.baseUrl,NATIVE_HOST:"127.0.0.1",NATIVE_PORT:"0",NATIVE_WORKERS:String(workers),NATIVE_DATABASE_POOL:String(connections),NATIVE_CHANNEL_CONCURRENCY:String(Math.max(1,Math.floor(connections/2))),NATIVE_BRIDGE_SECRET:secret}});
  const shutdown: (() => Promise<void>)[] = [];
  t.after(async()=>{for (const close of shutdown) await close(); child.kill();await new Promise<void>(done=>{if(child.exitCode!==null || child.signalCode!==null)done();else child.once("exit",()=>done());});store.close();});
  let error=""; child.stderr.on("data",chunk=>{error+=String(chunk);});
  const ready = await new Promise<{port:number;workers:number[]}>((done,fail)=>{
    let text=""; const timeout=setTimeout(()=>fail(new Error(`Native startup timeout: ${error}`)),30000);
    child.once("exit",code=>{clearTimeout(timeout);fail(new Error(`Native exited ${code}: ${error}`));});
    child.stdout.on("data",chunk=>{text+=String(chunk);if(text.includes("\n")){clearTimeout(timeout);try{done(JSON.parse(text.split("\n")[0]));}catch(e){fail(e);}}});
  });
  const origin=`http://127.0.0.1:${ready.port}`;
  const call = async (job:Record<string,unknown>, key=secret) => {
    const response=await fetch(`${origin}/v1/chat`,{method:"POST",headers:{Authorization:`Bearer ${key}`,"Content-Type":"application/json"},body:JSON.stringify({op:"post",channel:channel.id,token:session.token,csrf:session.csrf,body:"Native message",message_id:randomUUID(),...job})});
    return {status:response.status,data:await response.json() as any};
  };
  return {schema,db,store,alice,bob,channel,session,aliceSession,origin,ready,call,child,shutdown};
}

test("native configuration requires PostgreSQL and an authenticated service origin",()=>{
  assert.equal(loadConfig({FEDERATION_CHANNEL_TRANSPORT:"off",}).nativeChatUrl,"");
  assert.throws(()=>loadConfig({FEDERATION_CHANNEL_TRANSPORT:"off",NATIVE_CHAT_URL:"http://127.0.0.1:8870",NATIVE_BRIDGE_SECRET:secret}),/PostgreSQL/);
  assert.throws(()=>loadConfig({FEDERATION_CHANNEL_TRANSPORT:"off",DATABASE_URL:"postgres://test",NATIVE_CHAT_URL:"http://127.0.0.1:8870"}),/NATIVE_BRIDGE_SECRET/);
  const config=loadConfig({FEDERATION_CHANNEL_TRANSPORT:"off",DATABASE_URL:"postgres://test",NATIVE_CHAT_URL:"http://127.0.0.1:8870/",NATIVE_BRIDGE_SECRET:secret});
  assert.equal(config.nativeChatUrl,"http://127.0.0.1:8870");
});

test("embedded native schema matches the current migration sources",()=>{
  const hash=createHash("sha256"),directory=resolve("migrations");
  for(const file of readdirSync(directory).filter(f=>/^\d+.*\.sql$/.test(f)).sort())hash.update(file).update(readFileSync(resolve(directory,file),'utf8').replaceAll('\r\n','\n'));
  assert.ok(readFileSync(resolve("native/data/schema.sql"),"utf8").startsWith(`-- Generated from migrations; source SHA256 ${hash.digest("hex")}`));
});

test("native executable initializes an empty PostgreSQL schema and upgrades version 28 without Node migrations",skip,async t=>{
  const schema=`native_boot_${randomBytes(8).toString("hex")}`,client=new pg.Client({connectionString:url});await client.connect();
  const children:ReturnType<typeof spawn>[]=[];
  const stop=async(child:ReturnType<typeof spawn>)=>{child.kill();await new Promise<void>(done=>{if(child.exitCode!==null || child.signalCode!==null)done();else child.once("exit",()=>done());});};
  t.after(async()=>{for(const child of children)if(child.exitCode===null && child.signalCode===null)await stop(child);await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await client.end();});
  const start=async()=>{
    const child=spawn(binary,[],{windowsHide:true,stdio:["ignore","pipe","pipe"],env:{...process.env,DEV_AUTH:"true",DATABASE_URL:url,NATIVE_SCHEMA:schema,BASE_URL:"http://127.0.0.1:8799",NATIVE_HOST:"127.0.0.1",NATIVE_PORT:"0",NATIVE_WORKERS:"4",NATIVE_DATABASE_POOL:"2",NATIVE_BRIDGE_SECRET:secret}});children.push(child);
    let errors="";child.stderr?.on("data",chunk=>{errors+=String(chunk);});
    const ready=await new Promise<{port:number}>( (done,fail)=>{
      let output="";const timer=setTimeout(()=>fail(new Error(`Native bootstrap timed out: ${errors}`)),30000);
      child.once("exit",code=>{clearTimeout(timer);fail(new Error(`Native bootstrap exited ${code}: ${errors}`));});
      child.stdout?.on("data",chunk=>{output+=String(chunk);if(output.includes("\n")){clearTimeout(timer);done(JSON.parse(output.split("\n")[0]));}});
    });return {child,origin:`http://127.0.0.1:${ready.port}`};
  };
  const first=await start();assert.equal((await client.query(`SELECT version FROM "${schema}".archipel_schema`)).rows[0].version,"31");
  assert.equal((await client.query(`SELECT name FROM "${schema}".roles WHERE is_default=1`)).rows[0].name,"Member");
  const db=new PostgresDatabase(url!,schema),store=new Store(db,"http://127.0.0.1:8799");t.after(()=>store.close());
  const alice=store.loginIdentity("urn:archipel:development","alice","Alice",[],true),channel=store.createChannel(alice,{name:"native-boot",mode:"timeline",visibility:"members",admission:"open"}),session=store.createSession(alice.id);
  const post=await fetch(`${first.origin}/v1/chat`,{method:"POST",headers:{Authorization:`Bearer ${secret}`,"Content-Type":"application/json"},body:JSON.stringify({op:"post",channel:channel.id,token:session.token,csrf:session.csrf,body:"Native bootstrap works",message_id:randomUUID()})});assert.equal(post.status,200);
  await stop(first.child);
  // Rebuild the private routing index from durable rows, including rows queued
  // while the native service is stopped. Existing trigger functions may remain.
  const queued=randomUUID();
  db.prepare("INSERT INTO federation_outgoing VALUES(?,?,?,?,?,?,?)").run(queued,"{}","urn:boot",alice.id,channel.id,"relay",Date.now());
  db.prepare("INSERT INTO federation_deliveries(activity_id,recipient) VALUES(?,?)").run(queued,"urn:boot-peer");
  await client.query(`DROP TABLE "${schema}".native_federation_heads`);
  await client.query(`DROP TABLE "${schema}".native_changes`);await client.query(`DROP TABLE "${schema}".federation_instance_events; DROP TABLE "${schema}".federation_instance_state; DROP TABLE "${schema}".federation_channel_keys; DROP TABLE "${schema}".federation_channel_epochs; DROP TABLE "${schema}".federation_instance_incoming; DROP TABLE "${schema}".federation_instance_cursors; DROP TABLE "${schema}".federation_received_keys; DROP INDEX "${schema}".federation_legacy_followers; ALTER TABLE "${schema}".federation_follows DROP COLUMN key_epoch; ALTER TABLE "${schema}".federation_follows DROP COLUMN instance_start; ALTER TABLE "${schema}".federation_subscriptions DROP COLUMN instance_start; DROP TABLE "${schema}".federation_channel_events; DROP TABLE "${schema}".federation_channel_state; DROP TABLE "${schema}".federation_channel_cursors; DROP TABLE "${schema}".federation_channel_peers; ALTER TABLE "${schema}".federation_follows DROP COLUMN stream_start; ALTER TABLE "${schema}".federation_follows DROP COLUMN stream_capable; ALTER TABLE "${schema}".federation_subscriptions DROP COLUMN stream_start; UPDATE "${schema}".archipel_schema SET version=28`);
  const upgraded=await start();assert.equal((await fetch(`${upgraded.origin}/health`,{headers:{Authorization:`Bearer ${secret}`}})).status,200);
  assert.equal((await client.query(`SELECT version FROM "${schema}".archipel_schema`)).rows[0].version,"31");
  assert.equal((await client.query(`SELECT body FROM "${schema}".messages`)).rows[0].body,"Native bootstrap works");
  assert.equal((await client.query(`SELECT recipient FROM "${schema}".native_federation_heads`)).rows[0].recipient,"urn:boot-peer");
});

test("native queue heads track compatibility mutations, concurrent writers and rollback",skip,async t=>{
  const f=await fixture(t,1,4),second=f.store.createChannel(f.alice,{name:"head-index",mode:"timeline",visibility:"members",admission:"open"});
  const client=new pg.Pool({connectionString:url,max:4,options:`-c search_path=${f.schema}`});t.after(()=>client.end());
  const check=async()=>{
    const expected=(await client.query(`SELECT DISTINCT ON(d.recipient,o.channel_id) d.recipient,native_federation_lane(o.channel_id) AS lane,d.id::text AS head_id
      FROM federation_deliveries d JOIN federation_outgoing o ON o.id=d.activity_id WHERE d.status='pending' ORDER BY d.recipient,o.channel_id,d.id`)).rows;
    const actual=(await client.query("SELECT recipient,lane,head_id::text FROM native_federation_heads")).rows;
    const sorted=(rows:any[])=>rows.sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
    assert.deepEqual(sorted(actual),sorted(expected));
    const pending=(await client.query(`SELECT d.id::text AS delivery_id,d.recipient,native_federation_lane(o.channel_id) AS lane
      FROM federation_deliveries d JOIN federation_outgoing o ON o.id=d.activity_id WHERE d.status='pending'`)).rows;
    const routing=(await client.query("SELECT delivery_id::text,recipient,lane FROM native_federation_pending")).rows;
    assert.deepEqual(sorted(routing),sorted(pending));
  };
  const ids=Array.from({length:12},()=>randomUUID());
  for(let n=0;n<ids.length;n++){
    f.db.prepare("INSERT INTO federation_outgoing VALUES(?,?,?,?,?,?,?)").run(ids[n],"{}","urn:head-test",f.bob.id,n%3===0?null:n%3===1?f.channel.id:second.id,"relay",Date.now());
    f.db.prepare("INSERT INTO federation_deliveries(activity_id,recipient,next_attempt) VALUES(?,?,?)").run(ids[n],`urn:recipient:${n%2}`,Date.now()+60000);
  }
  await check();
  f.db.prepare("UPDATE federation_deliveries SET status='sent' WHERE activity_id=?").run(ids[0]);await check();
  f.db.prepare("UPDATE federation_deliveries SET status='pending' WHERE activity_id=?").run(ids[0]);await check();
  f.db.prepare("UPDATE federation_deliveries SET recipient='urn:moved' WHERE activity_id=?").run(ids[0]);await check();
  f.db.prepare("UPDATE federation_deliveries SET activity_id=? WHERE activity_id=?").run(ids[6],ids[0]);await check();
  f.db.prepare("UPDATE federation_outgoing SET channel_id=NULL WHERE id=?").run(ids[1]);await check();
  f.db.prepare("UPDATE federation_outgoing SET channel_id=? WHERE id=?").run(second.id,ids[6]);await check();
  f.db.prepare("UPDATE federation_outgoing SET channel_id=CASE WHEN channel_id=? THEN ? ELSE ? END WHERE id IN (?,?,?)")
    .run(f.channel.id,second.id,f.channel.id,ids[3],ids[4],ids[6]);await check();
  f.db.prepare("DELETE FROM federation_deliveries WHERE activity_id=?").run(ids[2]);await check();
  f.db.prepare("UPDATE federation_deliveries SET id=id+1000 WHERE activity_id=?").run(ids[3]);await check();
  const rollback=await client.connect();
  try{await rollback.query("BEGIN");await rollback.query("UPDATE federation_deliveries SET status='cancelled'");await rollback.query("ROLLBACK");}finally{rollback.release();}
  await check();
  for(let round=0;round<5;round++){
    await Promise.all(ids.slice(3,7).map(async(id,n)=>{
      const writer=await client.connect();
      try{
        await writer.query("BEGIN");
        await writer.query("UPDATE federation_deliveries SET status=$1 WHERE activity_id=$2",[round%2?"pending":"cancelled",id]);
        await writer.query("INSERT INTO federation_deliveries(activity_id,recipient) VALUES($1,$2) ON CONFLICT(activity_id,recipient) DO UPDATE SET status='pending'",[id,`urn:concurrent:${n%2}`]);
        await writer.query("COMMIT");
      }finally{writer.release();}
    }));
    await check();
  }
  f.db.prepare("UPDATE federation_deliveries SET status='cancelled'").run();await check();
  assert.equal((await client.query("SELECT COUNT(*)::int AS n FROM native_federation_heads")).rows[0].n,0);
});

test("native account session, profile changes and logout preserve roles, CSRF and revocation",skip,async t=>{
  const f=await fixture(t,1,4),native=new NativeChat(f.store,loadConfig({FEDERATION_CHANNEL_TRANSPORT:"off",DATABASE_URL:url,NATIVE_CHAT_URL:f.origin,NATIVE_BRIDGE_SECRET:secret}));
  const signed=await native.account("session",f.session.token);
  assert.deepEqual(signed,{user:f.store.profile(f.bob,true),csrf:f.session.csrf,registration_mode:"open",federation_enabled:false});
  assert.equal((await native.account("session","invalid")).user,null);
  await assert.rejects(native.account("profile",f.session.token,"wrong",{display_name:"changed",share_socials:true}),(error:any)=>error.status===403);
  const changed=await native.account("profile",f.session.token,f.session.csrf,{display_name:"  Native profile  ",share_socials:true});
  assert.deepEqual(changed,f.store.profile(f.store.user(f.bob.id),true));assert.equal(changed.display_name,"Native profile");
  const concurrent=await Promise.all(["One","Two","Three"].map(display_name=>native.account("profile",f.session.token,f.session.csrf,{display_name,share_socials:false})));
  assert.equal(concurrent.length,3);
  await assert.rejects(native.account("profile",f.session.token,f.session.csrf,{display_name:"Bad",share_socials:"yes"}),(error:any)=>error.status===400);
  f.db.prepare("UPDATE users SET admission_status='pending' WHERE id=?").run(f.bob.id);
  assert.equal((await native.account("session",f.session.token)).user.admission_status,"pending");
  await assert.rejects(native.account("profile",f.session.token,f.session.csrf,{display_name:"Denied",share_socials:true}),(error:any)=>error.status===403);
  assert.deepEqual(await native.account("logout",f.session.token,f.session.csrf),{ok:true});
  assert.equal((await native.account("session",f.session.token)).user,null);
});

test("native quota authentication coalesces in-flight requests and immediately observes revocation",skip,async t=>{
  const f=await fixture(t,1,4),native=new NativeChat(f.store,loadConfig({FEDERATION_CHANNEL_TRANSPORT:"off",DATABASE_URL:url,NATIVE_CHAT_URL:f.origin,NATIVE_BRIDGE_SECRET:secret}));
  const before=native.statistics.sessions;
  const sessions=await Promise.all(Array.from({length:24},()=>native.session(f.session.token)));
  assert.ok(sessions.every(s=>s.user.id===f.bob.id));assert.equal(native.statistics.sessions-before,1);
  f.db.prepare("UPDATE users SET admission_status='pending' WHERE id=?").run(f.bob.id);
  assert.equal((await native.session(f.session.token,true)).user.admission_status,"pending");
  await assert.rejects(native.session(f.session.token),(error:any)=>error.status===403);
  f.db.prepare("UPDATE users SET admission_status='approved' WHERE id=?").run(f.bob.id);
  f.store.logout(f.session.token);
  await assert.rejects(native.session(f.session.token),(error:any)=>error.status===401);
  const renewed=f.store.createSession(f.bob.id);
  assert.equal((await native.session(renewed.token)).user.id,f.bob.id);
});

test("native bridge never falls back after a timeout/error that might follow commit",async t=>{
  const store=new Store(":memory:");t.after(()=>store.close());let calls=0,broken=false;
  const server=createServer((_req,res)=>{
    calls++;
    if(broken) {res.writeHead(200,{"Content-Type":"application/json"});res.write('{"user":');setTimeout(()=>res.destroy(),25);}
    else {res.writeHead(503,{"Content-Type":"application/json"});res.end('{"error":"failed","code":"native_error"}');}
  });
  await new Promise<void>(done=>server.listen(0,"127.0.0.1",done));t.after(()=>new Promise<void>(done=>server.close(()=>done())));
  const address=server.address() as {port:number};
  const native=new NativeChat(store,loadConfig({FEDERATION_CHANNEL_TRANSPORT:"off",DATABASE_URL:"postgres://test",NATIVE_CHAT_URL:`http://127.0.0.1:${address.port}`,NATIVE_BRIDGE_SECRET:secret}));
  await assert.rejects(native.post("token","csrf","channel",{body:"Plain message"}),/failed/);
  assert.equal(calls,1);
  await assert.rejects(native.rawMessages("token","csrf","channel"),/failed/);assert.equal(calls,2);
  broken=true;
  await assert.rejects(native.post("token","csrf","channel",{body:"Lost reply"}),(error:any)=>error.status===503);
  assert.equal(calls,3);
  await assert.rejects(native.rawOverview("token","csrf"),(error:any)=>error.status===503);assert.equal(calls,4);
});

test("public HTTP uses native account and actor exports with fresh policy",skip,async t=>{
  const f=await fixture(t,1,4);
  const config=loadConfig({FEDERATION_CHANNEL_TRANSPORT:"off",DEV_AUTH:"true",HOST:"127.0.0.1",BASE_URL:f.store.baseUrl,DATABASE_URL:url,NATIVE_CHAT_URL:f.origin,NATIVE_BRIDGE_SECRET:secret});
  const app=createApp(config,f.store),server=createServer(app);
  await new Promise<void>(done=>server.listen(0,"127.0.0.1",done));
  f.shutdown.push(async()=>{await app.locals.federation.channelFeed.close();app.locals.events.close();server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));});
  const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const legacySession=f.store.session;f.store.session=()=>{throw new Error("Account HTTP used synchronous session lookup");};t.after(()=>{f.store.session=legacySession;});
  const headers={Cookie:`archipel=${f.session.token}`,Origin:f.store.baseUrl,"X-CSRF-Token":f.session.csrf,"Content-Type":"application/json"};
  const session=await fetch(`${origin}/api/session`,{headers});assert.equal(session.status,200);
  assert.deepEqual((await session.json() as any).user,f.store.profile(f.bob,true));
  const changed=await fetch(`${origin}/api/profile`,{method:"PATCH",headers,body:JSON.stringify({display_name:"HTTP native",share_socials:true})});
  assert.equal(changed.status,200);assert.equal((await changed.json() as any).display_name,"HTTP native");
  const wrong=await fetch(`${origin}/api/profile`,{method:"PATCH",headers:{...headers,"X-CSRF-Token":"wrong"},body:JSON.stringify({display_name:"Denied",share_socials:true})});assert.equal(wrong.status,403);
  const fed=app.locals.federation as Federation;fed.setEnabled(f.alice,true);grant(f.store,f.alice,f.bob.id,nativePermissions);
  fed.setChannel(f.alice,f.channel.id,true);
  const actorHeaders={Accept:"application/activity+json"};
  for(const [kind,id] of [["users",f.bob.id],["channels",f.channel.id]] as const) {
    const expected=fed.publicActor(kind,id);
    const result=await fetch(`${origin}/actors/${kind}/${id}`,{headers:actorHeaders});assert.equal(result.status,200);assert.deepEqual(await result.json(),expected);
  }
  f.store.ban(f.alice,f.bob.id,true);
  const banned=await fetch(`${origin}/actors/users/${f.bob.id}`,{headers:actorHeaders});assert.equal(banned.status,200);assert.deepEqual(await banned.json(),fed.publicActor("users",f.bob.id));
  f.store.ban(f.alice,f.bob.id,false);
  const renewed=f.store.createSession(f.bob.id);headers.Cookie=`archipel=${renewed.token}`;headers["X-CSRF-Token"]=renewed.csrf;
  f.db.prepare("UPDATE users SET admission_status='pending' WHERE id=?").run(f.bob.id);
  assert.equal((await fetch(`${origin}/actors/users/${f.bob.id}`,{headers:actorHeaders})).status,404);
  const logout=await fetch(`${origin}/api/logout`,{method:"POST",headers,body:"{}"});assert.equal(logout.status,200);
  assert.match(logout.headers.get("set-cookie")||"",/archipel=;/);
  f.store.session=legacySession;
  assert.equal(f.store.session(renewed.token),null);
  fed.setEnabled(f.alice,false);
  assert.equal((await fetch(`${origin}/actors/channels/${f.channel.id}`,{headers:actorHeaders})).status,403);
});

test("native workers have isolated processes, durable/idempotent posts and current admission checks",skip,async t=>{
  const f=await fixture(t);
  assert.equal(new Set(f.ready.workers).size,4);assert.ok(f.ready.workers.every(pid=>pid>0));
  assert.equal((await f.call({},"wrong-secret")).status,401);
  const rejectedRead=await fetch(`${f.origin}/v1/read`,{method:"POST",headers:{Authorization:`Bearer ${secret}`,"Content-Type":"application/json"},body:JSON.stringify({op:"post",channel:f.channel.id,token:f.session.token,csrf:f.session.csrf,body:"Must not mutate",message_id:randomUUID()})});assert.equal(rejectedRead.status,501);
  assert.equal((await f.call({csrf:"wrong"})).status,403);
  const id=randomUUID(), first=await f.call({message_id:id});assert.equal(first.status,200);
  assert.equal(first.data.result.body,"Native message");assert.equal(f.store.message(id).body,"Native message");
  assert.deepEqual(first.data.result,f.store.message(id));
  const page=await f.call({op:"messages"});assert.equal(page.status,200);
  assert.deepEqual(page.data.result.messages,f.store.messages(f.bob,f.channel.id));
  f.store.setUserBlock(f.alice,`${f.store.baseUrl}/actors/users/${f.bob.id}`,true);
  assert.deepEqual((await f.call({op:"messages",token:f.aliceSession.token,csrf:f.aliceSession.csrf})).data.result.messages,f.store.messages(f.alice,f.channel.id));
  f.store.setUserBlock(f.alice,`${f.store.baseUrl}/actors/users/${f.bob.id}`,false);
  const replay=await f.call({message_id:id});assert.equal(replay.status,200);assert.equal(replay.data.changed,false);
  assert.equal((await f.call({message_id:id,body:"Different message"})).status,409);
  f.db.prepare("UPDATE channels SET reaction_bans='[\"tada\"]' WHERE id=?").run(f.channel.id);
  assert.equal((await f.call({body:"An emoji :tada:"})).status,403);
  f.db.prepare("UPDATE channels SET reaction_bans='[]' WHERE id=?").run(f.channel.id);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM messages").get()!.n,1);
  const marked=await f.call({op:"read",seq:first.data.result.seq+100});assert.equal(marked.status,200);
  assert.equal(f.db.prepare("SELECT seq FROM read_marks WHERE user_id=? AND target=?").get(f.bob.id,f.channel.id)!.seq,first.data.result.seq);
  f.store.leave(f.bob,f.channel.id);assert.equal((await f.call({})).status,403);
  assert.equal((await f.call({op:"messages"})).status,403);
  f.store.join(f.bob,f.channel.id);f.store.ban(f.alice,f.bob.id,true);assert.equal((await f.call({})).status,401);
});

test("a blocked channel cannot occupy every database connection needed by another channel",skip,async t=>{
  const f=await fixture(t,1); const other=f.store.createChannel(f.alice,{name:"independent",mode:"timeline",visibility:"members",admission:"open"});f.store.join(f.bob,other.id);
  const blocker=new pg.Client({connectionString:url});await blocker.connect();
  t.after(async()=>{await blocker.query("ROLLBACK").catch(()=>{});await blocker.end();});
  await blocker.query("BEGIN");await blocker.query(`SELECT id FROM "${f.schema}".channels WHERE id=$1 FOR UPDATE`,[f.channel.id]);
  const blocked=Array.from({length:8},()=>f.call({}));
  await new Promise(done=>setTimeout(done,200));
  const fast=await Promise.race([f.call({channel:other.id,body:"Independent progress"}),new Promise<never>((_,fail)=>setTimeout(()=>fail(new Error("Independent channel stalled")),3000))]);
  assert.equal(fast.status,200);await blocker.query("ROLLBACK");assert.ok((await Promise.all(blocked)).every(r=>r.status===200));
});

test("native read marks avoid account row locks while enforcing current session, CSRF and membership",skip,async t=>{
  const f=await fixture(t,1,4),message=f.store.post(f.bob,f.channel.id,{body:"Read position"}),blocker=new pg.Client({connectionString:url});await blocker.connect();
  t.after(async()=>{await blocker.query("ROLLBACK").catch(()=>{});await blocker.end();});
  await blocker.query("BEGIN");await blocker.query(`SELECT id FROM "${f.schema}".users WHERE id=$1 FOR UPDATE`,[f.bob.id]);
  let timer:ReturnType<typeof setTimeout>|undefined;
  try {
    const marked=await Promise.race([f.call({op:"read",seq:message.seq+100}),new Promise<never>((_,fail)=>{timer=setTimeout(()=>fail(new Error("Read mark waited on the account row")),3000);})]);
    assert.equal(marked.status,200);assert.equal(f.db.prepare("SELECT seq FROM read_marks WHERE user_id=? AND target=?").get(f.bob.id,f.channel.id)!.seq,message.seq);
    assert.equal((await f.call({op:"read",csrf:"wrong"})).status,403);
  } finally {if(timer)clearTimeout(timer);await blocker.query("ROLLBACK");}
  assert.equal((await f.call({op:"read",seq:0})).status,200);assert.equal(f.db.prepare("SELECT seq FROM read_marks WHERE user_id=? AND target=?").get(f.bob.id,f.channel.id)!.seq,message.seq);
  f.store.leave(f.bob,f.channel.id);assert.equal((await f.call({op:"read"})).status,403);
  f.store.join(f.bob,f.channel.id);f.store.logout(f.session.token);assert.equal((await f.call({op:"read"})).status,401);
});

test("blocked read-mark batches leave the same channel free for posting",skip,async t=>{
  const f=await fixture(t,1,4),posted=await f.call({body:"Before locked read"});
  f.db.prepare("INSERT INTO read_marks(user_id,target,seq) VALUES(?,?,0) ON CONFLICT(user_id,target) DO UPDATE SET seq=0").run(f.bob.id,f.channel.id);
  const locker=new pg.Client({connectionString:url});await locker.connect();
  await locker.query(`SET search_path TO "${f.schema}",public`);await locker.query('BEGIN');
  await locker.query('SELECT * FROM read_marks WHERE user_id=$1 AND target=$2 FOR UPDATE',[f.bob.id,f.channel.id]);
  const reads=Array.from({length:2},()=>f.call({op:"read",seq:posted.data.result.seq}));
  try {
    let blocked=false;
    for(let attempt=0;attempt<100 && !blocked;attempt++){
      await locker.query('SELECT pg_stat_clear_snapshot()');
      blocked=(await locker.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'WITH source(slot%') AS blocked")).rows[0].blocked;
      if(!blocked)await new Promise(done=>setTimeout(done,10));
    }
    assert.ok(blocked,"read batch must reach the locked position before probing the channel");
    const response=await fetch(`${f.origin}/v1/chat`,{method:"POST",signal:AbortSignal.timeout(2000),
      headers:{Authorization:`Bearer ${secret}`,"Content-Type":"application/json"},
      body:JSON.stringify({op:"post",channel:f.channel.id,token:f.session.token,csrf:f.session.csrf,body:"Progress while read waits",message_id:randomUUID()})});
    assert.equal(response.status,200,await response.text());
  } finally {await locker.query('ROLLBACK');await locker.end();await Promise.all(reads);}
});

test("batched read marks isolate revoked entries and retain acknowledged monotone positions",skip,async t=>{
  const f=await fixture(t,1,4),message=f.store.post(f.bob,f.channel.id,{body:"Batch position"});
  const original=Number(f.db.prepare("SELECT seq FROM read_marks WHERE user_id=? AND target=?").get(f.bob.id,f.channel.id)?.seq||0);
  const requests=[];
  for(let i=0;i<6;i++){requests.push(f.call({op:"read",seq:message.seq+100}));requests.push(f.call({op:"read",token:f.aliceSession.token,csrf:f.aliceSession.csrf,seq:message.seq}));}
  await new Promise(done=>setTimeout(done,15));f.store.logout(f.session.token);
  const replies=await Promise.all(requests);
  for(let i=0;i<replies.length;i++)assert.equal(i%2===0?[401,403].includes(replies[i].status):replies[i].status===200,true);
  assert.equal(Number(f.db.prepare("SELECT seq FROM read_marks WHERE user_id=? AND target=?").get(f.bob.id,f.channel.id)?.seq||0),original);
  assert.equal(f.db.prepare("SELECT seq FROM read_marks WHERE user_id=? AND target=?").get(f.alice.id,f.channel.id)!.seq,message.seq);
});

test("concurrent duplicate messages commit once and a stopped native worker is replaced",skip,async t=>{
  const f=await fixture(t,1,4),id=randomUUID();
  const replies=await Promise.all(Array.from({length:12},()=>f.call({message_id:id})));
  assert.ok(replies.every(r=>r.status===200));assert.equal(replies.filter(r=>r.data.changed).length,1);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE id=?").get(id)!.n,1);
  const old=f.ready.workers[0];process.kill(old);
  await new Promise(done=>setTimeout(done,200));assert.equal((await f.call({body:"After worker replacement"})).status,200);
  const health=await fetch(`${f.origin}/health`,{headers:{Authorization:`Bearer ${secret}`}});
  assert.equal(health.status,200);assert.notEqual((await health.json() as any).workers[0],old);
});

test("native writes integrate with API and SSE, while unsupported rich posts keep the legacy path",skip,async t=>{
  const f=await fixture(t);
  const config=loadConfig({FEDERATION_CHANNEL_TRANSPORT:"off",DEV_AUTH:"true",HOST:"127.0.0.1",BASE_URL:f.store.baseUrl,DATABASE_URL:url,NATIVE_CHAT_URL:f.origin,NATIVE_BRIDGE_SECRET:secret});
  const app=createApp(config,f.store), server=createServer(app);
  await new Promise<void>(done=>server.listen(0,"127.0.0.1",done));
  f.shutdown.push(async()=>{await app.locals.federation.channelFeed.close();app.locals.events.close();server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));});
  const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  assert.equal((await fetch(`${origin}/health`)).status,200);
  const headers={Cookie:`archipel=${f.session.token}`,Origin:f.store.baseUrl,"X-CSRF-Token":f.session.csrf,"Content-Type":"application/json"};
  const authenticated=await f.call({op:"session",channel:"session:test-account",csrf:""});assert.equal(authenticated.status,200);
  assert.deepEqual(authenticated.data.result,f.store.session(f.session.token));
  const legacySession=f.store.session;
  f.store.session=()=>{throw new Error("Native hot route used synchronous session lookup");};
  t.after(()=>{f.store.session=legacySession;});
  const events=await fetch(`${origin}/api/events`,{headers}),reader=events.body!.getReader();
  await reader.read();
  await f.db.listenExternalChanges();
  const posted=await fetch(`${origin}/api/channels/${f.channel.id}/messages`,{method:"POST",headers,body:JSON.stringify({body:"Via native worker"})});assert.equal(posted.status,201);
  const page=await fetch(`${origin}/api/channels/${f.channel.id}/messages`,{headers});assert.equal(page.status,200);
  assert.deepEqual((await page.json() as any).messages,f.store.messages(f.bob,f.channel.id));
  const overview=await fetch(`${origin}/api/overview`,{headers});assert.equal(overview.status,200);
  assert.deepEqual(await overview.json(),{...f.store.overview(f.bob),xmpp_enabled:false,xmpp_rooms:[]});
  const notice=await Promise.race([reader.read(),new Promise<never>((_,fail)=>setTimeout(()=>fail(new Error("Missing SSE notice")),2000))]);
  assert.ok(new TextDecoder().decode(notice.value).includes(f.channel.id));
  await (app.locals.events as any).review();assert.equal(app.locals.events.listeners,1);
  f.store.logout(f.session.token);await (app.locals.events as any).review();assert.equal(app.locals.events.listeners,0);
  await reader.cancel();
  f.store.session=legacySession;
  const renewed=f.store.createSession(f.bob.id);headers.Cookie=`archipel=${renewed.token}`;headers["X-CSRF-Token"]=renewed.csrf;
  const rich=await fetch(`${origin}/api/channels/${f.channel.id}/messages`,{method:"POST",headers,body:JSON.stringify({body:"Compatibility with :tada:\u0085"})});assert.equal(rich.status,201);
  for(const extra of [{parent_id:""},{topic_id:0},{title:0}]) {
    const invalid=await fetch(`${origin}/api/channels/${f.channel.id}/messages`,{method:"POST",headers,body:JSON.stringify({body:"Do not bypass validation",...extra})});
    assert.equal(invalid.status,400);
  }
  const wrongCsrf=await fetch(`${origin}/api/channels/${f.channel.id}/messages`,{method:"POST",headers:{...headers,"X-CSRF-Token":"wrong"},body:JSON.stringify({body:"Not accepted"})});
  assert.equal(wrongCsrf.status,403);
  assert.ok(app.locals.nativeChat.statistics.sessions>0);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM messages").get()!.n,2);
});

test("native overview preserves unread exclusions, preferences and initial marks",skip,async t=>{
  const f=await fixture(t,2,4);
  const root=f.store.post(f.alice,f.channel.id,{body:"Unread root"});
  f.store.post(f.alice,f.channel.id,{body:"Unread reply",parent_id:root.id});
  f.store.post(f.bob,f.channel.id,{body:"My own message"});
  const overview=async()=>{
    const result=await f.call({op:"overview",channel:"overview:test-account"});assert.equal(result.status,200,JSON.stringify(result));
    assert.deepEqual(result.data.result,f.store.overview(f.store.user(f.bob.id)));return result;
  };
  assert.equal((await overview()).data.result.unread[f.channel.id],2);
  f.db.prepare("INSERT INTO conversation_prefs VALUES(?,?,?,?,?)").run(f.bob.id,`thread:${root.id}`,f.channel.id,1,2);
  f.db.prepare("INSERT INTO sidebar_layouts VALUES(?,?)").run(f.bob.id,JSON.stringify({sections:[],unfiled:[f.channel.id]}));
  assert.deepEqual((await overview()).data.result.unread,{});
  f.db.prepare("DELETE FROM conversation_prefs WHERE user_id=?").run(f.bob.id);
  f.store.setUserBlock(f.bob,`${f.store.baseUrl}/actors/users/${f.alice.id}`,true);
  assert.deepEqual((await overview()).data.result.unread,{});
  f.store.setUserBlock(f.bob,`${f.store.baseUrl}/actors/users/${f.alice.id}`,false);
  f.db.prepare("DELETE FROM read_marks WHERE user_id=? AND target=?").run(f.bob.id,f.channel.id);
  const seeded=await overview();assert.equal(seeded.data.changed,true);assert.deepEqual(seeded.data.result.unread,{});
  f.db.prepare("INSERT INTO direct_messages(id,user_id,peer,direction,body,created_at) VALUES(?,?,?,'incoming','A DM',?)")
    .run(randomUUID(),f.bob.id,`${f.store.baseUrl}/actors/users/${f.alice.id}`,new Date().toISOString());
  assert.equal((await f.call({op:"overview",channel:"overview:test-account"})).status,501);
  f.db.prepare("DELETE FROM direct_messages WHERE user_id=?").run(f.bob.id);
  f.db.prepare("INSERT INTO xmpp_remote_rooms(id,user_id,room,nick,session,updated_at) VALUES(?,?,?,?,?,?)")
    .run(randomUUID(),f.bob.id,"room@conference.example","Bob",randomUUID(),Date.now());
  assert.equal((await f.call({op:"overview",channel:"overview:test-account"})).status,501);
});

test("native pages preserve hidden threads, handle grants, live emoji metadata and reactions",skip,async t=>{
  const f=await fixture(t);
  f.db.prepare("UPDATE channels SET mode='threaded' WHERE id=?").run(f.channel.id);
  const image="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=";
  f.store.addEmoji(f.alice,{name:"native_party",image});
  const root=f.store.post(f.alice,f.channel.id,{body:"A :native_party: message",title:"Thread"});
  f.store.post(f.bob,f.channel.id,{body:"Reply",parent_id:root.id});
  f.store.react(f.alice,root.id,{emoji:"thumbsup",on:true});f.store.react(f.bob,root.id,{emoji:"thumbsup",on:true});
  f.store.react(f.bob,root.id,{emoji:"native_party",on:true});
  f.store.setPrivacy(f.alice,f.channel.id,{hide_handles:true});
  f.store.setPref(f.bob,{target:`thread:${root.id}`,hidden:true});
  const check=async()=>{
    const page=await f.call({op:"messages"});assert.equal(page.status,200,JSON.stringify(page));
    assert.deepEqual(page.data.result.messages,f.store.messages(f.bob,f.channel.id));return page.data.result.messages;
  };
  const hidden=await check();assert.ok(hidden.every((m:any)=>m.hidden_thread));assert.equal(hidden[0].author_actor_url,null);
  f.db.prepare("INSERT INTO channel_grants(channel_id,user_id,see_members,see_handles) VALUES(?,?,0,1)").run(f.channel.id,f.bob.id);
  assert.ok((await check())[0].author_actor_url);
  f.store.setUserBlock(f.bob,`${f.store.baseUrl}/actors/users/${f.alice.id}`,true);assert.deepEqual((await check())[0].emojis,[]);
  f.store.setUserBlock(f.bob,`${f.store.baseUrl}/actors/users/${f.alice.id}`,false);
  f.store.removeEmoji(f.alice,"native_party");assert.deepEqual((await check())[0].emojis,[]);
});

test("native incremental pages retain fresh authorization and reset for edits, deletions, authors and overflow",skip,async t=>{
  const f=await fixture(t,1,4);
  f.store.transaction(()=>{for(let index=0;index<120;index++)f.store.post(f.bob,f.channel.id,{body:`History ${index}`});});
  const full=await f.call({op:"messages",refresh:true});assert.equal(full.status,200);assert.equal(full.data.result.messages.length,100);
  const delta=(page:any,extra:Record<string,unknown>={})=>f.call({op:"messages",refresh:true,after:page.refresh_cursor,refresh_stamp:page.refresh_stamp,...extra});
  const empty=await delta(full.data.result);assert.equal(empty.status,200);assert.equal(empty.data.result.incremental,true);assert.deepEqual(empty.data.result.messages,[]);
  for(let index=0;index<3;index++)assert.equal((await f.call({body:`New ${index}`})).status,200);
  const added=await delta(full.data.result);assert.equal(added.status,200);assert.equal(added.data.result.incremental,true);
  assert.deepEqual(added.data.result.messages.map((m:any)=>m.body),["New 0","New 1","New 2"]);
  assert.equal(added.data.result.older_cursor,f.store.messages(f.bob,f.channel.id)[0].seq);
  const id=full.data.result.messages[3].id;f.store.editMessage(f.bob,id,{body:"Earlier edit",expected_edited_at:null});
  const edited=await delta(added.data.result);assert.equal(edited.data.result.incremental,false);assert.equal(edited.data.result.messages.find((m:any)=>m.id===id).body,"Earlier edit");
  f.store.deleteMessage(f.bob,id);
  const deleted=await delta(edited.data.result);assert.equal(deleted.data.result.incremental,false);assert.ok(deleted.data.result.messages.find((m:any)=>m.id===id).deleted_at);
  f.db.prepare("UPDATE users SET display_name='Fresh author' WHERE id=?").run(f.bob.id);
  const author=await delta(deleted.data.result);assert.equal(author.data.result.incremental,false);assert.ok(author.data.result.messages.every((m:any)=>m.display_name==="Fresh author"));
  f.store.transaction(()=>{for(let index=0;index<101;index++)f.store.post(f.store.user(f.bob.id),f.channel.id,{body:`Catch up ${index}`});});
  const overflow=await delta(author.data.result);assert.equal(overflow.data.result.incremental,false);assert.equal(overflow.data.result.messages.length,100);assert.equal(overflow.data.result.messages.at(-1).body,"Catch up 100");
  assert.equal((await delta(overflow.data.result,{before:1})).status,400);
  assert.equal((await delta(overflow.data.result,{refresh_stamp:"bad"})).status,400);
  f.db.prepare("INSERT INTO channel_rules(channel_id,user_id,rule) VALUES(?,?,'block') ON CONFLICT(channel_id,user_id) DO UPDATE SET rule='block'").run(f.channel.id,f.bob.id);
  assert.equal((await delta(overflow.data.result)).status,403);
  f.store.ban(f.alice,f.bob.id,true);assert.equal((await delta(overflow.data.result)).status,401);
});

test("native browser merges incremental arrivals, preserves the composer and refreshes older edits",{skip:skip.skip || process.env.ARCHIPEL_NATIVE_BROWSER!=="1"},async t=>{
  const {chromium}=await import("@playwright/test"),f=await protocolFixture(t),browser=await chromium.launch({headless:true});
  t.after(()=>browser.close());
  const other=f.store.createChannel(f.alice,{name:"other-deltas",mode:"timeline",visibility:"members",admission:"open"});f.store.join(f.bob,other.id);
  const first=await f.call({body:"Before browser delta"});assert.equal(first.status,200);
  const context=await browser.newContext();await context.addCookies([{name:"archipel",value:f.session.token,url:f.webOrigin}]);
  const page=await context.newPage(),responses:any[]=[];
  page.on("response",response=>{if(response.url().includes(`/api/channels/${f.channel.id}/messages`) && response.request().method()==="GET")void response.json().then(data=>responses.push({url:response.url(),data})).catch(()=>{});});
  await page.goto(`${f.webOrigin}/#/c/${f.channel.id}`);
  await page.getByText("Before browser delta",{exact:true}).waitFor();
  // SSE reconnect/startup performs one full reconciliation before content-only
  // notices are eligible to use the page's cursor.
  await page.waitForTimeout(2000);
  f.store.post(f.bob,other.id,{body:"My offscreen message"});await page.waitForTimeout(1800);
  assert.equal(await page.locator(`[data-channel="${other.id}"] .count`).count(),0,"own posts do not become unread");
  const unseen=f.store.post(f.alice,other.id,{body:"Offscreen message from Alice"});
  await page.locator(`[data-channel="${other.id}"] .count`).getByText("1",{exact:true}).waitFor();
  f.store.markRead(f.bob,{target:other.id,seq:unseen.seq});
  f.store.post(f.alice,other.id,{body:"Overview and delta overlap"});await page.waitForTimeout(2000);
  assert.equal(await page.locator(`[data-channel="${other.id}"] .count`).textContent(),"1","overview and queued delta do not double-count unread");
  await page.locator("#message-body").fill("Unsent draft");await page.locator("#message-body").focus();
  const pageReads=responses.length;
  const second=await f.call({body:"After browser delta",token:f.aliceSession.token,csrf:f.aliceSession.csrf});assert.equal(second.status,200);
  await page.getByText("After browser delta",{exact:true}).waitFor();
  assert.equal(responses.length,pageReads,"shared live delta needs no message-page request");
  assert.equal(await page.locator("#message-body").inputValue(),"Unsent draft");
  assert.equal(await page.evaluate(()=>document.activeElement?.id),"message-body");
  f.store.editMessage(f.store.user(f.bob.id),first.data.result.id,{body:"Edited browser history",expected_edited_at:null});
  await page.getByText("Edited browser history",{exact:true}).waitFor();assert.equal(await page.getByText("Before browser delta",{exact:true}).count(),0);
  f.store.deleteMessage(f.store.user(f.alice.id),second.data.result.id);
  await page.waitForFunction(()=>!document.querySelector("#message-list")?.textContent?.includes("After browser delta"));
});

test("native raw page reuse observes legacy edits, deletion and fresh account metadata",skip,async t=>{
  const f=await fixture(t,1,4);
  const first=f.store.post(f.bob,f.channel.id,{body:"Initial version"});
  const check=async(before?:number)=>{const page=await f.call({op:"messages",before});assert.equal(page.status,200);assert.deepEqual(page.data.result.messages,f.store.messages(f.store.user(f.bob.id),f.channel.id,before));return page.data.result.messages;};
  await check();await check();
  const health=await fetch(`${f.origin}/health`,{headers:{Authorization:`Bearer ${secret}`}});
  const metrics=await health.json() as any;assert.ok(metrics.pages.some((p:any)=>p.hits>0));
  f.store.updateProfile(f.bob,{display_name:"Fresh profile",share_socials:true});
  assert.equal((await check())[0].display_name,"Fresh profile");
  f.store.editMessage(f.store.user(f.bob.id),first.id,{body:"Edited by compatibility",expected_edited_at:null});
  assert.equal((await check())[0].body,"Edited by compatibility");
  const second=f.store.post(f.bob,f.channel.id,{body:"A newly committed row"});assert.equal((await check()).length,2);
  await check(second.seq);await check(second.seq);
  f.store.deleteMessage(f.bob,first.id);assert.ok((await check())[0].deleted_at);
  f.store.leave(f.bob,f.channel.id);assert.equal((await f.call({op:"messages"})).status,403);
});

test("native emoji posts preserve custom and personal tags, aliases and reversible bans",skip,async t=>{
  const f=await fixture(t,1,4),image=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jK1kAAAAASUVORK5CYII=","base64").toString("base64");
  f.store.addEmoji(f.alice,{name:"native_custom",image});f.store.adoptEmoji(f.bob,"native_personal",image,"");
  const body="😀 :tada: :native_custom: :native_personal: :unknown: :native_custom:";
  const posted=await f.call({body});assert.equal(posted.status,200,JSON.stringify(posted));
  assert.deepEqual(posted.data.result,f.store.message(posted.data.result.id));
  assert.equal(JSON.parse(posted.data.result.emoji_tags).length,2);
  const compare=async()=>{const page=await f.call({op:"messages"});assert.equal(page.status,200);assert.deepEqual(page.data.result.messages,f.store.messages(f.store.user(f.bob.id),f.channel.id));return page.data.result.messages;};
  await compare();
  f.db.prepare("UPDATE channels SET reaction_bans=? WHERE id=?").run(JSON.stringify(["tada","native_custom"]),f.channel.id);
  const masked=await compare();assert.ok(!masked[0].body.includes(":tada:"));assert.ok(!masked[0].body.includes(":native_custom:"));
  assert.equal((await f.call({body:"🎉"})).status,403);
  f.db.prepare("UPDATE instance_settings SET value=? WHERE key='emoji_bans'").run(JSON.stringify(["+1"]));
  // Seed setting in case the fixture has not configured any instance bans yet.
  f.db.prepare("INSERT OR IGNORE INTO instance_settings(key,value) VALUES('emoji_bans',?)").run(JSON.stringify(["+1"]));
  for(const body of [":thumbsup:","👍🏽",":+1:"])assert.equal((await f.call({body})).status,403);
  f.db.prepare("UPDATE channels SET reaction_bans='[]' WHERE id=?").run(f.channel.id);
  f.db.prepare("UPDATE instance_settings SET value='[]' WHERE key='emoji_bans'").run();await compare();
  assert.equal(f.store.message(posted.data.result.id).body,body);
});

test("durable change relay survives restart, coalesces duplicates and bounds large notification batches",skip,async t=>{
  const f=await fixture(t,1,4),notices:any[]=[];
  await f.db.listenExternalChanges();f.db.onChange=changes=>notices.push(...changes.filter(c=>c.table!=="native_changes"));
  f.child.kill();await new Promise<void>(done=>f.child.once("exit",()=>done()));
  const payload=JSON.stringify([{table:"messages",rows:[{channel_id:f.channel.id}]}]);
  assert.throws(()=>f.store.transaction(()=>{f.db.prepare("INSERT INTO native_changes(payload) VALUES(?)").run(payload);throw new Error("rollback notice");}),/rollback notice/);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM native_changes").get()!.n,0);
  f.db.prepare("INSERT INTO native_changes(payload) VALUES(?),(?)").run(payload,payload);
  const restarted=spawn(binary,[],{windowsHide:true,stdio:["ignore","pipe","pipe"],env:{...process.env,DEV_AUTH:"true",DATABASE_URL:url,NATIVE_SCHEMA:f.schema,BASE_URL:f.store.baseUrl,NATIVE_HOST:"127.0.0.1",NATIVE_PORT:"0",NATIVE_WORKERS:"1",NATIVE_DATABASE_POOL:"4",NATIVE_BRIDGE_SECRET:secret}});
  t.after(async()=>{restarted.kill();if(restarted.exitCode===null && restarted.signalCode===null)await new Promise<void>(done=>restarted.once("exit",()=>done()));});
  await new Promise<void>((done,fail)=>{const timer=setTimeout(()=>fail(new Error("Relay restart timeout")),30000);restarted.stdout.once("data",()=>{clearTimeout(timer);done();});restarted.once("exit",()=>{clearTimeout(timer);fail(new Error("Relay exited during restart"));});});
  for(let i=0;i<80 && !notices.length;i++)await new Promise(done=>setTimeout(done,25));
  assert.deepEqual(notices,[{table:"messages",rows:[{channel_id:f.channel.id}]}]);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM native_changes").get()!.n,0);
  notices.length=0;
  const rows=Array.from({length:900},(_,i)=>JSON.stringify([{table:"read_marks",rows:[{user_id:`relay-user-${i}`}]}]));
  f.db.native("INSERT INTO native_changes(payload) SELECT value FROM jsonb_array_elements_text($1::jsonb)",[JSON.stringify(rows)]);
  for(let i=0;i<120 && notices.reduce((n,c)=>n+c.rows.length,0)<900;i++)await new Promise(done=>setTimeout(done,25));
  assert.equal(new Set(notices.flatMap(c=>c.rows.map((row:any)=>row.user_id))).size,900);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM native_changes").get()!.n,0);
});

const nativePermissions={federation_send:true,federation_receive:true,federation_subscribe:true,federation_post:true,federate_channels:true};
test("native FWDXP outbox has verifiable origin proofs, current grants and atomic replay",skip,async t=>{
  const f=await fixture(t,2,4);
  const fed=new Federation(f.store,loadConfig({FEDERATION_CHANNEL_TRANSPORT:"off",DEV_AUTH:"true",BASE_URL:f.store.baseUrl}));
  fed.setEnabled(f.alice,true);grant(f.store,f.alice,f.bob.id,nativePermissions);
  fed.setChannel(f.alice,f.channel.id,true);
  for(const actor of ["https://one.example/actors/users/a","https://two.example/actors/users/b"])
    f.db.prepare("INSERT INTO federation_follows(channel_id,actor,follow_id,status) VALUES(?,?,?,'accepted')").run(f.channel.id,actor,randomUUID());
  const id=randomUUID(),body="Native FWDXP — 😀\nOrdinary punctuation: preserved";
  const replies=await Promise.all(Array.from({length:8},()=>f.call({body,message_id:id})));
  assert.ok(replies.every(r=>r.status===200),JSON.stringify(replies));assert.equal(replies.filter(r=>r.data.changed).length,1);
  assert.deepEqual(replies[0].data.result,f.store.message(id));
  const rows=f.db.prepare("SELECT * FROM federation_outgoing WHERE purpose='relay'").all();assert.equal(rows.length,1);
  const activity=JSON.parse(rows[0].activity),note=activity.object.object,{proof,...document}=note;
  assert.equal(activity.type,"Announce");assert.equal(activity.object.type,"Create");
  assert.equal(note.content,body);assert.equal(note.channel,fed.channelActor(f.store.channel(f.channel.id)));
  assert.equal(proof.actor,fed.userActor(f.store.user(f.bob.id)));
  assert.equal(verify("RSA-SHA256",Buffer.from(JSON.stringify(document)),fed.keys().public_key,Buffer.from(proof.signature,"base64")),true);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM federation_deliveries WHERE activity_id=?").get(rows[0].id)!.n,2);
  grant(f.store,f.alice,f.bob.id,{...nativePermissions,federation_post:false});
  assert.equal((await f.call({body:"Revoked posting"})).status,403);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM messages").get()!.n,1);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM federation_outgoing WHERE purpose='relay'").get()!.n,1);
});

test("native large-channel announcements use a compact audience with all recipient rows intact",skip,async t=>{
  const f=await fixture(t,1,4);
  const fed=new Federation(f.store,loadConfig({FEDERATION_CHANNEL_TRANSPORT:"off",DEV_AUTH:"true",BASE_URL:f.store.baseUrl}));
  fed.setEnabled(f.alice,true);grant(f.store,f.alice,f.bob.id,nativePermissions);fed.setChannel(f.alice,f.channel.id,true);
  f.store.transaction(()=>{
    for(let i=0;i<1400;i++) f.db.prepare("INSERT INTO federation_follows(channel_id,actor,follow_id,status) VALUES(?,?,?,'accepted')")
      .run(f.channel.id,`https://large-peer.example/actors/users/${String(i).padStart(36,"0")}`,`follow-${i}`);
  });
  const post=await f.call({body:"A small native message in a large channel"});assert.equal(post.status,200,JSON.stringify(post));
  const row=f.db.prepare("SELECT id,activity FROM federation_outgoing WHERE purpose='relay'").get()!;
  assert.deepEqual(JSON.parse(String(row.activity)).to,[fed.channelActor(f.store.channel(f.channel.id))]);
  assert.ok(Buffer.byteLength(String(row.activity))<65536);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM federation_deliveries WHERE activity_id=?").get(row.id)!.n,1400);
});

test("native titles, replies, topics and attachment publication preserve message contracts",skip,async t=>{
  const f=await fixture(t,1,4);
  const threaded=f.store.createChannel(f.alice,{name:"threads",mode:"threaded",visibility:"members",admission:"open"});f.store.join(f.bob,threaded.id);
  assert.equal((await f.call({channel:threaded.id})).status,400);
  const first=await f.call({channel:threaded.id,title:"A native thread"});assert.equal(first.status,200);
  const reply=await f.call({channel:threaded.id,parent_id:first.data.result.id,body:"A reply"});assert.equal(reply.status,200);
  assert.equal((await f.call({channel:threaded.id,parent_id:first.data.result.id,title:"Bad title"})).status,400);
  assert.deepEqual((await f.call({channel:threaded.id,op:"messages"})).data.result.messages,f.store.messages(f.bob,threaded.id));
  const topical=f.store.createChannel(f.alice,{name:"topics",mode:"topical",visibility:"members",admission:"open"});f.store.join(f.bob,topical.id);
  const topic=f.store.createTopic(f.bob,topical.id,"One topic");
  const post=await f.call({channel:topical.id,topic_id:topic.id,body:"Topic message"});assert.equal(post.status,200);
  assert.deepEqual(post.data.result,f.store.message(post.data.result.id));
  assert.equal((await f.call({channel:f.channel.id,parent_id:post.data.result.id})).status,400);
  const media=f.store.addAttachment(f.bob,Buffer.from("Sample"),"sample.txt");
  const attached=await f.call({body:`Read ${media.url}`});assert.equal(attached.status,200);
  assert.equal(f.db.prepare("SELECT published FROM attachments WHERE owner_id=?").get(f.bob.id)!.published,1);
});

test("native home edits preserve revisions, custom emoji, titles and reply relationships",skip,async t=>{
  const f=await fixture(t,1,4),message=f.store.post(f.bob,f.channel.id,{body:"Original"});
  const edited=await f.call({op:"edit",message_id:message.id,body:"Updated :tada:",expected_edited_at:null});assert.equal(edited.status,200,JSON.stringify(edited));
  assert.deepEqual(edited.data.result,f.store.message(message.id));assert.ok(edited.data.result.edited_at>message.created_at);
  assert.equal((await f.call({op:"edit",message_id:message.id,body:"Stale",expected_edited_at:null})).status,409);
  assert.equal((await f.call({op:"edit",message_id:message.id,body:"Wrong author",token:f.aliceSession.token,csrf:f.aliceSession.csrf,expected_edited_at:edited.data.result.edited_at})).status,403);
  assert.equal(f.db.prepare("SELECT target FROM audit WHERE action='message.edit'").get()!.target,message.id);
  const threaded=f.store.createChannel(f.alice,{name:"editable",mode:"threaded",visibility:"members",admission:"open"});f.store.join(f.bob,threaded.id);
  const root=f.store.post(f.bob,threaded.id,{body:"Root",title:"Keep title"}),reply=f.store.post(f.bob,threaded.id,{body:"Reply",parent_id:root.id});
  const changed=await f.call({op:"edit",channel:threaded.id,message_id:root.id,body:"Changed root",expected_edited_at:null});assert.equal(changed.status,200);assert.equal(changed.data.result.title,"Keep title");
  assert.equal((await f.call({op:"edit",channel:threaded.id,message_id:root.id,body:"Remove title",title:null,title_supplied:true,expected_edited_at:changed.data.result.edited_at})).status,400);
  f.store.deleteMessage(f.bob,root.id);
  assert.equal((await f.call({op:"edit",channel:threaded.id,message_id:reply.id,body:"Edited reply after parent removal",expected_edited_at:null})).status,200);
  const current=await f.call({op:"messages"});assert.deepEqual(current.data.result.messages,f.store.messages(f.bob,f.channel.id));
});

test("native home edit HTTP and signed FWDXP update reach the replica without compatibility mutation",skip,async t=>{
  const home=await protocolFixture(t),remote=await protocolFixture(t);
  const subscription=await remote.fed.subscribe(remote.store.user(remote.bob.id),home.fed.channelActor(home.store.channel(home.channel.id)));
  for(let i=0;i<5;i++){await remote.fed.tick();await home.fed.tick();}
  const posted=await home.call({body:"Native edit before"});await home.fed.tick();
  const original=home.store.editMessage;home.store.editMessage=()=>{throw new Error("Native edit used compatibility");};t.after(()=>{home.store.editMessage=original;});
  const response=await fetch(`${home.webOrigin}/api/messages/${posted.data.result.id}`,{method:"PATCH",headers:{Cookie:`archipel=${home.session.token}`,Origin:home.webOrigin,"Content-Type":"application/json","X-CSRF-Token":home.session.csrf},body:JSON.stringify({body:"Native edit after",expected_edited_at:null})});assert.equal(response.status,200,await response.clone().text());
  await home.fed.tick();
  const messages=remote.store.messages(remote.store.user(remote.bob.id),subscription.channel.id);assert.equal(messages.length,1);assert.equal(messages[0].body,"Native edit after");assert.ok(messages[0].edited_at);
});

test("native commits notify every subscribed front end, with schema isolation and no replay notice",skip,async t=>{
  const f=await fixture(t,1,4);
  const second=new PostgresDatabase(url!,f.schema),foreign=new PostgresDatabase(url!,`${f.schema}_other`,true);
  t.after(()=>{second.close();foreign.close();});
  const own:unknown[]=[],other:unknown[]=[],separate:unknown[]=[];
  f.db.onChange=changes=>own.push(changes);second.onChange=changes=>other.push(changes);foreign.onChange=changes=>separate.push(changes);
  await Promise.all([f.db.listenExternalChanges(),second.listenExternalChanges(),foreign.listenExternalChanges()]);
  const id=randomUUID();assert.equal((await f.call({message_id:id})).status,200);
  for(let n=0;n<20 && (!own.length || !other.length);n++) await new Promise(done=>setTimeout(done,25));
  const change=[{table:"messages",rows:[{channel_id:f.channel.id,id}]}];
  assert.deepEqual(own,[change]);assert.deepEqual(other,[change]);assert.deepEqual(separate,[]);
  assert.equal((await f.call({message_id:id})).data.changed,false);assert.equal((await f.call({message_id:id,body:"Conflict"})).status,409);
  await new Promise(done=>setTimeout(done,75));assert.equal(own.length,1);assert.equal(other.length,1);
});

async function protocolFixture(t:TestContext,workers=2,transport="off") {
  const server=createServer();await new Promise<void>(done=>server.listen(0,"127.0.0.1",done));
  const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const f=await fixture(t,workers,4,origin,transport);
  const config=loadConfig({DEV_AUTH:"true",BASE_URL:origin,HOST:"127.0.0.1",DATABASE_URL:url,NATIVE_CHAT_URL:f.origin,NATIVE_BRIDGE_SECRET:secret,
    FEDERATION_CHANNEL_TRANSPORT:transport,FEDERATION_SEND_RATE:"1000",FEDERATION_SEND_INTERVAL:"100",FEDERATION_PEER_SEND_RATE:"0",RATE_LIMIT_FEDERATION:"10000"});
  const app=createApp(config,f.store),fed=app.locals.federation as Federation;server.on("request",app);
  f.shutdown.push(async()=>{await fed.channelFeed.close();app.locals.events.close();server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));});
  fed.setEnabled(f.alice,true);grant(f.store,f.alice,f.bob.id,nativePermissions);grant(f.store,f.alice,f.alice.id,nativePermissions);
  fed.setChannel(f.store.user(f.alice.id),f.channel.id,true);
  return {...f,fed,app,server,webOrigin:origin};
}

for (const transport of ["batch", "stream"]) test(`native channel ${transport} commits events and cursors without follower queue fan-out`, skip, async t => {
  const home = await protocolFixture(t, 1, transport), remote = await protocolFixture(t, 1, transport);
  const actor = home.fed.channelActor(home.store.channel(home.channel.id));
  const sub = await remote.fed.subscribe(remote.store.user(remote.bob.id), actor);
  await remote.fed.subscribe(remote.store.user(remote.alice.id), actor);
  for (let n = 0; n < 5; n++) { await remote.fed.tick(); await home.fed.tick(); }
  const before = remote.fed.nativeStats.received;
  const first = await home.call({ body: "Native streamed event" });
  assert.equal(first.status, 200, JSON.stringify(first));
  assert.equal(Number(home.db.prepare("SELECT COUNT(*) AS n FROM federation_channel_events").get()!.n), 1);
  assert.equal(Number(home.db.prepare("SELECT COUNT(*) AS n FROM federation_instance_events").get()!.n), 1);
  assert.equal(Number(home.db.prepare("SELECT COUNT(*) AS n FROM federation_deliveries d JOIN federation_outgoing o ON o.id=d.activity_id WHERE o.purpose='relay'").get()!.n), 0);
  if (transport === "batch") {
    const page = home.fed.channelFeed.page(remote.fed.publicActor("users", remote.bob.id), home.channel.id, 0);
    await assert.rejects(remote.fed.receiveChannelEvent(home.fed.publicActor("channels", home.channel.id), page.events[0].activity,
      { channel: actor, follow: page.follow, after: 0, cursor: 2 }), /checkpoint/i);
    assert.equal(Number(remote.db.prepare("SELECT cursor FROM federation_channel_cursors").get()!.cursor), 0);
    assert.equal(Number(remote.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE body='Native streamed event'").get()!.n), 0);
  }
  await remote.fed.tick();
  const until = async (predicate: () => boolean) => {
    const deadline = Date.now() + 10000;
    while (!predicate()) { if (Date.now() >= deadline) assert.fail(JSON.stringify(remote.db.prepare("SELECT * FROM federation_channel_cursors").all())); await new Promise(done => setTimeout(done, 25)); }
  };
  await until(() => Number(remote.db.prepare("SELECT cursor FROM federation_channel_cursors").get()?.cursor) === 1);
  assert.equal(remote.store.messages(remote.store.user(remote.bob.id), sub.channel.id)[0].body, "Native streamed event");
  assert.equal(remote.fed.nativeStats.received, before + 1);
  assert.equal(Number(remote.db.prepare("SELECT COUNT(*) AS n FROM federation_channel_cursors").get()!.n), 1);
  assert.equal(Number(remote.db.prepare("SELECT COUNT(*) AS n FROM federation_instance_cursors").get()!.n), 1);
  const edited = await home.call({ op: "edit", message_id: first.data.result.id, body: "Native streamed edit", expected_edited_at: null });
  assert.equal(edited.status, 200, JSON.stringify(edited));
  await remote.fed.tick(); await until(() => Number(remote.db.prepare("SELECT cursor FROM federation_channel_cursors").get()?.cursor) === 2);
  assert.equal(remote.store.messages(remote.store.user(remote.bob.id), sub.channel.id)[0].body, "Native streamed edit");
  home.store.deleteMessage(home.store.user(home.bob.id), first.data.result.id);
  await remote.fed.tick(); await until(() => Number(remote.db.prepare("SELECT cursor FROM federation_channel_cursors").get()?.cursor) === 3);
  assert.ok(remote.db.prepare("SELECT deleted_at FROM messages WHERE remote_object=?").get(`${home.webOrigin}/objects/messages/${first.data.result.id}`)?.deleted_at);
});
test("three instances accept native FWDXP submissions and relay committed messages with valid proofs",skip,async t=>{
  const instances=[await protocolFixture(t),await protocolFixture(t),await protocolFixture(t)];
  const home=instances[0],remotes=instances.slice(1),subscriptions=[];
  for(const remote of remotes) subscriptions.push(await remote.fed.subscribe(remote.store.user(remote.bob.id),home.fed.channelActor(home.store.channel(home.channel.id))));
  const drain=async()=>{for(let step=0;step<5;step++) for(const f of instances) await f.fed.tick();};
  await drain();
  for(let n=0;n<remotes.length;n++) assert.ok(remotes[n].store.role(subscriptions[n].channel.id,remotes[n].bob.id));
  const local=await home.call({body:"Native home broadcast"});assert.equal(local.status,200);
  const remote=remotes[0],channel=subscriptions[0].channel.id,id=randomUUID();
  const nativeNotices:unknown[]=[];
  await remote.db.listenExternalChanges();remote.db.onChange=changes=>nativeNotices.push(changes);
  const submitted=await remote.call({channel,message_id:id,body:"Native remote submission"});assert.equal(submitted.status,200,JSON.stringify(submitted));
  assert.equal(submitted.data.result.queued,true);
  for(let n=0;n<20 && !nativeNotices.length;n++)await new Promise(done=>setTimeout(done,25));
  assert.deepEqual(nativeNotices,[[{table:"federation_outgoing",rows:[{user_id:remote.bob.id}]}]]);
  assert.deepEqual(submitted.data.result,remote.fed.pendingPosts(remote.store.user(remote.bob.id),channel)[0]);
  const pending=await remote.call({channel,op:"messages"});assert.equal(pending.status,200);
  assert.deepEqual(pending.data.result.pending,remote.fed.pendingPosts(remote.store.user(remote.bob.id),channel));
  const replay=await Promise.all(Array.from({length:6},()=>remote.call({channel,message_id:id,body:"Native remote submission"})));
  assert.ok(replay.every(r=>r.status===200 && !r.data.changed));
  assert.equal((await remote.call({channel,message_id:id,body:"Conflict"})).status,409);
  await drain();
  for(let n=0;n<instances.length;n++) {
    const f=instances[n]; const channel: string=n===0?home.channel.id:subscriptions[n-1].channel.id;
    const page=await f.call({channel,op:"messages"});assert.equal(page.status,200,JSON.stringify(page));
    assert.deepEqual(page.data.result.messages,f.store.messages(f.store.user(f.bob.id),channel));assert.deepEqual(page.data.result.pending,[]);
    assert.deepEqual(page.data.result.messages.map((m:any)=>m.body),["Native home broadcast","Native remote submission"]);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM federation_deliveries WHERE status IN ('failed','pending')").get()!.n,0);
    assert.ok(f.fed.nativeStats.received>0);assert.ok(f.fed.nativeStats.ticks>0);
  }
  const allowedActor=remote.store.channel(channel).remote_actor!;
  remote.db.prepare("UPDATE channels SET remote_actor=? WHERE id=?").run("http://127.0.0.2/actors/channels/unsafe",channel);
  assert.equal((await remote.call({channel,op:"messages"})).status,400);
  assert.throws(()=>remote.fed.allowed("http://127.0.0.2/actors/channels/unsafe"));
  remote.db.prepare("UPDATE channels SET remote_actor=? WHERE id=?").run(allowedActor,channel);
  remote.fed.block(remote.alice,{target:home.webOrigin,kind:"instance",blocked:true});
  assert.equal((await remote.call({channel,op:"messages"})).status,403);assert.equal((await remote.call({channel,body:"Blocked"})).status,403);
});

test("native Follow receipt preserves open admission, pending approval, bans and duplicate IDs",skip,async t=>{
  const home=await protocolFixture(t),remote=await protocolFixture(t),actor=remote.fed.userActor(remote.store.user(remote.bob.id));
  const privateChannel=home.store.createChannel(home.alice,{name:"native-private",mode:"timeline",visibility:"members",admission:"allowlist"});home.fed.setChannel(home.alice,privateChannel.id,true);
  const before=home.fed.nativeStats.unsupported;
  const follow=async(channel:string,id=`${remote.webOrigin}/federation/activities/${randomUUID()}`)=>{
    const activity={id,type:"Follow",actor,object:home.fed.channelActor(home.store.channel(channel))},body=JSON.stringify(activity),destination=new URL(`${home.webOrigin}/federation/inbox`);
    const response=await fetch(destination,{method:"POST",headers:signedHeaders(destination,"POST",actor,remote.fed.keys().private_key,body),body});assert.equal(response.status,202,await response.text());return activity;
  };
  const open=await follow(home.channel.id);await follow(home.channel.id,open.id);
  const row=home.db.prepare("SELECT status,follow_id FROM federation_follows WHERE channel_id=? AND actor=?").get(home.channel.id,actor)!;assert.equal(row.status,"accepted");assert.equal(row.follow_id,open.id);
  assert.equal(home.db.prepare("SELECT COUNT(*) AS n FROM federation_outgoing WHERE purpose='membership'").get()!.n,1);
  await follow(privateChannel.id);assert.equal(home.db.prepare("SELECT status FROM federation_follows WHERE channel_id=? AND actor=?").get(privateChannel.id,actor)!.status,"pending");
  const user=home.db.prepare("SELECT id FROM users WHERE remote_actor=?").get(actor)!;
  home.db.prepare("INSERT INTO channel_rules(channel_id,user_id,rule) VALUES(?,?,'allow')").run(privateChannel.id,user.id);
  await follow(privateChannel.id);assert.equal(home.db.prepare("SELECT status FROM federation_follows WHERE channel_id=? AND actor=?").get(privateChannel.id,actor)!.status,"accepted");
  home.db.prepare("UPDATE channel_rules SET rule='block' WHERE channel_id=? AND user_id=?").run(privateChannel.id,user.id);
  await follow(privateChannel.id);assert.equal(home.db.prepare("SELECT status FROM federation_follows WHERE channel_id=? AND actor=?").get(privateChannel.id,actor),undefined);
  const last=home.db.prepare("SELECT activity FROM federation_outgoing WHERE channel_id=? AND purpose='membership' ORDER BY created_at DESC LIMIT 1").get(privateChannel.id)!;assert.equal(JSON.parse(String(last.activity)).type,"Reject");
  assert.equal(home.fed.nativeStats.unsupported,before);
  const conflict=JSON.stringify({...open,extra:true}),destination=new URL(`${home.webOrigin}/federation/inbox`);
  assert.equal((await fetch(destination,{method:"POST",headers:signedHeaders(destination,"POST",actor,remote.fed.keys().private_key,conflict),body:conflict})).status,409);
});

test("native actor refresh atomically removes an obsolete avatar and emits no notice for a no-op",skip,async t=>{
  const home=await protocolFixture(t),remote=await protocolFixture(t),peer=remote.fed.userActor(remote.store.user(remote.bob.id));
  const subscription=await remote.fed.subscribe(remote.store.user(remote.bob.id),home.fed.channelActor(home.store.channel(home.channel.id)));
  for(let round=0;round<5;round++){await remote.fed.tick();await home.fed.tick();}
  home.db.prepare("INSERT INTO remote_avatars(id,peer,revision,mime,image,source,fetched_at) VALUES(?,?,?,'image/png',?,?,0)")
    .run(randomUUID(),peer,"old",Buffer.from([1,2,3]),`${remote.webOrigin}/old-avatar`);
  const notices:{table:string;rows:unknown[]}[][]=[];
  await home.db.listenExternalChanges();home.db.onChange=changes=>notices.push(changes);
  const refresh=async(body:string)=>{
    home.db.prepare("DELETE FROM federation_actors WHERE id=?").run(peer);
    const response=await remote.call({channel:subscription.channel.id,body});assert.equal(response.status,200);
    await remote.fed.tick();
    for(let attempt=0;attempt<20 && home.db.prepare("SELECT COUNT(*) AS n FROM native_changes").get()!.n;attempt++)await new Promise(done=>setTimeout(done,25));
    await new Promise(done=>setTimeout(done,25));
  };
  await refresh("Avatar removed during native refresh");
  assert.equal(home.db.prepare("SELECT COUNT(*) AS n FROM remote_avatars WHERE peer=?").get(peer)!.n,0);
  const removed=notices.flat().filter(change=>change.table==="remote_avatars");assert.equal(removed.length,1);assert.deepEqual(removed[0].rows,[]);
  notices.length=0;
  await refresh("No second avatar removal");
  assert.equal(notices.flat().filter(change=>change.table==="remote_avatars").length,0);
});

test("native sender reuses its unlocked connection and reconnects after backend loss",skip,async t=>{
  const home=await protocolFixture(t);
  await home.fed.tick();
  const connections=()=>home.db.native("SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND state='idle' AND query='SELECT pg_advisory_unlock($1)'").map(row=>Number(row.pid)).sort((a,b)=>a-b);
  const first=connections();assert.equal(first.length,1);
  for(let round=0;round<12;round++)await home.fed.tick();
  assert.deepEqual(connections(),first,"idle rounds must keep the same unlocked backend");
  home.db.native("SELECT pg_terminate_backend($1)",[first[0]]);
  await assert.rejects(home.fed.tick());
  await home.fed.tick();
  const replacement=connections();assert.equal(replacement.length,1);assert.notEqual(replacement[0],first[0]);
});

test("native sender groups exact shared inboxes and retains distinct recipient audit rows",skip,async t=>{
  const home=await protocolFixture(t),remote=await protocolFixture(t),actor=home.fed.channelActor(home.store.channel(home.channel.id));
  await remote.fed.subscribe(remote.store.user(remote.bob.id),actor);
  await remote.fed.subscribe(remote.store.user(remote.alice.id),actor);
  for(let i=0;i<5;i++){await remote.fed.tick();await home.fed.tick();}
  const before=home.fed.deliveryStats.requests,received=remote.fed.nativeStats.received;
  assert.equal((await home.call({body:"One shared POST"})).status,200);
  await home.fed.tick();
  assert.equal(home.fed.deliveryStats.requests-before,1);
  assert.equal(remote.fed.nativeStats.received-received,1);
  const rows=home.db.prepare("SELECT status,attempts FROM federation_deliveries d JOIN federation_outgoing o ON o.id=d.activity_id WHERE o.purpose='relay'").all();
  assert.equal(rows.length,2);assert.ok(rows.every(row=>row.status==="sent" && row.attempts===1));
});

test("native receipt retains reserved database capacity when foreground channels are blocked",skip,async t=>{
  const home=await protocolFixture(t),remote=await protocolFixture(t,1);
  const sub=await remote.fed.subscribe(remote.store.user(remote.bob.id),home.fed.channelActor(home.store.channel(home.channel.id)));
  for(let round=0;round<5;round++){await remote.fed.tick();await home.fed.tick();}
  const channels=Array.from({length:3},(_,i)=>{
    const c=remote.store.createChannel(remote.store.user(remote.alice.id),{name:`blocked-${i}`,mode:"timeline",visibility:"members",admission:"open"});
    remote.store.join(remote.store.user(remote.bob.id),c.id);return c.id;
  });
  const blocker=new pg.Client({connectionString:url});await blocker.connect();
  t.after(async()=>{await blocker.query("ROLLBACK").catch(()=>{});await blocker.end();});
  await blocker.query("BEGIN");
  await blocker.query(`SELECT id FROM "${remote.schema}".channels WHERE id=ANY($1) FOR UPDATE`,[channels]);
  const requests=channels.map(channel=>remote.call({channel,body:"Waiting for channel row"}));
  try {
    let occupied=0;
    for(let attempt=0;attempt<100;attempt++) {
      // PostgreSQL caches activity statistics within a transaction. Refresh the
      // observer snapshot while retaining the deliberate channel row locks.
      await blocker.query("SELECT pg_stat_clear_snapshot()");
      const row=await blocker.query("SELECT COUNT(DISTINCT a.pid)::int AS n FROM pg_stat_activity a JOIN pg_locks l ON l.pid=a.pid WHERE a.wait_event_type='Lock' AND l.relation=$1::regclass",[`"${remote.schema}".channels`]);
      occupied=row.rows[0].n;if(occupied===3)break;
      await new Promise(done=>setTimeout(done,20));
    }
    assert.equal(occupied,3,"all three foreground connections must be occupied by blocked channels");
    await home.call({body:"Receipt despite foreground saturation"});await home.fed.tick();
    assert.deepEqual(remote.store.messages(remote.store.user(remote.bob.id),sub.channel.id).map(m=>m.body),
      ["Receipt despite foreground saturation"]);
  } finally {
    await blocker.query("ROLLBACK");
    assert.ok((await Promise.all(requests)).every(r=>r.status===200));
  }
});

test("native receipt borrows idle foreground capacity when another channel holds the reservation",skip,async t=>{
  const home=await protocolFixture(t),remote=await protocolFixture(t,1);
  const other=home.store.createChannel(home.store.user(home.alice.id),{name:"other-inbox-lane",mode:"timeline",visibility:"members",admission:"open"});
  home.store.join(home.store.user(home.bob.id),other.id);home.fed.setChannel(home.store.user(home.alice.id),other.id,true);
  const first=await remote.fed.subscribe(remote.store.user(remote.bob.id),home.fed.channelActor(home.store.channel(home.channel.id)));
  const second=await remote.fed.subscribe(remote.store.user(remote.alice.id),home.fed.channelActor(home.store.channel(other.id)));
  for(let round=0;round<5;round++){await remote.fed.tick();await home.fed.tick();}
  const blocker=new pg.Client({connectionString:url});await blocker.connect();
  t.after(()=>blocker.end());await blocker.query("BEGIN");
  await blocker.query(`SELECT id FROM "${remote.schema}".channels WHERE id=$1 FOR UPDATE`,[first.channel.id]);
  try {
    await home.call({body:"Holding receiver reservation"});await home.fed.tick({wait:false});
    assert.ok(home.fed.nativeStats.senderActive>0);
    await home.call({channel:other.id,body:"Independent receiver lane"});await home.fed.tick({wait:false});
    assert.deepEqual(remote.store.messages(remote.store.user(remote.alice.id),second.channel.id).map(m=>m.body),
      ["Independent receiver lane"]);
    const snapshot=await fetch(`${remote.origin}/health`,{headers:{Authorization:`Bearer ${secret}`}}).then(r=>r.json()) as any;
    assert.ok(snapshot.stages.receivers[0].poolBorrow.calls>0);
  } finally {
    await blocker.query("ROLLBACK");await home.fed.tick({drainOnly:true});
  }
  assert.deepEqual(remote.store.messages(remote.store.user(remote.bob.id),first.channel.id).map(m=>m.body),
    ["Holding receiver reservation"]);
});

test("native sender refills across ticks while a peer stalls and keeps the instance lock until drain",skip,async t=>{
  const home=await protocolFixture(t),slow=await protocolFixture(t),fast=await protocolFixture(t);
  const actor=home.fed.channelActor(home.store.channel(home.channel.id));
  const slowSub=await slow.fed.subscribe(slow.store.user(slow.bob.id),actor);
  const fastSub=await fast.fed.subscribe(fast.store.user(fast.bob.id),actor);
  for(let round=0;round<5;round++)for(const f of [slow,fast,home])await f.fed.tick();
  let release!:()=>void,blocked=false,slowPosts=0;
  const gate=new Promise<void>(done=>{release=done;});t.after(release);
  slow.server.removeListener("request",slow.app);
  slow.server.on("request",(req,res)=>{
    if(req.url==="/federation/inbox" && req.method==="POST") {
      slowPosts++;blocked=true;void gate.then(()=>slow.app(req,res));
    } else slow.app(req,res);
  });
  await home.call({body:"Before stalled peer"});
  await home.fed.tick({wait:false});assert.ok(blocked);assert.ok(home.fed.nativeStats.senderActive>0);
  const key=createHash("sha256").update(`${home.schema}:federation-sender`).digest().readBigInt64BE().toString();
  const probe=new pg.Client({connectionString:url});await probe.connect();t.after(()=>probe.end());
  assert.equal((await probe.query("SELECT pg_try_advisory_lock($1) AS held",[key])).rows[0].held,false,
    "a second supervisor cannot acquire ownership between scheduling ticks");
  await home.call({body:"Pass stalled peer"});await home.fed.tick({wait:false});
  assert.deepEqual(fast.store.messages(fast.store.user(fast.bob.id),fastSub.channel.id).map(m=>m.body),
    ["Before stalled peer","Pass stalled peer"]);
  assert.equal(slowPosts,1,"the stalled recipient's successor must retain its order");
  release();await home.fed.tick({drainOnly:true});assert.equal(home.fed.nativeStats.senderActive,0);
  assert.equal(slowPosts,1,"draining must not select new work");
  assert.equal((await probe.query("SELECT pg_try_advisory_lock($1) AS held",[key])).rows[0].held,true);
  await probe.query("SELECT pg_advisory_unlock($1)",[key]);
  await home.fed.tick();
  assert.deepEqual(slow.store.messages(slow.store.user(slow.bob.id),slowSub.channel.id).map(m=>m.body),
    ["Before stalled peer","Pass stalled peer"]);
  const snapshot=await fetch(`${home.origin}/health`,{headers:{Authorization:`Bearer ${secret}`}}).then(r=>r.json()) as any;
  for(const stage of ["pool","selection","peers","policy","discovery","signing","http","finish"])
    assert.ok(snapshot.stages.sender[stage].calls>0,`${stage} must be measured`);
  assert.ok(snapshot.stages.receivers.every((stages:any)=>typeof stages.inboxActivityLock.totalMs==="number"));
});

test("native sender holds claims and its lock until accepted deliveries are durably marked",skip,async t=>{
  const home=await protocolFixture(t,1),remote=await protocolFixture(t,1);
  const second=home.store.createChannel(home.alice,{name:"completion-batch",mode:"timeline",visibility:"members",admission:"open"});
  home.store.join(home.bob,second.id);home.fed.setChannel(home.alice,second.id,true);
  await remote.fed.subscribe(remote.store.user(remote.bob.id),home.fed.channelActor(home.store.channel(home.channel.id)));
  await remote.fed.subscribe(remote.store.user(remote.alice.id),home.fed.channelActor(home.store.channel(second.id)));
  for(let i=0;i<5;i++){await remote.fed.tick();await home.fed.tick();}
  await home.call({body:"Batch acceptance one"});await home.call({channel:second.id,body:"Batch acceptance two"});
  const rows=home.db.prepare("SELECT d.id FROM federation_deliveries d JOIN federation_outgoing o ON o.id=d.activity_id WHERE o.purpose='relay' AND d.status='pending' ORDER BY d.id").all();assert.equal(rows.length,2);
  const blocker=new pg.Client({connectionString:url,options:`-c search_path=${home.schema}`});await blocker.connect();
  const accepted:import("node:http").ServerResponse[]=[];
  remote.server.removeListener("request",remote.app);
  remote.server.on("request",(req,res)=>{
    if(req.url==="/federation/inbox" && req.method==="POST"){
      req.resume();accepted.push(res);
      if(accepted.length===2)for(const response of accepted){response.writeHead(202);response.end();}
    }else remote.app(req,res);
  });
  let tick:Promise<void>|undefined,settled=false;
  try{
    await blocker.query("BEGIN");await blocker.query("SELECT id FROM federation_deliveries WHERE id=ANY($1::bigint[]) FOR UPDATE",[rows.map(row=>row.id)]);
    tick=home.fed.tick().finally(()=>{settled=true;});
    for(let n=0;n<100 && accepted.length<2;n++)await new Promise(done=>setTimeout(done,20));
    assert.equal(accepted.length,2,"Both independent inbox requests should be accepted");
    await new Promise(done=>setTimeout(done,40));assert.equal(settled,false);
    assert.equal(home.db.prepare("SELECT COUNT(*) AS n FROM federation_deliveries WHERE status='pending' AND id IN (?,?)").get(rows[0].id,rows[1].id)!.n,2);
    const key=createHash("sha256").update(`${home.schema}:federation-sender`).digest().readBigInt64BE().toString();
    assert.equal((await blocker.query("SELECT pg_try_advisory_lock($1) AS acquired",[key])).rows[0].acquired,false);
    await blocker.query("COMMIT");await tick;
    const audit=home.db.prepare("SELECT status,attempts,error FROM federation_deliveries WHERE id IN (?,?) ORDER BY id").all(rows[0].id,rows[1].id);
    assert.deepEqual(audit,[{status:"sent",attempts:1,error:null},{status:"sent",attempts:1,error:null}]);
    const health=await (await fetch(`${home.origin}/health`,{headers:{Authorization:`Bearer ${secret}`}})).json() as any;
    assert.ok(health.stages.sender.deliveryBatch.calls>0);
    assert.equal((await blocker.query("SELECT pg_try_advisory_lock($1) AS acquired",[key])).rows[0].acquired,true);
    await blocker.query("SELECT pg_advisory_unlock($1)",[key]);
  }finally{
    await blocker.query("ROLLBACK");
    for(const response of accepted)if(!response.writableEnded)response.end();
    await tick?.catch(()=>{});await blocker.end();
  }
});

test("native delivery retries a failed recipient head before sending its later activity",skip,async t=>{
  const home=await protocolFixture(t),remote=await protocolFixture(t);
  await remote.fed.subscribe(remote.store.user(remote.bob.id),home.fed.channelActor(home.store.channel(home.channel.id)));
  for(let i=0;i<5;i++){await remote.fed.tick();await home.fed.tick();}
  remote.server.removeListener("request",remote.app);
  let posts=0;
  remote.server.on("request",(req,res)=>{
    if(req.url==="/federation/inbox" && req.method==="POST" && ++posts===1){res.writeHead(500);res.end();}
    else remote.app(req,res);
  });
  await home.call({body:"First, retry me"});await home.call({body:"Then, deliver me"});
  await home.fed.tick();
  const pending=home.db.prepare("SELECT d.id,d.status,d.attempts,d.next_attempt FROM federation_deliveries d JOIN federation_outgoing o ON o.id=d.activity_id WHERE o.purpose='relay' ORDER BY d.id").all();
  assert.equal(pending.length,2);assert.equal(pending[0].status,"pending");assert.equal(pending[0].attempts,1);assert.ok(pending[0].next_attempt>Date.now());assert.equal(pending[1].attempts,0);assert.equal(posts,1);
  home.db.prepare("UPDATE federation_deliveries SET next_attempt=0 WHERE id=?").run(pending[0].id);
  await home.fed.tick();
  const channel=remote.db.prepare("SELECT id FROM channels WHERE remote_actor=?").get(home.fed.channelActor(home.store.channel(home.channel.id)))!.id;
  assert.deepEqual(remote.store.messages(remote.store.user(remote.bob.id),String(channel)).map(m=>m.body),["First, retry me","Then, deliver me"]);
});

test("native grouped failures preserve individual retry exhaustion, revocation and permanent rejection",skip,async t=>{
  const home=await protocolFixture(t),remote=await protocolFixture(t);
  const actor=home.fed.channelActor(home.store.channel(home.channel.id));
  for(const user of [remote.bob,remote.alice])await remote.fed.subscribe(remote.store.user(user.id),actor);
  for(let i=0;i<5;i++){await remote.fed.tick();await home.fed.tick();}
  const bob=remote.fed.userActor(remote.store.user(remote.bob.id));
  let status=500,posts=0,revoke=false;
  remote.server.removeListener("request",remote.app);
  remote.server.on("request",(req,res)=>{
    if(req.url==="/federation/inbox" && req.method==="POST"){
      posts++;
      if(revoke)home.db.prepare("UPDATE federation_follows SET status='blocked' WHERE channel_id=? AND actor=?").run(home.channel.id,bob);
      res.writeHead(status);res.end();
    }else remote.app(req,res);
  });
  const deliveries=(id:string)=>home.db.prepare("SELECT recipient,status,attempts,next_attempt FROM federation_deliveries WHERE activity_id=? ORDER BY recipient").all(id);
  const queue=async(body:string)=>{
    assert.equal((await home.call({body})).status,200);
    return String(home.db.prepare("SELECT id FROM federation_outgoing WHERE purpose='relay' ORDER BY created_at DESC,id DESC LIMIT 1").get()!.id);
  };
  const first=await queue("Mixed retry exhaustion");
  home.db.prepare("UPDATE federation_deliveries SET attempts=11 WHERE activity_id=? AND recipient=?").run(first,bob);
  await home.fed.tick();assert.equal(posts,1);
  let rows=deliveries(first);
  assert.equal(rows.find(r=>r.recipient===bob)!.status,"failed");
  assert.equal(rows.find(r=>r.recipient===bob)!.attempts,12);
  const retry=rows.find(r=>r.recipient!==bob)!;assert.equal(retry.status,"pending");assert.equal(retry.attempts,1);
  assert.ok(Number(retry.next_attempt)>Date.now());
  home.db.prepare("UPDATE federation_deliveries SET status='failed' WHERE activity_id=? AND status='pending'").run(first);
  const second=await queue("Revoke while grouped request fails");revoke=true;
  await home.fed.tick();assert.equal(posts,2);
  rows=deliveries(second);assert.equal(rows.find(r=>r.recipient===bob)!.status,"cancelled");
  assert.equal(rows.find(r=>r.recipient===bob)!.attempts,1);
  assert.equal(rows.find(r=>r.recipient!==bob)!.status,"pending");
  home.db.prepare("UPDATE federation_deliveries SET status='failed' WHERE activity_id=? AND status='pending'").run(second);
  home.db.prepare("UPDATE federation_follows SET status='accepted' WHERE channel_id=? AND actor=?").run(home.channel.id,bob);
  const third=await queue("Permanent grouped rejection");revoke=false;status=413;
  await home.fed.tick();assert.equal(posts,3);
  rows=deliveries(third);assert.ok(rows.every(r=>r.status==="failed" && r.attempts===1));
  assert.equal(home.db.prepare("SELECT COUNT(*) AS n FROM native_federation_heads WHERE lane=?").get(home.channel.id)!.n,0);
});

test("native sender cancels a recipient when author permission is revoked during discovery",skip,async t=>{
  const home=await protocolFixture(t),remote=await protocolFixture(t),peer=remote.fed.userActor(remote.store.user(remote.bob.id));
  await remote.fed.subscribe(remote.store.user(remote.bob.id),home.fed.channelActor(home.store.channel(home.channel.id)));
  for(let i=0;i<5;i++){await remote.fed.tick();await home.fed.tick();}
  home.db.prepare("DELETE FROM federation_actors WHERE id=?").run(peer);
  remote.server.removeListener("request",remote.app);
  let revoked=false,posts=0;
  remote.server.on("request",(req,res)=>{
    if(req.url===new URL(peer).pathname){home.db.prepare("UPDATE users SET federation_send=0 WHERE id=?").run(home.bob.id);revoked=true;}
    if(req.url==="/federation/inbox" && req.method==="POST")posts++;
    remote.app(req,res);
  });
  await home.call({body:"Revoked before transmission"});await home.fed.tick();
  assert.equal(revoked,true);assert.equal(posts,0);
  const row=home.db.prepare("SELECT d.status,d.attempts FROM federation_deliveries d JOIN federation_outgoing o ON o.id=d.activity_id WHERE o.purpose='relay'").get()!;
  assert.equal(row.status,"cancelled");assert.equal(row.attempts,0);
});

test("native sender lets another channel pass a retry but preserves state-change barriers",skip,async t=>{
  const home=await protocolFixture(t),remote=await protocolFixture(t);
  const second=home.store.createChannel(home.alice,{name:"independent",mode:"timeline",visibility:"members",admission:"open"});
  home.store.join(home.bob,second.id);home.fed.setChannel(home.alice,second.id,true);
  const subscriptions=[];
  for(const channel of [home.channel,second])subscriptions.push(await remote.fed.subscribe(remote.store.user(remote.bob.id),home.fed.channelActor(home.store.channel(channel.id))));
  for(let i=0;i<6;i++){await remote.fed.tick();await home.fed.tick();}
  await home.call({body:"Waiting retry"});
  const waiting=home.db.prepare("SELECT d.id FROM federation_deliveries d JOIN federation_outgoing o ON o.id=d.activity_id WHERE o.purpose='relay' ORDER BY d.id DESC LIMIT 1").get()!;
  home.db.prepare("UPDATE federation_deliveries SET next_attempt=? WHERE id=?").run(Date.now()+60000,waiting.id);
  await home.call({channel:second.id,body:"Independent delivery"});await home.fed.tick();
  assert.deepEqual(remote.store.messages(remote.store.user(remote.bob.id),subscriptions[1].channel.id).map(m=>m.body),["Independent delivery"]);
  assert.equal(home.db.prepare("SELECT status FROM federation_deliveries WHERE id=?").get(waiting.id)!.status,"pending");
  // A state-changing activity must remain a barrier even in another channel.
  home.db.prepare("UPDATE federation_outgoing SET activity=? WHERE id=(SELECT activity_id FROM federation_deliveries WHERE id=?)")
    .run(JSON.stringify({type:"Announce",object:{type:"Update",object:{type:"Note"}}}),waiting.id);
  await home.call({channel:second.id,body:"Must wait for update"});await home.fed.tick();
  assert.deepEqual(remote.store.messages(remote.store.user(remote.bob.id),subscriptions[1].channel.id).map(m=>m.body),["Independent delivery"]);
});

test("native inbox rejects digest tampering, activity ID reuse and conflicting origin content",skip,async t=>{
  const home=await protocolFixture(t),remote=await protocolFixture(t);
  const subscription=await remote.fed.subscribe(remote.store.user(remote.bob.id),home.fed.channelActor(home.store.channel(home.channel.id)));
  for(let i=0;i<5;i++){await remote.fed.tick();await home.fed.tick();}
  await remote.call({channel:subscription.channel.id,body:"Original proof"});
  const outgoing=remote.db.prepare("SELECT activity,signer FROM federation_outgoing WHERE purpose='post' ORDER BY created_at DESC LIMIT 1").get()!;
  const destination=new URL(`${home.webOrigin}/federation/inbox`);
  const send=async(body:string,headers=signedHeaders(destination,"POST",String(outgoing.signer),remote.fed.keys().private_key,body))=>{
    const response=await fetch(destination,{method:"POST",headers,body});await response.arrayBuffer();return response.status;
  };
  const original=String(outgoing.activity),headers=signedHeaders(destination,"POST",String(outgoing.signer),remote.fed.keys().private_key,original);
  assert.equal(await send(original+" ",headers),401);
  assert.equal(await send(original),202);assert.equal(await send(original),202);
  const count=home.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE body='Original proof'").get()!.n;assert.equal(count,1);
  assert.equal(await send(JSON.stringify({...JSON.parse(original),extra:"different"})),409);
  const changed=JSON.parse(original);changed.id=`${remote.webOrigin}/federation/activities/${randomUUID()}`;changed.object.content="Forged content";
  assert.equal(await send(JSON.stringify(changed)),401);
  const expired=signedHeaders(destination,"POST",String(outgoing.signer),remote.fed.keys().private_key,original,new Date(Date.now()-600000).toUTCString());
  assert.equal(await send(original,expired),401);
});

test("native inbox fills a history placeholder when a thread parent arrives after its reply",skip,async t=>{
  const home=await protocolFixture(t),remote=await protocolFixture(t);
  home.db.prepare("UPDATE channels SET mode='threaded' WHERE id=?").run(home.channel.id);
  const sub=await remote.fed.subscribe(remote.store.user(remote.bob.id),home.fed.channelActor(home.store.channel(home.channel.id)));
  for(let i=0;i<5;i++){await remote.fed.tick();await home.fed.tick();}
  const parent=await home.call({body:"Thread parent",title:"Thread"});assert.equal(parent.status,200);
  assert.equal((await home.call({body:"Early reply",parent_id:parent.data.result.id})).status,200);
  const rows=home.db.prepare("SELECT activity,signer FROM federation_outgoing WHERE purpose='relay' ORDER BY created_at,id").all();assert.equal(rows.length,2);
  const destination=new URL(`${remote.webOrigin}/federation/inbox`);
  const send=async(row:any)=>{
    const body=String(row.activity),headers=signedHeaders(destination,"POST",String(row.signer),home.fed.keys().private_key,body);
    const response=await fetch(destination,{method:"POST",headers,body});assert.equal(response.status,202,await response.text());
  };
  const child=rows.find(r=>JSON.parse(String(r.activity)).object.object.inReplyTo)!;
  const first=rows.find(r=>r!==child)!;
  const before=remote.fed.nativeStats.received;
  await send(child);
  const placeholder=remote.db.prepare("SELECT id FROM messages WHERE channel_id=? AND history_placeholder=1").get(sub.channel.id)!;assert.ok(placeholder);
  await send(first);
  const page=await remote.call({op:"messages",channel:sub.channel.id});assert.equal(page.status,200);
  assert.equal(remote.fed.nativeStats.received-before,2);
  assert.deepEqual(page.data.result.messages,remote.store.messages(remote.store.user(remote.bob.id),sub.channel.id));
  assert.deepEqual(page.data.result.messages.map((m:any)=>m.body),["Thread parent","Early reply"]);
  assert.equal(page.data.result.messages[0].id,placeholder.id);assert.equal(page.data.result.messages[1].parent_id,placeholder.id);
});

test("native pending pages batch relationships and retain current custom emoji metadata",skip,async t=>{
  const home=await protocolFixture(t),remote=await protocolFixture(t);
  const subscription=await remote.fed.subscribe(remote.store.user(remote.bob.id),home.fed.channelActor(home.store.channel(home.channel.id)));
  for(let i=0;i<5;i++){await remote.fed.tick();await home.fed.tick();}
  const homeUnsupported=home.fed.nativeStats.unsupported,remoteUnsupported=remote.fed.nativeStats.unsupported;
  const image="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jK1kAAAAASUVORK5CYII=";
  remote.store.addEmoji(remote.alice,{name:"queued_custom",image});
  for(let i=0;i<12;i++) {
    const posted=await remote.call({channel:subscription.channel.id,body:`Pending ${i} :queued_custom: :tada:`});assert.equal(posted.status,200,JSON.stringify(posted));
    assert.deepEqual(posted.data.result,remote.fed.pendingPosts(remote.store.user(remote.bob.id),subscription.channel.id).at(-1));
  }
  const compare=async()=>{const page=await remote.call({channel:subscription.channel.id,op:"messages"});assert.equal(page.status,200);assert.deepEqual(page.data.result.pending,remote.fed.pendingPosts(remote.store.user(remote.bob.id),subscription.channel.id));};
  await compare();
  for(let i=0;i<3;i++){await remote.fed.tick();await home.fed.tick();}
  await compare();assert.equal(home.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE body LIKE 'Pending %'").get()!.n,12);
  assert.equal(home.fed.nativeStats.unsupported,homeUnsupported);assert.equal(remote.fed.nativeStats.unsupported,remoteUnsupported);
  remote.store.removeEmoji(remote.alice,"queued_custom");await compare();
  assert.equal(home.db.prepare("SELECT COUNT(*) AS n FROM remote_emoji_cache").get()!.n,1);
});
