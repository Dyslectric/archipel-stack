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

## Correctness checks

TypeScript checks, client build, legacy SQLite tests and native/PostgreSQL tests
pass. New integration coverage includes mixed legacy/capable peers, one cursor
per peer/channel, shared bootstrap, edits/deletes, restart replay, transactional
rollback, expired cursors, access revocation, local author blocks, split UTF-8
SSE frames with CRLF and recovery of quiet channels. Native tests verify receipt
and cursor commit through the real gateway without per-follower broadcast rows.
