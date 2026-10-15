import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mergeHistogram, histogram } from './benchmark-metrics.mjs';

// Merge disjoint client populations, preserving histogram maxima and buckets.
export function mergeStats(rows) {
  const result = {};
  for (const row of rows) for (const [key, value] of Object.entries(row)) {
    if (value && typeof value === 'object') {
      if ('buckets' in value) result[key] = mergeHistogram(result[key] ?? histogram(), value);
      else result[key] = mergeStats([result[key] ?? {}, value]);
    } else if (typeof value === 'number') result[key] = (result[key] ?? 0) + value;
  }
  return result;
}

if (process.send) process.once('message', ({ origin, users, options, worker }) => {
  const count = Math.max(1, Math.min(options.webWorkers, users.length));
  const children = [], latest = new Map(), ready = new Map(), results = new Map();
  let stopping = false, finished = false;
  const send = message => { if (process.connected) process.send(message); };
  const fail = () => { for (const child of children) child.kill(); process.exit(1); };
  for (let shard = 0; shard < count; shard++) {
    const child = fork(fileURLToPath(new URL('./benchmark-worker.mjs', import.meta.url)), [],
      { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    children.push(child);
    child.on('error', fail);
    child.on('exit', code => { if (!stopping || code) fail(); });
    child.on('message', message => {
      if (message.type === 'ready') {
        ready.set(shard, message);
        if (ready.size === count) send({ type: 'ready', ...mergeStats([...ready.values()].map(({type,worker,...stats})=>stats)) });
      }
      if (message.type === 'telemetry') {
        latest.set(shard, message);
        if (latest.size !== count) return;
        const rows = [...latest.values()];
        const merged = mergeStats(rows.map(({ type, time, worker, ...stats }) => stats));
        send({ ...merged, type: 'telemetry', worker, time: Math.min(...rows.map(s => s.time)),
          oldestRefreshMs: Math.max(...rows.map(s => s.oldestRefreshMs)),
          eventLoopP95Ms: Math.max(...rows.map(s => s.eventLoopP95Ms)),
          shards: rows.map(s => ({ shard: s.worker, rssMB: s.rssMB, cpuPercent: s.cpuPercent, eventLoopP95Ms: s.eventLoopP95Ms })) });
      }
      if (message.type === 'result') {
        results.set(shard, message.stats);
        if (results.size === count) {
          finished = true;
          process.send({ type: 'result', worker, stats: mergeStats([...results.values()]) }, () => process.disconnect());
        }
      }
    });
    child.send({ origin, users: users.filter((_, i) => i % count === shard), worker: shard,
      options: { ...options, scheduleMembers: users.length } });
  }
  process.on('message', message => {
    if (message.type === 'stop') { if (stopping) return; stopping = true; }
    for (const child of children) if (child.connected) child.send(message);
  });
  process.on('disconnect', () => {
    if (!finished) for (const child of children) child.kill();
  });
  process.once('SIGTERM', () => { for (const child of children) child.kill(); process.exit(143); });
});
