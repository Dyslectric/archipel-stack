import { fork, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync, readdirSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import { histogram, mergeHistogram, summarize } from './benchmark-metrics.mjs';
import { deliveryCoverage } from './benchmark-topology.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const options = { instances: 3, members: 1000, rooms: 99, history: 10, ramp: 20, bootRamp: 20,
  warmup: 120, duration: 120, messageInterval: 60, inflight: 64, timeout: 20, bootstrapTimeout: 300,
  peerRate: 1000, inboxRate: 2000, batch: 20, interval: 1000, concurrency: 4, profile: 0, postgres:0,nativeChat:0,
  nativeWorkers: 4, nativePool: 4, nativeHistory: 0, postgresBuffers:128 };
const names = { instances: 'instances', members: 'members', rooms: 'rooms', history: 'history', ramp: 'ramp',
  'boot-ramp': 'bootRamp', warmup: 'warmup', duration: 'duration', 'message-interval': 'messageInterval',
  inflight: 'inflight', timeout: 'timeout', 'bootstrap-timeout': 'bootstrapTimeout',
  'peer-rate': 'peerRate', 'inbox-rate': 'inboxRate', batch: 'batch', interval: 'interval', concurrency: 'concurrency', profile: 'profile',postgres:'postgres','native-chat':'nativeChat',
  'native-workers': 'nativeWorkers', 'native-pool': 'nativePool', 'native-history':'nativeHistory', 'postgres-buffers':'postgresBuffers' };
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log(`Signed FWDXP shared-channel benchmark; no Prosody or native XMPP clients.
Usage: npm run benchmark:fwdxp -- --instances 3 --members 1000 --rooms 99
All members are web protocol clients. Rooms are global and must divide evenly across hosts.
Options: --history 10 --ramp 20 --boot-ramp 20 --warmup 120 --duration 120
  --message-interval 60 --inflight 64 --timeout 20 --bootstrap-timeout 300
  --peer-rate 1000 (deliveries/minute/peer; 0 disables cap) --inbox-rate 2000 (requests/minute/address)
  --batch 20 (deliveries/round) --interval 1000 (milliseconds between rounds)
  --concurrency 4 (independent deliveries in flight; 1–32)
  --profile 0 (optional CPU profile seconds during measured chat; adds overhead)
  --postgres 1 (isolated PostgreSQL 17 instead of SQLite)
  --native-chat 1 (native Rust chat/auth/overview/FWDXP receipt and delivery; requires --postgres 1 and archipel-native:dev)
  --native-workers 4 --native-pool 4 (processes/instance and SQL connections/process)
  --native-history 1 (join empty rooms, then commit/deliver seed history through Rust before client startup)
  --postgres-buffers 128 (PostgreSQL shared buffers in MiB; 16–8192)
Bootstrap uses faster fixture-only limits, then resets to recorded chat settings before client startup.
Independent Linux processes/databases share an isolated loopback namespace for supported development HTTP.
Real signatures/proofs/admission/inbox validation and production queue worker are retained.
Exit 0: target met; 2: target missed; 1: harness error.`); process.exit(0);
}
for (let i = 0; i < args.length; i += 2) {
  const key = names[args[i]?.replace(/^--/, '')], value = Number(args[i + 1]);
  if (!key || args[i + 1] === undefined || !Number.isFinite(value) || value < 0) throw new Error(`Invalid ${args[i]}`);
  options[key] = value;
}
for (const key of ['instances', 'members', 'rooms', 'history', 'inflight', 'peerRate', 'inboxRate', 'batch', 'interval', 'concurrency', 'nativeWorkers', 'nativePool'])
  if (!Number.isSafeInteger(options[key])) throw new Error(`${key} must be an integer`);
if (options.instances < 2 || options.instances > 16 || options.rooms < options.instances || options.rooms % options.instances ||
  options.members < options.rooms || options.inflight < 1 || options.batch < 1 || options.batch > 1000 ||
  options.interval < 100 || options.interval > 600000 || options.concurrency < 1 || options.concurrency > 32 || options.inboxRate < 1 || options.duration <= 0 ||
  options.messageInterval <= 0 || options.timeout <= 0 || options.bootstrapTimeout <= 0) throw new Error('Invalid workload counts or pacing.');
