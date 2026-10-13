import { fork, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, writeFileSync, readFileSync, createWriteStream, unlinkSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { createServer, createConnection } from 'node:net';
import os from 'node:os';
import { deliveryCoverage } from './benchmark-topology.mjs';
import { histogram, mergeHistogram, summarize } from './benchmark-metrics.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const options = { instances: 5, members: 2000, native: 500, rooms: 100, history: 100, nativeRamp: 120,
  ramp: 30, bootRamp: 30, warmup: 120, duration: 120, messageInterval: 60, inflight: 64, timeout: 20, bootstrapTimeout: 300 };
const names = { instances: 'instances', members: 'members', native: 'native', rooms: 'rooms', history: 'history',
  'native-ramp': 'nativeRamp', ramp: 'ramp', 'boot-ramp': 'bootRamp', warmup: 'warmup', duration: 'duration',
  'message-interval': 'messageInterval', inflight: 'inflight', timeout: 'timeout', 'bootstrap-timeout': 'bootstrapTimeout', 'adapter-ip': 'adapterIp' };
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log(`Real Archipel/Prosody instances sharing rooms across all origins.
Usage: npm run benchmark:five -- [--instances 5 --members 2000 --native 500 --rooms 100]
Options: --native-ramp 120 --ramp 30 --boot-ramp 30 --warmup 120 --duration 120
  --message-interval 60 --history 100 --inflight 64 --timeout 20 --bootstrap-timeout 300
Member counts are per instance. Rooms are global, evenly hosted across the instances.
Docker must be running. Only this run's named containers/network are removed.
Small validation: --members 20 --native 5 --rooms 5 --history 10 --native-ramp 2 --ramp 1 --boot-ramp 1 --warmup 8 --duration 12 --message-interval 4
Exit 0: checks met; 2: capacity/setup-readiness target missed; 1: harness failure.`);
  process.exit(0);
}
for (let i = 0; i < args.length; i += 2) {
  const name = names[args[i]?.replace(/^--/, '')], value = Number(args[i + 1]);
  if (!name || args[i + 1] === undefined || !Number.isFinite(value) || value < 0) throw new Error(`Invalid option ${args[i]}`);
  options[name] = value;
}
for (const name of ['instances', 'members', 'native', 'rooms', 'history', 'inflight']) if (!Number.isSafeInteger(options[name])) throw new Error(`${name} must be an integer`);
if (options.instances < 2 || options.native < 1 || options.members <= options.native || options.rooms < options.instances || options.rooms % options.instances ||
  options.members - options.native < options.rooms || options.inflight < 1 || options.messageInterval <= 0 || options.duration <= 0 || options.timeout <= 0)
  throw new Error('Use at least two instances, rooms divisible by the instance count, at least one native user, and at least one web member per room.');
