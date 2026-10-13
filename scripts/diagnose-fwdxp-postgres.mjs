// Read-only query-plan diagnostics against this harness's temporary PostgreSQL.
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
const directory=resolve(process.argv[2] || '');
const input=JSON.parse(readFileSync(resolve(directory,'input-0.json'),'utf8'));
if(!/^[a-f0-9]{10}$/.test(input.tag) || !input.postgresUrl)throw new Error('Expected a running PostgreSQL FWDXP fixture.');
const container=`archipel-fwdxp-${input.tag}-postgres`;
const sql=text=>execFileSync('docker',['exec',container,'psql','-U','postgres','-d','archipel','-t','-A','-c',text],{encoding:'utf8',timeout:60000,maxBuffer:1024*1024});
const sample=sql("SELECT id FROM instance_0.federation_deliveries WHERE status='pending' ORDER BY id LIMIT 40").trim().split('\n').filter(id=>/^\d+$/.test(id));
const head=(exclude)=>`EXPLAIN (ANALYZE,BUFFERS) SELECT d.id,d.recipient FROM instance_0.federation_deliveries d
  WHERE d.status='pending' AND d.next_attempt<=${Date.now()} ${exclude.length?`AND d.id NOT IN (${exclude.join(',')})`:''}
  AND NOT EXISTS(SELECT 1 FROM instance_0.federation_deliveries earlier WHERE earlier.recipient=d.recipient AND earlier.id<d.id AND earlier.status='pending')
  ORDER BY d.id LIMIT 1`;
const plain=alias=>`(${alias}.channel_id IS NOT NULL AND ${alias}.purpose IN ('post','relay') AND CASE WHEN ${alias}.activity::jsonb->>'type'='Announce' THEN ${alias}.activity::jsonb->'object' ELSE ${alias}.activity::jsonb END @> '{"type":"Create","object":{"type":"Note"}}'::jsonb)`;
const lanes=exclude=>`EXPLAIN (ANALYZE,BUFFERS) SELECT d.id,d.recipient FROM instance_0.federation_deliveries d JOIN instance_0.federation_outgoing o ON o.id=d.activity_id
  WHERE d.status='pending' AND d.next_attempt<=${Date.now()} ${exclude.length?`AND d.id NOT IN (${exclude.join(',')})`:''}
  AND NOT EXISTS(SELECT 1 FROM instance_0.federation_deliveries earlier JOIN instance_0.federation_outgoing eo ON eo.id=earlier.activity_id
    WHERE earlier.recipient=d.recipient AND earlier.id<d.id AND earlier.status='pending'
    AND (eo.channel_id IS NOT DISTINCT FROM o.channel_id OR NOT ${plain('o')} OR NOT ${plain('eo')})) ORDER BY d.id LIMIT 1`;
const report=`Recipient-wide control head:\n${sql(head([]))}\nControl excluding 40 sampled pending IDs:\n${sql(head(sample))}\nNative channel lanes head:\n${sql(lanes([]))}\nNative channel lanes excluding 40 sampled pending IDs:\n${sql(lanes(sample))}`;
writeFileSync(resolve(directory,'postgres-head-explain.txt'),report);console.log(report);