if (![0,1].includes(options.postgres) || ![0,1].includes(options.nativeChat) || (options.nativeChat && !options.postgres)) throw new Error('Native chat requires --postgres 1; backend switches must be 0 or 1.');
if (options.nativeWorkers < 1 || options.nativeWorkers > 32 || options.nativePool < 2 || options.nativePool > 32) throw new Error('Invalid native process/pool budget.');
if (![0,1].includes(options.nativeHistory) || (options.nativeHistory && !options.nativeChat)) throw new Error('Native history seeding requires --native-chat 1.');
if(!Number.isSafeInteger(options.postgresBuffers) || options.postgresBuffers<16 || options.postgresBuffers>8192)throw new Error('Invalid PostgreSQL buffer budget.');
options.tag = randomBytes(5).toString('hex'); options.users = options.members;
options.native = 0; options.schedule = 'uniform-within-each-protocol';
const output = resolve(root, 'test-results', 'fwdxp', new Date().toISOString().replace(/[:.]/g, '-'));
mkdirSync(output, { recursive: true });
const prefix = `archipel-fwdxp-${options.tag}`, anchor = `${prefix}-loopback`;
const nativeSecret=randomBytes(32).toString('base64url'),postgresPassword=randomBytes(24).toString('hex');
const postgresUrl=`postgres://postgres:${postgresPassword}@127.0.0.1:5432/archipel`;
const execute = promisify(execFile), containers = [], apps = [], workers = [], samples = [], last = new Map();
const sleep = ms => new Promise(done => setTimeout(done, ms));
async function docker(...args) {
  try { const r = await execute('docker', args, { encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
    return (r.stdout + (args[0] === 'logs' ? r.stderr : '')).trim(); }
  catch (e) { throw new Error(`Docker ${args[0]} failed: ${String(e.stderr || e.code).slice(0, 2000)}`); }
}
function json(name) { try { return JSON.parse(readFileSync(resolve(output, name), 'utf8')); } catch { return null; } }
const offsets = Array(options.instances).fill(0);
const readSamples = () => {
  for (let i = 0; i < options.instances; i++) {
    try {
      const lines = readFileSync(resolve(output, `server-${i}.ndjson`), 'utf8').trim().split('\n');
      for (; offsets[i] < lines.length; offsets[i]++) {
        let sample; try { sample = JSON.parse(lines[offsets[i]]); } catch { break; }
        const row = { source: `server-${i}`, ...sample }; samples.push(row); last.set(row.source, row);
      }
    } catch {}
  }
};
const reader = setInterval(readSamples, 500);
let resourceTimer, resourcePending;
const resourceSamples = [];
async function sampleResources() {
  const rows = (await docker('stats', '--no-stream', '--format', '{{json .}}', ...containers)).split('\n').map(JSON.parse);
  const bytes = value => {
    const match = /^([\d.]+)(B|KiB|MiB|GiB|TiB|kB|MB|GB)$/.exec(value.trim());
    if (!match) throw new Error(`Unrecognized Docker memory unit: ${value}`);
    return Number(match[1]) * ({ B:1, KiB:1024, MiB:1024**2, GiB:1024**3, TiB:1024**4, kB:1000, MB:1000**2, GB:1000**3 })[match[2]];
  };
  const sample = {time:Date.now(),containers:rows,
    containerMemoryBytes:rows.reduce((sum,row)=>sum+bytes(row.MemUsage.split('/')[0]),0),
    containerCPUPercent:rows.reduce((sum,row)=>sum+Number(row.CPUPerc.replace('%','')),0),
    generatorRSSMB:Array.from({length:options.instances},(_,i)=>last.get(`web-${i}`)?.rssMB || 0).reduce((a,b)=>a+b,0)};
  resourceSamples.push(sample);
  appendFileSync(resolve(output,'resources.ndjson'),JSON.stringify(sample)+'\n');
}
async function until(predicate, seconds, phase) {
  const end = Date.now() + seconds * 1000;
  let checked = 0;
  while (Date.now() < end) {
    readSamples(); if (predicate()) return;
    if (workers.some(p => p.exitCode !== null || p.signalCode !== null)) throw new Error(`Generator stopped during ${phase}`);
    if (apps.length && Date.now() - checked > 5000) {
      checked = Date.now();
      for (const name of apps) if (await docker('inspect', '--format', '{{.State.Running}}', name) !== 'true') {
        throw new Error(`Instance stopped during ${phase}: ${name}; ${await docker('logs', name)}`);
      }
    }
    await sleep(1000);
  }
  throw new Error(`Timed out during ${phase}`);
}
function waitFor(p, type, ms) {
  return new Promise((done, reject) => {
    const clear = () => { clearTimeout(timer); p.off('message', message); p.off('exit', exit); p.off('error', error); };
    const message = m => { if (m.type === type) { clear(); done(m); } };
    const exit = code => { clear(); reject(new Error(`Generator stopped before ${type}: ${code}`)); };
    const error = e => { clear(); reject(e); };
    const timer = setTimeout(() => { clear(); reject(new Error(`Timed out waiting for ${type}`)); }, ms);
    p.on('message', message); p.once('exit', exit); p.once('error', error);
  });
}
let cleaned = false;
async function cleanup() {
  if (cleaned) return; cleaned = true; clearInterval(reader); readSamples();
  clearInterval(resourceTimer); await resourcePending;
  for (const p of workers) if (p.connected) p.send({ type: 'stop' }, () => {});
  await sleep(250); for (const p of workers) if (p.exitCode === null) p.kill();
  // Freeze every sender before stopping any receiver, so shutdown doesn't create
  // ECONNREFUSED retries in another instance's saved delivery queue.
  const running = (await Promise.all(apps.map(async (name, i) => {
    try { return await docker('inspect', '--format', '{{.State.Running}}', name) === 'true' ? i : null; }
    catch { return null; }
  }))).filter(i => i !== null);
  if (running.length) {
    writeFileSync(resolve(output, 'pause-deliveries'), 'ready');
    const deadline = Date.now() + 30000;
    while (!running.every(i => existsSync(resolve(output, `paused-${i}.json`))) && Date.now() < deadline) await sleep(250);
    if (!running.every(i => json(`paused-${i}.json`)?.drained !== false && existsSync(resolve(output, `paused-${i}.json`))))
      writeFileSync(resolve(output, 'cleanup-warning.txt'), 'Some delivery workers did not confirm a successful drain before shutdown. Inspect post-window snapshot retries separately.\n');
  }
  for (const name of apps) await docker('stop', '--time', '30', name).catch(() => {});
  for (const name of containers) {
    try { writeFileSync(resolve(output, `${name}.log`), await docker('logs', name)); } catch {}
  }
  await Promise.all(apps.map(name => docker('rm', '-f', name).catch(() => {})));
  for(const name of containers.filter(name=>!apps.includes(name) && name!==anchor)) await docker('rm','-f',name).catch(()=>{});
  if (containers.includes(anchor)) await docker('rm', '-f', anchor).catch(() => {});
  for (let i = 0; i < options.instances; i++) for (const file of [`input-${i}.json`, `ready-${i}.json`]) {
    try { unlinkSync(resolve(output, file)); } catch {}
  }
  writeFileSync(resolve(output, 'telemetry.ndjson'), samples.map(row => JSON.stringify(row)).join('\n') + '\n');
}
process.once('SIGINT', () => void cleanup().then(() => process.exit(130)));
process.once('SIGTERM', () => void cleanup().then(() => process.exit(143)));
const report = { options, output, protocol: 'FWDXP', pass: false,
  machine: { platform: os.platform(), node: process.version, cpu: os.cpus()[0]?.model, logicalCPUs: os.cpus().length },
  setup: {}, limitations: [
    `Independent Linux ${options.nativeChat?'Node front ends with native Rust workers':'Node instances'}/${options.postgres?'PostgreSQL schemas':'SQLite databases'} and host generators share this workstation; this is not VPS or WAN capacity.`,
    ...(options.nativeChat?['FWDXP posting, pages, overview, authentication, plain Note receipt/relay and network delivery use native workers. Membership/history bootstrap and other APIs retain compatibility.']:[]),
    'Signed FWDXP uses supported loopback development HTTP, excluding HTTPS, reverse proxy, Internet latency, browser rendering and OIDC login.',
    'All members are web protocol clients, one shared room per member. No native XMPP connections or XMPP bridges run.',
    ...(options.nativeHistory?['Real Follow/Accept joins initially empty rooms; Rust then commits and signs/delivers the seed messages to every replica before web startup. Existing-history Accept/bootstrap retains compatibility and is excluded in this setup mode.']:['Real Follow/Accept and signed history bootstrap use faster fixture-only pacing; chat settings are restored before SSE/API bootstrap.']),
    'API acceptance of a remote post means queued submission. Stored home/replica messages and recipient observations are measured separately.',
    'Missing observations have no latency sample; the configured delivery drain is included.' ] };
try {
  await docker('info', '--format', '{{.ServerVersion}}');
  if (options.nativeChat) report.nativeImage = await docker('image','inspect','--format','{{.Id}}','archipel-native:dev');
  const sources = ['native/Cargo.toml','native/Cargo.lock',...readdirSync(resolve(root,'native/src')).filter(name=>name.endsWith('.rs')).sort().map(name=>`native/src/${name}`),
    'src/native-chat.ts','src/server.ts','scripts/benchmark-fwdxp-server.ts','src/federation.ts','src/events.ts','src/app.ts','client/chat.ts','scripts/benchmark-fwdxp.mjs','scripts/benchmark-worker.mjs'];
  report.sourceSHA256 = Object.fromEntries(sources.map(name=>[name,createHash('sha256').update(readFileSync(resolve(root,name))).digest('hex')]));
  console.log(`${options.instances} FWDXP instances, ${options.members} active members each, ${options.rooms} shared rooms.\nResults: ${output}`);
  await execute(process.execPath, [resolve(root, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.build.json'], { cwd: root, timeout: 120000 });
  writeFileSync(resolve(root, 'build/package.json'), readFileSync(resolve(root, 'package.json')));
  mkdirSync(resolve(root, 'build/node_modules'), { recursive: true }); mkdirSync(resolve(root, 'build/migrations'), { recursive: true });
  const allocated = [];
  while (allocated.length < options.instances*(options.nativeChat?2:1)) {
    const s = createServer(); await new Promise(done => s.listen(0, '127.0.0.1', done));
    const port=s.address().port; if(!allocated.includes(port))allocated.push(port); await new Promise(done => s.close(done));
  }
  const ports=allocated.slice(0,options.instances),nativePorts=allocated.slice(options.instances);
  containers.push(anchor);
  // Docker publishes to the namespace's Ethernet address. Keep the real dev listeners
  // bound to loopback and forward only the benchmark's published web ports to them.
  const proxy = `const net=require('net'),os=require('os');const address=Object.values(os.networkInterfaces()).flat().find(a=>!a.internal&&a.family==='IPv4').address;
    for(const port of ${JSON.stringify(ports)})net.createServer(socket=>{const upstream=net.connect(port,'127.0.0.1');
      socket.pipe(upstream).pipe(socket);socket.on('error',()=>upstream.destroy());upstream.on('error',()=>socket.destroy());
      socket.on('close',()=>upstream.destroy());upstream.on('close',()=>socket.destroy());}).listen(port,address);`;
  await docker('run', '--detach', '--name', anchor, ...ports.flatMap(port => ['--publish', `127.0.0.1:${port}:${port}`]),
    'node:24-bookworm-slim', 'node', '-e', proxy);
  if(options.postgres) {
    const name=`${prefix}-postgres`;containers.push(name);
    // Workers, supervisor, detached sender lock, Node SQL/LISTEN and diagnostics.
    const maxConnections = Math.max(100, options.instances * (options.nativeChat ? (options.nativeWorkers + 1) * options.nativePool + 3 : 2) + 10);
    report.postgresMaxConnections = maxConnections;
    report.postgresSharedMemoryMiB = 512;
    await docker('run','--detach','--name',name,'--network',`container:${anchor}`,'--shm-size','512m','--env',`POSTGRES_PASSWORD=${postgresPassword}`,'--env','POSTGRES_DB=archipel','postgres:17-alpine',
      '-c',`max_connections=${maxConnections}`,'-c','shared_preload_libraries=pg_stat_statements','-c',`shared_buffers=${options.postgresBuffers}MB`);
  }
  for (let i = 0; i < options.instances; i++) {
    const name = `${prefix}-app-${i}`; containers.push(name); apps.push(name);
    writeFileSync(resolve(output, `input-${i}.json`), JSON.stringify({ ...options, instance: i, port: ports[i],
      database: '/tmp/instance.sqlite', output: '/fixture',
      ...(options.postgres?{postgresUrl,schema:`instance_${i}`} : {}),
      ...(options.nativeChat?{nativeUrl:`http://127.0.0.1:${nativePorts[i]}`,nativeSecret}: {}) }));
    await docker('run', '--detach', '--name', name, '--network', `container:${anchor}`, '--env', 'NODE_ENV=production', '--workdir', '/app',
      '--mount', `type=bind,src=${resolve(root, 'build')},dst=/app,readonly`,
      '--mount', `type=bind,src=${resolve(root, 'node_modules')},dst=/app/node_modules,readonly`,
      '--mount', `type=bind,src=${resolve(root, 'migrations')},dst=/app/migrations,readonly`,
      '--mount', `type=bind,src=${output},dst=/fixture`,
      'node:24-bookworm-slim', 'node', 'scripts/benchmark-fwdxp-server.js', `/fixture/input-${i}.json`);
  }
  await until(() => ports.every((_, i) => json(`ready-${i}.json`)?.type === 'ready'), 180, 'instance seeding');
  if(options.nativeChat) for(let i=0;i<options.instances;i++) {
    const name=`${prefix}-native-${i}`;containers.push(name);
    await docker('run','--detach','--name',name,'--network',`container:${anchor}`,
      '--env',`DATABASE_URL=${postgresUrl}`,'--env',`NATIVE_SCHEMA=instance_${i}`,'--env',`BASE_URL=http://127.0.0.1:${ports[i]}`,
      '--env',`NATIVE_BRIDGE_SECRET=${nativeSecret}`,'--env',`NATIVE_PORT=${nativePorts[i]}`,'--env','NATIVE_HOST=127.0.0.1','--env','DEV_AUTH=true',
      '--env',`NATIVE_WORKERS=${options.nativeWorkers}`,'--env',`NATIVE_DATABASE_POOL=${options.nativePool}`,
      '--env',`FEDERATION_SEND_RATE=${options.batch}`,'--env',`FEDERATION_SEND_CONCURRENCY=${options.concurrency}`,
      '--env',`FEDERATION_PEER_SEND_RATE=${options.peerRate}`,'archipel-native:dev');
    let healthy=false;
    for(let attempt=0;attempt<30;attempt++) {
      try { await docker('exec',name,'archipel-chat','--check');healthy=true;break; } catch { await sleep(1000); }
    }
    if(!healthy) throw new Error(`Native workers did not start: ${await docker('logs',name)}`);
  }
  const initial = ports.map((_, i) => json(`ready-${i}.json`));
  report.applicationNode = initial[0].node;
  writeFileSync(resolve(output, 'setup.json'), JSON.stringify({ actors: Object.assign({}, ...initial.map(row => row.actors)) }));
  await until(() => ports.every((_, i) => json(`ready-${i}.json`)?.type === 'configured'), options.bootstrapTimeout, 'signed subscriptions');
  const fixtures = ports.map((_, i) => json(`ready-${i}.json`));
  const expected = fixtures.map((row, i) => row.users.filter(u => u.room % options.instances !== i).length);
  await until(() => expected.every((n, i) => {
    const row = last.get(`server-${i}`);
    return row?.subscriptions.find(s => s.status === 'accepted')?.count === n && row.pending === 0 &&
      !row.deliveries.some(d => ['failed', 'cancelled'].includes(d.status) && d.count > 0);
  }), options.bootstrapTimeout, 'signed Follow/Accept/history completion');
  report.setup.acceptedSubscriptions = expected; report.setup.bootstrap = ports.map((_, i) => last.get(`server-${i}`));
  if(options.nativeHistory) {
    writeFileSync(resolve(output,'start-native-history'),'ready');
    await until(()=>ports.every((_,i)=>json(`history-${i}.json`)),options.bootstrapTimeout,'native history production');
    await until(()=>ports.every((_,i)=>last.get(`server-${i}`)?.pending===0),options.bootstrapTimeout,'signed native history delivery');
    writeFileSync(resolve(output,'check-native-history'),'ready');
    await until(()=>ports.every((_,i)=>json(`history-check-${i}.json`)),60,'native history replica checks');
    report.setup.nativeHistory=ports.map((_,i)=>json(`history-check-${i}.json`));
    if(report.setup.nativeHistory.some(row=>row.rooms!==options.rooms || row.minimum!==options.history || row.maximum!==options.history))throw new Error('Native seed history was not committed on every room/replica.');
  }
  writeFileSync(resolve(output, 'start-measured-settings'), 'ready');
  await until(() => ports.every((_, i) => json(`settings-${i}.json`)), 60, 'chat settings reset');
  report.setup.chatSettings = ports.map((_, i) => json(`settings-${i}.json`));
  console.log(`Signed subscriptions accepted: ${expected.join('/')}; queues drained. Chat settings: ${options.peerRate}/minute/peer, ${options.inboxRate}/minute inbound, ${options.batch}/round every ${options.interval}ms.`);
  await Promise.all(fixtures.map(async (fixture, i) => {
    const p = fork(resolve(root, 'scripts/benchmark-worker.mjs'), [], { cwd: root, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    workers.push(p); p.on('message', m => { if (m.type === 'telemetry') { const row = { source: `web-${i}`, ...m }; samples.push(row); last.set(row.source, row); } });
    const ready = waitFor(p, 'ready', (options.ramp + options.timeout + 60) * 1000);
    p.send({ origin: fixture.origin, users: fixture.users, options, worker: i }); await ready;
  }));
  for (const p of workers) p.send({ type: 'bootstrap' });
  await until(() => ports.every((_, i) => last.get(`web-${i}`)?.bootstrapped === options.members), options.bootstrapTimeout, 'web initial reads');
  report.setup.webBootstrapComplete = true;
  if(options.postgres) {
    await docker('exec',`${prefix}-postgres`,'psql','-U','postgres','-d','archipel','-c','CREATE EXTENSION IF NOT EXISTS pg_stat_statements; SELECT pg_stat_statements_reset();');
  }
  report.setup.webBootstrap=ports.map((_,i)=>last.get(`web-${i}`)?.bootstrap);
  writeFileSync(resolve(output, 'docker-stats-bootstrap.txt'), await docker('stats', '--no-stream', '--format', '{{.Name}} {{.CPUPerc}} {{.MemUsage}}', ...containers));
  const at = Date.now() + 1000, start = at + options.warmup * 1000, end = start + options.duration * 1000;
  for (const p of workers) p.send({ type: 'start', at });
  report.measurement = { start, end, seconds: options.duration };
  resourceTimer = setInterval(()=>{
    if (!resourcePending) resourcePending=sampleResources().catch(error=>{
      appendFileSync(resolve(output,'resource-errors.txt'),String(error)+'\n');
    }).finally(()=>{resourcePending=undefined;});
  },10000);
  console.log('All web clients bootstrapped; starting FWDXP chat warmup.');
  const progress = setInterval(() => {
    console.log(`${Date.now() < start ? 'warmup' : 'measured'}: web accepted ${ports.reduce((n, _, i) => n + (last.get(`web-${i}`)?.successful || 0), 0)}; ` +
      `FWDXP pending ${ports.map((_, i) => last.get(`server-${i}`)?.pending || 0).join('/')}; ` +
      `web connected ${ports.map((_, i) => last.get(`web-${i}`)?.connected || 0).join('/')}; ` +
      `pages incremental/full ${ports.reduce((n,_,i)=>n+(last.get(`web-${i}`)?.pageModes?.incremental || 0),0)}/${ports.reduce((n,_,i)=>n+(last.get(`web-${i}`)?.pageModes?.full || 0),0)}`);
  }, 10000);
  try {
    while (Date.now() < end) {
      if (options.profile && Date.now() >= start && !existsSync(resolve(output, 'profile-start')))
        writeFileSync(resolve(output, 'profile-start'), 'ready');
      if (workers.some(p => p.exitCode !== null || p.signalCode !== null)) throw new Error('A generator exited during chat.');
      await sleep(1000);
    }
  } finally { clearInterval(progress); }
  await sleep(options.timeout * 1000);
  if(options.postgres) writeFileSync(resolve(output,'postgres-statements.json'),await docker('exec',`${prefix}-postgres`,'psql','-U','postgres','-d','archipel','-At','-c',
    "SELECT COALESCE(jsonb_agg(to_jsonb(q)),'[]') FROM (SELECT query,calls,total_exec_time,mean_exec_time,rows,shared_blks_hit,shared_blks_read,wal_bytes FROM pg_stat_statements WHERE dbid=(SELECT oid FROM pg_database WHERE datname=current_database()) ORDER BY total_exec_time DESC LIMIT 40) q"));
  writeFileSync(resolve(output, 'docker-stats-end.txt'), await docker('stats', '--no-stream', '--format', '{{.Name}} {{.CPUPerc}} {{.MemUsage}}', ...containers));
  report.instances = await Promise.all(workers.map(async (p, i) => {
    const result = waitFor(p, 'result', (options.timeout + 15) * 1000); p.send({ type: 'stop' }); const row = await result;
    const during = samples.filter(s => s.source === `server-${i}` && s.time >= start && s.time < end);
    return { instance: i, web: row.stats,
      endState: last.get(`server-${i}`), serverPeakRSSMB: Math.max(0, ...during.map(r => r.rssMB)),
      serverWorstEventLoopP95Ms: Math.max(0, ...during.map(r => r.eventLoopP95Ms)) };
  }));
  const post = histogram(), visible = histogram();
  for (const row of report.instances) { mergeHistogram(post, row.web.writes.latency); mergeHistogram(visible, row.web.deliveries.latency); }
  const sum = fn => report.instances.reduce((n, row) => n + fn(row.web), 0);
  report.totals = { scheduled: sum(w => w.writes.scheduled), webAccepted: sum(w => w.writes.successful),
    webFailed: sum(w => w.writes.failed), generatorDropped: sum(w => w.writes.dropped),
    authorsObservedOwnCommittedPost: sum(w => w.deliveries.selfObserved), webObserved: sum(w => w.deliveries.visible),
    streamsAtStop: sum(w => w.sse.activeAtStop), pendingRefreshes: sum(w => w.refresh.pendingAtStop),
    incrementalPages:sum(w=>w.refresh.incrementalPages || 0),fullPages:sum(w=>w.refresh.fullPages || 0),
    scheduledPostsPerSecond: options.instances * options.members / options.messageInterval,
    postLatency: summarize(post), visibleLatency: summarize(visible), ...deliveryCoverage(options,
      report.instances.map(row => ({ ...row, native: { writes: { scheduled: 0, scheduledByRoom: {} } } }))) };
  report.classification = 'chat-after-complete-signed-bootstrap';
} catch (e) {
  report.error = String(e); report.classification = 'harness-or-bootstrap-error';
  report.setup.webBootstrap=Array.from({length:options.instances},(_,i)=>({bootstrapped:last.get(`web-${i}`)?.bootstrapped,stats:last.get(`web-${i}`)?.bootstrap}));
  console.error(e);
}
finally {
  await cleanup();
  if (report.measurement) {
    const during=resourceSamples.filter(sample=>sample.time>=report.measurement.start && sample.time<report.measurement.end);
    report.resources={samples:during.length,
      peakContainerMemoryBytes:during.length?Math.max(...during.map(sample=>sample.containerMemoryBytes)):null,
      peakContainerCPUPercent:during.length?Math.max(...during.map(sample=>sample.containerCPUPercent)):null,
      peakGeneratorRSSMB:during.length?Math.max(...during.map(sample=>sample.generatorRSSMB)):null,
      scope:'10-second samples of this run\'s Node, native worker, PostgreSQL and forwarding containers; host generators reported separately. Docker memory accounting is not host RSS; peaks between samples and unrelated services are excluded.'};
  }
  if(options.nativeChat) report.nativeStages = Array.from({length:options.instances},(_,i)=>json(`native-stages-${i}.json`));
  if (report.instances) {
    const { start, end } = report.measurement;
    report.replication = report.instances.map(row => {
      const path = resolve(output, `instance-${row.instance}.sqlite`);
      const snapshot=options.postgres?json(`snapshot-${row.instance}.json`):null;
      if (options.postgres?!snapshot:!existsSync(path)) return { instance: row.instance, snapshotMissing: true };
      const db = options.postgres?null:new DatabaseSync(path, { readOnly: true });
      const messages = snapshot?snapshot.messages:db.prepare('SELECT body,channel_id FROM messages WHERE body LIKE ?').all(`BENCH|${options.tag}|%`);
      const seen = new Set(), home = new Set();
      for (const m of messages) {
        const parts = m.body.split('|'), due = Number(parts[5]), key = parts.slice(0, 6).join('|');
        if (due >= start && due < end) { seen.add(key); if (Number(parts[2]) % options.instances === row.instance) home.add(key); }
      }
      const queues = snapshot?snapshot.queues:db.prepare("SELECT d.status,o.purpose,COUNT(*) AS count,SUM(d.attempts) AS attempts FROM federation_deliveries d JOIN federation_outgoing o ON o.id=d.activity_id GROUP BY d.status,o.purpose").all();
      const errors = snapshot?snapshot.errors:db.prepare("SELECT error,COUNT(*) AS count FROM federation_deliveries WHERE error IS NOT NULL GROUP BY error").all();
      db?.close(); return { instance: row.instance, committedCopies: seen.size, authoritativeHomeCommits: home.size,
        foreignReplicaCopies: seen.size - home.size, queues, errors };
    });
    const t = report.totals;
    report.checks = { allStreamsRetained: report.instances.every(r => r.web.sse.activeAtStop === options.members && r.web.sse.failures === 0),
      allAuthorsOffered: report.instances.every(r => r.web.writes.scheduled >= .99 * options.members * options.duration / options.messageInterval),
      apiAccepted99Percent: t.webAccepted >= .99 * t.scheduled, noGeneratorDrops: t.generatorDropped === 0,
      ownCommittedPostsObserved99Percent: t.authorsObservedOwnCommittedPost >= .99 * t.scheduled,
      recipientObservations99Percent: t.webObserved >= .99 * t.webExpectedFromOfferedPosts,
      everyReplicaCommitted99Percent: report.replication.every(r => r.committedCopies >= .99 * t.scheduled),
      webPostP95Below1Second: t.postLatency.p95Ms !== null && t.postLatency.p95Ms <= 1000,
      visibleP95Below3Seconds: t.visibleLatency.p95Ms !== null && t.visibleLatency.p95Ms <= 3000 };
    report.pass = Object.values(report.checks).every(Boolean);
    if(options.nativeChat) {
      report.nativeChat=Array.from({length:options.instances},(_,i)=>json(`final-${i}.json`)?.nativeChat);
      report.nativeFederation=Array.from({length:options.instances},(_,i)=>json(`final-${i}.json`)?.nativeFederation);
      report.checks.nativeFederationExercised=report.nativeFederation.every(s=>s && s.received>0 && s.ticks>0 && s.unsupported===0);
      report.checks.nativeSenderNoErrors=report.nativeFederation.every(s=>s && s.senderErrors===0);
      report.checks.nativePathsExercised=report.nativeChat.every(s=>s && s.posts>0 && s.pages>0 && s.overviews>0 && s.sessions>0 && s.unsupported===0 && s.errors===0);
      report.checks.incrementalPagesExercised=t.incrementalPages>0;
      report.pass=Object.values(report.checks).every(Boolean);
    }
  }
  writeFileSync(resolve(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  const t = report.totals, ms = n => n === null ? 'n/a' : `${n.toFixed(1)} ms`;
  const markdown = `# FWDXP shared-channel benchmark\n\n${report.pass ? 'PASS' : 'TARGET NOT MET'}; ${report.classification}\n\n` +
    `${options.instances} instances × ${options.members} active web members; ${options.rooms} shared rooms; ${options.instances * options.members / options.messageInterval} scheduled posts/second.\n\n` +
    `Chat pacing: ${options.peerRate} deliveries/minute/peer, ${options.inboxRate} inbound requests/minute/address, ${options.batch} deliveries/round with ${options.interval} ms between completed rounds; ${options.concurrency} independent deliveries in flight.\n\n` +
    (t ? `| Metric | Result |\n|---|---:|\n| Scheduled posts | ${t.scheduled} |\n| API accepted / failed / generator dropped | ${t.webAccepted} / ${t.webFailed} / ${t.generatorDropped} |\n` +
      `| Streams retained | ${t.streamsAtStop} / ${options.instances * options.members} |\n| Authors observing their committed posts | ${t.authorsObservedOwnCommittedPost} / ${t.scheduled} |\n` +
      `| Recipient observations | ${t.webObserved} / ${t.webExpectedFromOfferedPosts} (${(100 * t.webObserved / t.webExpectedFromOfferedPosts).toFixed(2)}%) |\n` +
      `| API posting p95 | ${ms(t.postLatency.p95Ms)} |\n| Observed visibility p95 | ${ms(t.visibleLatency.p95Ms)} |\n` +
      `| Committed copies per instance | ${report.replication.map(r => r.committedCopies ?? 'missing').join(' / ')}; ${t.scheduled} expected each |\n\n` : '') +
    (report.error ? `${report.error}\n\n` : '') + report.limitations.map(s => `- ${s}`).join('\n') + '\n';
  writeFileSync(resolve(output, 'report.md'), markdown); console.log(markdown);
  process.exitCode = report.error ? 1 : report.pass ? 0 : 2;
}