options.users = options.members;
options.schedule = 'uniform-within-each-protocol';
options.tag = randomBytes(5).toString('hex');
const output = resolve(root, 'test-results', 'five-instance', new Date().toISOString().replace(/[:.]/g, '-'));
mkdirSync(output, { recursive: true }); mkdirSync(resolve(output, 'certs'));
const image = 'prosodyim/prosody:13.0@sha256:0d4efc7c11018dfd863c9a25495efe706027de357a58a18ef02f8c484fb264ed';
const prefix = `archipel-bench-${options.tag}`, network = `${prefix}-net`;
const domains = Array.from({ length: options.instances }, (_, i) => `i${i}-${options.tag}.bench.test`);
const children = [], containers = [], appContainers = [], samples = [], last = new Map(), readers = [];
const telemetry = createWriteStream(resolve(output, 'telemetry.ndjson'));
const execute = promisify(execFile);
async function docker(...args) {
  try { const result = await execute('docker', args, { encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
    return (result.stdout + (args[0] === 'logs' ? result.stderr : '')).trim(); }
  catch (error) { throw new Error(`Docker ${args[0]} failed: ${String(error.stderr || error.code).slice(0, 2000)}`); }
}
function child(path, execArgv = [], source) {
  const p = fork(resolve(root, path), [], { cwd: root, execArgv, env: { ...process.env, NODE_ENV: 'production' }, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  children.push(p);
  p.on('message', value => {
    if (value.type !== 'telemetry') return;
    const row = { source, ...value }; samples.push(row); last.set(source, row); telemetry.write(`${JSON.stringify(row)}\n`);
  });
  return p;
}
function waitFor(p, type, milliseconds = 180000) {
  return new Promise((done, reject) => {
    const clear = () => { clearTimeout(timer); p.off('message', message); p.off('exit', exit); p.off('error', error); };
    const message = m => { if (m.type === type) { clear(); done(m); } };
    const exit = (code, signal) => { clear(); reject(new Error(`Child stopped before ${type}: ${code ?? signal}`)); };
    const error = err => { clear(); reject(err); };
    const timer = setTimeout(() => { clear(); reject(new Error(`Timed out waiting for ${type}`)); }, milliseconds);
    p.on('message', message); p.once('exit', exit); p.once('error', error);
  });
}
const sleep = ms => new Promise(done => setTimeout(done, ms));
function portReady(port) {
  return new Promise(done => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const finish = ok => { socket.destroy(); done(ok); };
    socket.once('connect', () => finish(true)); socket.once('error', () => finish(false));
    socket.setTimeout(1000, () => finish(false));
  });
}
let cleaned = false;
async function cleanup() {
  if (cleaned) return; cleaned = true;
  for (const p of children) if (p.connected) p.send({ type: 'stop' }, () => {});
  await sleep(500);
  for (const p of children) if (p.exitCode === null) p.kill();
  for (const timer of readers) clearInterval(timer);
  for (let i = 0; i < appContainers.length; i++) {
    try { await docker('stop', '--time', '10', appContainers[i]);
      const snapshot = resolve(output, `instance-${i}.sqlite`);
      if (!existsSync(snapshot)) await docker('cp', `${appContainers[i]}:/tmp/instance.sqlite`, snapshot);
    } catch (error) { writeFileSync(resolve(output, `snapshot-${i}-error.txt`), String(error)); }
  }
  for (const name of containers) {
    try { writeFileSync(resolve(output, `${name}.log`), await docker('logs', name)); } catch {}
  }
  await Promise.all(containers.map(name => docker('rm', '-f', name).catch(() => {})));
  await docker('network', 'rm', network).catch(() => {});
  // These manifests contain only run-specific test credentials; they are no longer needed.
  for (let i = 0; i < options.instances; i++) for (const name of [`input-${i}.json`, `ready-${i}.json`]) {
    try { unlinkSync(resolve(output, name)); } catch {}
  }
  telemetry.end();
}
process.once('SIGINT', () => { void cleanup().then(() => process.exit(130)); });
process.once('SIGTERM', () => { void cleanup().then(() => process.exit(143)); });
async function until(predicate, seconds, label) {
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) {
    if (predicate()) return true;
    if (children.some(p => p.exitCode !== null || p.signalCode !== null)) throw new Error(`Process stopped during ${label}`);
    await sleep(1000);
  }
  return false;
}
const report = { options, output, platform: os.platform(), node: process.version, cpu: os.cpus()[0].model, logicalCPUs: os.cpus().length,
  memoryGB: os.totalmem() / 1073741824, setup: {}, pass: false,
  limitations: ['App servers and Prosody run on the same Docker Linux VM; protocol generators run on the workstation alongside existing unrelated services.',
    'This is real TLS/c2s/s2s/MUC/bridging and MAM, with protocol-driven web refreshes; browser DOM rendering, web TLS/proxy and OIDC login are excluded.',
    'Warmup may still have bridge joins or queued work; readiness and workload phase classification are reported explicitly.',
    'Native socket writes are reported separately from room self-echo confirmation. Visible latency includes scheduling, commit, network and refresh admission.',
    'Visibility totals cover unique observed messages; unfinished/absent deliveries have no latency sample and must not be inferred successful.',
    'The native inventory parser fix is active; pre-existing seed history is excluded from the live outbox; all other pipeline/pacing behavior remains current default.'] };
try {
  await docker('info', '--format', '{{.ServerVersion}}');
  console.log(`${options.instances}-instance workload: ${options.members} members and ${options.native} native clients each, ${options.rooms} shared rooms.\nResults: ${output}`);
  await docker('network', 'create', network);
  const subnet = JSON.parse(await docker('network', 'inspect', network))[0].IPAM.Config[0].Subnet.split('/')[0].split('.');
  const ips = domains.map((_, i) => [...subnet.slice(0, 3), String(10 + i)].join('.'));
  await execute(process.execPath, [resolve(root, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.build.json'], { cwd: root, timeout: 120000 });
  writeFileSync(resolve(root, 'build', 'package.json'), readFileSync(resolve(root, 'package.json')));
  mkdirSync(resolve(root, 'build', 'node_modules'), { recursive: true });
  mkdirSync(resolve(root, 'build', 'migrations'), { recursive: true });
  const fixtures = [];
  for (let i = 0; i < options.instances; i++) {
    const reservation = createServer(); await new Promise(done => reservation.listen(0, '127.0.0.1', done));
    const port = reservation.address().port; await new Promise(done => reservation.close(done));
    const origin = `http://127.0.0.1:${port}`, name = `${prefix}-app-${i}`;
    containers.push(name); appContainers.push(name);
    const input = { ...options, instance: i, domains, secret: randomBytes(32).toString('base64url'),
      database: '/tmp/instance.sqlite', port: 8788, origin, readyPath: `/fixture/ready-${i}.json`, telemetryPath: `/fixture/server-${i}.ndjson`, bridgesStartPath: '/fixture/start-bridges' };
    writeFileSync(resolve(output, `input-${i}.json`), JSON.stringify(input), { mode: 0o600 });
    await docker('run', '--detach', '--name', name, '--network', network, '--network-alias', `app-${i}`,
      '--publish', `127.0.0.1:${port}:8788`, '--env', 'NODE_ENV=production', '--workdir', '/app',
      '--mount', `type=bind,src=${resolve(root, 'build')},dst=/app,readonly`,
      '--mount', `type=bind,src=${resolve(root, 'package.json')},dst=/app/package.json,readonly`,
      '--mount', `type=bind,src=${resolve(root, 'node_modules')},dst=/app/node_modules,readonly`,
      '--mount', `type=bind,src=${resolve(root, 'migrations')},dst=/app/migrations,readonly`,
      '--mount', `type=bind,src=${output},dst=/fixture`,
      'node:24-bookworm-slim', 'node', 'scripts/benchmark-five-server.js', `/fixture/input-${i}.json`);
    const readyFile = resolve(output, `ready-${i}.json`);
    const available = await until(() => { try { return JSON.parse(readFileSync(readyFile, 'utf8')).type === 'ready'; } catch { return false; } }, 180, 'Linux server seed');
    if (!available) throw new Error(`Linux instance ${i} did not finish seeding`);
    fixtures.push(JSON.parse(readFileSync(readyFile, 'utf8')));
    fixtures[i].adapterAddress = JSON.parse(await docker('inspect', name))[0].NetworkSettings.Networks[network].IPAddress;
    let offset = 0;
    readers.push(setInterval(() => {
      try {
        const lines = readFileSync(resolve(output, `server-${i}.ndjson`), 'utf8').trim().split('\n');
        for (; offset < lines.length; offset++) {
          let sample; try { sample = JSON.parse(lines[offset]); } catch { break; }
          const row = { source: `server-${i}`, ...sample }; samples.push(row); last.set(row.source, row); telemetry.write(`${JSON.stringify(row)}\n`);
        }
      } catch {}
    }, 500));
    console.log(`Linux application ${i + 1}/${options.instances} seeded.`);
  }
  report.applicationNode = fixtures[0].node;
  const certName = `${prefix}-cert`; containers.push(certName);
  const sans = domains.flatMap(domain => [`DNS:${domain}`, `DNS:channels.${domain}`]).join(',');
  await docker('run', '--name', certName, '--entrypoint', 'sh', image, '-c',
    `mkdir -p /tmp/certs && openssl req -x509 -newkey rsa:2048 -nodes -keyout /tmp/certs/bench.key -out /tmp/certs/bench.crt -days 1 -subj /CN=bench.test -addext subjectAltName=${sans} >/dev/null 2>&1`);
  await docker('cp', `${certName}:/tmp/certs/.`, resolve(output, 'certs'));
  await docker('rm', certName); containers.splice(containers.indexOf(certName), 1);
  const ca = readFileSync(resolve(output, 'certs', 'bench.crt'), 'utf8');
  const baseConfig = readFileSync(resolve(root, 'prosody', 'prosody.cfg.lua'), 'utf8');
  writeFileSync(resolve(output, 'prosody.cfg.lua'), 'unbound = { resolvconf = true; hoststxt = true; options = { ["domain-insecure"] = "bench.test" } }\n' + baseConfig);
  const ports = [];
  for (let i = 0; i < options.instances; i++) {
    const name = `${prefix}-prosody-${i}`; containers.push(name);
    const hosts = domains.flatMap((domain, j) => ['--add-host', `${domain}:${ips[j]}`, '--add-host', `channels.${domain}:${ips[j]}`]);
    await docker('run', '--detach', '--name', name, '--network', network, '--ip', ips[i], '--network-alias', domains[i],
      '--network-alias', `channels.${domains[i]}`, '--add-host', 'host.docker.internal:host-gateway', ...hosts,
      '--publish', '127.0.0.1::5222', '--env', `XMPP_DOMAIN=${domains[i]}`, '--env', `XMPP_BRIDGE_SECRET=${fixtures[i].secret}`,
      '--env', `ARCHIPEL_API_URL=http://${options.adapterIp ? fixtures[i].adapterAddress : `app-${i}`}:8788/internal/xmpp`,
      '--env', 'XMPP_CERTS_PATH=/tmp/bench-certs', '--env', 'XMPP_CA_FILE=/tmp/bench-certs/bench.crt', '--env', 'PROSODY_LOGLEVEL=info',
      '--mount', `type=bind,src=${resolve(output, 'prosody.cfg.lua')},dst=/etc/prosody/prosody.cfg.lua,readonly`,
      '--mount', `type=bind,src=${resolve(root, 'prosody/modules')},dst=/etc/prosody/archipel-modules,readonly`,
      '--mount', `type=bind,src=${resolve(output, 'certs')},dst=/test-certs,readonly`, '--entrypoint', 'sh', image, '-c',
      `mkdir -p /tmp/bench-certs && cp /test-certs/bench.crt /tmp/bench-certs/bench.crt && cp /test-certs/bench.crt /tmp/bench-certs/${domains[i]}.crt && cp /test-certs/bench.key /tmp/bench-certs/${domains[i]}.key && chown -R prosody:prosody /tmp/bench-certs && exec /entrypoint.sh prosody`);
    ports.push(Number(JSON.parse(await docker('inspect', name))[0].NetworkSettings.Ports['5222/tcp'][0].HostPort));
  }
  for (const port of ports) {
    let listening = false;
    for (let n = 0; n < 60 && !listening; n++) { listening = await portReady(port); if (!listening) await sleep(1000); }
    if (!listening) throw new Error('An XMPP service did not open its client listener');
  }
  writeFileSync(resolve(output, 'start-bridges'), 'ready');
  const bridgeOwners = options.rooms * (options.instances - 1) / options.instances;
  report.setup.bridgeSubscriptionsReady = await until(() => fixtures.every((_, i) => {
    const row = last.get(`server-${i}`); return row?.virtualRooms === bridgeOwners && row.joinedVirtualRooms === bridgeOwners;
  }), options.bootstrapTimeout, 'bridge bootstrap');
  report.setup.bridgeBootstrapState = fixtures.map((_, i) => last.get(`server-${i}`));
  console.log(`Bridge subscriptions: ${report.setup.bridgeBootstrapState.map(r => `${r?.joinedVirtualRooms || 0}/${bridgeOwners}`).join(' | ')}`);
  if (!report.setup.bridgeSubscriptionsReady) {
    const error = new Error('Cross-instance bridge subscriptions did not become ready before native ramp');
    error.classification = 'bridge-bootstrap-failed'; throw error;
  }
  await sleep(5000);
  const nativeWorkers = fixtures.map((_, i) => child('scripts/benchmark-xmpp-worker.mjs', [], `native-${i}`));
  const nativeReady = await Promise.all(nativeWorkers.map((p, i) => {
    const ready = waitFor(p, 'ready', (options.nativeRamp + options.timeout + 90) * 1000);
    p.send({ users: fixtures[i].users.filter(u => u.credential), instance: i, domain: domains[i], port: ports[i], ca, options });
    return ready;
  }));
  report.setup.native = nativeReady.map(row => row.stats);
  writeFileSync(resolve(output, 'docker-stats-bootstrap.txt'), await docker('stats', '--no-stream', '--format', '{{.Name}} {{.CPUPerc}} {{.MemUsage}}', ...containers));
  const nativeConnected = nativeReady.every(row => row.stats.online === options.native && row.stats.joined === options.native && row.stats.mam === options.native);
  console.log(`Native readiness: ${nativeReady.map(row => `${row.stats.online}/${options.native} online, ${row.stats.joined} joined, ${row.stats.mam} MAM`).join(' | ')}`);
  if (!nativeConnected) {
    report.classification = 'native-bootstrap-failed'; process.exitCode = 2;
  } else {
    const webWorkers = fixtures.map((_, i) => child('scripts/benchmark-worker.mjs', [], `web-${i}`));
    await Promise.all(webWorkers.map((p, i) => {
      const ready = waitFor(p, 'ready', (options.ramp + options.timeout + 60) * 1000);
      p.send({ origin: fixtures[i].origin, users: fixtures[i].users.filter(u => !u.credential), options, worker: i }); return ready;
    }));
    for (const p of webWorkers) p.send({ type: 'bootstrap' });
    const booted = await until(() => webWorkers.every((_, i) => last.get(`web-${i}`)?.bootstrapped === options.members - options.native), options.bootstrapTimeout, 'web bootstrap');
    report.setup.webBootstrapComplete = booted;
    if (!booted) { report.classification = 'web-bootstrap-failed'; process.exitCode = 2; }
    else {
      const at = Date.now() + 1000, start = at + options.warmup * 1000, end = start + options.duration * 1000;
      for (const p of [...nativeWorkers, ...webWorkers]) p.send({ type: 'start', at });
      console.log('Initial web/native bootstrap completed; starting chat warmup.');
      const progress = setInterval(() => {
        const native = Array.from({ length: options.instances }, (_, i) => last.get(`native-${i}`));
        const web = Array.from({ length: options.instances }, (_, i) => last.get(`web-${i}`));
        console.log(`${Date.now() < start ? 'warmup' : 'measured'}: native ${native.map(r => r?.online || 0).join('/')}; ` +
          `web posts ${web.reduce((n, r) => n + (r?.successful || 0), 0)}, native echoes ${native.reduce((n, r) => n + (r?.selfEcho || 0), 0)}; ` +
          `bridge resources ${Array.from({ length: options.instances }, (_, i) => last.get(`server-${i}`)?.virtualRooms || 0).join('/')}`);
      }, 10000);
      let measurementStart;
      while (Date.now() < end) {
        await sleep(1000);
        if (!measurementStart && Date.now() >= start) measurementStart = Array.from({ length: options.instances }, (_, i) => ({
          instance: i, server: last.get(`server-${i}`), native: last.get(`native-${i}`), web: last.get(`web-${i}`) }));
        if (children.some(p => p.exitCode !== null || p.signalCode !== null)) { clearInterval(progress); throw new Error('A workload process stopped unexpectedly'); }
      }
      clearInterval(progress);
      report.measurement = { start: new Date(start).toISOString(), end: new Date(end).toISOString(), seconds: options.duration, startState: measurementStart };
      report.classification = measurementStart.every(row => row.native?.online === options.native && row.native?.joined === options.native &&
        row.web?.bootstrapped === options.members - options.native && row.server?.joinedVirtualRooms === row.server?.virtualRooms)
        ? 'steady-state-after-bootstrap' : 'chat-load-with-incomplete-warmup';
      await sleep(options.timeout * 1000); // no new writes; allow native committed echoes to arrive
      report.instances = await Promise.all(fixtures.map(async (_, i) => {
        const nativeResult = waitFor(nativeWorkers[i], 'result', 10000), webResult = waitFor(webWorkers[i], 'result', (options.timeout + 15) * 1000);
        nativeWorkers[i].send({ type: 'stop' }); webWorkers[i].send({ type: 'stop' });
        const [n, w] = await Promise.all([nativeResult, webResult]);
        const during = samples.filter(row => row.time >= start && row.time < end && row.source === `server-${i}`);
        return { instance: i, native: n.stats, web: w.stats, serverPeakRSSMB: Math.max(0, ...during.map(row => row.rssMB)),
          serverWorstEventLoopP95Ms: Math.max(0, ...during.map(row => row.eventLoopP95Ms)), endState: last.get(`server-${i}`) };
      }));
      const nativeLatency = histogram(), webLatency = histogram(), nativeVisible = histogram(), webVisible = histogram();
      let scheduled = 0, webSuccess = 0, nativeConfirmed = 0, dropped = 0, nativeObserved = 0, webObserved = 0;
      for (const instance of report.instances) {
        const n = instance.native, w = instance.web;
        scheduled += n.writes.scheduled + w.writes.scheduled; webSuccess += w.writes.successful; nativeConfirmed += n.writes.selfEcho; dropped += w.writes.dropped;
        nativeObserved += n.deliveries.visible; webObserved += w.deliveries.visible;
        mergeHistogram(nativeLatency, n.writes.latency); mergeHistogram(webLatency, w.writes.latency);
        mergeHistogram(nativeVisible, n.deliveries.latency); mergeHistogram(webVisible, w.deliveries.latency);
      }
      report.totals = { scheduled, webSuccess, nativeSelfEchoConfirmed: nativeConfirmed, generatorDropped: dropped,
        scheduledPostsPerSecond: options.members * options.instances / options.messageInterval,
        confirmedOrApiAcceptedPostsPerSecond: (webSuccess + nativeConfirmed) / options.duration,
        nativeSelfEchoLatency: summarize(nativeLatency), webApiPostLatency: summarize(webLatency),
        nativeFirstObservedMessageLatency: summarize(nativeVisible), webFirstObservedMessageLatency: summarize(webVisible) };
      report.totals.deliveryCoverage = { nativeObserved, webObserved,
        ...deliveryCoverage(options, report.instances),
        note: 'One assigned room per receiver; expected observations use actual offered posts and receiver counts in each room. Observations include the configured timeout-duration drain.' };
      report.checks = { completeBootstrap: report.classification === 'steady-state-after-bootstrap',
        allWebStayedConnected: report.instances.every(row => row.web.sse.activeAtStop === options.members - options.native && row.web.sse.failures === 0),
        allNativeStayedOnline: report.instances.every(row => row.native.online === options.native && row.native.disconnected === 0),
        webWrites99Percent: webSuccess >= .99 * report.instances.reduce((n, row) => n + row.web.writes.scheduled, 0),
        nativeSelfEcho99Percent: nativeConfirmed >= .99 * report.instances.reduce((n, row) => n + row.native.writes.scheduled, 0),
        nativeEchoP95Below3Seconds: summarize(nativeLatency).p95Ms !== null && summarize(nativeLatency).p95Ms <= 3000,
        webApiPostP95Below1Second: summarize(webLatency).p95Ms !== null && summarize(webLatency).p95Ms <= 1000,
        nativeVisibleP95Below3Seconds: summarize(nativeVisible).p95Ms !== null && summarize(nativeVisible).p95Ms <= 3000,
        webVisibleP95Below3Seconds: summarize(webVisible).p95Ms !== null && summarize(webVisible).p95Ms <= 3000 };
      report.pass = Object.values(report.checks).every(Boolean); process.exitCode = report.pass ? 0 : 2;
    }
  }
} catch (error) { report.error = String(error); report.classification = error.classification || 'harness-error';
  process.exitCode = error.classification ? 2 : 1; console.error(report.error); }
finally {
  report.lastTelemetry = [...last.values()];
  writeFileSync(resolve(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  const ms = value => value === null ? 'n/a' : `${value.toFixed(1)} ms`;
  const text = `# ${options.instances}-instance shared-room benchmark\n\n${report.classification}; ${report.pass ? 'PASS' : 'TARGET NOT MET'}\n\n` +
    `${options.members} members (${options.members - options.native} web, ${options.native} native) per instance; ${options.rooms} rooms shared by all ${options.instances} instances.\n\n` +
    (report.setup.native ? `Native bootstrap: ${report.setup.native.map((n, i) => `instance ${i}: ${n.online} online, ${n.joined} joined, ${n.mam} MAM`).join('; ')}.\n\n` : '') +
    (report.totals ? `Scheduled: ${report.totals.scheduled}; web API accepted: ${report.totals.webSuccess}; native room self-echo confirmed: ${report.totals.nativeSelfEchoConfirmed}; generator-dropped web posts: ${report.totals.generatorDropped}.\n\n` +
      `Web API post p95: ${ms(report.totals.webApiPostLatency.p95Ms)}; native self-echo p95: ${ms(report.totals.nativeSelfEchoLatency.p95Ms)}.\n\n` +
      `First observed message p95: native ${ms(report.totals.nativeFirstObservedMessageLatency.p95Ms)}, web ${ms(report.totals.webFirstObservedMessageLatency.p95Ms)}. Missing deliveries have no percentile sample.\n\n` : '') +
    (report.error ? `${report.error}\n\n` : '') + report.limitations.map(value => `- ${value}`).join('\n') + '\n';
  writeFileSync(resolve(output, 'report.md'), text); console.log(text); await cleanup();
}
