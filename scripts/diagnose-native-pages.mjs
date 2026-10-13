// Inspect the exact current page-window plans in an owned synthetic fixture.
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const directory=resolve(process.argv[2]),fixture=JSON.parse(readFileSync(resolve(directory,'ready-0.json'),'utf8'));
const input=JSON.parse(readFileSync(resolve(directory,'input-0.json'),'utf8'));
if(!/^[a-f0-9]{10}$/.test(input.tag))throw new Error('Owned fixture required');
const channel=fixture.users[15].channel;if(!/^[a-f0-9-]+$/.test(channel))throw new Error('Unexpected channel');
const source=readFileSync('native/src/pages.rs','utf8');
const sql=source.match(/sqlx::query\("(WITH page AS (?:MATERIALIZED )?\(SELECT m\.id,[^"\n]+)"\)/)[1];
const execute=promisify(execFile);
const explainMode=process.argv.includes('--plan-only')?'(COSTS TRUE)':'(ANALYZE,BUFFERS)';
const commands=`SET search_path TO instance_0,public; PREPARE page_window(text,bigint,bigint) AS ${sql};
SET plan_cache_mode=force_custom_plan; EXPLAIN${explainMode} EXECUTE page_window('${channel}',9007199254740991,1);
SET plan_cache_mode=force_generic_plan; EXPLAIN${explainMode} EXECUTE page_window('${channel}',9007199254740991,1);`;
const result=await execute('docker',['exec',`archipel-fwdxp-${input.tag}-postgres`,'psql','-U','postgres','-d','archipel','-c',commands],{windowsHide:true,maxBuffer:1024*1024});
writeFileSync(resolve(directory,'page-window-plans.txt'),result.stdout);console.log(result.stdout);
const outbox=readFileSync('native/src/outbox.rs','utf8');
const template=JSON.parse('"'+outbox.match(/"((?:WITH lane_heads AS MATERIALIZED|SELECT d\.id AS delivery_id)[^"\n]+)"/)[1]+'"');
const plain=alias=>`(${alias}.channel_id IS NOT NULL AND ${alias}.purpose IN ('post','relay') AND CASE WHEN ${alias}.activity::jsonb->>'type'='Announce' THEN ${alias}.activity::jsonb->'object' ELSE ${alias}.activity::jsonb END @> '{"type":"Create","object":{"type":"Note"}}'::jsonb)`;
const predecessor=`(SELECT 1 FROM federation_deliveries earlier JOIN federation_outgoing eo ON eo.id=earlier.activity_id WHERE earlier.recipient=d.recipient AND earlier.id<d.id AND earlier.status='pending' AND (eo.channel_id IS NOT DISTINCT FROM o.channel_id OR NOT ${plain('o')} OR NOT ${plain('eo')}) LIMIT 1) IS NULL`;
const head=template.replace('{}',predecessor);
let report='';
for(const schema of ['instance_0','instance_5']) {
  const signature=head.includes('$5')?'bigint,bigint[],text[],text[],bigint':head.includes('$4')?'bigint,bigint[],text[],text[]':'bigint,bigint[],text[]';
  const extra=(head.includes('$4')?',ARRAY[]::text[]':'')+(head.includes('$5')?',32':'');
  const explain=`SET search_path TO ${schema},public; PREPARE delivery_head(${signature}) AS ${head};
    SET statement_timeout='3s';
    SET plan_cache_mode=force_custom_plan; EXPLAIN${explainMode} EXECUTE delivery_head(${Date.now()},ARRAY[]::bigint[],ARRAY[]::text[]${extra});
    SET plan_cache_mode=force_generic_plan; EXPLAIN${explainMode} EXECUTE delivery_head(${Date.now()},ARRAY[]::bigint[],ARRAY[]::text[]${extra});`;
  const row=await execute('docker',['exec',`archipel-fwdxp-${input.tag}-postgres`,'psql','-U','postgres','-d','archipel','-c',explain],{windowsHide:true,maxBuffer:2*1024*1024});
  report+=schema+'\n'+row.stdout+'\n';
}
writeFileSync(resolve(directory,'delivery-head-plans.txt'),report);console.log(report);
