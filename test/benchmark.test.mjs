import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, fork } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { histogram, observe, mergeHistogram, summarize } from '../scripts/benchmark-metrics.mjs';
import { deliveryCoverage, memberCounts, roomHost } from '../scripts/benchmark-topology.mjs';
import { mergeStats } from '../scripts/benchmark-web-group.mjs';

test('listener identities do not inflate the active population or offered delivery count', () => {
  const options={instances:3,membersPerInstance:[10000,1,1],webMembersPerInstance:[10000,0,0],native:0,rooms:1};
  const instances=[40,0,0].map(scheduled=>({web:{writes:{scheduled,scheduledByRoom:{0:scheduled}}},native:{writes:{scheduled:0,scheduledByRoom:{}}}}));
  assert.deepEqual(deliveryCoverage(options,instances),{nativeExpectedFromOfferedPosts:0,webExpectedFromOfferedPosts:400000});
  const a=histogram(),b=histogram();observe(a,10);observe(b,1000);
  const merged=mergeStats([{writes:{scheduled:1,latency:a},requests:{POST:{statuses:{201:1}}}},
    {writes:{scheduled:1,latency:b},requests:{POST:{statuses:{201:1}}}}]);
  assert.equal(merged.writes.scheduled,2);assert.equal(merged.writes.latency.max,1000);
  assert.equal(merged.writes.latency.count,2);assert.equal(merged.requests.POST.statuses[201],2);
});

test('generator shards recover initial connection errors and retain the total rate and original author indices',async t=>{
  const authors=new Set();let posts=0,eventAttempts=0;
  const server=createServer((req,res)=>{
    if(req.url.startsWith('/api/events')){
      if(++eventAttempts===1){res.writeHead(503);res.end('{}');return;}
      res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('retry: 2000\n\n');return;
    }
    if(req.method==='POST' && req.url.endsWith('/messages')) {
      let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{
        authors.add(Number(JSON.parse(body).body.split('|')[4]));posts++;
        res.writeHead(201,{'Content-Type':'application/json'});res.end('{}');
      });return;
    }
    res.writeHead(200,{'Content-Type':'application/json'});res.end('{"messages":[]}');
  });
  await new Promise(done=>server.listen(0,'127.0.0.1',done));
  t.after(async()=>{server.closeAllConnections();await new Promise(done=>server.close(done));});
  const worker=fork(resolve('scripts/benchmark-web-group.mjs'),[],{stdio:['ignore','ignore','ignore','ipc']});
  t.after(()=>{if(worker.exitCode===null)worker.kill();});
  const until=predicate=>new Promise((done,fail)=>{
    const timer=setTimeout(()=>{worker.off('message',message);fail(new Error('Shard group timed out'));},20000);
    const message=row=>{if(predicate(row)){clearTimeout(timer);worker.off('message',message);done(row);}};
    worker.on('message',message);
  });
  const ready=until(row=>row.type==='ready');
  worker.send({origin:`http://127.0.0.1:${server.address().port}`,worker:0,
    users:Array.from({length:12},(_,index)=>({index,instance:0,room:0,channel:'room',token:'token',csrf:'csrf'})),
    options:{users:12,webWorkers:3,connectRetries:2,tag:'shards',ramp:0,bootRamp:0,timeout:2,inflight:8,messageInterval:1,warmup:0,duration:2}});
  const connected=await ready;assert.equal(connected.connected,12);assert.equal(connected.failures,0);
  assert.equal(connected.connectionFailures,1);assert.equal(connected.connectionStatuses[503],1);
  const boot=until(row=>row.type==='telemetry' && row.bootstrapped===12);worker.send({type:'bootstrap'});await boot;
  worker.send({type:'start',at:Date.now()+100});
  await new Promise(done=>setTimeout(done,2400));
  const result=until(row=>row.type==='result');worker.send({type:'stop'});const row=await result;
  assert.equal(row.stats.writes.scheduled,24);assert.equal(row.stats.writes.successful,24);
  assert.equal(posts,24);assert.equal(authors.size,12);assert.equal(row.stats.sse.activeAtStop,12);
  assert.equal(row.stats.sse.failures,1);assert.equal(row.stats.sse.recoveredSetupFailures,1);
});

