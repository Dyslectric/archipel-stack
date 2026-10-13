import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {appendFileSync} from 'node:fs';
const execute=promisify(execFile),[container,output]=process.argv.slice(2);
if(!/^archipel-fwdxp-[a-f0-9]{10}-postgres$/.test(container||'') || !output)throw new Error('Pass an owned FWDXP PostgreSQL fixture container and an output path.');
const sql=`SELECT jsonb_build_object('waits',(SELECT COALESCE(jsonb_agg(s),'[]') FROM (SELECT wait_event_type,wait_event,count(*) FROM pg_stat_activity WHERE datname=current_database() GROUP BY 1,2) s),'active',(SELECT COALESCE(jsonb_agg(s),'[]') FROM (SELECT pid,wait_event_type,wait_event,EXTRACT(EPOCH FROM clock_timestamp()-query_start)*1000 AS elapsed_ms,left(query,2000) AS query FROM pg_stat_activity WHERE datname=current_database() AND state='active' AND pid<>pg_backend_pid()) s),'blocked',(SELECT COALESCE(jsonb_agg(s),'[]') FROM (SELECT pid,wait_event,pg_blocking_pids(pid) AS blockers,left(query,200) AS query FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock') s),'object_locks',(SELECT COALESCE(jsonb_agg(s),'[]') FROM (SELECT locktype,classid,objid,objsubid,mode,granted,count(*) FROM pg_locks WHERE locktype IN ('object','advisory') GROUP BY 1,2,3,4,5,6) s))`;
for(let round=0;round<180;round++) {
  try {
    const {stdout}=await execute('docker',['exec',container,'psql','-U','postgres','-d','archipel','-At','-c',sql],{windowsHide:true,maxBuffer:1024*1024,timeout:10000});
    appendFileSync(output,JSON.stringify({time:Date.now(),...JSON.parse(stdout.trim())})+'\n');
  } catch {break;}
  await new Promise(done=>setTimeout(done,5000));
}
