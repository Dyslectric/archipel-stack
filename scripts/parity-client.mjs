// One shard of the parity load: the same room workload offered to an XMPP MUC
// (Prosody, ejabberd) or to Archipel's browser API. Clients are deliberately thin,
// scanning bytes for benchmark markers instead of parsing XML/JSON, so the
// generator stays cheap next to the server it measures.
import net from 'node:net';
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { histogram, observe } from './benchmark-metrics.mjs';
import { funny } from './parity-funny.mjs';

const o = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const say = value => process.stdout.write(JSON.stringify(value) + '\n');
const delay = monitorEventLoopDelay({ resolution: 20 }); delay.enable();
const stats = { connected: 0, joined: 0, failed: 0, dropped: 0, errors: {}, joinMs: histogram(), streamMs: histogram(), historyMs: histogram(),
  writes: { scheduled: 0, sent: 0, failed: 0, ok: 0, latency: histogram() },
  deliveries: { visible: 0, duplicate: 0, latency: histogram() }, bytes: 0 };
let start = Infinity, end = Infinity, measureFrom = Infinity, stopping = false;
const error = key => { stats.errors[key] = (stats.errors[key] || 0) + 1; };
const marker = `BENCH|${o.tag}|`;
const text = (nick, due) => `${o.funny ? funny(nick, due) : ''}${marker}${nick}|${due}|E`;

// Find complete `BENCH|tag|sender|due|E` markers in text; return the unconsumed tail.
function scan(client, text) {
  let at = 0;
  for (;;) {
    const found = text.indexOf(marker, at);
    if (found < 0) return text.slice(Math.max(at, text.length - marker.length));
    const close = text.indexOf('|E', found + marker.length);
    if (close < 0) return text.slice(found);
    const [sender, due] = text.slice(found + marker.length, close).split('|');
    const key = `${sender}|${due}`, when = Number(due);
    at = close + 2;
    if (!(when >= measureFrom && when < end)) continue;
    if (client.seen.has(key)) { stats.deliveries.duplicate++; continue; }
    client.seen.add(key); if (client.seen.size > 256) client.seen.delete(client.seen.values().next().value);
    stats.deliveries.visible++; observe(stats.deliveries.latency, Date.now() - when);
  }
}

