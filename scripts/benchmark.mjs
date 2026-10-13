import { fork } from 'node:child_process';
import { mkdirSync, writeFileSync, createWriteStream } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { histogram, mergeHistogram, summarize } from './benchmark-metrics.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const options = { users: 10000, channels: 100, duration: 120, warmup: 15, ramp: 30,
  messageInterval: 60, workers: 4, inflight: 64, timeout: 10, history: 100, visibility: 'members' };
const names = { users: 'users', channels: 'channels', duration: 'duration', warmup: 'warmup', ramp: 'ramp',
  'message-interval': 'messageInterval', workers: 'workers', inflight: 'inflight', timeout: 'timeout', history: 'history' };
const argv = process.argv.slice(2);
if (argv.includes('--help')) {
  console.log(`Archipel isolated HTTP/SSE benchmark (no .env or existing database is used)
Usage: npm run benchmark -- [options]
  --users 10000            Distinct authenticated, connected chat users
  --channels 100           One channel membership/open conversation per user
  --message-interval 60    Seconds between each user's posts (open-loop)
  --duration 120           Measured seconds after warmup
  --warmup 15              Unmeasured warmup seconds
  --ramp 30                Seconds to establish streams
  --workers 4              Separate generator processes
  --inflight 64            Max concurrent writes and refreshes per worker
  --timeout 10             Request deadline in seconds, including agent queue
  --history 100            Messages seeded per channel
  --visibility members    members or public (public notifications go to everyone)
  --output <directory>    New run directory (default: test-results/benchmarks/<timestamp>)
Exit: 0 = thresholds met; 2 = capacity thresholds missed; 1 = setup/runtime failure.`);
  process.exit(0);
}
for (let i = 0; i < argv.length; i += 2) {
  const key = argv[i].replace(/^--/, ''), value = argv[i + 1];
  if (!argv[i].startsWith('--') || value === undefined) throw new Error(`Invalid option: ${argv[i]}`);
  if (key === 'output') options.output = resolve(value);
  else if (key === 'visibility' && ['members', 'public'].includes(value)) options.visibility = value;
  else if (names[key] && /^(?:\d+(?:\.\d+)?|\.\d+)$/.test(value)) options[names[key]] = Number(value);
  else throw new Error(`Invalid option: ${argv[i]} ${value}`);
}
for (const key of ['users', 'channels', 'workers', 'inflight', 'history'])
  if (!Number.isSafeInteger(options[key]) || options[key] < (key === 'history' ? 0 : 1)) throw new Error(`Invalid ${key}`);
for (const key of ['duration', 'messageInterval', 'timeout'])
  if (options[key] <= 0) throw new Error(`${key} must be positive`);
if (options.channels > options.users || options.workers > options.users || options.workers > 32)
  throw new Error('Channels/workers cannot exceed users; use at most 32 workers.');
