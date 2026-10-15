import http from 'node:http';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { histogram, observe } from './benchmark-metrics.mjs';

process.once('message', async ({ origin, users, options, worker }) => {
  const agent = new http.Agent({ keepAlive: true, maxSockets: options.inflight * 3 });
  const streams = new http.Agent({ keepAlive: true, maxSockets: Infinity });
  const sockets = new Set();
  const delay = monitorEventLoopDelay({ resolution: 20 }); delay.enable();
  let running = false, stopping = false, start = Infinity, end = Infinity;
  let drainDeadline = Infinity;
  let activeWrites = 0, activeReads = 0, cursor = 0;
  const stats = { requests: {}, writes: { scheduled: 0, scheduledByRoom: {}, dropped: 0, successful: 0, failed: 0, users: 0,
    latency: histogram() }, refresh: { started: 0, completed: 0, failed: 0, incrementalPages:0, fullPages:0, latency: histogram() },
    sse: { opened: 0, active: 0, failures: 0, notices: 0, bytes: 0, deltaMessages:0 },
    deliveries: { visible: 0, selfObserved: 0, latency: histogram() }, bootstrapped: 0, bytes: 0,
    bootstrap: {refreshAttempts:0,failedRefreshes:0,requests:{},streamAttempts:0,streamFailures:0,streamStatuses:{}} };
  const posted = new Set();
  // Share the bounded cohort keys between clients on this shard. Counting still
  // remains per client; this avoids retaining millions of identical strings.
  const deliveryKeys=new Map();
  const cohortKey=parts=>{const key=parts.slice(0,6).join('|');let shared=deliveryKeys.get(key);if(shared===undefined){if(deliveryKeys.size>=2048)deliveryKeys.delete(deliveryKeys.keys().next().value);shared=key;deliveryKeys.set(key,shared);}return shared;};
  const pageModes={incremental:0,full:0};
  const measured = at => at >= start && at < end;
  const clients = users.map(user => ({ ...user, connected: false, dirty: 0, full: false,
    current: false, metadata: false, busy: false, lastRefresh: 0, nextWrite: Infinity, booted: false, seen: new Set() }));
  function request(user, path, method = 'GET', body, epoch = Date.now()) {
    return new Promise(resolve => {
      const begun = performance.now(), record = measured(epoch),boot = !user.booted && start===Infinity;
      const key = `${method} ${new URL(path,origin).pathname.replace(/\/channels\/[^/]+/g, '/channels/:id')}`;
      const data = body === undefined ? undefined : JSON.stringify(body);
      let done = false, timer;
      const finish = (status, bytes, parsed, error) => {
        if (done) return; done = true; clearTimeout(timer);
        if(boot) {
          const item=stats.bootstrap.requests[key]??={count:0,errors:0,statuses:{}};
          item.count++;item.statuses[status]=(item.statuses[status]||0)+1;
          if(!(status>=200 && status<300 && !error))item.errors++;
        }
        if (record) {
          const item = stats.requests[key] ??= { count: 0, success: 0, errors: 0, statuses: {}, latency: histogram() };
          item.count++; item.statuses[status] = (item.statuses[status] || 0) + 1;
          if (status >= 200 && status < 300 && !error) item.success++; else item.errors++;
          observe(item.latency, performance.now() - begun); stats.bytes += bytes;
        }
        resolve({ ok: status >= 200 && status < 300 && !error, data: parsed });
      };
      const req = http.request(new URL(path, origin), { agent, method, headers: {
        Cookie: `archipel=${user.token}`, Origin: origin, 'X-CSRF-Token': user.csrf,
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
      } }, res => {
        let bytes = 0; const chunks = [];
        res.on('data', chunk => { bytes += chunk.length; chunks.push(chunk); });
        res.on('end', () => {
          try { finish(res.statusCode, bytes, JSON.parse(Buffer.concat(chunks).toString())); }
          catch { finish(res.statusCode, bytes, null, true); }
        });
        res.on('error', () => finish('response-error', bytes, null, true));
        res.on('aborted', () => finish('aborted', bytes, null, true));
      });
      // Wall-clock deadline includes waiting in the HTTP agent's queue.
      timer = setTimeout(() => { finish('timeout', 0, null, true); req.destroy(); },
        Math.max(1, Math.min(options.timeout * 1000, drainDeadline - Date.now())));
      req.on('error', error => finish(error.code || 'network-error', 0, null, true));
      req.end(data);
    });
  }
  function markDirty(user, notice) {
    if (!notice.all && !notice.me && !notice.channels && !notice.read && !notice.rooms && !notice.sending) return;
    user.dirty ||= Date.now();
    user.full ||= !!(notice.all || notice.me);
    user.current ||= !!(notice.all || notice.me || notice.rooms || notice.sending || notice.channels?.includes(user.channel));
    user.metadata ||= !!(notice.all || notice.me || notice.rooms || (notice.channels?.includes(user.channel) && !notice.content));
  }
  function connect(user) {
    stats.bootstrap.streamAttempts++;
    let attemptFailures=0;
    const failed=status=>{attemptFailures++;stats.sse.failures++;stats.bootstrap.streamFailures++;
      stats.bootstrap.streamStatuses[status]=(stats.bootstrap.streamStatuses[status]||0)+1;};
    return new Promise(resolve => {
      let settled = false, timer;
      const finish = () => { if (!settled) { settled = true; clearTimeout(timer); resolve(attemptFailures); } };
      const req = http.get(new URL(`/api/events?deltas=1&watch=${encodeURIComponent(user.channel)}`, origin), { agent: streams,
        headers: { Cookie: `archipel=${user.token}` } }, res => {
        if (res.statusCode !== 200) { failed(res.statusCode); res.resume(); finish(); return; }
        user.connected = true; stats.sse.opened++; stats.sse.active++;
        let pending = '';
        res.setEncoding('utf8');
        res.on('data', chunk => {
          if (measured(Date.now())) stats.sse.bytes += Buffer.byteLength(chunk);
          pending += chunk;
          let at;
          while ((at = pending.indexOf('\n\n')) >= 0) {
            const event = pending.slice(0, at); pending = pending.slice(at + 2);
            if (!event.startsWith('data: ')) continue;
            try { const notice = JSON.parse(event.slice(6));
              if (measured(Date.now())) stats.sse.notices++;
              if(notice.delta?.channel===user.channel && Array.isArray(notice.delta.messages)) {
                const page=notice.delta;
                for(const message of page.messages) {
                  if(measured(Date.now()))stats.sse.deltaMessages++;
                  if(!message.body?.startsWith(`BENCH|${options.tag}|`))continue;
                  const parts=message.body.split('|'),due=Number(parts[5]),key=cohortKey(parts);
                  if(!(due>=start && due<end) || user.seen.has(key))continue;
                  user.seen.add(key);if(user.seen.size>1000)user.seen.delete(user.seen.values().next().value);
                  stats.deliveries.visible++;observe(stats.deliveries.latency,Date.now()-due);
                  if(Number(parts[3])===user.instance && Number(parts[4])===user.index)stats.deliveries.selfObserved++;
                }
              }
              markDirty(user, notice);
            } catch { stats.sse.failures++; }
          }
        });
        const closed = () => {
          if (user.connected) { user.connected = false; stats.sse.active--; if (!stopping) stats.sse.failures++; }
        };
        res.on('close', closed); res.on('error', closed);
        finish();
      });
      sockets.add(req);
      timer = setTimeout(() => { failed('timeout'); req.destroy(); finish(); }, options.timeout * 1000);
      req.on('error', error => { if (!settled && !stopping) failed(error.code || 'network-error'); finish(); });
    });
  }
  async function initialConnect(user) {
    let failures=0;
    for(let attempt=0;attempt<=(options.connectRetries||0) && !stopping;attempt++) {
      failures+=await connect(user);
      if(user.connected) {stats.sse.recoveredSetupFailures=(stats.sse.recoveredSetupFailures||0)+failures;return;}
      if(attempt<(options.connectRetries||0))await new Promise(done=>setTimeout(done,2000));
    }
  }
  async function refresh(user) {
    const epoch = Date.now(), record = measured(epoch), dirtyAt = Math.max(user.dirty, start);
    const full = user.full, current = user.current, metadata = user.metadata;
    user.dirty = 0; user.full = false; user.current = false; user.metadata = false; user.busy = true;
    user.lastRefresh = epoch; activeReads++;
    if (record) stats.refresh.started++;
    let ok = true;
    const get = async path => { const result = await request(user, path, 'GET', undefined, epoch); ok &&= result.ok; return result; };
    try {
      if (full) { await get('/api/session'); await get('/api/emojis'); await get('/api/channels'); }
      await get('/api/overview');
      if (current) {
        const suffix=!metadata && user.refreshCursor!==undefined && user.refreshStamp
          ? `?after=${user.refreshCursor}&stamp=${encodeURIComponent(user.refreshStamp)}` : '';
        const [, page] = await Promise.all([metadata ? get(`/api/channels/${user.channel}?members=0`) : Promise.resolve(null), get(`/api/channels/${user.channel}/messages${suffix}`)]);
        if(page.ok){user.refreshCursor=page.data?.refresh_cursor;user.refreshStamp=page.data?.refresh_stamp;
          if(page.data?.incremental===true)pageModes.incremental++;else pageModes.full++;
          if(record){if(page.data?.incremental===true)stats.refresh.incrementalPages++;else stats.refresh.fullPages++;}}
        if (options.tag) for (const message of page.data?.messages || []) {
          if (!message.body?.startsWith(`BENCH|${options.tag}|`)) continue;
          const parts = message.body.split('|'), due = Number(parts[5]), key = cohortKey(parts);
          if (!(due >= start && due < end) || user.seen.has(key)) continue;
          user.seen.add(key); if (user.seen.size > 1000) user.seen.delete(user.seen.values().next().value);
          stats.deliveries.visible++; observe(stats.deliveries.latency, Date.now() - due);
          if (Number(parts[3]) === user.instance && Number(parts[4]) === user.index) stats.deliveries.selfObserved++;
        }
      }
    } finally {
      if (record) { if (ok) stats.refresh.completed++; else stats.refresh.failed++;
        observe(stats.refresh.latency, Date.now() - dirtyAt); }
      user.busy = false; activeReads--;
      if(full && !user.booted) {
        stats.bootstrap.refreshAttempts++;
        if(ok) { user.booted=true;stats.bootstrapped++; }
        else {
          stats.bootstrap.failedRefreshes++;
          // A failed initial refresh must stay eligible for the bounded
          // round-robin queue, even when there will be no new SSE notice.
          markDirty(user,{all:true});
        }
      }
    }
  }
  function write(user, due) {
    const record = measured(due);
    if (record) {
      stats.writes.scheduled++;
      stats.writes.scheduledByRoom[user.room] = (stats.writes.scheduledByRoom[user.room] || 0) + 1;
    }
    if (activeWrites >= options.inflight) { if (record) stats.writes.dropped++; return; }
    activeWrites++;
    void request(user, `/api/channels/${user.channel}/messages`, 'POST',
      { body: options.tag ? `BENCH|${options.tag}|${user.room}|${user.instance}|${user.index}|${due}|web chat`
        : `Benchmark user ${user.index} at ${due}: ${'chat '.repeat(30)}` }, due).then(result => {
      if (record) {
        if (result.ok) { stats.writes.successful++; posted.add(user.index); }
        else stats.writes.failed++;
        observe(stats.writes.latency, Date.now() - due);
      }
    }).finally(() => activeWrites--);
  }
  const tick = setInterval(() => {
    if (!running || stopping) return;
    const now = Date.now();
    for (const user of clients) {
      while (user.nextWrite <= now && user.nextWrite < end) {
        const due = user.nextWrite; user.nextWrite += options.messageInterval * 1000; write(user, due);
      }
    }
    // Mixed-client runs keep observing the measured cohort during the delivery drain.
    if (now >= end + (options.tag ? options.timeout * 1000 : 0)) return;
    // Round-robin admits bounded refresh tasks; pending notification age exposes generator backpressure.
    for (let n = 0; n < clients.length && activeReads < options.inflight; n++) {
      const user = clients[cursor++ % clients.length];
      if (user.dirty && !user.busy && now >= user.lastRefresh + 1500) void refresh(user);
    }
  }, 25);
  let cpu = process.cpuUsage(), wall = performance.now();
  const telemetry = setInterval(() => {
    const now = performance.now(), used = process.cpuUsage(cpu); cpu = process.cpuUsage();
    const dirty = clients.filter(user => user.dirty);
    process.send?.({ type: 'telemetry', worker, time: Date.now(), connected: stats.sse.active,
      successful: stats.writes.successful, failed: stats.writes.failed, dropped: stats.writes.dropped,
      pendingRefresh: dirty.length, oldestRefreshMs: dirty.length ? Math.max(...dirty.map(user => Date.now() - user.dirty)) : 0,
      activeReads, activeWrites, bootstrapped: stats.bootstrapped, bootstrap:stats.bootstrap, received: stats.deliveries.visible,
      pageModes,
      rssMB: process.memoryUsage().rss / 1048576,
      cpuPercent: (used.user + used.system) / ((now - wall) * 10), eventLoopP95Ms: delay.percentile(95) / 1e6 });
    wall = now; delay.reset();
  }, 1000);
  process.on('message', async message => {
    if (message.type === 'bootstrap') {
      running = true;
      clients.forEach((user, i) => setTimeout(() => markDirty(user, { all: true }), i / clients.length * options.bootRamp * 1000));
    }
    if (message.type === 'start') {
      start = message.at + options.warmup * 1000; end = start + options.duration * 1000;
      for (const user of clients) {
        user.nextWrite = message.at + user.index / (options.tag ? (options.scheduleMembers ?? clients.length) : options.users) * options.messageInterval * 1000;
        // Stagger initial boot across warmup instead of an artificial simultaneous login storm.
        if (!options.writeOnly && !user.booted) setTimeout(() => markDirty(user, { all: true }), Math.max(0, message.at - Date.now()) +
          user.index / options.users * options.warmup * 1000);
      }
      running = true;
    }
    if (message.type === 'stop') {
      stopping = true; clearInterval(tick); clearInterval(telemetry); delay.disable();
      drainDeadline = Date.now() + options.timeout * 1000;
      stats.sse.activeAtStop = stats.sse.active;
      for (const req of sockets) req.destroy();
      const deadline = Date.now() + options.timeout * 1000 + 1000;
      while ((activeReads || activeWrites) && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
      stats.writes.users = posted.size;
      stats.refresh.pendingAtStop = clients.filter(user => user.dirty).length;
      agent.destroy(); streams.destroy();
      if(process.send && process.connected) process.send({type:'result',worker,stats},()=>process.disconnect());
      else process.exit(0);
    }
  });
  process.on('disconnect', () => process.exit(0));
  // Ramp socket creation in small batches, without tying ramp speed to response throughput.
  const rampStart = Date.now(), pending = new Set();
  for (let i = 0; i < clients.length; i++) {
    if(options.writeOnly)break;
    const wait = rampStart + i / clients.length * options.ramp * 1000 - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    const promise = initialConnect(clients[i]); pending.add(promise); promise.finally(() => pending.delete(promise));
  }
  await Promise.all(pending);
  process.send?.({ type: 'ready', worker, connected: stats.sse.active,
    failures: stats.sse.failures-(stats.sse.recoveredSetupFailures||0),
    connectionAttempts:stats.bootstrap.streamAttempts,connectionFailures:stats.bootstrap.streamFailures,
    connectionStatuses:stats.bootstrap.streamStatuses });
});
