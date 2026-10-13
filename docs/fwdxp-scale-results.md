# Three-instance FWDXP load test

The October 12, 2026 workload is **FWDXP**, with no Prosody, native XMPP clients
or XMPP bridges. Each of three independent Linux Node/SQLite instances has 1,000
active web protocol users. There are 99 shared timeline channels, 33 authoritative
homes per instance, with one assigned channel per user. Each offers one post per
minute: 50 posts/second globally. History is 10 messages per room; chat warmup and
measurement are 120 seconds each, followed by a 20-second observation drain.

As requested, the chat outbound peer cap is **1,000 deliveries/minute/peer**.
Inbound pacing is 2,000 federation requests/minute/address to accommodate two
peers. The worker retains the production default of 20 deliveries per round and
a 1,000 ms delay after each completed round. These are fixture settings; no
production deployment configuration was changed.

Source artifacts: `test-results/fwdxp/2026-10-12T13-11-12-083Z/`, containing the
report, interpretation, telemetry, logs and all three synthetic database snapshots.

## Result: target not met

All 2,000 remote subscriptions completed actual signed Follow/Accept and history
requests. Setup queues drained before limits were reset and all clients completed
initial web reads. Setup alone used faster fixture pacing; admission and inbox
validation were not fabricated or bypassed.

| Metric | Result |
| --- | ---: |
| Connections retained | 3,000 / 3,000 |
| Measured offered posts | 6,000 |
| API accepted | 5,999 / 6,000 (99.98%) |
| Generator-dropped posts | 0 |
| Authors observing their committed post | 2,000 / 6,000 (33.33%) |
| Recipient observations | 20,220 / 181,980 (11.11%) |
| API posting p95 | 540 ms |
| Observed message visibility p95 | 8.32 seconds |
| Committed measured messages per instance | 668 / 666 / 666; 6,000 expected each |
| Measured messages committed on foreign replicas | 0 |
| Pending deliveries at observation end | 90,233, including warmup |

The measured committed messages were local authoritative writes. Foreign
submissions were accepted into queues but had not reached their authoritative
homes, and measured home messages had not reached foreign replicas within the
window. A queued composer entry is not counted as a committed message. Missing
messages have no latency sample, so the observed p95 does not describe the whole
offered conversation. One API request returned ECONNRESET.

App peak RSS during measurement was 338–347 MiB per instance. Worst one-second
event-loop p95 samples were 571–614 ms. The oldest pending delivery was about
255 seconds old at observation end. Recorded inbox responses were all HTTP 202;
the peer cap increase did not eliminate the delivery backlog.

## What the original queues show

The original sender queued announcements per follower, even when those followers used
the same peer instance and shared inbox. Saved rows contain roughly **10.1 relay
deliveries per distinct activity/peer pair**. In the three snapshots, 1,939 sent
relay delivery rows represented only 191 distinct activity/peer pairs. Receivers
deduplicate activity IDs; repeated successful POSTs consume sender work and pacing
budget without adding another server-side message copy.

Even ignoring network/CPU time, the current round configuration permits fewer
than 20 deliveries/second per instance. This workload generates many delivery
rows per post, in addition to forwarding remote submissions. Observed throughput
was well below that ceiling. This test therefore measures the current paced
delivery pipeline, not the maximum throughput of unrestricted FWDXP or a VPS.

This led to shared-inbox consolidation while preserving policy checks, recipient
ordering, retries and revocation. Per-follower audit rows remain intentional;
the new worker counts POST attempts separately. The row multiplier establishes
repeated work in the original implementation, not a tenfold capacity result.

## Implemented fixes and follow-up measurements

The application now consolidates compatible channel announcements by their exact
advertised inbox, admits independent recipient heads concurrently, and uses
partial pending-queue indexes. Discovery coalesces concurrent validation and
avoids durable timestamp-only writes when an actor is unchanged. HTTP pools reuse
connections pinned to freshly validated DNS addresses. Discovery, signed reads
and POSTs have separate pools to avoid callback deadlocks.

Read marks, message submissions, inbox mutations and delivery completion can
share a durable SQLite commit. Each operation has an isolated savepoint; storage
errors roll back the entire batch. A response resolves only after commit. The
batch window is at most 50 ms before admission to the synchronous commit, or
128 queued operations, whichever happens first; event-loop and storage delays
can extend actual acknowledgement latency. Savepoint names are reused safely
by nesting depth. Queue insertions and shared completion updates use bounded
bulk SQL statements.