const output = options.output || resolve(root, 'test-results', 'benchmarks', new Date().toISOString().replace(/[:.]/g, '-'));
// A fresh directory and fixture make accidental reuse of real instance data impossible.
mkdirSync(dirname(output), { recursive: true });
mkdirSync(output, { recursive: false });
const telemetryFile = createWriteStream(resolve(output, 'telemetry.ndjson'));
const children = [], resources = [], last = new Map();
let stopped = false;
function spawn(path, execArgv = []) {
  const child = fork(resolve(root, path), [], { cwd: root, execArgv, env: { ...process.env, NODE_ENV: 'production' },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  children.push(child);
  child.on('message', item => {
    if (item.type !== 'telemetry') return;
    const row = { source: path.endsWith('server.ts') ? 'server' : `worker-${item.worker}`, ...item };
    resources.push(row); last.set(row.source, row); telemetryFile.write(`${JSON.stringify(row)}\n`);
  });
  return child;
}
function waitFor(child, type, timeout = 180000) {
  return new Promise((resolvePromise, reject) => {
    const cleanup = () => { clearTimeout(timer); child.off('message', message); child.off('exit', exit); child.off('error', error); };
    const message = value => { if (value.type === type) { cleanup(); resolvePromise(value); } };
    const exit = (code, signal) => { cleanup(); reject(new Error(`${type}: child exited (${code ?? signal})`)); };
    const error = err => { cleanup(); reject(err); };
    const timer = setTimeout(() => { cleanup(); reject(new Error(`Timed out waiting for ${type}`)); }, timeout);
    child.on('message', message); child.once('exit', exit); child.once('error', error);
  });
}
async function cleanup() {
  if (stopped) return; stopped = true;
  for (const child of children) if (child.connected) child.send({ type: 'stop' }, () => {});
  await new Promise(r => setTimeout(r, 250));
  for (const child of children) if (child.exitCode === null) child.kill();
  telemetryFile.end();
}
process.once('SIGINT', () => { void cleanup().then(() => process.exit(130)); });
process.once('SIGTERM', () => { void cleanup().then(() => process.exit(143)); });
try {
  console.log(`Workload: ${options.users.toLocaleString()} users, ${options.channels} ${options.visibility} channels, ` +
    `${(options.users / options.messageInterval).toFixed(1)} scheduled chat posts/sec.\nResults: ${output}`);
  const server = spawn('scripts/benchmark-server.ts', ['--import', 'tsx']);
  const ready = waitFor(server, 'ready');
  server.send({ ...options, database: resolve(output, 'fixture.sqlite') });
  const fixture = await ready;
  const workers = Array.from({ length: options.workers }, () => spawn('scripts/benchmark-worker.mjs'));
  const connected = await Promise.all(workers.map((child, worker) => {
    const ready = waitFor(child, 'ready', options.ramp * 1000 + options.timeout * 1000 + 60000);
    child.send({ origin: fixture.origin, users: fixture.users.filter(user => user.index % workers.length === worker), options, worker });
    return ready;
  }));
  console.log(`Connected ${connected.reduce((n, value) => n + value.connected, 0)}/${options.users} streams. Starting warmup.`);
  const at = Date.now() + 1000, start = at + options.warmup * 1000, end = start + options.duration * 1000;
  for (const child of workers) child.send({ type: 'start', at });
  const progress = setInterval(() => {
    const s = last.get('server'), w = [...last.values()].filter(row => row.source.startsWith('worker'));
    console.log(`${Date.now() < start ? 'warmup' : `measured ${Math.min(options.duration, Math.round((Date.now() - start) / 1000))}s`}: ` +
      `${s?.connections ?? 0} streams, ${w.reduce((n, row) => n + row.successful, 0)} posts OK, ` +
      `${w.reduce((n, row) => n + row.failed + row.dropped, 0)} failed/dropped; ` +
      `server ${s?.cpuPercent.toFixed(0) ?? '?'}% CPU, ${s?.rssMB.toFixed(0) ?? '?'} MB RSS, ` +
      `${Math.max(0, ...w.map(row => row.oldestRefreshMs))}ms oldest refresh.`);
  }, 10000);
  // Check child liveness during the run; never turn an early crash into a successful benchmark.
  while (Date.now() < end) {
    await new Promise(r => setTimeout(r, Math.min(1000, Math.max(1, end - Date.now()))));
    if (children.some(child => child.exitCode !== null || child.signalCode !== null)) {
      clearInterval(progress); throw new Error('A benchmark process exited during the measured workload.');
    }
  }
  clearInterval(progress);
  const activeAtEnd = last.get('server')?.connections ?? 0;
  const collected = await Promise.all(workers.map((child, worker) => {
    const result = waitFor(child, 'result', options.timeout * 1000 + 10000);
    child.send({ type: 'stop', connected: last.get(`worker-${worker}`)?.connected ?? 0 });
    return result;
  }));
  const totals = { writes: { scheduled: 0, successful: 0, failed: 0, dropped: 0, users: 0, latency: histogram() },
    refresh: { started: 0, completed: 0, failed: 0, pendingAtStop: 0, latency: histogram() },
    sse: { opened: 0, failures: 0, notices: 0, bytes: 0 }, requests: {}, bytes: 0 };
  for (const { stats } of collected) {
    totals.bytes += stats.bytes;
    for (const group of ['writes', 'refresh', 'sse']) for (const key of Object.keys(totals[group])) {
      if (key === 'latency') mergeHistogram(totals[group][key], stats[group][key]);
      else totals[group][key] += stats[group][key];
    }
    for (const [key, item] of Object.entries(stats.requests)) {
      const dest = totals.requests[key] ??= { count: 0, success: 0, errors: 0, statuses: {}, latency: histogram() };
      dest.count += item.count; dest.success += item.success; dest.errors += item.errors;
      mergeHistogram(dest.latency, item.latency);
      for (const [code, n] of Object.entries(item.statuses)) dest.statuses[code] = (dest.statuses[code] || 0) + n;
    }
  }
  totals.writes.latency = summarize(totals.writes.latency); totals.refresh.latency = summarize(totals.refresh.latency);
  for (const item of Object.values(totals.requests)) item.latency = summarize(item.latency);
  const samples = resources.filter(row => row.time >= start && row.time < end);
  const serverSamples = samples.filter(row => row.source === 'server');
  const max = (rows, key) => rows.length ? Math.max(...rows.map(row => row[key])) : null;
  const requestCount = Object.values(totals.requests).reduce((n, row) => n + row.count, 0);
  const errors = Object.values(totals.requests).reduce((n, row) => n + row.errors, 0);
  const writeRatio = totals.writes.scheduled ? totals.writes.successful / totals.writes.scheduled : 0;
  const expectedWrites = Math.round(options.users / options.messageInterval * options.duration);
  const checks = {
    connectedAllUsers: totals.sse.opened === options.users && activeAtEnd === options.users && totals.sse.failures === 0,
    offeredAllWrites: totals.writes.scheduled >= Math.floor(expectedWrites * .99),
    writesSucceeded99Percent: writeRatio >= .99,
    requestErrorsBelow1Percent: requestCount > 0 && errors / requestCount < .01,
    writeP95Below1Second: totals.writes.latency.p95Ms !== null && totals.writes.latency.p95Ms <= 1000,
    refreshP95Below3Seconds: totals.refresh.latency.p95Ms !== null && totals.refresh.latency.p95Ms <= 3000,
    generatorResponsive: max(samples.filter(row => row.source !== 'server'), 'eventLoopP95Ms') !== null &&
      max(samples.filter(row => row.source !== 'server'), 'eventLoopP95Ms') < 100,
  };
  const pass = Object.values(checks).every(Boolean);
  let revision = 'unknown'; try { revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(); } catch {}
  const report = { date: new Date().toISOString(), revision, options, machine: { platform: os.platform(), release: os.release(),
    node: process.version, cpu: os.cpus()[0]?.model, logicalCPUs: os.cpus().length, memoryGB: os.totalmem() / 1073741824 },
    database: 'SQLite on disk, WAL, default durability', rateLimitApi: fixture.rateLimitApi,
    measured: { start: new Date(start).toISOString(), end: new Date(end).toISOString(), seconds: options.duration },
    totals, throughput: { offeredPostsPerSecond: options.users / options.messageInterval,
      successfulPostsPerSecond: totals.writes.successful / options.duration, requestsPerSecond: requestCount / options.duration,
      responseMBPerSecond: (totals.bytes + totals.sse.bytes) / 1048576 / options.duration, requestErrorPercent: requestCount ? errors / requestCount * 100 : 100 },
    resources: { serverPeakRSSMB: max(serverSamples, 'rssMB'), serverPeakCPUPercent: max(serverSamples, 'cpuPercent'),
      serverPeakEventLoopP95Ms: max(serverSamples, 'eventLoopP95Ms'), serverPeakEventLoopMaxMs: max(serverSamples, 'eventLoopMaxMs'),
      generatorPeakEventLoopP95Ms: max(samples.filter(row => row.source !== 'server'), 'eventLoopP95Ms'),
      oldestPendingRefreshMs: max(samples.filter(row => row.source !== 'server'), 'oldestRefreshMs') }, activeAtEnd, checks, pass,
    limitations: ['Server and generators share this machine; this is not a VPS capacity certification.',
      'Protocol clients approximate the foreground timeline refresh path; no browser rendering, TLS/proxy, OIDC login, XMPP, federation peers, media, or push subscribers.',
      'Fresh database history is synthetic, one channel membership per user; production histories and memberships may cost more.',
      'End-to-end post latency includes scheduler delay; refresh latency includes waiting for generator admission and reads. HTTP latencies include agent queue.',
      'Latency percentiles use logarithmic buckets with up to 5% rounding. Metrics include draining operations started within the measured interval.'] };
  writeFileSync(resolve(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  const ms = value => value === null ? 'n/a' : `${value.toFixed(1)} ms`;
  const markdown = `# Archipel chat load benchmark\n\n${pass ? 'PASS' : 'CAPACITY TARGET MISSED'}\n\n` +
    `${options.users.toLocaleString()} users, ${options.channels} ${options.visibility} channels, one post/user/${options.messageInterval}s; ${options.duration}s measured.\n\n` +
    `| Metric | Result |\n|---|---:|\n` +
    `| Streams at end | ${activeAtEnd}/${options.users} |\n| Scheduled posts | ${totals.writes.scheduled} |\n` +
    `| Successful / failed / generator-dropped posts | ${totals.writes.successful} / ${totals.writes.failed} / ${totals.writes.dropped} |\n` +
    `| Distinct users with successful measured posts | ${totals.writes.users} |\n` +
    `| Successful posts/sec | ${report.throughput.successfulPostsPerSecond.toFixed(2)} |\n` +
    `| Completed HTTP requests/sec | ${report.throughput.requestsPerSecond.toFixed(2)} |\n` +
    `| HTTP error rate | ${report.throughput.requestErrorPercent.toFixed(2)}% |\n` +
    `| Post end-to-end p50 / p95 / p99 | ${ms(totals.writes.latency.p50Ms)} / ${ms(totals.writes.latency.p95Ms)} / ${ms(totals.writes.latency.p99Ms)} |\n` +
    `| Notification-to-refresh p95 | ${ms(totals.refresh.latency.p95Ms)} |\n` +
    `| Server peak RSS | ${report.resources.serverPeakRSSMB?.toFixed(0)} MB |\n` +
    `| Server worst sampled event-loop p95 | ${ms(report.resources.serverPeakEventLoopP95Ms)} |\n` +
    `| Generator worst sampled event-loop p95 | ${ms(report.resources.generatorPeakEventLoopP95Ms)} |\n\n` +
    `Checks:\n\n${Object.entries(checks).map(([key, ok]) => `- ${ok ? 'PASS' : 'FAIL'}: ${key}`).join('\n')}\n\n` +
    `Environment: ${report.machine.cpu}, ${report.machine.logicalCPUs} logical CPUs, ${report.machine.memoryGB.toFixed(1)} GiB RAM; ${report.machine.platform}, Node ${report.machine.node}; ${report.database}.\n\n` +
    `Limits:\n\n${report.limitations.map(value => `- ${value}`).join('\n')}\n`;
  writeFileSync(resolve(output, 'report.md'), markdown);
  console.log(markdown);
  process.exitCode = pass ? 0 : 2;
} catch (error) {
  console.error(error);
  writeFileSync(resolve(output, 'failure.json'), JSON.stringify({ date: new Date().toISOString(), options, error: String(error) }, null, 2));
  process.exitCode = 1;
} finally { await cleanup(); }
