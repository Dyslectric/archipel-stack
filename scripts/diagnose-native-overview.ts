// Rebuilds representative synthetic message/user cardinalities from a saved
// FWDXP snapshot; reads both custom and generic PostgreSQL query plans.
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {randomUUID,randomBytes} from 'node:crypto';
import pg from 'pg';
import {PostgresDatabase} from '../src/db.js';
import {Store} from '../src/store.js';
const url=process.env.ARCHIPEL_TEST_POSTGRES;if(!url)throw new Error('ARCHIPEL_TEST_POSTGRES is required');
const directory=resolve(process.argv[2]||''),snapshot=JSON.parse(readFileSync(resolve(directory,'snapshot-0.json'),'utf8')) as {messages:{body:string;channel_id:string}[]};
const schema=`native_plan_${randomBytes(8).toString('hex')}`,db=new PostgresDatabase(url,schema,true),store=new Store(db,'http://127.0.0.1:9871');
const client=new pg.Client({connectionString:url});
try {
  const users=Array.from({length:3000},(_,index)=>({id:randomUUID(),username:`plan_${index}`,remote:index<1000?null:`http://peer.example/actors/users/${randomUUID()}`}));
  const channels=[...new Set(snapshot.messages.map(m=>m.channel_id))],rooms=new Map<number,string>();
  for(const row of snapshot.messages){const p=row.body.split('|');if(p[0]==='BENCH')rooms.set(Number(p[4])%99,row.channel_id);}
  db.native("INSERT INTO users(id,username,display_name,remote_actor,admission_status,federation_send,federation_receive,federation_subscribe,federation_post,created_at) SELECT id,name,name,actor,'approved',1,1,1,1,'2026-10-13T00:00:00.000Z' FROM unnest($1::text[],$2::text[],$3::text[]) AS u(id,name,actor)",[users.map(u=>u.id) as any,users.map(u=>u.username) as any,users.map(u=>u.remote) as any]);
  db.native("INSERT INTO channels(id,name,description,mode,visibility,admission,owner_id,created_at) SELECT id,'plan_'||n,'','timeline','members','open',$2,'2026-10-13T00:00:00.000Z' FROM unnest($1::text[]) WITH ORDINALITY AS c(id,n)",[channels as any,users[0].id]);
  const members=users.slice(0,1000).map((u,index)=>({id:u.id,channel:rooms.get(index%99)||channels[index%channels.length]}));
  db.native("INSERT INTO memberships(channel_id,user_id,role) SELECT channel,id,'member' FROM unnest($1::text[],$2::text[]) AS m(channel,id)",[members.map(m=>m.channel) as any,members.map(m=>m.id) as any]);
  for(let at=0;at<snapshot.messages.length;at+=500){const batch=snapshot.messages.slice(at,at+500),authors=batch.map(m=>{const p=m.body.split('|');return users[p[0]==='BENCH'?(Number(p[3])*1000+Number(p[4]))%3000:0].id;});
    db.native("INSERT INTO messages(id,channel_id,author_id,body,created_at) SELECT id,channel,author,body,'2026-10-13T00:00:00.000Z' FROM unnest($1::text[],$2::text[],$3::text[],$4::text[]) AS m(id,channel,author,body)",[batch.map(()=>randomUUID()) as any,batch.map(m=>m.channel_id) as any,authors as any,batch.map(m=>m.body) as any]);}
  db.native("INSERT INTO read_marks(user_id,target,seq) SELECT user_id,channel_id,(SELECT COALESCE(MAX(seq),0) FROM messages WHERE channel_id=m.channel_id) FROM memberships m");
  db.exec('ANALYZE users; ANALYZE channels; ANALYZE memberships; ANALYZE messages; ANALYZE read_marks');
  await client.connect();await client.query(`SET search_path TO "${schema}",public`);
  const text=readFileSync(resolve('native/src/overview.rs'),'utf8').match(/r#"([\s\S]*?)"#/)! [1];
  const member=members[500],values=[member.id,[member.channel],1,store.baseUrl];let report='Representative saved snapshot: '+snapshot.messages.length+' messages, 3000 accounts, 1000 local memberships.\n';
  const quote=(s:string)=>`'${s.replaceAll("'","''")}'`;
  await client.query(`PREPARE native_overview(text,text[],bigint,text) AS ${text}`);
  const argumentsSql=[quote(String(values[0])),`ARRAY[${(values[1] as string[]).map(quote).join(',')}]::text[]`,'1',quote(store.baseUrl)].join(',');
  for(const mode of ['force_custom_plan','force_generic_plan']) {
    await client.query(`SET plan_cache_mode=${mode}`);
    const result=await client.query(`EXPLAIN (ANALYZE,BUFFERS) EXECUTE native_overview(${argumentsSql})`);
    const plan=result.rows.map(r=>r['QUERY PLAN']).join('\n');report+=`\n${mode}\n${plan}\n`;console.log(mode+': '+plan.split('\n').find(s=>s.startsWith('Execution Time')));
  }
  writeFileSync(resolve(directory,'overview-reconstructed-plan.txt'),report);
} finally {await client.end().catch(()=>{});store.close();}
