// Compare current PostgreSQL discovery/auth reads with a preserved built Store.
// This is a round-trip microbenchmark, not a protocol/user-capacity measurement.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { writeFileSync } from "node:fs";
import { PostgresDatabase } from "../src/db.js";
import { Store } from "../src/store.js";

const url=process.env.ARCHIPEL_TEST_POSTGRES;
if(!url)throw new Error("Set ARCHIPEL_TEST_POSTGRES to an isolated test database.");
const baseline=resolve(process.env.ARCHIPEL_BASELINE_STORE || "build/src/store.js");
const LegacyStore=(await import(pathToFileURL(baseline).href)).Store as typeof Store;
const db=new PostgresDatabase(url,`discovery_${randomBytes(10).toString("hex")}`,true);
const store=new Store(db,"https://discovery.example"),old=new LegacyStore(db,store.baseUrl);
try {
  store.initializeRegistration("open");
  const owner=store.loginIdentity("urn:archipel:development","owner","Owner",[],true);
  const reader=store.loginIdentity("urn:archipel:development","reader","Reader",[]);
  const channels:string[]=[];
  store.transaction(()=>{
    for(let n=0;n<99;n++) {
      const channel=store.createChannel(owner,{name:`room-${String(n).padStart(3,"0")}`,mode:"timeline",visibility:"members",admission:"open"});
      channels.push(channel.id);
      if(n%3!==0)db.prepare("UPDATE channels SET remote_actor=?,federation_enabled=1 WHERE id=?")
        .run(`https://peer.example/actors/channels/${channel.id}`,channel.id);
    }
    store.join(reader,channels[0]);
  });
  const session=store.createSession(reader.id);
  assert.deepEqual(store.listChannels(reader),old.listChannels(reader));
  assert.deepEqual(store.session(session.token)!.user,old.session(session.token)!.user);
  const measure=(label:string,count:number,fn:()=>unknown)=>{
    const before=db.statistics(),at=performance.now();
    for(let n=0;n<count;n++)fn();
    const ms=performance.now()-at,after=db.statistics();
    return {label,operations:count,ms,queries:after.queries-before.queries,driverCalls:after.statements-before.statements,
      queriesPerOperation:(after.queries-before.queries)/count};
  };
  const authentication=(s:Store)=>()=>{const current=s.session(session.token)!;s.renewSession(session.token,current.expiresAt);};
  const results=[measure("baseline channel discovery",30,()=>old.listChannels(reader)),
    measure("current channel discovery",30,()=>store.listChannels(reader)),
    measure("baseline authentication and renewal",100,authentication(old)),
    measure("current authentication and renewal",100,authentication(store))];
  const report={baseline,rooms:99,visibleRooms:1,results,limitation:"Synthetic PostgreSQL round-trip comparison; excludes protocol transport and user capacity."};
  writeFileSync(resolve(process.env.ARCHIPEL_DISCOVERY_REPORT || "test-results/postgres-discovery.json"),JSON.stringify(report,null,2)+"\n");
  console.log(JSON.stringify(report,null,2));
} finally {store.close();}