test('failed initial reads retry without another SSE notice and preserve failure counts',async t=>{
  let sessionReads=0;
  const server=createServer((req,res)=>{
    if(req.url.startsWith('/api/events')) {res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('retry: 2000\n\n');return;}
    const failed=req.url==='/api/session' && ++sessionReads===1;
    res.writeHead(failed?503:200,{'Content-Type':'application/json'});res.end(JSON.stringify({messages:[]}));
  });
  await new Promise(done=>server.listen(0,'127.0.0.1',done));
  t.after(async()=>{server.closeAllConnections();await new Promise(done=>server.close(done));});
  const worker=fork(resolve('scripts/benchmark-worker.mjs'),[],{stdio:['ignore','ignore','ignore','ipc']});
  t.after(()=>{if(worker.exitCode===null)worker.kill();});
  const until=(predicate)=>new Promise((done,fail)=>{
    const timeout=setTimeout(()=>{worker.off('message',message);fail(new Error('Bootstrap did not recover'));},15000);
    const message=m=>{if(predicate(m)){clearTimeout(timeout);worker.off('message',message);done(m);}};
    worker.on('message',message);
  });
  const ready=until(m=>m.type==='ready');
  worker.send({origin:`http://127.0.0.1:${server.address().port}`,worker:0,
    users:[{index:0,instance:0,channel:'room',token:'token',csrf:'csrf'}],
    options:{users:1,ramp:0,bootRamp:0,timeout:2,inflight:1,messageInterval:60,warmup:0,duration:1}});
  await ready;
  const booted=until(m=>m.type==='telemetry' && m.bootstrapped===1);
  worker.send({type:'bootstrap'});const telemetry=await booted;
  assert.equal(telemetry.bootstrap.failedRefreshes,1);assert.equal(telemetry.bootstrap.refreshAttempts,2);
  assert.equal(telemetry.bootstrap.requests['GET /api/session'].errors,1);
  assert.deepEqual(telemetry.bootstrap.requests['GET /api/session'].statuses,{'200':1,'503':1});
  const result=until(m=>m.type==='result');worker.send({type:'stop'});await result;
});

test('incremental cursor requests retain bounded metric keys and flush their result before exit',async t=>{
  let stream,sequence=1;
  const urls=[];
  const server=createServer((req,res)=>{
    if(req.url.startsWith('/api/events')){stream=res;res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('retry: 2000\n\n');return;}
    urls.push(req.url);
    const incremental=req.url.startsWith('/api/channels/room/messages?after=');
    res.writeHead(req.method==='POST' && req.url.endsWith('/messages')?201:200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({messages:[{id:`row-${sequence}`,seq:sequence}],refresh_cursor:sequence,refresh_stamp:String(sequence).padStart(32,'0'),incremental}));
  });
  await new Promise(done=>server.listen(0,'127.0.0.1',done));
  t.after(async()=>{server.closeAllConnections();await new Promise(done=>server.close(done));});
  const worker=fork(resolve('scripts/benchmark-worker.mjs'),[],{stdio:['ignore','ignore','ignore','ipc']});t.after(()=>{if(worker.exitCode===null)worker.kill();});
  const until=predicate=>new Promise((done,fail)=>{
    const timer=setTimeout(()=>{worker.off('message',message);fail(new Error('Generator response timed out'));},15000);
    const message=row=>{if(predicate(row)){clearTimeout(timer);worker.off('message',message);done(row);}};worker.on('message',message);
  });
  const ready=until(row=>row.type==='ready');worker.send({origin:`http://127.0.0.1:${server.address().port}`,worker:0,
    users:[{index:0,instance:0,channel:'room',token:'token',csrf:'csrf'}],options:{users:1,ramp:0,bootRamp:0,timeout:2,inflight:1,messageInterval:60,warmup:0,duration:4}});await ready;
  const boot=until(row=>row.type==='telemetry' && row.bootstrapped===1);worker.send({type:'bootstrap'});await boot;
  worker.send({type:'start',at:Date.now()});
  const timer=setInterval(()=>{sequence++;stream.write('data: {"channels":["room"],"content":true}\n\n');},100);t.after(()=>clearInterval(timer));
  await new Promise(done=>setTimeout(done,3500));clearInterval(timer);
  const result=until(row=>row.type==='result'),exit=new Promise(done=>worker.once('exit',done));worker.send({type:'stop'});
  const row=await result;await exit;
  assert.ok(urls.some(url=>url.includes('after=') && url.includes('stamp=')));
  assert.ok(row.stats.refresh.incrementalPages>0);
  assert.ok(Object.keys(row.stats.requests).every(key=>!key.includes('?')));
  assert.ok(row.stats.requests['GET /api/channels/:id/messages'].count>0);
});

test('three-instance delivery expectations account for unequal room membership', () => {
  const row = { web: { writes: { scheduled: 3, scheduledByRoom: { 0: 2, 1: 1 } } },
    native: { writes: { scheduled: 1, scheduledByRoom: { 2: 1 } } } };
  assert.deepEqual(deliveryCoverage({ instances: 3, members: 10, native: 4, rooms: 3 }, [row, row, row]), {
    nativeExpectedFromOfferedPosts: 54, webExpectedFromOfferedPosts: 72 });
});

