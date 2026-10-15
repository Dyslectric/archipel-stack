// Summarizes parity reports as a Markdown table: node scripts/interpret-parity.mjs <report dir>...
import { readFileSync } from 'node:fs';
import { resolve, basename } from 'node:path';

const rows = process.argv.slice(2).map(dir => {
  const r = JSON.parse(readFileSync(resolve(dir, 'report.json'), 'utf8')), o = r.options, x = r.result;
  if (!x) return `| ${basename(dir)} | ${o.target} | ${o.clients} / ${o.rooms} | failed: ${String(r.error).split('\n')[0]} |||||||`;
  const ms = v => v == null ? '—' : Math.round(v).toLocaleString('en-US');
  return `| ${basename(dir)} | ${o.target} | ${o.clients.toLocaleString('en-US')} / ${o.rooms} | ${(o.clients / o.interval).toFixed(0)} | ` +
    `${x.joined.toLocaleString('en-US')} in ${Math.round(r.phases.joinSeconds)} s | ${(100 * x.completeness).toFixed(2)}% | ` +
    `${ms(x.visibility.p50Ms)} / ${ms(x.visibility.p95Ms)} | ${r.measured.cores.toFixed(2)} | ${Math.round(r.measured.peakMemoryMiB)} | ` +
    `${r.idle.cores.toFixed(2)} / ${Math.round(r.idle.memoryMiB)} |`;
});
console.log('| Report | Server | Clients / rooms | Posts/s | Joined | Delivered | Visibility p50 / p95 ms | Cores | Peak MiB | Idle cores / MiB |');
console.log('|---|---|---:|---:|---:|---:|---:|---:|---:|---:|');
for (const row of rows) console.log(row);
