// Process-pool microbenchmark. This is not the FWDXP capacity benchmark.
import { spawn } from "node:child_process";
import { randomBytes,randomUUID } from "node:crypto";
import { writeFileSync,existsSync } from "node:fs";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { PostgresDatabase } from "../src/db.js";
import { Store } from "../src/store.js";

const database=process.env.ARCHIPEL_TEST_POSTGRES;
const binary=resolve(process.env.ARCHIPEL_NATIVE_BINARY || `native/target/release/archipel-chat${process.platform==="win32"?".exe":""}`);
if(!database || !existsSync(binary)) throw new Error("Requires ARCHIPEL_TEST_POSTGRES and a built native binary.");
const secret="benchmark-native-"+randomBytes(32).toString("base64url"),results=[];
for(const workers of [1,4]) {
  const schema=`native_bench_${randomBytes(8).toString("hex")}`,db=new PostgresDatabase(database,schema,true),store=new Store(db,"http://127.0.0.1:8799");
  let child:ReturnType<typeof spawn>|undefined;
  try {
    store.initializeRegistration("open");const user=store.loginIdentity("bench","alice","Alice",[],true),session=store.createSession(user.id);
    const channels:string[]=[];
    store.transaction(()=>{for(let i=0;i<32;i++)channels.push(store.createChannel(user,{name:`room-${i}`,mode:"timeline",visibility:"members",admission:"open"}).id);});
    child=spawn(binary,[],{windowsHide:true,stdio:["ignore","pipe","pipe"],env:{...process.env,DATABASE_URL:database,NATIVE_SCHEMA:schema,BASE_URL:store.baseUrl,NATIVE_HOST:"127.0.0.1",NATIVE_PORT:"0",NATIVE_WORKERS:String(workers),NATIVE_DATABASE_POOL:"4",NATIVE_CHANNEL_CONCURRENCY:"2",NATIVE_BRIDGE_SECRET:secret}});
    const ready=await new Promise<{port:number;workers:number[]}>((done,fail)=>{
      let text="",errors="";const timeout=setTimeout(()=>fail(new Error(`Native startup timeout: ${errors}`)),30000);
      child!.stderr!.on("data",chunk=>{errors+=String(chunk);});child!.once("exit",code=>{clearTimeout(timeout);fail(new Error(`Native exit ${code}: ${errors}`));});
      child!.stdout!.on("data",chunk=>{text+=String(chunk);if(text.includes("\n")){clearTimeout(timeout);try{done(JSON.parse(text.split("\n")[0]));}catch(e){fail(e);}}});
    });
    const origin=`http://127.0.0.1:${ready.port}`,latencies:number[]=[];let cursor=0,accepted=0;
    const post=async(index:number,warm=false)=>{
      const begin=performance.now();const response=await fetch(`${origin}/v1/chat`,{method:"POST",headers:{Authorization:`Bearer ${secret}`,"Content-Type":"application/json"},body:JSON.stringify({op:"post",channel:channels[index%channels.length],token:session.token,csrf:session.csrf,body:`${warm?"Warmup":"Measured"} ${index}`,message_id:randomUUID()})});
      await response.arrayBuffer();if(!response.ok)throw new Error(`Native post HTTP ${response.status}`);
      if(!warm){accepted++;latencies.push(performance.now()-begin);}
    };
    await Promise.all(channels.map((_,i)=>post(i,true)));
    const started=performance.now();
    await Promise.all(Array.from({length:32},async()=>{while(cursor<320){const index=cursor++;await post(index);}}));
    const elapsed=performance.now()-started;latencies.sort((a,b)=>a-b);
    const committed=Number(db.prepare("SELECT COUNT(*) AS n FROM messages WHERE body LIKE 'Measured %'").get()!.n);
    if(committed!==320)throw new Error(`Only ${committed} measured posts committed`);
    results.push({workers,workerPids:ready.workers,connectionsPerWorker:4,channels:32,inflight:32,offered:320,accepted,committed,elapsedMs:elapsed,postsPerSecond:320000/elapsed,p95Ms:latencies[Math.ceil(latencies.length*0.95)-1]});
  } finally {
    if(child){child.kill();await new Promise<void>(done=>{if(child!.exitCode!==null || child!.signalCode!==null)done();else child!.once("exit",()=>done());});}
    store.close();
  }
}
const report={time:new Date().toISOString(),results,limitations:["Local plaintext writes to 32 channels, one session, 32 concurrent requests; no FWDXP, SSE, rich messages or WAN.","Four processes also increase the connection budget from 4 to 16; results measure that combined configuration change.","These measurements do not establish 3000-active-user capacity."]};
if(process.env.ARCHIPEL_NATIVE_REPORT)writeFileSync(process.env.ARCHIPEL_NATIVE_REPORT,JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