function xmppClient(user) {
  const client = { user, seen: new Set(), joined: false, socket: null, tail: '' };
  const header = `<?xml version='1.0'?><stream:stream to='${o.domain}' xmlns='jabber:client' xmlns:stream='http://etherx.jabber.org/streams' version='1.0'>`;
  client.post = due => {
    if (!client.joined) return false;
    client.socket.write(`<message to='${user.room}' type='groupchat' id='${user.nick}-${due}'><body>${text(user.nick, due)}</body></message>`);
    return true;
  };
  client.start = () => new Promise(done => {
    const begun = performance.now();
    let stage = 'features', buffer = '', settled = false;
    const finish = ok => { if (settled) return; settled = true; clearTimeout(timer);
      if (ok) { stats.joined++; client.joined = true; observe(stats.joinMs, performance.now() - begun); }
      else { stats.failed++; socket.destroy(); }
      done(); };
    const timer = setTimeout(() => { error(`timeout:${stage}`); finish(false); }, o.timeout * 1000);
    const socket = client.socket = net.connect(o.port, o.host);
    socket.setNoDelay(true); socket.setEncoding('utf8');
    socket.on('connect', () => { stats.connected++; socket.write(header); });
    socket.on('error', e => { error(e.code || 'socket'); finish(false); });
    socket.on('close', () => { if (client.joined && !stopping) { stats.dropped++; client.joined = false; } finish(false); });
    socket.on('data', chunk => {
      if (client.joined) { stats.bytes += chunk.length; client.tail = scan(client, client.tail + chunk); return; }
      buffer += chunk;
      if (buffer.includes('<stream:error') || buffer.includes('<failure')) { error(`refused:${stage}`); finish(false); return; }
      if (stage === 'features' && buffer.includes('</stream:features>')) {
        stage = 'auth'; buffer = '';
        socket.write("<auth xmlns='urn:ietf:params:xml:ns:xmpp-sasl' mechanism='ANONYMOUS'/>");
      } else if (stage === 'auth' && buffer.includes('<success')) {
        stage = 'restart'; buffer = ''; socket.write(header);
      } else if (stage === 'restart' && buffer.includes('</stream:features>')) {
        stage = 'bind'; buffer = '';
        socket.write("<iq type='set' id='bind'><bind xmlns='urn:ietf:params:xml:ns:xmpp-bind'/></iq>");
      } else if (stage === 'bind' && /id=['"]bind['"]/.test(buffer) && buffer.includes('</iq>')) {
        stage = 'join'; buffer = '';
        socket.write(`<presence to='${user.room}/${user.nick}'><x xmlns='http://jabber.org/protocol/muc'><history maxstanzas='0'/></x></presence>`);
      } else if (stage === 'join' && /code=['"]110['"]/.test(buffer)) {
        stage = 'history'; buffer = '';
        socket.write(`<iq type='set' id='mam' to='${user.room}'><query xmlns='urn:xmpp:mam:2'><set xmlns='http://jabber.org/protocol/rsm'><max>${o.history}</max><before/></set></query></iq>`);
      } else if (stage === 'history' && /<iq[^>]*id=['"]mam['"]/.test(buffer)) {
        if (/<iq[^>]*type=['"]error['"]/.test(buffer)) { error('mam'); finish(false); return; }
        buffer = ''; finish(true);
      }
    });
  });
  return client;
}

const pages = new http.Agent({ keepAlive: true, maxSockets: o.inflight });
const streams = new http.Agent({ keepAlive: true, maxSockets: Infinity });
function request(user, path, method, body) {
  return new Promise(resolve => {
    const data = body && JSON.stringify(body);
    const req = http.request({ host: o.host, port: o.port, path, method, agent: pages, headers: {
      Cookie: `archipel=${user.token}`, Origin: o.origin, 'X-CSRF-Token': user.csrf,
      ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) } }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode)); res.on('error', () => resolve('response-error'));
    });
    req.setTimeout(o.timeout * 1000, () => req.destroy(new Error('timeout')));
    req.on('error', e => resolve(e.message === 'timeout' ? 'timeout' : e.code || 'network'));
    req.end(data);
  });
}
function webClient(user) {
  const client = { user, seen: new Set(), joined: false, tail: '' };
  client.post = due => {
    if (!client.joined) return false;
    const begun = performance.now();
    void request(user, `/api/channels/${user.channel}/messages`, 'POST', { body: text(user.nick, due) }).then(status => {
      if (status === 201) { stats.writes.ok++; if (due >= measureFrom && due < end) observe(stats.writes.latency, performance.now() - begun); }
      else { stats.writes.failed++; error(`post:${status}`); }
    });
    return true;
  };
  client.start = () => new Promise(done => {
    const begun = performance.now();
    let settled = false;
    const finish = ok => { if (settled) return; settled = true; clearTimeout(timer);
      if (ok) { stats.joined++; client.joined = true; observe(stats.joinMs, performance.now() - begun); } else stats.failed++;
      done(); };
    const timer = setTimeout(() => { error('timeout'); finish(false); }, o.timeout * 1000);
    const req = http.get({ host: o.host, port: o.port, agent: streams,
      path: `/api/events?deltas=1&watch=${encodeURIComponent(user.channel)}`, headers: { Cookie: `archipel=${user.token}` } }, res => {
      if (res.statusCode !== 200) { error(`events:${res.statusCode}`); res.resume(); finish(false); return; }
      stats.connected++; observe(stats.streamMs, performance.now() - begun);
      const asked = performance.now();
      res.setEncoding('utf8');
      res.on('data', chunk => { if (client.joined) stats.bytes += chunk.length; client.tail = scan(client, client.tail + chunk); });
      res.on('close', () => { if (client.joined && !stopping) { stats.dropped++; client.joined = false; } });
      // The same recent history an XMPP client asks its archive for.
      void request(user, `/api/channels/${user.channel}/messages`, 'GET').then(status => {
        observe(stats.historyMs, performance.now() - asked);
        if (status === 200) finish(true); else { error(`history:${status}`); finish(false); }
      });
    });
    req.on('error', e => { error(e.code || 'events'); finish(false); });
  });
  return client;
}

const clients = o.users.map(o.kind === 'archipel' ? webClient : xmppClient);
let cpu = process.cpuUsage(), wall = performance.now();
const telemetry = setInterval(() => {
  const now = performance.now(), used = process.cpuUsage(cpu); cpu = process.cpuUsage();
  say({ type: 'telemetry', shard: o.shard, time: Date.now(), joined: stats.joined, failed: stats.failed, dropped: stats.dropped,
    sent: stats.writes.sent, visible: stats.deliveries.visible, cpuPercent: (used.user + used.system) / ((now - wall) * 10),
    rssMB: process.memoryUsage().rss / 1048576, eventLoopP95Ms: delay.percentile(95) / 1e6 });
  wall = now; delay.reset();
}, 5000);

const ramp = Date.now();
await Promise.all(clients.map(async (client, i) => {
  const wait = ramp + i / clients.length * o.ramp * 1000 - Date.now();
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  await client.start();
}));
say({ type: 'ready', shard: o.shard, joined: stats.joined, failed: stats.failed, errors: stats.errors });
while (!existsSync(o.control)) await new Promise(r => setTimeout(r, 200));
({ start } = JSON.parse(readFileSync(o.control, 'utf8')));
measureFrom = start + o.warmup * 1000; end = measureFrom + o.duration * 1000;
// Each client posts every `interval` seconds, phased by its global index.
for (const c of clients) c.next = start + c.user.index / o.population * o.interval * 1000;
const tick = setInterval(() => {
  const now = Date.now();
  for (const c of clients) while (c.next <= now && c.next < end) {
    const due = c.next; c.next += o.interval * 1000;
    const record = due >= measureFrom;
    if (record) stats.writes.scheduled++;
    if (c.post(due)) { if (record) stats.writes.sent++; } else if (record) stats.writes.failed++;
  }
}, 10);
await new Promise(r => setTimeout(r, Math.max(0, end - Date.now()) + o.drain * 1000));
stopping = true; clearInterval(tick); clearInterval(telemetry);
say({ type: 'result', shard: o.shard, stats });
for (const c of clients) { c.socket?.destroy(); }
process.exit(0);