test('FWDXP expectations include every receiver across three instances with no native clients', () => {
  const row = { web: { writes: { scheduled: 10, scheduledByRoom: { 0: 4, 1: 3, 2: 3 } } },
    native: { writes: { scheduled: 0, scheduledByRoom: {} } } };
  assert.deepEqual(deliveryCoverage({ instances: 3, members: 10, native: 0, rooms: 3 }, [row, row, row]), {
    nativeExpectedFromOfferedPosts: 0, webExpectedFromOfferedPosts: 306 });
});

test('single-home FWDXP channel accounts for all 3400 receivers with unequal populations', () => {
  const options = { instances: 8, members: 200, membersPerInstance: [2000, 200, 200, 200, 200, 200, 200, 200],
    native: 0, rooms: 1, roomHost: 0 };
  assert.deepEqual(memberCounts(options), options.membersPerInstance);
  assert.equal(roomHost(options, 0), 0);
  assert.equal(roomHost({ instances: 8 }, 9), 1);
  const instances = options.membersPerInstance.map(members => ({
    web: { writes: { scheduled: members, scheduledByRoom: { 0: members } } },
    native: { writes: { scheduled: 0, scheduledByRoom: {} } } }));
  assert.deepEqual(deliveryCoverage(options, instances), {
    nativeExpectedFromOfferedPosts: 0, webExpectedFromOfferedPosts: 3400 * 3400 });
  assert.throws(() => memberCounts({ ...options, membersPerInstance: [2000, 200] }));
  assert.throws(() => memberCounts({ ...options, membersPerInstance: [2000, 200, 200, 200, 200, 200, 200, 0] }));
});

test('merged latency buckets retain counts and a slow minority in the tail', () => {
  const fast = histogram(), slow = histogram();
  for (let i = 0; i < 90; i++) observe(fast, 10);
  for (let i = 0; i < 10; i++) observe(slow, 1000);
  const result = summarize(mergeHistogram(fast, slow));
  assert.equal(result.count, 100);
  assert.equal(result.meanMs, 109);
  assert.ok(result.p50Ms >= 10 && result.p50Ms < 11);
  assert.equal(result.p95Ms, 1000);
  assert.equal(summarize(histogram()).p95Ms, null);
});

test('fixture, authentication, SSE, HTTP writes/refreshes, reporting and shutdown work together', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  mkdirSync(resolve(root, 'test-results', 'benchmarks'), { recursive: true });
  const output = resolve(root, 'test-results', 'benchmarks', `smoke-${Date.now()}`);
  const child = spawn(process.execPath, ['scripts/benchmark.mjs', '--users', '8', '--channels', '2', '--workers', '2',
    '--ramp', '.1', '--warmup', '1', '--duration', '4', '--message-interval', '1', '--history', '5', '--output', output],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = ''; child.stdout.on('data', value => logs += value); child.stderr.on('data', value => logs += value);
  const code = await new Promise((resolveCode, reject) => { child.once('error', reject); child.once('exit', resolveCode); });
  assert.equal(code, 0, logs);
  const result = JSON.parse(readFileSync(resolve(output, 'report.json'), 'utf8'));
  assert.equal(result.activeAtEnd, 8);
  assert.equal(result.totals.writes.scheduled, 32);
  assert.equal(result.totals.writes.successful, 32);
  assert.equal(result.totals.writes.users, 8);
  assert.ok(result.totals.sse.deltaMessages > 0, 'live messages arrive without per-message page and read requests');
  assert.ok(result.totals.sse.notices > 0);
  assert.equal(result.totals.sse.failures, 0);
  assert.equal(result.options.users, 8);
  assert.ok(!readFileSync(resolve(output, 'report.json'), 'utf8').includes('csrf'));
});

test('overload preserves the offered schedule, counts dropped work and exits with a saved failure report', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  mkdirSync(resolve(root, 'test-results', 'benchmarks'), { recursive: true });
  const output = resolve(root, 'test-results', 'benchmarks', `overload-${Date.now()}`);
  const child = spawn(process.execPath, ['scripts/benchmark.mjs', '--users', '20', '--channels', '2', '--workers', '1',
    '--inflight', '1', '--ramp', '0.1', '--warmup', '0.1', '--duration', '2', '--message-interval', '0.01',
    '--history', '5', '--output', output], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = ''; child.stdout.on('data', value => logs += value); child.stderr.on('data', value => logs += value);
  const code = await new Promise((resolveCode, reject) => { child.once('error', reject); child.once('exit', resolveCode); });
  assert.equal(code, 2, logs);
  const result = JSON.parse(readFileSync(resolve(output, 'report.json'), 'utf8'));
  assert.ok(result.totals.writes.scheduled >= 3800);
  assert.ok(result.totals.writes.dropped > 0);
  assert.equal(result.totals.writes.scheduled,
    result.totals.writes.successful + result.totals.writes.failed + result.totals.writes.dropped);
  assert.equal(result.checks.writesSucceeded99Percent, false);
  assert.equal(result.pass, false);
});
