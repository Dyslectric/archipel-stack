// Summarize completed stage timers between the nearest preceding samples.
// This is a sampled interval, not an exact measurement-window decomposition:
// nested stages overlap and a timer is recorded only when its operation ends.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const directory = process.argv[2];
if (!directory) throw new Error('Pass a completed FWDXP report directory.');
const root = resolve(directory), report = JSON.parse(readFileSync(resolve(root, 'report.json'), 'utf8'));
if (!report.measurement) throw new Error('The run has no measurement window.');
const summary = { requestedWindow:report.measurement, instances:[], aggregate:{sender:{},receivers:{}},
  scope:'Differences of cumulative timers between the nearest preceding ten-second samples. Nested stages overlap; totals sum concurrent work. Lifetime maxima are omitted. Counts include failed operations.' };
for (let instance=0;instance<report.options.instances;instance++) {
  let samples;
  try { samples = readFileSync(resolve(root,`native-stages-${instance}.ndjson`),'utf8').trim().split('\n').map(JSON.parse); }
  catch { summary.instances.push({instance,missing:true});continue; }
  const before = samples.filter(s=>s.time<=report.measurement.start).at(-1);
  const after = samples.filter(s=>s.time<=report.measurement.end).at(-1);
  if (!before || !after || after.time<=before.time) { summary.instances.push({instance,missing:true});continue; }
  const row = {instance,start:before.time,end:after.time,seconds:(after.time-before.time)/1000,stages:{sender:{},receivers:{}},workers:{sender:[],receivers:[]},resets:[]};
  for (const role of ['sender','receivers']) {
    const a = role==='sender'?[before.stages[role]]:before.stages[role];
    const b = role==='sender'?[after.stages[role]]:after.stages[role];
    if(a.length!==b.length){row.resets.push(role);continue;}
    for (let worker=0;worker<a.length;worker++) {
      const local={};row.workers[role].push(local);
      for (const [name,stat] of Object.entries(b[worker])) {
      const prior=a[worker][name];if(!prior)continue;
      const calls=stat.calls-prior.calls,totalMs=stat.totalMs-prior.totalMs;
      if(calls<0 || totalMs<0){row.resets.push(`${role}:${worker}:${name}`);continue;}
      if(!calls)continue;
      local[name]={calls,totalMs,meanMs:totalMs/calls};
      for(const target of [row.stages[role],summary.aggregate[role]]) {
        const value=target[name]??={calls:0,totalMs:0};value.calls+=calls;value.totalMs+=totalMs;
      }
      }
    }
  }
  summary.instances.push(row);
}
for(const stages of [summary.aggregate,...summary.instances.filter(i=>i.stages).map(i=>i.stages)])
  for(const role of ['sender','receivers'])for(const stat of Object.values(stages[role]))stat.meanMs=stat.totalMs/stat.calls;
writeFileSync(resolve(root,'native-stage-summary.json'),JSON.stringify(summary,null,2)+'\n');
for(const role of ['sender','receivers']) {
  console.log(role);
  for(const [name,stat] of Object.entries(summary.aggregate[role]))
    console.log(`  ${name}: ${stat.calls} completed, ${stat.meanMs.toFixed(2)} ms mean`);
}
