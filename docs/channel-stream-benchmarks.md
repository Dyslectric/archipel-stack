# Channel event transport implementation and measurements

The initial channel transport appends one immutable event to an ordered channel log.
Negotiated followers retain individual admission records but do not create
per-event delivery rows. Each receiving instance consumes one channel stream or
batch feed and stores one durable cursor. Existing followers without negotiation,
DMs, remote submissions, membership decisions and individual roles retain inbox
delivery. SQLite and native PostgreSQL implementations share migration 30.

The subsequent constant-work redesign uses schema 31 and one multiplexed feed
per origin, including encrypted private channels with rotating key epochs.
Receivers stage raw frames before independent channel materialization. Browser
connections use maintained routes and shared message deltas; chat metadata omits
the full roster and live read acknowledgements are coalesced. Legacy peers retain
their compatible transports. The implementation and validation details are in
[constant-work-implementation.md](constant-work-implementation.md) and the
[instance feed protocol](fwdxp.md#multiplexed-instance-feed-extension).

Imports and cursors commit together. Reconnects resume from committed cursors;
activity IDs/digests and author proofs remain checked. Sending policy can yield
a null event; locally blocked/inactive authors are discarded with conflict
detection while later authors continue. Revoking channel access stops the feed.
Retention is seven days or 100,000 events; one publication record per author
remains so older note proofs can still resolve the author's key after grants are
revoked. An expired cursor produces HTTP 410
and requires leaving/rejoining for bounded current history, not silent advancement.

Channel admissions share history/roster bootstrap only for the same admission
boundary. A copy behind a new boundary refreshes its snapshot. Scheduling selects
one eligible follower per channel in SQL. Idle streams share batched admission
and log-tail checks, rather than querying every follower independently.

## Workload and interpretation

All runs use real signatures, origin proofs, Follow/Accept admission, current
permissions, durable storage, API posting and web protocol clients. Native runs
use PostgreSQL 17 and four native workers/four connections per process per
instance. The initial high-population measurements offer five to 5.67 posts/second,
with 30 seconds of warmup and 60 seconds of measured chat, after complete signed
admission/history and initial web reads. Sending uses 100 deliveries/round,
100 ms intervals, concurrency 32, no peer POST cap and 10,000 inbox requests/minute.

These are single-workstation loopback measurements. They exclude WAN/TLS/proxy
cost and actual browser rendering. They are not VPS sizing results or a statistical
A/B study. Source hashes, image identity, workload settings, raw metrics, SQL
statistics, cursor snapshots and transport counters are saved with each report.
Counters can include warmup/drain; percentile samples exclude missing observations.

| Population / topology | Transport | API accepted / offered | Committed on every instance | Client observations | Posting p95 | Visibility p95 | Target |
|---|---|---:|---:|---:|---:|---:|---|
| 2,000 users, ten instances, one home channel (ten-minute run) | Stream | 1,500 / 1,500 | 1,500 on nine instances; 1,181 on instance 5 | 97.87% | 625.6 ms | 5,910.5 ms | Not met |
| 3,400 users, eight instances, one home channel | Stream | 337 / 340 | 337 / 337 accepted | 70.79% | 1,124.3 ms | 20,017.3 ms | Not met |
| 3,000 users, three instances, 99 channels | Stream (final validation) | 300 / 300 | 300 / 300 | 100% | 56.4 ms | 1,744.7 ms | Met |
| 3,000 users, three instances, 99 channels | Batch | 300 / 300 | 300 / 300 | 100% | 347.9 ms | 2,842.5 ms | Met |

Reports:

- [2,000 users / ten instances](../test-results/fwdxp/2026-10-14T12-50-29-960Z/report.md), with [verified interpretation](../test-results/fwdxp/2026-10-14T12-50-29-960Z/interpretation.json)
- [Single-channel streaming](../test-results/fwdxp/2026-10-14T01-05-43-987Z/report.md)
- [Final 99-channel streaming](../test-results/fwdxp/2026-10-14T01-39-58-388Z/report.md)
- [First 99-channel streaming](../test-results/fwdxp/2026-10-14T01-15-05-825Z/report.md)
- [99-channel batch reads](../test-results/fwdxp/2026-10-14T01-24-34-946Z/report.md)

The initial high-population snapshots have zero legacy broadcast delivery rows and zero
unresolved cursor errors. The single-channel home's log tail and all seven peer
cursors are 607: 100 seed events, 170 warmup events and 337 measured events. That
run has no channel transport retries. All accepted writes replicated, but three
home posting requests failed and client observation coverage/latency missed the
target. This identifies a remaining gap between committed channel data and web
observations; it does not isolate the exact web/server bottleneck.

The first 99-channel streaming run recovered 121 request aborts across its three
receivers, with no lost observations or unresolved errors. Batch reads had no
transport retries but substantially more empty reads. Stream sockets now rely on
the bounded request/lease timeout rather than a five-second agent idle timeout;
a valid empty page also clears a recovered network error on a quiet channel.
The final streaming run passed again with 44 recovered request aborts, zero
unresolved errors and full observation coverage. The exact abort cause has not
been isolated; automatic reconnect/replay remained effective.

An earlier 3,400-user attempt timed out during individual admission before chat
measurement. It exposed repeated per-follower scheduler checks and repeated
history/roster work; the subsequent completed runs use channel-level scheduling
and shared bootstrap. The failed setup is preserved in
[its report](../test-results/fwdxp/2026-10-14T00-50-21-867Z/report.md).

## Ten instances, 2,000 readers, 150 posts per minute

The October 14 follow-up uses one channel on instance 1, with 200 web protocol
users on each of ten instances. The per-user message interval is 800 seconds:
2,000 / 800 = 2.5 posts/second, or 150/minute globally. All 1,800 remote
Follow/Accept admissions, 100 native-produced seed messages on every replica
and 2,000 initial web reads completed before two minutes of warmup and ten
minutes of measured chat. Four native workers and four connections per process
retain the recent streaming profile; PostgreSQL has 512 MiB shared buffers and
a 240-connection fixture limit. The same explicit chat pacing applies.

All 1,500 measured posts were API-accepted, without HTTP posting errors or
generator drops. All 2,000 streams remained connected. Nine instances committed
all 1,500 messages and completed all their expected recipient observations.
Instance 5 committed 1,181 and completed 236,200 of its 300,000 observations.
Overall coverage is 2,936,200 / 3,000,000 (97.87%); 1,468 / 1,500 author
self-observations completed. Posting p95 is 625.6 ms, visibility p50 2.98 seconds,
p95 5.91 seconds and p99 7.54 seconds. Every unaffected instance also exceeded
the three-second visibility target, so the recovery failure does not explain
the latency miss by itself. Missing observations have no latency sample.

Around eight minutes into measured chat, instance 5 recorded
`The database connection stopped.` from the synchronous PostgreSQL worker
handoff. Subsequent queue/cursor telemetry was inconsistent, and its normal
shutdown snapshot was missing. A separate read-only PostgreSQL snapshot, taken
after measured chat before cleanup, verifies cursor 1,581 (100 seed + 300 warmup
+ 1,181 measured events), the retained error and zero pending delivery rows.
The 319 missing messages account exactly for its 63,800 missing observations.
The error's precise cause remains unverified. No application code changed during
the run; the original report retains its missing-snapshot and failed checks.
The supplemental [snapshot](../test-results/fwdxp/2026-10-14T12-50-29-960Z/direct-postgres-snapshot-4.json)
and interpretation preserve the independent evidence.

Sixty ten-second samples cover the measured interval. The entire run-owned
container stack peaked at 5.35 GiB memory and 2,620.71% Docker CPU (26.2 logical
cores worth); average sampled CPU was 2,218.61% (22.2 cores worth). Host generators
used another 1.26 GiB peak RSS, with worst sampled event-loop p95 35.1 ms.
These totals cover all ten front ends, native processes, shared PostgreSQL and
forwarding container, exclude generator CPU and unrelated services, and do not
establish capacity on ten separate modest servers. All run-owned containers
were removed afterward.

Reproduce with:

```sh
node scripts/benchmark-fwdxp.mjs --instances 10 --members 200 --rooms 1 --room-host 0 \
  --postgres 1 --native-chat 1 --native-workers 4 --native-pool 4 --channel-transport stream \
  --history 100 --native-history 1 --bootstrap-timeout 900 \
  --message-interval 800 --warmup 120 --duration 600 \
  --peer-rate 0 --inbox-rate 10000 --batch 100 --interval 100 --concurrency 32 --postgres-buffers 512
```

## One instance with 10,000 web clients and twelve listening peers

The October 14 evening run (October 15 UTC) is **TARGET NOT MET**. Twelve real
peer instances each use one admission identity and consume the channel feed,
with no remote web clients or posting. All 100 seed messages reached every peer.
The home has 10,000 web protocol clients in the same room, using eight generator
shards and four native workers/four SQL connections per process. Application
performance code was unchanged; the harness gained passive peers, sharded
generators and recorded bounded initial-connection retries.

An initial attempt with a 60-second connection ramp failed to open every stream
and never started posting. The retry's 120-second ramp opened all 10,000 streams
with zero connection failures and no retries needed. Initial web reads remained
incomplete: 4,038 / 10,000 clients completed them by the 900-second deadline.
The original steady-state harness therefore never entered measured chat.

To exercise the requested posting rate, a separate writer reused the same local
identities while initial reads continued. It opened no additional streams and
offered 40 posts/second for 120 seconds. This phase is explicitly classified as
**posting during incomplete web bootstrap**, not steady-state capacity. It uses
128 in-flight requests and 20-second deadlines. All 10,000 original streams
remained connected through the phase.

| Posting-phase metric | Result |
|---|---:|
| Scheduled posts | 4,800 |
| HTTP successes | 241 (5.02% of offered posts) |
| HTTP timeouts | 706 |
| Generator drops at bounded write concurrency | 3,853 |
| Messages committed on the home | 947, all issued requests |
| New messages committed on each listening peer | 0 on all twelve |
| Posting p95, including timed-out requests | 20.05 seconds |
| Per-reader observation latency / completeness | Unavailable; reader measurement never started |

The timeouts did not prevent commits: all 947 issued requests stored a message,
including the 706 whose clients timed out. Dropped posts were never issued.
Independent database reads after the phase and after load stopped agree with
the final application snapshots. Every peer's cursor remains at the 100 seed
events with `The operation was aborted`; this is a failed replication observation
within the run, not evidence of permanent message loss.

Eleven ten-second posting-phase samples show all run-owned containers peaking at
2.81 GiB memory and 388.94% Docker CPU (3.89 logical cores worth); average sampled
CPU is 315.37% (3.15 cores). Home Node/native containers average 90.26% CPU and peak
at 0.79 GiB memory, excluding shared PostgreSQL, peers and host generators. Reader
generators peak at 1.26 GiB RSS with worst shard event-loop p95 34.0 ms; the writer
adds roughly 79 MiB. Manager/root process memory is additional. These samples
suggest an application bottleneck rather than whole-machine CPU exhaustion, but
do not isolate the exact cause or establish separate-server capacity. All
run-owned containers were removed.

The [combined summary](../test-results/fwdxp/2026-10-15T01-22-06-613Z/summary.md)
and [verified interpretation](../test-results/fwdxp/2026-10-15T01-22-06-613Z/interpretation.json)
link the original startup report, separate posting-phase counters, resource
samples and final replicas. The [first connection attempt](../test-results/fwdxp/2026-10-15T01-15-30-813Z/report.md)
and [small passive-peer/sharded smoke run](../test-results/fwdxp/2026-10-15T01-14-04-974Z/report.md)
are retained. The smoke run passed all 48 posts and 1,152 client observations.
The benchmark's ten tests also passed, including fixed offered rates across
shards, passive-peer observation counts and initial connection recovery. See
[the workload command](benchmark.md#one-large-instance-with-listening-peers)
for the original gated setup; the additional writer driver is retained at
`test-results/fwdxp/posting-during-bootstrap.mjs`.

## Constant-work redesign: first complete 10,000-reader run

Run `2026-10-15T03-15-20-361Z` completed initial reads for all 10,000 local
readers and measured the requested 40 offered posts/sec for 120 seconds, with
twelve listening peers and a private room. It used schema 31's encrypted origin
feed and browser deltas. The target was not met.

| Metric | Result |
|---|---:|
| Offered posts | 4,800 |
| HTTP 201 / failures / generator drops | 1,084 / 501 / 3,215 |
| Failed HTTP requests | 489 timeouts, 12 HTTP 503 |
| Local committed measured messages | 1,530 |
| Measured copies per peer at shutdown | 1,448–1,530 |
| Local recipient observations | 12,800,000 / 48,000,000 (26.67%) |
| Client streams retained | 10,000 / 10,000, no SSE failures |
| Posting p95 | 20.05 seconds |
| Observation p95, measured from offered time | 90.84 seconds |
| Worst sampled source event-loop p95 | 3.64 seconds |

All twelve origin consumers staged and materialized thousands of encrypted
events without transport retries or gaps, including warmup. Several had not
reached the final source tail when shutdown froze consumption. Their smaller
copy counts are a deadline/backlog observation, not proof of permanent loss.
HTTP timeout does not imply rollback: local commits exceed HTTP successes.
The run saved independent PostgreSQL snapshots after application shutdown.

Sampled aggregate run-owned container memory peaked at 4.96 GiB; host generator
RSS peaked at 2.53 GiB, excluding their manager process. Containers averaged
8.67 logical-core equivalents and peaked at 11.89. Source Node and native workers
averaged 0.76 and 0.13 cores respectively; the shared PostgreSQL server averaged
3.57, all peer application/native containers 3.14, and the benchmark's Node TCP
forwarder 1.07. This forwarding layer is additional harness overhead; its load
prevents attributing the entire throughput limit to Archipel alone.

Compared with the earlier startup-contention attempt, initial reads now complete
and every peer imports new events. The two workloads do not form a controlled
throughput A/B comparison because the earlier run never completed startup.
This complete run exposed per-connection UTF-8 encoding of shared strings and
clustered read acknowledgements. The subsequent run reuses immutable encoded
buffers and spreads acknowledgements over their 30-second interval.

[Full report](../test-results/fwdxp/2026-10-15T03-15-20-361Z/report.md),
[raw report](../test-results/fwdxp/2026-10-15T03-15-20-361Z/report.json).

## Final run before the Claude handoff

Run `2026-10-15T03-33-11-309Z` completed normally with the shared encoded
buffers and phased read acknowledgements. The same 10,000 local readers,
twelve listening peers and 40 offered posts/sec for 120 seconds still failed
the target. These changes did not demonstrate a throughput improvement.

| Metric | Result |
|---|---:|
| Offered posts | 4,800 |
| HTTP successes / failures / generator drops | 665 / 715 / 3,420 |
| Local committed measured messages | 1,357 |
| Measured copies on each listening peer at shutdown | 1,212 |
| Local recipient observations | 10,514,695 / 48,000,000 (21.91%) |
| Client streams retained | 10,000 / 10,000 |
| Posting p95 | 20.04 seconds |
| Observation p95, measured from offered time | 90.84 seconds |

The harness saved final application and independent PostgreSQL snapshots,
logs and telemetry, then removed its containers and stopped its generators.
No additional runs were started after the user requested wind-down. Raw
artifacts remain locally under the ignored `test-results/` directory.

[Full report](../test-results/fwdxp/2026-10-15T03-33-11-309Z/report.md),
[raw report](../test-results/fwdxp/2026-10-15T03-33-11-309Z/report.json),
[Claude handoff](claude-handoff.md).

## Rerun after the room-delivery parity changes

Run `2026-10-15T14-12-36-921Z` repeated the same command
([benchmark.md](benchmark.md#one-large-instance-with-listening-peers)) on
`9b13ece`, which includes the room-delivery parity work from `29fbd62`
(incremental stream routing, scoped notices, adaptive flushing, pre-framed
writes, SSE writer processes, change-relay wakeups). The `archipel-native:dev`
image was rebuilt after the last native source change. Uncommitted edits were
limited to browser client files and benchmark helpers outside this workload.
It completed normally, and the target is still **NOT MET**. Throughput improved
over the previous run, but tail visibility got worse.

| Metric | 03:33 run | This run |
|---|---:|---:|
| Offered posts | 4,800 | 4,800 |
| HTTP successes / timeouts / generator drops | 665 / 715 / 3,420 | 1,402 / 628 / 2,770 |
| Local committed measured messages | 1,357 | 2,020 (every issued request) |
| Measured copies per listening peer at shutdown | 1,212 | 1,833–1,834 |
| Source commit rate during the window | ≈9.4/s | ≈12.9/s |
| Local recipient observations | 10,514,695 (21.91%) | 15,826,041 / 48,000,000 (32.97%) |
| Client streams retained | 10,000 / 10,000 | 10,000 / 10,000 |
| Posting p50 / p95 | 20.0 s / 20.04 s | 2.02 s / 20.04 s |
| Observation p50 / p95, from offered time | 1.83 s / 90.84 s | 1.66 s / 121.74 s |
| Source Node event-loop p95, median / max sample | 573 ms / 2,823 ms | 186 ms / 244 ms |

Observations reached 78% of the copies possible from committed posts
(2,020 × 10,000); the rest are readers still waiting in the generator's
refresh backlog at shutdown (see below).

### Where throughput is limited

Average CPU over the measured window, in logical cores (14 Docker samples; host
generators from their own telemetry):

| Component | 03:33 run | This run |
|---|---:|---:|
| Source Node (including SSE writer processes) | 0.89 | 1.49 |
| Source native workers | 0.11 | 0.22 |
| Shared PostgreSQL | 2.33 | 3.32 |
| Peer Node, all twelve | 1.58 | 2.32 |
| Peer native workers, all twelve | 0.77 | 1.14 |
| Harness TCP forwarder | 1.19 | 1.41 (1.27–1.84 per sample) |
| Host web generators | 2.04 | 2.58 |

The machine has 32 logical cores and used about 12.5, so the whole workstation
was not short of CPU. By stage:

- **Peer materialization is not the limit.** Every peer's origin cursor stayed
  within about five events of the source's tail at each 15-second sample, and
  staged equalled materialized when the window ended. The final gap of about 186
  events covers commits made after shutdown froze the consumers. 84% of
  PostgreSQL statement time (186 s, 75,699 calls, 2.46 ms mean) is
  `pg_advisory_xact_lock` on the peers' receive path
  ([inbox.rs](../native/src/inbox.rs), keys `incoming:{activity_id}`,
  `inbox-channel:…`, `remote-user:…`). These keys are not schema-qualified, so
  twelve peers sharing one PostgreSQL server wait on each other for the same
  activity. That is an artifact of the shared database; the peers still kept up.
- **The source's commit path is not the limit.** Every issued post committed,
  including the 628 the client timed out. Post statements are cheap: the
  channel-tail upsert and update average 2.44 ms and 0.68 ms. Source native
  workers averaged 0.22 cores, and Node→native calls had no errors or timeouts
  during the window (17,269 completed). The source event loop stayed under
  250 ms p95 in every sample, down from up to 2.8 s, so the parity changes
  removed the old source event-loop saturation.
- **Posting acceptance is the limiting stage, and the delay sits in the
  request path from the host generators to the source.** Read
  acknowledgements (`POST /api/read`, batched natively within 50 ms) and posts
  share the same floor: p50 2.02 s, with successes clustered between about 1.3
  and 3 s. Neither native work nor the event loop accounts for that. Timeouts
  arrive in bursts about every 20 s (window seconds 32–37, 52–57, 72–77,
  92–97, 112–117), so posts issued in the same few seconds stall together, yet
  all of them committed. Each timeout holds one of the 128 write slots for 20 s,
  which produces the 2,770 generator drops. Read slots also stayed at the 128
  cap for the whole window. Read acknowledgements alone used about 120 of them
  (≈60/s × 2 s), so the refresh backlog grew from 116 to 3,288 readers, with
  its oldest entry aging at wall-clock speed. That backlog explains the 121.7 s
  visibility p95.

The only component on that path running near a single-thread ceiling is the
harness's Node TCP forwarder, which proxies every host connection (10,000 SSE
streams plus all API requests) through one JavaScript thread. Docker Desktop's
host-side port relay is also on the path and is not sampled. Neither reports
event-loop or queueing telemetry, so the forwarder is the leading suspect, not
a proven cause. The source Node HTTP accept/parse path is not timed
server-side either. Confirming this needs a run whose generators bypass the
forwarder (for example, inside the Docker network) or forwarder latency
instrumentation; no application code was changed for this run.

[Full report](../test-results/fwdxp/2026-10-15T14-12-36-921Z/report.md),
[raw report](../test-results/fwdxp/2026-10-15T14-12-36-921Z/report.json),
[PostgreSQL statements](../test-results/fwdxp/2026-10-15T14-12-36-921Z/postgres-statements.json).

## Rerun without read acknowledgements

Runs `2026-10-15T15-52-41-837Z` and `2026-10-15T16-06-57-917Z` repeated the
same command on `46eff4f` plus the uncommitted read-mark change: neither
browsers nor the load clients send `POST /api/read` while watching. Instead,
the server records the read mark when the watching stream closes
([events.ts](../src/events.ts) `drop()`, wired in [app.ts](../src/app.ts)),
and the push worker runs only while push subscriptions exist and skips
connected users ([push.ts](../src/push.ts)). No native sources changed, so
`archipel-native:dev` was not rebuilt. The second run is identical apart from
an external latency probe (below). Both completed normally, and both are
**TARGET NOT MET**. Removing the read acknowledgements did not raise
throughput; both runs did worse than the 14:12 run.

| Metric | 14:12 run | 15:52 run | 16:06 run (probed) |
|---|---:|---:|---:|
| HTTP successes / failures / generator drops | 1,402 / 628 / 2,770 | 871 / 717 / 3,212 | 821 / 709 / 3,270 |
| Failure kinds | 628 timeouts | 660 timeouts, 57 ECONNRESET | 704 timeouts, 5 ECONNRESET |
| Posts issued / committed on the source | 2,030 / 2,020 | 1,588 / 1,382 | 1,530 / 1,077 |
| Posts reaching native in the window | 1,523 (12.7/s) | 992 (8.3/s) | 909 (7.6/s) |
| Measured copies per listening peer | 1,833–1,834 | 1,380 | 1,077 |
| Local recipient observations | 32.97% | 26.04% | 20.12% |
| Posting p50 / p95 | 2.02 s / 20.04 s | 6.84 s / 20.05 s | 1.58 s / 20.04 s |
| Observation p50 / p95, from offered time | 1.66 s / 121.7 s | 1.74 s / 95.4 s | 1.18 s / 121.7 s |
| `POST /api/read` in the window | 7,204 | 0 | 0 |
| Page refreshes started / completed | 0 / 0 | 963 / 604 | 981 / 760 |
| Source event-loop p95, median / max sample | 118 ms / 244 ms | 65 ms / 8,040 ms | 55 ms / 142 ms |

The 14:12 section quoted 186 ms as the median sample. Recomputed from the same
telemetry, the median is 118 ms; 186 ms is near the 95th percentile of samples.
In the 15:52 run, the event loop stalled during the window's first 12 seconds
(samples of 8,040, 1,765, 2,171 and 2,848 ms at t+1, 4, 8 and 11 s). The rest
of the window stayed below 720 ms. The probed run had no such stall.

Read acknowledgements are gone, but the 128 read slots did not free up. Page
refreshes now fill them. In the 14:12 run, acknowledgements held the slots so
that no refresh started in the window and the backlog grew to 3,316 readers.
Now refreshes start: 963 and 981 per run, all full pages, about a third timing
out. Their latency is the same kind as the posts': GET page and overview p50
1.4–1.6 s, p95 20 s. Throughput through the generator's slots fell from about
77 completed requests/s (60 acknowledgements plus 17 posts) to about 25–29/s.
The two runs of the same tree differ by six points of observations, so
run-to-run variance is large. That alone does not show the change made things
worse, but it does show acknowledgements were not the bottleneck.

### Where throughput is limited

Average CPU over the measured window, in logical cores:

| Component | 14:12 run | 15:52 run | 16:06 run |
|---|---:|---:|---:|
| Source Node (including SSE writer processes) | 1.49 | 1.33 | 1.27 |
| Source Node main process (own telemetry) | 0.48 | 0.41 | 0.38 |
| Source native workers | 0.22 | 0.16 | 0.15 |
| Shared PostgreSQL | 3.32 | 3.26 | 2.50 |
| Peer Node, all twelve | 2.32 | 2.30 | 1.73 |
| Peer native workers, all twelve | 1.14 | 1.05 | 0.81 |
| Harness TCP forwarder | 1.41 | 1.34 (1.26–1.65 per sample) | 1.33 |
| Host web generators | 2.58 | 2.28 | 2.12 |

About 10 of the workstation's 32 logical cores were in use. By stage:

- **Peers are not the limit.** Origin cursors stayed within a few events of the
  source tail at every 15-second sample, and every peer ended with the same
  measured copy count as the source. PostgreSQL time is again dominated by the
  peers' unqualified `pg_advisory_xact_lock` keys (81% and 87% of statement
  time), a shared-database artifact as described above.
- **The source is mostly idle.** It received 7.6–8.3 posts/s and about 6–7
  page and overview requests/s. Native workers had no errors and averaged
  0.15 cores, the main event loop's median sample p95 was 55–65 ms, and the
  main process used about 0.4 cores.
- **Issued requests are lost before they reach the server.** Of 1,530 posts
  issued in the probed run, 453 never committed. The 14:12 run lost 10 of
  2,030. Posts whose client timed out used to commit anyway; now most of
  them never reached Node.

To locate the delay, the probed run sent `GET /health` every 500 ms on a fresh
connection over three paths during the second half of the measured window
(t+57 s to t+120 s). The first two ran inside the source container's
network namespace:

| Path | Samples | Succeeded | Latency of successes |
|---|---:|---:|---|
| Directly to source Node (`127.0.0.1`) | 126 | 126 | p50 7.8 ms, p95 80 ms, max 178 ms |
| Through the harness forwarder (container address) | 126 | 15 (111 timed out at 30 s) | p50 27.9 s |
| From the Windows host (Docker Desktop relay, then forwarder) | 40 | 4 (36 timed out at 30 s) | 28–30 s |

A single request to a lightly loaded listening peer through the same forwarder
took 4.4 s to its first byte, against 15 ms directly. TCP connects completed
within 8 ms on every path; the delay comes after the connection is accepted.
The forwarder's own listen queue was empty. The kernel recorded 14,639 listen
overflows over the container's life. At shutdown the source's listen queue was
full (512), but direct requests during the window got through, so that full
queue was not the steady state.

**The remaining limit is the harness's single-threaded Node TCP forwarder.**
Requests that skip it are answered in milliseconds while the source sits idle.
The same requests sent through it take about 28 s or time out, whether or not
they also cross Docker Desktop's relay. The forwarder pipes all 10,000 SSE
streams (7–12 GB per run) and every API request through one JavaScript event
loop at about 1.3 cores. Load clients survive on their warm keep-alive
connections. A timeout destroys its connection, and the replacement must be
set up through the stalled forwarder. That is why timeouts come in bursts,
and why posts that time out on a fresh connection never reach the server. The
probe covered only the second half of one run's window, and it does not
separate the forwarder's JavaScript work from its kernel socket time. These
measurements show where the requests wait, not the source's capacity. A
meaningful capacity number needs a run whose generators bypass this forwarder,
for example inside the Docker network or with a multi-threaded relay.

[15:52 report](../test-results/fwdxp/2026-10-15T15-52-41-837Z/report.md),
[16:06 report](../test-results/fwdxp/2026-10-15T16-06-57-917Z/report.md),
[16:06 container probes](../test-results/fwdxp/2026-10-15T16-06-57-917Z/probe-container.ndjson).

## Load clients inside the Docker network

Run `2026-10-15T16-41-16-379Z` repeated the same command with
`--web-clients docker`. Each instance's generator group now runs in a
`node:24-bookworm-slim` container that shares the instances' network namespace.
It reaches the source on `127.0.0.1`, skipping Docker Desktop's port relay and
the harness TCP forwarder. The harness relays its messages to the generators as
JSON lines over `docker run -i`
([benchmark-web-bridge.mjs](../scripts/benchmark-web-bridge.mjs)). Offered rate,
readers, peers, transport, native and PostgreSQL settings are unchanged.
`--web-clients host` remains the default and reproduces the earlier runs.
Application code is the same as the 15:52 and 16:06 runs. The target is still
**NOT MET**, but this is the best run so far.

| Metric | 16:06 run (forwarder) | This run (in Docker) |
|---|---:|---:|
| Offered posts | 4,800 | 4,800 |
| HTTP successes / failures / generator drops | 821 / 709 / 3,270 | 2,080 / 533 / 2,187 |
| Posts issued / committed on the source | 1,530 / 1,077 | 2,613 / 2,527 |
| Posts reaching native in the window | 909 (7.6/s) | 2,456 (20.5/s) |
| Measured copies per listening peer | 1,077 | 2,527 on all twelve |
| Local recipient observations | 9,655,337 (20.12%) | 25,270,000 / 48,000,000 (52.65%) |
| Observations of committed posts | 90% | 100% (2,527 × 10,000) |
| Page refreshes started / completed / pending at stop | 981 / 760 / 162 | 2,597 / 2,325 / 0 |
| Posting p50 / p95 | 1.58 s / 20.04 s | 1.18 s / 20.31 s |
| Observation p50 / p95, from offered time | 1.18 s / 121.7 s | 1.58 s / 58.6 s |
| SSE bytes delivered to readers | 7.4 GB | 23.1 GB |
| Source event-loop p95, median / max sample | 55 ms / 142 ms | 455 ms / 1,836 ms |

Removing the forwarder more than doubled accepted and committed posts and
halved tail visibility. Every committed post reached every reader, and the
refresh backlog drained to zero. The failure is now in posting: about 20 posts/s
are accepted, against 40 offered, and 533 posts timed out at 20 s. Of those,
86 never committed, against 453 in the forwarder run.

### Where throughput is limited

Average CPU over the measured window, in logical cores:

| Component | 16:06 run | This run |
|---|---:|---:|
| Source Node (including SSE writer processes) | 1.27 | 1.06 |
| Source Node main process (own telemetry) | 0.38 | 0.57 |
| Source native workers | 0.15 | 0.30 |
| Shared PostgreSQL | 2.50 | 5.00 |
| Peer Node, all twelve | 1.73 | 2.92 |
| Peer native workers, all twelve | 0.81 | 1.51 |
| Harness TCP forwarder | 1.33 | 0.02 |
| Web generators | 2.12 (host) | 2.71 (containers) |

About 13.5 of 32 logical cores were in use. The same `GET /health` probe ran
from t−28 s to t+147 s (inside the measured window: 239 samples per path):

| Path | Succeeded in window | Latency of successes |
|---|---:|---|
| Directly to source Node (`127.0.0.1`) | 58 / 239 (181 timed out at 30 s) | p50 20.7 s, minimum 12.0 s |
| Through the now-idle harness forwarder | 54 / 239 (185 timed out) | p50 20.3 s, minimum 12.0 s |
| From the Windows host | 12 / 63 | — |

The direct and forwarder paths now behave the same, so the forwarder is no longer
in the way. Every fresh connection waits about as long, directly or not. By stage:

- **Peers and readers are not the limit.** All twelve peers committed every
  measured post, and readers observed every committed post.
- **PostgreSQL and native workers have headroom.** PostgreSQL used 5 of 32
  cores; its largest statement was the page/overview query on
  `conversation_prefs` (30% of statement time, 11.7 ms mean, 3,314 calls). The
  peers' advisory-lock time fell to 0.2 ms mean. Source native workers averaged
  0.30 cores, with one error in 14,967 calls.
- **The source Node front end is now the limit.** Its main event loop's
  one-second p95 samples had a median of 455 ms and reached 1,836 ms, against
  55 ms when the forwarder throttled the load. At t+40 s its listen socket on
  `127.0.0.1` held the full 512-connection accept backlog in five successive
  one-second samples. The kernel counted about 150–180 listen overflows a
  second, and a request to an unknown path took 56 s to get its 401.
  Keep-alive generator connections are already accepted, so they keep posting
  at about 1.2 s p50. A connection opened after a timeout waits for the stalled
  event loop to accept it, and SYN retransmissions push it to 12 s or more. This
  causes the 20 s posting timeouts. The main process averaged only 0.57 cores,
  so the stalls look like bursts of synchronous work, not sustained CPU
  saturation. This run did not profile what blocks the loop.

The generators now share the Docker VM with the instances, and their worst
shard event-loop p95 was 236 ms (33 ms on the host). That adds some client-side
delay but not the 12-second connection waits seen by the probes. This is one
run, and earlier runs varied by several points between repetitions.

[Full report](../test-results/fwdxp/2026-10-15T16-41-16-379Z/report.md),
[raw report](../test-results/fwdxp/2026-10-15T16-41-16-379Z/report.json),
[container probes](../test-results/fwdxp/2026-10-15T16-41-16-379Z/probe-container.ndjson),
[host probes](../test-results/fwdxp/2026-10-15T16-41-16-379Z/probe-host.ndjson).

## Profiling the source's event loop

Run `2026-10-15T19-53-29-376Z` repeated the in-Docker command with
`--profile 120 --profile-instance 0`. This captures a V8 CPU profile of the
source's main Node process for the full measured window, and only that process.
`--profile-instance` is a new harness option; application code is unchanged.
The profiler adds overhead, so this run's throughput is not comparable. For
the record: 2,559 posts issued, 2,366 committed, 49.29% observations, posting
p50 3.5 s, 46 HTTP 503s, and 128 native call errors. The source wrote only 42
one-second telemetry samples in 120 s because its own timer was starved. Their
event-loop p95 had a median of 1,194 ms and a maximum of 2,821 ms.

The [profile](../test-results/fwdxp/2026-10-15T19-53-29-376Z/cpu-0.cpuprofile)
covers 122.3 s with 106,914 samples. The main thread was **busy for 99.5% of
it**, though the process averaged only 0.63 cores. It spent most of that time
waiting, not computing:

| Self time | Share of busy | Function |
|---:|---:|---|
| 94.7 s | 77.8% | `waitForDatabaseMessage` ([db.ts:595](../src/db.ts)): `Atomics.wait` on a synchronous PostgreSQL call |
| 5.3 s | 4.4% | `postMessage` (sending those queries to the SQL worker) |
| 2.9 s | 2.4% | `receiveMessageOnPort` |
| 2.2 s | 1.8% | `writeBuffer` (socket writes) |
| 1.3 s | 1.0% | `ask` ([db.ts:450](../src/db.ts)) |
| 1.1 s | 0.9% | `InstanceFeed.page` ([instance-feed.ts:70](../src/instance-feed.ts)) |
| 0.7 s | 0.6% | `broadcastDelta` ([events.ts:405](../src/events.ts)) |
| 0.6 s | 0.5% | garbage collection |

By total time, almost all of it sits under one call path. It is the instance
feed that serves the twelve peers' `/federation/stream` connections
([app.ts:175](../src/app.ts)):

| Total time | Share | Frame |
|---:|---:|---|
| 107.4 s | 88.2% | `InstanceFeed.open` ([instance-feed.ts:114](../src/instance-feed.ts)) |
| 106.3 s | 87.4% | `InstanceFeed.page` ([instance-feed.ts:70](../src/instance-feed.ts)) |
| 70.4 s | 57.9% | `channelPublicationAllowed` ([federation.ts:2862](../src/federation.ts)), once per row |
| 39.0 s | 32.1% | `Federation.require` ([federation.ts:192](../src/federation.ts)) |
| 37.1 s | 30.5% | `Store.user` / `authenticated` / `active` ([store.ts:254–266](../src/store.ts)) |
| 28.9 s | 23.7% | `ensureEnabled` → `enabled` ([federation.ts:176–185](../src/federation.ts)) |
| 12.7 s | 10.5% | `Store.channel` ([store.ts:1062](../src/store.ts)) |
| 9.2 s | 7.5% | `publicActor` ([federation.ts:245](../src/federation.ts)) |
| 2.2 s | 1.8% | `InstanceFeed.secret` ([instance-feed.ts:65](../src/instance-feed.ts)) |

The other candidates are small. SSE frame building and fan-out (`flush`,
`broadcastDelta`, `sendFrame` in [events.ts](../src/events.ts)) total 3.7 s
(3.0%). Express routing and the rate limiter total about 6 s (5%). Native
chat RPC is 1.1 s (0.9%), JSON serialization does not show separately, and the
harness's telemetry is under 0.5 s.

**Every stall lines up with the instance feed.** The profile has 100 non-idle
stretches of 250 ms or longer, covering 114.3 s; 48 lasted over a second and
14 over two seconds, the longest 3.26 s. In each of the 25 longest,
`InstanceFeed.open` accounts for 63–100% of the time (over 80% in 23 of them), and most of that is the
synchronous SQL wait. While a stretch runs, the event loop never reaches
`accept()`. That is how the 512-connection backlog fills and fresh connections
wait 12 s or more in the earlier run.

Why it costs so much:

- **Each query is cheap, but each round trip blocks.** PostgreSQL recorded
  93,247 `instance_settings` reads, 91,725 `users` reads and 30,708
  `channels` reads, at 0.02 ms mean execution time. Across the whole server
  (twelve peers included), the source still spent about 95 s blocked, roughly
  0.4 ms per synchronous round trip through the SQL worker.
- **`page()` re-checks policy for every row, every time.** For each of up to
  32 rows it calls `channelPublicationAllowed`, even when the row already has
  a cached frame. That runs `ensureEnabled`, `Store.channel` and
  `Store.active`, and for relays `require` twice more, each with its own
  `ensureEnabled` and user read. That is roughly three to seven synchronous
  queries per row.
- **The page cache rarely hits during live posting.** It is keyed by the
  peer's cursor and is only valid while the cursor is at the tail. With about
  20 new events a second the tail keeps moving, so all twelve peers each
  rebuild their own page of the same events (1,526 page queries in the window).
- **`open()` does not yield while events are flowing.** After a successful
  `res.write` it calls `page()` again with no `await`. A peer that is a few
  pages behind is caught up in one synchronous run, which can take several
  seconds.

Fixes, not applied here, roughly in order of effect and effort:

1. Yield to the event loop between pages in `InstanceFeed.open` (for example
   `await setImmediate()` after each write). This bounds a stall to one page
   and lets accept and HTTP requests run in between.
2. Evaluate publication policy once per event, not once per peer page. Cache
   the allowed result and built frame per event `seq`, under the existing
   `stamp()`. Then twelve peers share one evaluation, and rows with a cached
   frame skip policy until a table in the stamp changes.
3. Hoist `ensureEnabled()` out of the per-row loop (`page()` already calls it
   once). Memoize `Store.channel` and `Store.active` within one `page()` call.
4. Longer term, build instance-feed pages with asynchronous SQL or in the
   native worker, which already does the per-peer delivery work, so the main
   thread never blocks on PostgreSQL to serve peers.

These findings explain the stalls in the earlier unprofiled in-Docker run. They
also explain why removing the forwarder did not bring the source's event loop
back to the 55 ms seen when the forwarder throttled the load.

[Full report](../test-results/fwdxp/2026-10-15T19-53-29-376Z/report.md),
[CPU profile](../test-results/fwdxp/2026-10-15T19-53-29-376Z/cpu-0.cpuprofile)
(open it in Chrome DevTools' Performance panel or speedscope).

## Rerun with the instance feed fixes

Run `2026-10-15T20-16-48-881Z` repeated the in-Docker command without profiling
after fixes 1–3 above were applied to [instance-feed.ts](../src/instance-feed.ts)
and [federation.ts](../src/federation.ts) (uncommitted):

- `open()` now yields with `setImmediate` after each page it writes.
- Built events and their publication result are cached per `seq` under
  `stamp()`, for up to 1 s, and shared by every peer.
- Each page reads the channel and author once and skips the per-row
  `ensureEnabled`.

Native sources are unchanged. The target is still **NOT MET**, but most
measures improved sharply, and the visibility p95 check now passes.

| Metric | 16:41 run | This run |
|---|---:|---:|
| HTTP successes / failures / generator drops | 2,080 / 533 / 2,187 | 4,332 / 207 / 261 |
| Accepted posts per second | 17.3 | 36.1 |
| Posts committed in the window (native) | 2,456 (20.5/s) | 4,331 (36.1/s) |
| Posts issued / committed on the source | 2,613 / 2,527 | 4,539 / 4,473 |
| Local recipient observations | 25,270,000 (52.65%) | 44,730,000 / 48,000,000 (93.19%) |
| Observations of committed posts | 100% | 100% (4,473 × 10,000) |
| Posting p50 / p95 | 1.18 s / 20.31 s | 1.92 s / 9.63 s |
| Observation p50 / p95 / p99, from offered time | 1.58 s / 58.6 s / 71.2 s | 2.02 s / **2.84 s** / 86.5 s |
| Page and overview GET p50 / p95 | 0.88–0.93 s / 20.0 s | 1.83–2.02 s / 2.23–2.46 s |
| Source event-loop p95, median / p90 / max sample | 455 / 1,482 / 1,836 ms | 670 / 772 / 822 ms |
| Listen overflows on the source in the window | ≈150–180/s (sampled at t+40 s) | 1,729 (≈14/s) |
| Seconds with the 512-connection backlog full | 5 of 5 sampled | 33 of 120 |
| Copies on listening peers at shutdown | 2,527 on all twelve | 4,473 on ten; 3,520 and 4,243 on two |

Checks passed: all streams retained, all authors offered, visibility p95 under
3 s, incremental delivery. Failed: API acceptance (90.3% of scheduled posts, not 99%), generator
drops (261), own-post and recipient observation completeness, every replica
committing, and posting p95 under 1 s. The three native checks fail only
because peers 1 and 2 wrote no final statistics. Both were still applying a
backlog when the harness stopped them, and the harness recorded "did not
confirm a successful drain". Ten peers' statistics show native federation
running without sender errors. The source's native chat had no errors inside
the window.

**PostgreSQL lookups.** In the 16:41 run, `SELECT value FROM instance_settings
WHERE key=…` ran 75,284 times and `SELECT * FROM users WHERE id=…` 71,955
times, about 2 s of statement time each. In this run neither appears in the
harness's top 40 statements by total time, whose cutoff is 1.24 s, and
neither does `SELECT * FROM channels WHERE id=…`. The harness keeps only those
40, so exact counts were not captured. They fell even though committed events
nearly doubled.

### Where throughput is limited now

Average CPU over the measured window, in logical cores:

| Component | 16:41 run | This run |
|---|---:|---:|
| Source Node (including SSE writer processes) | 1.06 | 1.35 |
| Source Node main process (own telemetry) | 0.57 | 0.55 |
| Source native workers | 0.30 | 0.49 |
| Shared PostgreSQL | 5.00 | 5.88 |
| Peer Node, all twelve | 2.92 | 3.24 |
| Peer native workers, all twelve | 1.51 | 1.50 |
| Web generator containers | 2.71 | 5.11 |

About 17.6 of 32 logical cores were in use. Two limits remain:

- **Peers now apply events more slowly than the source produces them.** Every
  peer's origin cursor matched the source's tail at each 20-second sample, with
  no retries. Materialization, though, ran at about 17–20 events/s while about
  33/s arrived. On peers 1–3, the gap between staged and materialized events
  grew from about 380 at the window's start to 2,388–2,401 at t+142 s. The
  16:41 run never hit this, because the source then produced only about 20
  events/s. Peer event loops stayed at 50–145 ms p95, and peer Node and native
  processes averaged about 0.27 and 0.13 cores each. So materialization is
  probably serialized per channel rather than CPU-bound, but no peer was
  profiled to confirm it. This is the remaining replication limit, and why two
  peers ended short.
- **The source's event loop is busy, but no longer in multi-second stalls.**
  The worst one-second p95 sample fell from 1,836 ms to 822 ms. The loop now
  sits at a steady 0.6–0.8 s p95 rather than spiking. That lag still sets a
  floor on every request: page and overview GETs complete in 1.8–2.5 s with a
  narrow spread. The backlog was full in 33 of 120 seconds, and fresh
  connections waited about 15–20 s (`/health` probe: 42 of 240 direct requests
  answered, p50 19.5 s). That accounts for the 203 posting timeouts and the
  9.6 s p95. The main process averaged 0.55 cores, so it is still mostly
  waiting, not computing. This run was not profiled, so what it waits on is
  not established.

PostgreSQL's largest statement is again the page/overview query on
`conversation_prefs`: 5,551 calls, 113 s, 49% of statement time, with its mean
up from 11.7 ms to 20.4 ms. Peer receive advisory locks fell to 0.09 ms mean.
The containerized generators now use 5.1 cores, and their worst shard
event-loop p95 was 333 ms. That adds some client-side delay to every latency
above. The next useful measurement is a profile of the source's main thread,
and of one peer's materialization path, under this load.

[Full report](../test-results/fwdxp/2026-10-15T20-16-48-881Z/report.md),
[raw report](../test-results/fwdxp/2026-10-15T20-16-48-881Z/report.json),
[listen-queue samples](../test-results/fwdxp/2026-10-15T20-16-48-881Z/netstat.ndjson),
[container probes](../test-results/fwdxp/2026-10-15T20-16-48-881Z/probe-container.ndjson).

## Profiling the source and a peer after the feed fixes

Run `2026-10-15T20-36-17-581Z` repeated the 20:16 command with
`--profile 120 --profile-instance 0,1 --statement-limit 0`. These are harness
changes only. `--profile-instance` now takes a list. `--statement-limit 0`
saves every PostgreSQL statement (780 entries) instead of the top 40. While
profiling, the harness also counts each profiled process's synchronous
database round trips by statement, timed on the main thread
(`sql-N.json`). The profiler adds overhead, so this run's throughput is not
comparable: 3,274 accepted, 3,625 committed, 75.52% observations, source
event-loop p95 samples with a median of 567 ms and a maximum of 1,110 ms. The
backlog was full in 66 of 120 seconds, with 4,395 overflows.

Postgres statement counts below run from the reset after bootstrap through
the post-window drain. Main-thread call counts cover the 120 s profile.

### Source (instance 0)

[Profile](../test-results/fwdxp/2026-10-15T20-36-17-581Z/cpu-0.cpuprofile),
[synchronous SQL](../test-results/fwdxp/2026-10-15T20-36-17-581Z/sql-0.json).
The main thread was busy for 98.8% of the window: 59.7% blocked in
`waitForDatabaseMessage` ([db.ts:595](../src/db.ts)) and the rest mostly
socket writes and SSE work.

| Total time | Share of busy | Frame |
|---:|---:|---|
| 79.0 s | 66.2% | `InstanceFeed.open` ([instance-feed.ts:129](../src/instance-feed.ts)) |
| 76.7 s | 64.3% | `InstanceFeed.page` ([instance-feed.ts:75](../src/instance-feed.ts)) |
| 66.4 s | 55.6% | `InstanceFeed.build` ([instance-feed.ts:106](../src/instance-feed.ts)) |
| 19.5 s | 16.3% | `publicActor` ([federation.ts:249](../src/federation.ts)) |
| 14.3 s | 12.0% | SSE fan-out: `flush` / `broadcastDelta` / `sendFrame` ([events.ts:454, 405, 259](../src/events.ts)) |
| 4.6 s | 3.8% | `InstanceFeed.secret` ([instance-feed.ts:70](../src/instance-feed.ts)) |
| 4.4 s | 3.7% | `channelPublicationAllowed` ([federation.ts:2868](../src/federation.ts)) |
| 2.7 s | 2.2% | native chat RPC ([native-chat.ts:10](../src/native-chat.ts)) |

The main thread made 62,008 synchronous round trips, blocking 76.6 s (1.24 ms
mean). It built 3,586 events, one per new event, so the shared cache works.
Each build still costs about 17 synchronous calls and 19 ms of blocking:

| Calls | Blocked | Per call | Statement (main thread) |
|---:|---:|---:|---|
| 3,586 | 29.5 s | 8.22 ms | `UPDATE federation_instance_events SET frame=…` (write-back of each built frame) |
| 14,483 | 11.4 s | 0.79 ms | `SELECT * FROM users WHERE id=…` (4 per event) |
| 10,819 | 7.1 s | 0.65 ms | `instance_settings` `federation_enabled` (3 per event) |
| 7,172 | 4.5 s | 0.63 ms | `SELECT * FROM federation_keys WHERE id=1` (2 per event) |
| 4,793 | 4.0 s | 0.83 ms | `SELECT * FROM channels WHERE id=…` |
| 3,586 | 3.7 s | 1.03 ms | `SELECT frame FROM federation_instance_events` (re-read after the write) |
| 3,586 ×2 | 4.1 s | 0.54–0.61 ms | `federation_channel_keys` `INSERT … ON CONFLICT DO NOTHING` then `SELECT secret` |
| 3,586 | 2.1 s | 0.59 ms | `SELECT revision FROM user_avatars` |
| 1,588 | 5.2 s | 3.29 ms | the page's event query |

PostgreSQL itself executes these in microseconds; the frame write averages
0.42 ms. The 8 ms the main thread sees for each write is commit and round-trip
latency, which `pg_stat_statements` does not count. Reads cost 0.6–0.8 ms per
round trip against 0.03–0.07 ms of execution.

So, on the questions asked:

- **Synchronous SQL via the worker:** yes, this is what the main thread waits
  on. Every stall of 250 ms or more is mainly `InstanceFeed.open`. There were
  191 such stretches (93 s in total) and 80 over 500 ms; the longest is 1.1 s,
  where the profile before the feed fixes had 3.3 s stalls. `open()` now yields between
  pages, but one page of up to 32 new events still takes 32 × ~19 ms ≈
  0.6 s. That matches the steady 0.6–0.8 s lag and the full-backlog seconds.
- **The `conversation_prefs` page/overview query:** not on the main thread. It
  runs in the native workers: 4,651 calls at 17.2 ms mean, 79.8 s, and the
  largest single statement at 25% of PostgreSQL time. It loads PostgreSQL but
  does not block Node.
- **SSE fan-out:** real CPU (about 12% of busy time, plus 6.1% self time in
  `writeBuffer`), but not the stall.

Ranked fixes (not applied):

1. **Stop the synchronous frame write-back.** Keep built frames in the shared
   in-memory cache, or write them per page in one transaction. Better still,
   seal the frame when the outgoing event is created (native already has it).
   This removes about 9 ms of the ~19 ms per event (the `UPDATE` plus re-`SELECT`).
2. **Memoize per page what doesn't change per event:** the channel actor and
   `publicActor` documents, `federation_keys`, `user_avatars`, `ensureEnabled`,
   and the channel key secret per (channel, epoch). The secret currently costs
   an `INSERT … ON CONFLICT` and a `SELECT` for every event.
3. **Bound a single stall further:** yield between events, not only between
   pages. Or build pages off the main thread (async pool or native), so
   `accept()` keeps running.
4. Separately, the `conversation_prefs` query is the biggest PostgreSQL cost
   on the read path, worth an index or cached hidden-thread set later.

### Peer (instance 1)

[Profile](../test-results/fwdxp/2026-10-15T20-36-17-581Z/cpu-1.cpuprofile),
[synchronous SQL](../test-results/fwdxp/2026-10-15T20-36-17-581Z/sql-1.json).
During the window, peer 1 staged 29.6 events/s but materialized 16.1/s; peer 5
staged 29.8 and materialized 16.3. Peer 1's unmaterialized backlog grew from 352
to 1,974. Its event loop stayed at a median of 68 ms p95, and the process used
0.36 cores. The main thread was busy for 76.8% of the window: 81.9% of that
blocked in `waitForDatabaseMessage`, with 27.9 s idle.

| Total time | Share of busy | Frame |
|---:|---:|---|
| 65.2 s | 70.6% | `InstanceFeed.materialize` ([instance-feed.ts:267](../src/instance-feed.ts)) |
| 36.6 s | 39.7% | `cacheActor` ([instance-feed.ts:302](../src/instance-feed.ts)) |
| 11.4 s | 12.4% | `stage` ([instance-feed.ts:226](../src/instance-feed.ts)), staging transaction and commit |
| 10.1 s | 10.9% | `Federation.allowed` ([federation.ts:206](../src/federation.ts)) |
| 5.0 s | 5.4% | `Federation.actor` ([federation.ts:308](../src/federation.ts)) |
| 3.6 s | 3.9% | `receiveChannelEvent` → `receive` ([federation.ts:2828, 2274](../src/federation.ts)) |
| 2.1 s | 2.3% | `mirrors.pull` ([mirrors.ts:24](../src/mirrors.ts)) |
| 1.9 s | 2.1% | `syncAvatar` → `cacheRemoteAvatar` ([federation.ts:377](../src/federation.ts), [store.ts:3526](../src/store.ts)) |

It made 39,174 synchronous round trips in the window, blocking 78.4 s (2.0 ms
mean), for 1,930 applied events. That is about 20 calls and 41 ms of blocking
per event:

| Calls | Blocked | Per call | Statement (main thread) |
|---:|---:|---:|---|
| 3,860 | 29.2 s | 7.57 ms | `INSERT INTO federation_actors … ON CONFLICT DO UPDATE` (2 per event, channel and author) |
| 1,930 | 14.8 s | 7.68 ms | `UPDATE federation_instance_incoming SET state='done'` |
| 11,638 | 9.0 s | 0.78 ms | `SELECT 1 FROM federation_blocks WHERE target=…` (6 per event) |
| 340 | 4.6 s | 13.6 ms | `commit` (staging transactions) |
| 3,538 | 4.3 s | 1.22 ms | `INSERT INTO federation_instance_incoming` (staging) |
| 1,930 each | 10.4 s | 0.8–1.1 ms | `mirror_sources`, channel cursor, `DELETE FROM remote_avatars`, received key, author `users` row, `federation_actors` read |

Across all twelve peers, PostgreSQL logged 69,354 actor upserts (0.14 ms mean
execution) and about 2,890 "done" updates per peer (0.15 ms). It also logged
444,270 `federation_blocks` reads, 34,676 `remote_avatars` deletes and 34,668
`mirror_sources` reads. Here too the time is commit and round-trip latency,
not execution.

Per applied event that is about 41 ms of synchronous SQL plus about 14 ms of
awaited work. The awaited part is mainly the native `receive` call: the 27.9 s
idle spread over 1,930 events. All of it is serialized. `pump()` runs one job
per channel ([instance-feed.ts:249](../src/instance-feed.ts)) and the benchmark
has one channel, so events apply one at a time: 1 / ~60 ms ≈ 16/s, the rate
measured. The limit is serialized synchronous writes at about 7.6 ms each,
three per event, not CPU and not network fetches. The key fetch path
(`peerJson`) did not appear.

Ranked fixes (not applied):

1. **Stop rewriting unchanged actor documents.** `cacheActor` upserts both
   actors on every event; skip the upsert when the document matches what is
   cached in memory. This removes about 15 ms per event.
2. **Commit per page, not per statement:** apply a page's events in one
   transaction, or at least the "done" update together with the event's
   receipt. Each autocommit write costs a WAL flush, about 7.6 ms here.
3. **Memoize policy reads per page:** `allowed()`'s six `federation_blocks`
   reads, `federation_enabled`, `mirror_sources`, the received key, and the
   `remote_avatars` delete that `cacheRemoteAvatar` issues for every event.
4. **Overlap or batch the native receive:** prepare the next event while the
   current receive is awaited, or hand native a page of events per call. Longer
   term, materialize in the native worker, which already does receipt.

With fixes 1–2 alone, per-event blocking would fall from about 41 ms to about
10 ms. That should be enough to keep up with about 30 events/s from a single
channel; the source's write-back fix similarly frees about half of its
main-thread time.

## Correctness checks

TypeScript checks, client build, legacy SQLite tests and native/PostgreSQL tests
pass. New integration coverage includes mixed legacy/capable peers, one cursor
per peer/channel, shared bootstrap, edits/deletes, restart replay, transactional
rollback, expired cursors, access revocation, local author blocks, split UTF-8
SSE frames with CRLF and recovery of quiet channels. Native tests verify receipt
and cursor commit through the real gateway without per-follower broadcast rows.
