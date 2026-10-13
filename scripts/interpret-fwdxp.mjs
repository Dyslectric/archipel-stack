import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

if (!process.argv[2]) throw new Error('Provide an FWDXP report.json path.');
const path = resolve(process.argv[2]), report = JSON.parse(readFileSync(path, 'utf8'));
if (report.protocol !== 'FWDXP' || !report.instances) throw new Error('This is not a completed FWDXP chat report.');
const instances = report.instances.map(row => {
  const snapshot=report.options.postgres?JSON.parse(readFileSync(resolve(dirname(path),`snapshot-${row.instance}.json`),'utf8')):null;
  const db = snapshot?null:new DatabaseSync(resolve(dirname(path), `instance-${row.instance}.sqlite`), { readOnly: true });
  const relay = snapshot?snapshot.relay || []:db.prepare("SELECT d.activity_id,d.recipient,d.status FROM federation_deliveries d JOIN federation_outgoing o ON o.id=d.activity_id WHERE o.purpose='relay'").all();
  const grouped = new Set(), groupedSent = new Set();
  let sent = 0;
  for (const d of relay) {
    const key = `${d.activity_id}|${new URL(d.recipient).origin}`;
    grouped.add(key); if (d.status === 'sent') { sent++; groupedSent.add(key); }
  }
  const statuses = snapshot?snapshot.statuses || Object.values(snapshot.queues.reduce((by,r)=>{const s=by[r.status]??={status:r.status,count:0,attempts:0};s.count+=r.count;s.attempts+=r.attempts;return by;},{})):db.prepare('SELECT status,COUNT(*) AS count,SUM(attempts) AS attempts FROM federation_deliveries GROUP BY status').all();
  const errors = snapshot?snapshot.errors:db.prepare('SELECT error,COUNT(*) AS count FROM federation_deliveries WHERE error IS NOT NULL GROUP BY error').all();
  const distinctIncomingActivities = db?Number(db.prepare('SELECT COUNT(*) AS count FROM federation_incoming').get().count):null;
  db?.close();
  const finalPath = resolve(dirname(path), `final-${row.instance}.json`);
  const final = existsSync(finalPath) ? JSON.parse(readFileSync(finalPath, 'utf8')) : null;
  const allInbox = (final?.wire || row.endState.wire)['/federation/inbox'];
  const bootInbox = report.setup.bootstrap[row.instance].wire['/federation/inbox'];
  return { instance: row.instance, statuses, errors, streams: row.web.sse.activeAtStop,
    desiredChatPeerCapPerMinute: report.options.peerRate, workerRound: report.setup.chatSettings[row.instance].sending,
    chatInboxRequestsAfterSignedBootstrap: allInbox.requests - bootInbox.requests,
    allInboxStatusesIncludingBootstrap: allInbox?.statuses || {}, distinctIncomingActivitiesIncludingBootstrap: final?.distinctIncomingActivities ?? distinctIncomingActivities,
    physicalChatPostAttempts: final?.deliveryStats?.requests ?? null,
    chatRecipientAttempts: final?.deliveryStats?.recipientAttempts ?? null,
    relayDeliveryRows: snapshot && !snapshot.relay ? null : relay.length, distinctRelayActivityPeerPairs: snapshot && !snapshot.relay ? null : grouped.size,
    relayRowMultiplierPerActivityPeer: grouped.size ? relay.length / grouped.size : null,
    sentRelayDeliveryRows: snapshot && !snapshot.relay ? null : sent, distinctSentRelayActivityPeerPairs: snapshot && !snapshot.relay ? null : groupedSent.size,
    note: 'Per-follower audit rows are retained even when one physical POST covers a shared inbox. Use physicalChatPostAttempts and inbox counts to assess network traffic; row counts alone do not prove repeated POSTs. Final wire totals are used when recorded; older runs use pre-shutdown telemetry.' };
});
const sum = key => instances.reduce((n, row) => n + row[key], 0), t = report.totals;
const analysis = { report: path, protocol: 'FWDXP', targetMet: report.pass, instances,
  apiAcceptancePercent: 100 * t.webAccepted / t.scheduled,
  authorsObservedOwnCommittedPercent: 100 * t.authorsObservedOwnCommittedPost / t.scheduled,
  recipientObservationPercent: 100 * t.webObserved / t.webExpectedFromOfferedPosts,
  committedCopies: report.replication.map(r => ({ instance: r.instance, total: r.committedCopies,
    authoritative: r.authoritativeHomeCommits, foreign: r.foreignReplicaCopies, expectedTotal: t.scheduled })),
  totalQueued: instances.reduce((n, r) => n + (r.statuses.find(s => s.status === 'pending')?.count || 0), 0),
  totalSentRelayDeliveryRows: sum('sentRelayDeliveryRows'),
  totalDistinctSentRelayActivityPeerPairs: sum('distinctSentRelayActivityPeerPairs'),
  conclusion: 'Assess replica commits and recipient observations separately from queued API acceptance. Low observed latency can describe only local/early deliveries when most remote messages remain queued.' };
writeFileSync(resolve(dirname(path), 'interpretation.json'), JSON.stringify(analysis, null, 2) + '\n');
console.log(JSON.stringify(analysis, null, 2));