Delivery notices now ask the sender to refresh sending state instead of their
entire account. Latest message pages share bounded raw/public projections,
with immediate write invalidation and external SQLite change detection.
Permission, block, contact name, reaction and hidden-thread state remains fresh
for each reader. Emoji ban policy is read once per page rather than per message.

The scale runs use **2,000 POST attempts/minute/peer**, 4,000 incoming
requests/minute/address, 100 attempts/round, 100 ms between completed rounds and
32 independent deliveries in flight. After consolidation this topology still
requires roughly 1,333 POSTs/minute to each peer: remote submissions plus home
announcements. The requested 1,000/minute cap therefore cannot sustain this
offered workload. Production pacing defaults remain unchanged.

| Artifact timestamp | Active warmup / measured seconds | Observations | Copies per instance | Visibility p95 |
|---|---:|---:|---|---:|
| `2026-10-12T15-35-11-609Z` | 60 / 60 | 60.16% | 1,841 / 1,926 / 1,955 of 3,000 | 50.58 s |
| `2026-10-12T15-43-42-997Z` (CPU profiling enabled) | 30 / 30 | 100% | 1,500 / 1,500 / 1,500 of 1,500 | 5.63 s |
| `2026-10-12T15-47-36-083Z` | 120 / 120 | 29.42% | 1,823 / 1,814 / 1,804 of 6,000 | 90.84 s |
| `2026-10-12T15-53-53-288Z` (final fixes) | 120 / 120 | 66.27% | 4,035 / 4,141 / 4,172 of 6,000 | 67.79 s |

Every row above missed the complete target. The full-duration run accepted
5,999/6,000 API submissions and retained all 3,000 streams. Shorter windows
cannot establish sustainable throughput, and their coverage percentages are
not controlled before/after improvements. Each run combines code and pacing
changes. The final row includes the public projection cache, 50 ms batching and
bulk insertions. It accepted all 6,000 offered posts, retained all 3,000 streams,
and had API posting p95 of 272 ms. Authors observed 3,989 committed posts.
The snapshots held 30,946 pending recipient rows, including warmup. Five transient
inbox HTTP 500 responses were retried; no failed/cancelled rows or retained retry
errors remained in the snapshots. This is a substantial delivery improvement
over the initial fixture, but **the 3,000-user sustained target remains unmet**.

The same-duration baseline and final run use different pacing/caps as well as
different code. They establish the result of the combined changes, not the
isolated contribution of each optimization. Baseline visibility sampled only
the earliest/local observations; its smaller p95 cannot be read as better overall
delivery. Continued full-page web refresh work and durable writes share the
application process with delivery. A further performance change must be profiled
and validated at the full duration; faster POST acceptance alone is insufficient.

The CPU diagnostic attributes substantial wall time to SQLite commits and message
page reads. A separate 200-commit FULL/WAL probe took about 2.43 seconds in a
Docker named volume and 2.39 seconds in the writable layer on this host. That
probe does not support a storage-mount speedup here. No durability setting was
weakened.

## Validation and limits

Final code validation passed TypeScript checking, 199 automated tests (one
PostgreSQL integration test skipped because no test database was configured),
five benchmark-harness tests, five real-browser messaging/federation/access tests,
and Compose configuration validation without resolving the absent deployment env
file. Shared-inbox tests exercise exact-inbox matching, retry after restart,
per-recipient order, slow-peer independence and revocation during discovery.
All benchmark containers were removed; the workstation's other services remained
running. Production defaults and deployment credentials were not changed.

The 36-member smoke test `2026-10-12T13-10-07-917Z` passed: all 36 measured posts
committed on every instance, all 432 recipient observations arrived, and visibility
p95 was 2.71 seconds. The final cleanup validation,
`2026-10-12T13-18-52-287Z`, also passed after coordinated sender pause was added:
all posts, replicas and recipient observations completed, with visibility p95
2.84 seconds.

The large run predates coordinated sender pause at shutdown. Sequentially stopping
receivers added connection-refused/reset retries to later database snapshots.
Those errors are cleanup artifacts; workload status is taken from end-of-window
telemetry, and the raw snapshots remain intact with this caveat documented. The
harness now pauses every sender before stopping any receiver.

Instances share an isolated Docker loopback namespace for supported development
HTTP, with separate processes, databases and signing keys. Real RSA request
signatures, origin proofs, admission, deduplication and production delivery logic
are retained. HTTPS, reverse-proxy/WAN cost, browser rendering, OIDC login and media
are excluded. Other Docker services were preserved. See [benchmark instructions](benchmark.md)
for the executable workload and all pacing controls.
