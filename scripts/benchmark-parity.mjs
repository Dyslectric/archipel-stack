// Offers one room workload to Prosody, ejabberd or Archipel on the same host,
// in the same containerized network namespace, through the same thin clients.
// Usage: node scripts/benchmark-parity.mjs --target prosody --clients 1000 --rooms 1 --interval 100
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { histogram, mergeHistogram, summarize } from './benchmark-metrics.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const execute = promisify(execFile);
const args = process.argv.slice(2), option = (name, fallback) => {
  const at = args.indexOf(`--${name}`); return at < 0 ? fallback : args[at + 1];
};
const o = {
  target: option('target', 'prosody'), clients: Number(option('clients', 1000)), rooms: Number(option('rooms', 1)),
  interval: Number(option('interval', 100)), ramp: Number(option('ramp', 60)), warmup: Number(option('warmup', 15)),
  duration: Number(option('duration', 60)), drain: Number(option('drain', 10)), shards: Number(option('shards', 4)),
  history: Number(option('history', 10)), idle: Number(option('idle', 15)), timeout: Number(option('timeout', 60)),
  inflight: Number(option('inflight', 64)), profile: option('profile', '0') === '1', cpus: option('cpus', ''), nativeWorkers: Number(option('native-workers', 4)),
  nativePool: Number(option('native-pool', 4)), label: option('label', ''),
};
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const output = resolve(root, 'test-results/parity', `${stamp}-${o.target}`);
mkdirSync(output, { recursive: true });
const prefix = `parity-${randomBytes(3).toString('hex')}`, anchor = `${prefix}-net`;
const servers = [], containers = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const docker = async (...a) => (await execute('docker', a, { encoding: 'utf8', timeout: 600000, maxBuffer: 64 << 20 })).stdout.trim();
const limits = ['--ulimit', 'nofile=262144:262144', ...(o.cpus ? ['--cpus', o.cpus] : [])];
const run = async (name, server, ...a) => {
  containers.push(name); if (server) servers.push(name);
  await docker('run', '--detach', '--name', name, '--network', `container:${anchor}`, ...(server ? limits : ['--ulimit', 'nofile=262144:262144']), ...a);
};
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
async function until(check, seconds, what) {
  const deadline = Date.now() + seconds * 1000;
  for (;;) { try { if (await check()) return; } catch {} if (Date.now() > deadline) throw new Error(`Timed out: ${what}`); await sleep(500); }
}
// Cumulative cgroup CPU seconds and current memory of every server container.
async function usage() {
  const rows = await Promise.all(servers.map(async name => {
    const text = await docker('exec', name, 'cat', '/sys/fs/cgroup/cpu.stat', '/sys/fs/cgroup/memory.current');
    const cpu = Number(/usage_usec (\d+)/.exec(text)[1]) / 1e6, memory = Number(text.trim().split('\n').at(-1));
    return [name, { cpu, memory }];
  }));
  return { time: Date.now(), containers: Object.fromEntries(rows) };
}
const total = (sample, key) => Object.values(sample.containers).reduce((n, c) => n + c[key], 0);

