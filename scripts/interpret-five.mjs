import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { deliveryCoverage } from './benchmark-topology.mjs';
import { DatabaseSync } from 'node:sqlite';

const path = resolve(process.argv[2] || '');
if (!process.argv[2]) throw new Error('Provide a multi-instance report.json path.');
const report = JSON.parse(readFileSync(path, 'utf8'));
if (!report.instances) throw new Error('This run did not reach the chat phase; inspect bootstrap state.');
const sum = fn => report.instances.reduce((total, row) => total + fn(row), 0);
const instances = report.instances.map(row => {
  const snapshot = resolve(dirname(path), `instance-${row.instance}.sqlite`);
  let originRows = null, pending = null;
  if (existsSync(snapshot)) {
    const db = new DatabaseSync(snapshot, { readOnly: true });
    originRows = db.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN body LIKE '%|native chat' THEN 1 ELSE 0 END) AS native, SUM(CASE WHEN body LIKE '%|web chat' THEN 1 ELSE 0 END) AS web FROM messages WHERE body LIKE ?").get(`BENCH|${report.options.tag}|%`);
    pending = db.prepare("SELECT status,COUNT(*) AS count FROM xmpp_remote_messages GROUP BY status").all();
    db.close();
  }
  return { instance: row.instance, webAccepted: row.web.writes.successful,
    nativeOnlineAtEnd: row.native.online, nativeDisconnects: row.native.disconnected,
    webOnlineAtEnd: row.web.sse.activeAtStop, webObserved: row.web.deliveries.visible,
    refreshPending: row.web.refresh.pendingAtStop, queuedBridgePosts: row.endState.queuedBridgePosts,
    projectionBacklog: row.endState.projectionBacklog, joinedBridgeResources: row.endState.joinedVirtualRooms,
    desiredBridgeResources: row.endState.virtualRooms, storedBenchmarkMessagesIncludingWarmup: originRows,
    bridgeMessageStatuses: pending };
});
const coverage = report.totals.deliveryCoverage || deliveryCoverage(report.options, report.instances);
const nativeExpected = coverage.nativeExpectedFromOfferedPosts;
const webExpected = coverage.webExpectedFromOfferedPosts;
const nativeObserved = sum(row => row.native.deliveries.visible), webObserved = sum(row => row.web.deliveries.visible);
const analysis = { report: path, classification: report.classification,
  completeChatTargetMet: report.pass, instances,
  webPostSuccessPercent: sum(row => row.web.writes.successful) / sum(row => row.web.writes.scheduled) * 100,
  webObserved, nativeObserved, webExpectedFromOfferedPosts: webExpected, nativeExpectedFromOfferedPosts: nativeExpected,
  webObservationPercentOfOfferedDeliveries: webObserved / webExpected * 100,
  nativeObservationPercentOfOfferedDeliveries: nativeObserved / nativeExpected * 100,
  observationCaveats: `Counts are per-message/per-client observations of the measured marker cohort, including a ${report.options.timeout}-second observation drain. Expected counts use per-room offered posts and assigned receivers when recorded; historical reports assume even membership. Missing observations can reflect absent writes, failed forwarding, disconnections or refresh backlog.`,
  snapshotsAvailable: instances.every(row => row.storedBenchmarkMessagesIncludingWarmup !== null),
  schedule: report.options.schedule || 'Not recorded in this harness revision; consult docs/scale-review.md for the schedule actually used.',
  schedulingCaveat: 'Protocol phasing differs between historical harness revisions. Do not interpret an older run as using the updated uniform mixed schedule.' };
writeFileSync(resolve(dirname(path), 'interpretation.json'), JSON.stringify(analysis, null, 2) + '\n');
console.log(JSON.stringify({ ...analysis, instances: instances.map(({ storedBenchmarkMessagesIncludingWarmup, bridgeMessageStatuses, ...row }) => row) }, null, 2));
