import tls from 'node:tls';
import { client, xml } from '@xmpp/client';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { histogram, observe } from './benchmark-metrics.mjs';

process.once('message', async ({ users, instance, domain, port, ca, options }) => {
  tls.setDefaultCACertificates([...tls.getCACertificates(), ca]);
  const delay = monitorEventLoopDelay({ resolution: 20 }); delay.enable();
  const stats = { online: 0, joined: 0, mam: 0, connectFailed: 0, disconnected: 0, stanzaErrors: 0, errors: [],
    writes: { scheduled: 0, scheduledByRoom: {}, socketWritten: 0, failed: 0, selfEcho: 0, latency: histogram() },
    deliveries: { visible: 0, duplicate: 0, latency: histogram() } };
  let stopping = false, start = Infinity, end = Infinity;
  const natives = [], waits = [];
  function create(user) {
    const xmpp = client({ service: `xmpp://127.0.0.1:${port}`, domain, resource: 'benchmark',
      username: user.credential.jid.split('@')[0], password: user.credential.password });
    xmpp.reconnect.stop();
    let online = false, joined = false, joinResolve;
    const seen = new Set();
    const join = new Promise(resolve => { joinResolve = resolve; });
    const native = { user, xmpp, nextWrite: Infinity, joined: () => joined };
    natives.push(native);
    xmpp.on('online', () => { if (!online) { online = true; stats.online++; } });
    xmpp.on('status', status => {
      if (online && status !== 'online') {
        online = false; stats.online--; if (joined) { joined = false; stats.joined--; }
        if (!stopping) stats.disconnected++;
      }
    });
    const recordError = value => { if (stats.errors.length < 12) stats.errors.push(String(value).slice(0, 300)); };
    xmpp.on('error', error => recordError(error.condition || error.message || error));
    xmpp.on('stanza', stanza => {
      if (stanza.attrs.type === 'error') {
        stats.stanzaErrors++; recordError(stanza.getChild('error')?.toString() || 'stanza error');
        if (!joined) joinResolve(false);
      }
      if (stanza.is('presence') && stanza.attrs.from?.split('/')[0] === user.roomJid && !stanza.attrs.type) {
        const x = stanza.getChild('x', 'http://jabber.org/protocol/muc#user');
        if (x?.getChildren('status').some(s => s.attrs.code === '110') && !joined) {
          joined = true; stats.joined++; joinResolve(true);
        }
      }
      const body = stanza.getChildText('body');
      if (!body?.startsWith(`BENCH|${options.tag}|`)) return;
      const parts = body.split('|'), due = Number(parts[5]);
      if (!(due >= start && due < end)) return;
      const key = parts.slice(0, 6).join('|');
      if (seen.has(key)) { stats.deliveries.duplicate++; return; }
      seen.add(key); if (seen.size > 1000) seen.delete(seen.values().next().value);
      stats.deliveries.visible++; observe(stats.deliveries.latency, Date.now() - due);
      if (Number(parts[3]) === instance && Number(parts[4]) === user.index) {
        stats.writes.selfEcho++; observe(stats.writes.latency, Date.now() - due);
      }
    });
    return (async () => {
      try {
        await Promise.race([xmpp.start(), new Promise((_, reject) => setTimeout(() => reject(new Error('connect timeout')), options.timeout * 1000))]);
        await xmpp.send(xml('presence'));
        await xmpp.send(xml('presence', { to: `${user.roomJid}/load-${instance}-${user.index}` },
          xml('x', { xmlns: 'http://jabber.org/protocol/muc' }, xml('history', { maxstanzas: '0' }))));
        const ok = await Promise.race([join, new Promise(resolve => setTimeout(() => resolve(false), options.timeout * 1000))]);
        if (!ok) throw new Error('room join failed');
        await xmpp.iqCaller.request(xml('iq', { type: 'set', to: user.roomJid },
          xml('query', { xmlns: 'urn:xmpp:mam:2', queryid: `bootstrap-${user.index}` },
            xml('set', { xmlns: 'http://jabber.org/protocol/rsm' }, xml('max', {}, '10'), xml('before')))));
        stats.mam++;
      } catch (error) { stats.connectFailed++; recordError(error.message); }
    })();
  }
  let cpu = process.cpuUsage(), wall = performance.now();
  const telemetry = setInterval(() => {
    const now = performance.now(), used = process.cpuUsage(cpu); cpu = process.cpuUsage();
    process.send?.({ type: 'telemetry', transport: 'xmpp', instance, time: Date.now(), online: stats.online,
      joined: stats.joined, mam: stats.mam, failures: stats.connectFailed + stats.disconnected,
      scheduled: stats.writes.scheduled, selfEcho: stats.writes.selfEcho, received: stats.deliveries.visible,
      rssMB: process.memoryUsage().rss / 1048576, cpuPercent: (used.user + used.system) / ((now - wall) * 10),
      eventLoopP95Ms: delay.percentile(95) / 1e6 });
    wall = now; delay.reset();
  }, 1000);
  const tick = setInterval(() => {
    if (stopping) return;
    const now = Date.now();
    for (const n of natives) while (n.nextWrite <= now && n.nextWrite < end) {
      const due = n.nextWrite; n.nextWrite += options.messageInterval * 1000;
      const record = due >= start && due < end;
      if (record) {
        stats.writes.scheduled++;
        stats.writes.scheduledByRoom[n.user.room] = (stats.writes.scheduledByRoom[n.user.room] || 0) + 1;
      }
      if (!n.joined() || n.xmpp.status !== 'online') { if (record) stats.writes.failed++; continue; }
      void n.xmpp.send(xml('message', { to: n.user.roomJid, type: 'groupchat', id: `b-${instance}-${n.user.index}-${due}` },
        xml('body', {}, `BENCH|${options.tag}|${n.user.room}|${instance}|${n.user.index}|${due}|native chat`)))
        .then(() => { if (record) stats.writes.socketWritten++; }, () => { if (record) stats.writes.failed++; });
    }
  }, 25);
  process.on('message', async message => {
    if (message.type === 'start') {
      start = message.at + options.warmup * 1000; end = start + options.duration * 1000;
      for (const n of natives) n.nextWrite = message.at +
        (n.user.index - (options.members - options.native)) / options.native * options.messageInterval * 1000;
    }
    if (message.type === 'stop') {
      stopping = true; clearInterval(tick); clearInterval(telemetry); delay.disable();
      // Exit after flushing metrics; simultaneous library stream-close handshakes can race parsing.
      process.send?.({ type: 'result', instance, transport: 'xmpp', stats }, () => process.exit(0));
    }
  });
  process.on('disconnect', () => process.exit(0));
  const ramp = Date.now();
  for (let i = 0; i < users.length; i++) {
    const wait = ramp + i / users.length * options.nativeRamp * 1000 - Date.now();
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
    waits.push(create(users[i]));
  }
  await Promise.all(waits);
  process.send?.({ type: 'ready', instance, transport: 'xmpp', stats });
});