const report = { options: o, started: new Date().toISOString(), phases: {}, samples: [] };
try {
  await docker('run', '--detach', '--name', anchor, '--ulimit', 'nofile=262144:262144', 'node:24-bookworm-slim', 'sleep', 'infinity');
  containers.push(anchor);
  let host = '127.0.0.1', port = 5222, users;
  const roomOf = i => i % o.rooms;
  if (o.target === 'prosody') {
    writeFileSync(resolve(output, 'prosody.cfg.lua'), `
pidfile = "/var/run/prosody/prosody.pid"
log = { warn = "*console" }
network_backend = "epoll"
modules_enabled = { "saslauth"; "disco"; "ping" }
c2s_require_encryption = false
allow_unencrypted_plain_auth = true
statistics = nil
VirtualHost "localhost"
  authentication = "anonymous"
Component "conference.localhost" "muc"
  modules_enabled = { "muc_mam" }
  muc_room_locking = false
  muc_room_default_history_length = 0
  muc_room_default_presence_broadcast = {}
  muc_log_by_default = true
  muc_log_all_rooms = true
`);
    await run(`${prefix}-prosody`, true, '--mount', `type=bind,src=${resolve(output, 'prosody.cfg.lua')},dst=/etc/prosody/prosody.cfg.lua,readonly`,
      // The image's entrypoint drops privileges through PAM, which resets the descriptor limit to 1,024.
      '--user', 'prosody', '--entrypoint', 'prosody', 'prosodyim/prosody:13.0', '-F');
    report.image = await docker('image', 'inspect', '--format', '{{.Id}}', 'prosodyim/prosody:13.0');
  } else if (o.target === 'ejabberd') {
    writeFileSync(resolve(output, 'ejabberd.yml'), `
hosts: [localhost]
loglevel: warning
auth_method: [anonymous]
anonymous_protocol: sasl_anon
allow_multiple_connections: true
listen:
  - port: 5222
    ip: "0.0.0.0"
    module: ejabberd_c2s
    max_stanza_size: 262144
    access: c2s
    starttls_required: false
access_rules:
  c2s: { allow: all }
  muc_create: { allow: all }
shaper_rules:
  max_user_sessions: 10
modules:
  mod_disco: {}
  mod_ping: {}
  mod_mam: { default: always }
  mod_muc:
    access: [allow]
    access_create: muc_create
    access_mam: [allow]
    history_size: 0
    max_users: 1000000
    max_users_admin_threshold: 1000000
    max_users_presence: 1
    min_message_interval: 0
    min_presence_interval: 0
    default_room_options: { mam: true, max_users: 1000000 }
`);
    await run(`${prefix}-ejabberd`, true, '--mount', `type=bind,src=${resolve(output, 'ejabberd.yml')},dst=/opt/ejabberd/conf/ejabberd.yml,readonly`, 'ghcr.io/processone/ejabberd:latest');
    report.image = await docker('image', 'inspect', '--format', '{{.Id}} {{index .Config.Labels "org.opencontainers.image.version"}}', 'ghcr.io/processone/ejabberd:latest');
  } else if (o.target === 'archipel') {
    port = 8788;
    const password = randomBytes(12).toString('hex'), url = `postgres://postgres:${password}@127.0.0.1:5432/archipel`;
    const origin = `http://127.0.0.1:${port}`, secret = randomBytes(24).toString('hex');
    await run(`${prefix}-postgres`, true, '--shm-size', '512m', '--env', `POSTGRES_PASSWORD=${password}`, '--env', 'POSTGRES_DB=archipel',
      'postgres:17-alpine', '-c', 'max_connections=200', '-c', 'shared_buffers=512MB', '-c', 'shared_preload_libraries=pg_stat_statements');
    await until(async () => (await docker('exec', `${prefix}-postgres`, 'pg_isready', '-h', '127.0.0.1')).includes('accepting'), 60, 'postgres');
    await sleep(2000);
    const mounts = ['--workdir', '/app', '--mount', `type=bind,src=${resolve(root, 'build')},dst=/app,readonly`,
      '--mount', `type=bind,src=${resolve(root, 'node_modules')},dst=/app/node_modules,readonly`,
      '--mount', `type=bind,src=${resolve(root, 'migrations')},dst=/app/migrations,readonly`,
      '--mount', `type=bind,src=${output},dst=/out`];
    log('seeding archipel');
    await docker('run', '--rm', '--network', `container:${anchor}`, ...mounts, 'node:24-bookworm-slim', 'node', 'scripts/parity-archipel-seed.js',
      url, 'public', String(o.clients), String(o.rooms), String(o.history), '/out/users.json', origin);
    users = JSON.parse(readFileSync(resolve(output, 'users.json'), 'utf8'));
    await docker('exec', `${prefix}-postgres`, 'psql', '-U', 'postgres', '-d', 'archipel', '-c', 'CREATE EXTENSION IF NOT EXISTS pg_stat_statements; SELECT pg_stat_statements_reset();');
    await run(`${prefix}-native`, true, '--env', `DATABASE_URL=${url}`, '--env', 'NATIVE_SCHEMA=public', '--env', `BASE_URL=${origin}`,
      '--env', `NATIVE_BRIDGE_SECRET=${secret}`, '--env', 'NATIVE_PORT=8870', '--env', 'NATIVE_HOST=127.0.0.1', '--env', 'DEV_AUTH=true',
      '--env', `NATIVE_WORKERS=${o.nativeWorkers}`, '--env', `NATIVE_DATABASE_POOL=${o.nativePool}`, 'archipel-native:dev');
    await until(async () => { await docker('exec', `${prefix}-native`, 'archipel-chat', '--check'); return true; }, 60, 'native service');
    await run(`${prefix}-app`, true, ...mounts, '--env', 'NODE_ENV=production', '--env', `DATABASE_URL=${url}`, '--env', 'DEV_AUTH=true',
      '--env', `BASE_URL=${origin}`, '--env', 'HOST=127.0.0.1', '--env', `PORT=${port}`, '--env', 'NATIVE_CHAT_URL=http://127.0.0.1:8870',
      '--env', `NATIVE_BRIDGE_SECRET=${secret}`, ...(option('app-env', '') ? option('app-env').split(',').flatMap(v => ['--env', v]) : []),
      'node:24-bookworm-slim', 'node', ...(o.profile ? ['--cpu-prof', '--cpu-prof-dir=/out'] : []), 'src/server.js');
    report.image = await docker('image', 'inspect', '--format', '{{.Id}}', 'archipel-native:dev');
    report.origin = origin;
  } else throw new Error(`Unknown target ${o.target}`);
  if (!users) users = Array.from({ length: o.clients }, (_, i) => ({ index: i, nick: `u${i}`,
    room: `room-${String(roomOf(i)).padStart(4, '0')}@conference.localhost` }));
  // Wait until the service accepts connections.
  await until(async () => { await docker('exec', anchor, 'node', '-e',
    `require('net').connect(${port},'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))`); return true; }, 120, 'service listening');
  await sleep(2000);

  const tag = randomBytes(4).toString('hex'), control = '/out/control.json';
  const shardResults = [], ready = new Set(), telemetry = [];
  log(`${o.target}: ${o.clients} clients, ${o.rooms} rooms, ${(o.clients / o.interval).toFixed(1)} posts/s offered`);
  const shards = Array.from({ length: o.shards }, (_, s) => new Promise((done, fail) => {
    const file = `shard-${s}.json`;
    writeFileSync(resolve(output, file), JSON.stringify({ ...o, kind: o.target === 'archipel' ? 'archipel' : 'xmpp', shard: s, tag, control,
      host, port, domain: 'localhost', origin: report.origin, population: o.clients, users: users.filter((_, i) => i % o.shards === s) }));
    const name = `${prefix}-load-${s}`; containers.push(name);
    const child = spawn('docker', ['run', '--rm', '--name', name, '--network', `container:${anchor}`, '--ulimit', 'nofile=262144:262144',
      '--mount', `type=bind,src=${resolve(root, 'scripts')},dst=/work,readonly`, '--mount', `type=bind,src=${output},dst=/out`,
      'node:24-bookworm-slim', 'node', '--max-old-space-size=4096', '/work/parity-client.mjs', `/out/${file}`], { stdio: ['ignore', 'pipe', 'inherit'] });
    let pending = '';
    child.stdout.on('data', chunk => {
      pending += chunk; let at;
      while ((at = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, at); pending = pending.slice(at + 1);
        let row; try { row = JSON.parse(line); } catch { console.log(line); continue; }
        if (row.type === 'ready') { ready.add(s); report.phases[`ready-${s}`] = row; }
        if (row.type === 'telemetry') telemetry.push(row);
        if (row.type === 'result') shardResults.push(row.stats);
      }
    });
    child.on('exit', code => code === 0 ? done() : fail(new Error(`shard ${s} exited ${code}`)));
  }));
  const rampStart = Date.now();
  await Promise.race([until(() => ready.size === o.shards, o.ramp + o.timeout + 120, 'clients joined'), Promise.all(shards)]);
  report.phases.joinSeconds = (Date.now() - rampStart) / 1000;
  const joined = Object.keys(report.phases).filter(k => k.startsWith('ready-')).reduce((n, k) => n + report.phases[k].joined, 0);
  log(`joined ${joined}/${o.clients} in ${report.phases.joinSeconds}s`);
  if (o.target === 'archipel') writeFileSync(resolve(output, 'postgres-statements-join.json'), await docker('exec', `${prefix}-postgres`, 'psql', '-U', 'postgres', '-d', 'archipel', '-At', '-c',
    "SELECT COALESCE(json_agg(t),'[]') FROM (SELECT calls,round(total_exec_time::numeric,1) AS total_ms,round(mean_exec_time::numeric,3) AS mean_ms,rows,left(query,400) AS query FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT 40) t"));
  await sleep(5000);
  const idleStart = await usage(); await sleep(o.idle * 1000); const idleEnd = await usage();
  report.idle = { cores: (total(idleEnd, 'cpu') - total(idleStart, 'cpu')) / ((idleEnd.time - idleStart.time) / 1000),
    memoryMiB: total(idleEnd, 'memory') / 1048576, containers: idleEnd.containers,
    perContainerCores: Object.fromEntries(Object.keys(idleEnd.containers).map(k => [k, (idleEnd.containers[k].cpu - idleStart.containers[k].cpu) / ((idleEnd.time - idleStart.time) / 1000)])) };
  log(`idle: ${report.idle.cores.toFixed(2)} cores, ${report.idle.memoryMiB.toFixed(0)} MiB`);
  const start = Date.now() + 2000;
  writeFileSync(resolve(output, 'control.json'), JSON.stringify({ start }));
  await sleep(start + o.warmup * 1000 - Date.now());
  const statements = o.target === 'archipel' ? (sql => docker('exec', `${prefix}-postgres`, 'psql', '-U', 'postgres', '-d', 'archipel', '-At', '-c', sql)) : null;
  await statements?.('CREATE EXTENSION IF NOT EXISTS pg_stat_statements; SELECT pg_stat_statements_reset();');
  let previous = await usage(); const measureStart = previous;
  const sampler = setInterval(async () => {
    try { const now = await usage(); report.samples.push({ time: now.time, cores: (total(now, 'cpu') - total(previous, 'cpu')) / ((now.time - previous.time) / 1000),
      memoryMiB: total(now, 'memory') / 1048576, perContainer: Object.fromEntries(Object.entries(now.containers).map(([k, v]) =>
        [k, { cores: (v.cpu - previous.containers[k].cpu) / ((now.time - previous.time) / 1000), memoryMiB: v.memory / 1048576 }])) }); previous = now; } catch {}
  }, 5000);
  await sleep(o.duration * 1000);
  clearInterval(sampler);
  const measureEnd = await usage();
  report.measured = { cores: (total(measureEnd, 'cpu') - total(measureStart, 'cpu')) / ((measureEnd.time - measureStart.time) / 1000),
    peakCores: Math.max(0, ...report.samples.map(s => s.cores)), peakMemoryMiB: Math.max(total(measureEnd, 'memory') / 1048576, ...report.samples.map(s => s.memoryMiB)),
    perContainerCores: Object.fromEntries(Object.keys(measureEnd.containers).map(k => [k, (measureEnd.containers[k].cpu - measureStart.containers[k].cpu) / ((measureEnd.time - measureStart.time) / 1000)])) };
  if (statements) writeFileSync(resolve(output, 'postgres-statements.json'), await statements(
    "SELECT COALESCE(json_agg(t),'[]') FROM (SELECT calls,round(total_exec_time::numeric,1) AS total_ms,round(mean_exec_time::numeric,3) AS mean_ms,rows,left(query,400) AS query FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT 40) t"));
  await Promise.all(shards);
  const merged = { joined: 0, failed: 0, dropped: 0, errors: {}, writes: { scheduled: 0, sent: 0, failed: 0, ok: 0, latency: histogram() },
    deliveries: { visible: 0, duplicate: 0, latency: histogram() }, joinMs: histogram(), streamMs: histogram(), historyMs: histogram(), bytes: 0 };
  for (const s of shardResults) {
    merged.joined += s.joined; merged.failed += s.failed; merged.dropped += s.dropped; merged.bytes += s.bytes;
    for (const [k, n] of Object.entries(s.errors)) merged.errors[k] = (merged.errors[k] || 0) + n;
    for (const k of ['scheduled', 'sent', 'failed', 'ok']) merged.writes[k] += s.writes[k];
    mergeHistogram(merged.writes.latency, s.writes.latency); mergeHistogram(merged.deliveries.latency, s.deliveries.latency);
    mergeHistogram(merged.joinMs, s.joinMs); if (s.streamMs) { mergeHistogram(merged.streamMs, s.streamMs); mergeHistogram(merged.historyMs, s.historyMs); } merged.deliveries.visible += s.deliveries.visible; merged.deliveries.duplicate += s.deliveries.duplicate;
  }
  // Every room member, including the author, should see each measured post.
  const roomSize = r => Math.floor(o.clients / o.rooms) + (r < o.clients % o.rooms ? 1 : 0);
  const expected = merged.writes.scheduled * (o.clients / o.rooms);
  report.result = { joined: merged.joined, joinFailed: merged.failed, dropped: merged.dropped, errors: merged.errors,
    join: summarize(merged.joinMs), ...(merged.streamMs.count ? { streamOpen: summarize(merged.streamMs), history: summarize(merged.historyMs) } : {}), postsScheduled: merged.writes.scheduled, postsSent: merged.writes.sent, postsFailed: merged.writes.failed,
    postLatency: summarize(merged.writes.latency), expectedDeliveries: expected, delivered: merged.deliveries.visible,
    completeness: expected ? merged.deliveries.visible / expected : null, duplicates: merged.deliveries.duplicate,
    visibility: summarize(merged.deliveries.latency), offeredPostsPerSecond: o.clients / o.interval,
    deliveredPerSecond: merged.deliveries.visible / o.duration, minimumRoomSize: roomSize(o.rooms - 1) };
  report.efficiency = { coreSecondsPerMillionDeliveries: report.measured.cores * o.duration / (merged.deliveries.visible / 1e6),
    idleKiBPerClient: report.idle.memoryMiB * 1024 / Math.max(1, merged.joined) };
  report.generator = { peakCpuPercent: Math.max(0, ...telemetry.map(t => t.cpuPercent)), worstEventLoopP95Ms: Math.max(0, ...telemetry.map(t => t.eventLoopP95Ms)) };
  const r = report.result;
  log(`delivered ${r.delivered}/${r.expected ?? expected} (${(100 * r.completeness).toFixed(2)}%), visibility p50 ${r.visibility.p50Ms?.toFixed(0)} p95 ${r.visibility.p95Ms?.toFixed(0)} p99 ${r.visibility.p99Ms?.toFixed(0)} ms; ` +
    `${report.measured.cores.toFixed(2)} cores avg, ${report.measured.peakMemoryMiB.toFixed(0)} MiB peak; generator peak ${report.generator.peakCpuPercent.toFixed(0)}%`);
} catch (error) {
  report.error = String(error.stack || error); console.error(error);
} finally {
  if (o.profile) await docker('stop', '--time', '30', `${prefix}-app`).catch(() => {});
  for (const name of servers) try { writeFileSync(resolve(output, `${name.slice(prefix.length + 1)}.log`), (await execute('docker', ['logs', '--tail', '400', name], { maxBuffer: 64 << 20 })).stderr); } catch {}
  writeFileSync(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
  await Promise.all(containers.reverse().map(name => docker('rm', '-f', name).catch(() => {})));
  log(`report: ${resolve(output, 'report.json')}`);
}
