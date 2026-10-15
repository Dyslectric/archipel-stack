# Native server refactor: chat and FWDXP transport

The native service is a compiled Rust PostgreSQL chat service. It runs a
supervisor plus a configurable pool of independent worker processes. Each worker
has its own address space, async runtime, channel lanes and PostgreSQL connection
pool. Channels are assigned by a stable hash; multiple channels run concurrently.
This is real native machine code, not bundled TypeScript or an embedded Node
runtime. Both the Windows release executable and Linux container were exercised.

**The complete application is not native yet.** The existing HTTP/API server
remains the compatibility front end. Production `npm start` now runs built
JavaScript directly; `tsx` remains a development/test tool. The compiled native
service handles the supported hot paths, while unported behavior continues through
the existing implementation. This preserves features during the port.

## Implemented

| Path | Native coverage |
|---|---|
| Read marks | A single channel target, including followed FWDXP channels; current session, account and membership checked at apply time |
| Read-mark batching | Per-worker queues of at most 128 entries / 50 ms, fresh authorization per entry, monotone/clamped writes and acknowledgement after shared commit |
| API authentication | Async current session/account reads for API pacing and CSRF; pending accounts can inspect their session, listen and log out; other APIs require approval |
| Account endpoints | Session/profile projection with current role grants, profile updates and logout; approval, suspension, CSRF and revocation checks |
| Actor exports | Public user/channel FWDXP documents with current approval, federation settings, avatars, channel metadata and persistent signing keys |
| Posting | Local/FWDXP posts including standard/custom/personal emoji tags, remote submissions, replies, titles and topics; durable acknowledgement and idempotent IDs |
| Home edits | Author revisions, titles and emoji metadata, transactional signed Update outbox entries and replica receipt; unsupported hooks retain compatibility |
| FWDXP outbox | RSA-SHA256 origin proofs, key initialization, transactional objects/activities/recipient rows |
| FWDXP delivery | Async signed HTTPS transport, per-request DNS validation and IP pinning, bounded parallel sends, recipient ordering, exact shared-inbox grouping, retries and fresh authorization |
| FWDXP receipt | HTTP signature verification and transactional Create/Update receipt/relay; origin proofs, duplicates/conflicts, replies, topics, custom emoji caching and missing-history placeholders |
| FWDXP Follow receipt | Home open/pending/blocked admission, channel/instance bans, signed Accept/Reject outbox entries and activity-id conflicts; retained delegated roles use compatibility |
| SSE session review | Batched async current-session/account reads, including expiry, logout, suspension, approval and administrator changes |
| SSE connection / audience | Async current-session validation when opening a stream and bulk current channel/member audience reads; sockets still use the Node front end |
| Message pages | Local/federated histories; pagination, local/remote author and avatar metadata, contact aliases, blocks, receive permissions, reversible emoji bans and batched pending submissions |
| Incremental refresh | A current authorized snapshot validates the prior 100-message window and author tuple versions; unchanged windows return new rows, while edits, deletion, profile changes and overflow return a complete current window |
| Overview | Async unread counts, hidden-thread/topic exclusions, blocks, preferences/layout and initial read marks; DM/XMPP accounts retain compatibility |
| Process pool | Isolated memory, async SQL pools, bounded admission, health checks, worker replacement, child cleanup after supervisor death |
| Database startup | Embedded PostgreSQL schema initializes empty instances; schema 26–29 upgrades to 30 with a shared startup lock |
| Existing API integration | PostgreSQL commit-time notifications reach all subscribed front ends on the same schema, including when an RPC reply is lost |

FWDXP Accept/history bootstrap, other membership and protocol extensions, XMPP, emoji catalog management,
reaction mutations, mirrors, media upload/serving, account management, OIDC, broad read
marks and SQLite are not fully ported. Message pages now support hidden threads/handles,
custom emoji metadata and reaction counts. Native page reads return to the compatibility
path when their projection requires those unported features. The new service does
not fabricate protocol success or bypass their hooks.

Native producers store the existing FWDXP activity and delivery formats. Remote
posts remain queued until their home accepts and relays them. A local home queues
an Announce for accepted followers. Queued submissions notify their own author;
room readers are notified when the home commits and relays the post. Current account grants, federation enablement,
remote blocks, session and membership are checked before committing. Signature
serialization preserves key order for receivers that verify with `JSON.stringify`.
Signing runs on blocking-task threads; each process caches its parsed key. Posting
publishes existing attachments belonging to the author in the same transaction.

Immutable plain Create deliveries may advance independently across channels.
An actor has at most one physical delivery in flight; completed tasks release
their claims before the next queue selection. Active recipients are filtered
before the predecessor check, avoiding repeatedly walking their later pending
rows while a network send is already in progress.
Retries within one channel keep their order. Updates, deletes, membership and
other state changes retain recipient-wide ordering barriers. Exact inbox grouping
and per-recipient policy/audit checks still apply. This avoids letting one channel's
retry stop every other channel for that recipient.

Successful network deliveries share bounded completion commits through an 8 ms
coalescing window (up to 32 groups; 64 queued requests). Each group waits for its
durable update before releasing its recipient claims. Retry/error updates retain
their per-recipient policy checks. Aborted jobs drain any previously submitted
successful completions before this supervisor reconnects or releases its sender
socket. Health timings expose `deliveryBatch` separately from each group's
`finish` wait, so profiles can distinguish commits from accepted inbox requests.

The sender reads a private `native_federation_heads` routing index containing the
first pending delivery for each recipient/channel lane. PostgreSQL statement
triggers use transition tables to update it in batches for both native and
compatibility writers, including cancellation, retry,
recipient/activity reassignment and channel changes. A companion
`native_federation_pending` index maps pending IDs to recipient/channel lanes, so
advancing a head uses one ordered index lookup rather than repeatedly joining
the outgoing activity history. Enqueuing a later ID leaves the head untouched.
Startup creates and backfills missing indexes or an outdated private cache
generation atomically under a schema-specific initialization lock. A short
transaction lock orders concurrent index maintenance; network work runs after the
transaction. The durable outgoing/delivery tables remain the source of truth.
Selection still reads due time, state-change barriers and current policy from
those tables. A future retry in one lane cannot hide an eligible independent lane.

Each enabled front end uses one additional async PostgreSQL LISTEN connection.
Notifications carry identifiers and are scoped by a hash of the current schema.
Migration 29 adds a durable `native_changes` queue. Mutations append notices in the
same transaction as their writes; a supervisor relay publishes committed batches
as soon as the gateway has forwarded a mutation (and at least once a second for
any other writer), deduplicates repeated notices, and splits payloads below
PostgreSQL's 8 KiB limit. The publication transaction deletes only the rows it
successfully notifies. It commits without waiting for its WAL flush: a crash can
only make it publish those notices again, which listeners treat as a repeat. Restart, network failure and rollback cannot silently discard pending
notices. Rollbacks and duplicate replays emit no notice. Reconnected listeners request
reconciliation because NOTIFY does not retain messages for disconnected listeners.
The API continues to decide what each reader may see. These shared notifications
cover native writes; legacy writes retain their current front-end event path.

API routes use native authentication before account-based pacing when enabled.
There is no cross-request permission cache. Native mutations/pages validate the
session and policy again at apply time; an unsupported feature reloads the session
before compatibility execution. Due cookie renewal still uses its existing
conditional update. Session and profile projection and logout now run in Rust;
OIDC, admission, broader management and the HTTP front end still retain Node.
Concurrent quota requests for the same session share only an in-flight lookup;
completed results are discarded immediately. Native operations recheck their
session and permissions at apply time. Pending-post pages batch received-object,
parent, topic, avatar and emoji-catalog reads instead of querying per queued post.
Quota/session reads use one plain query. Message pages use a read-only repeatable
snapshot, avoiding the WAL records that PostgreSQL row locks would generate on
otherwise read-only requests. Posting keeps its shared permission locks.
Integration tests deliberately make synchronous session lookup throw while
native posting and page/overview reads succeed, then verify rich fallback and CSRF.
Read marks also avoid shared account/session/channel/membership locks. The upsert
checks current session, CSRF, approval, suspension and membership in the same
statement that writes a clamped, monotone position. This keeps authorization at
apply time while avoiding WAL from permission row locks on every read notice.
The queue waits without holding a PostgreSQL connection. Revoked entries fail
individually while permitted entries commit; duplicate targets are combined with
their greatest clamped position. No caller receives success before commit.
Unread counts now start from each readable channel's read position, allowing the
channel/sequence index to discard already-read rows before author/block lookups.
Overview initialization skips insert attempts for marks that already exist.
Overview also defers for stored XMPP rooms even when XMPP is disabled in the
current configuration, so existing conversation metadata remains visible.

Only an explicit `501 native_unsupported` response issued before mutation permits
compatibility execution. A timeout or other error never causes a second write.
Workers acknowledge only after PostgreSQL commit. Each operation uses a short
transaction for permissions and its own write; there is no instance-wide
transaction or global request-order gate. Administrative revocation still needs
consistent handling. No producer-time ordering guarantee is made for chat posts;
clients fetch the committed page. Concurrent duplicate message IDs create one row.

## Parallelism and resource bounds

Defaults are four worker processes and four database connections per worker, plus
a four-connection supervisor pool for delivery, session review and change relay.
Workers with at least four configured connections reserve one for federation
receipt and use the rest for foreground requests and read-mark batches. Smaller
pools stay shared. The supervisor retains its full configured pool.
When the reserved connection is occupied, receipt can borrow an immediately idle
foreground connection; it does not wait in the foreground pool's queue. Channel
concurrency is capped below the foreground pool size, leaving capacity for other
channels. These are partitions of the existing budget, not additional connections.
Delivery uses one additional dedicated advisory-lock connection. It is unlocked
when idle and remains locked while jobs run across timer calls. An RPC cancellation
keeps the jobs, claims and owned socket; connection loss aborts and joins the local
jobs before a later tick reconnects. An unacknowledged lock attempt is discarded
before retry, preventing recursive acquisition. With
one Node database connection and one LISTEN connection, the default maximum is
23 PostgreSQL connections per instance. Each process has two async runtime threads. By default a channel
can admit two operations at once. Its concurrency must stay below its worker's
connection budget, so one blocked channel cannot hold all connections needed by
other channels. Waiting for a channel slot occurs outside the SQL pool. Read marks
use their independent bounded batch queue without holding a channel slot; fresh
authorization, monotonicity and position clamping occur in the apply statement.

| Setting | Default | Bounds |
|---|---:|---|
| `NATIVE_WORKERS` | 4 | 1–32 processes |
| `NATIVE_DATABASE_POOL` | 4 | 2–32 connections per process |
| `NATIVE_CHANNEL_CONCURRENCY` | half the pool, rounded down | 1 to pool size minus one |
| `NATIVE_HOST` / `NATIVE_PORT` | `127.0.0.1` / 8870 | Internal RPC listener |

Each worker admits at most 128 active/waiting jobs; the supervisor also bounds
admission by pool size. RPC bodies are limited to 64 KiB, with a 4 MiB supported
page-response bound. Every worker validates the bridge secret and current session
and CSRF token. Use the same `DATABASE_URL`, `BASE_URL` and bridge secret as the
compatibility server. The native service initializes empty PostgreSQL schemas and upgrades schema
versions 26–29 to version 30 under the shared startup lock. Older schemas require
the compatibility migrations first. Use the same `FEDERATION_CHANNEL_TRANSPORT`
setting on both processes. Negotiated broadcasts append to the shared channel
event log; stream imports commit with their receiver cursors.

## Build and run

```sh
# Native release build; no Node is required to build or execute this binary.
cargo build --manifest-path native/Cargo.toml --locked --release -j 4
```

Windows output is `native/target/release/archipel-chat.exe`; Linux/macOS output is
`native/target/release/archipel-chat`. Set `DATABASE_URL`, `BASE_URL` and a random
`NATIVE_BRIDGE_SECRET` of at least 43 base64url characters before starting it.
The executable prints its bound port and worker PIDs at startup. `--check` performs
an authenticated health check, including the workers' database access.

Enable the compatibility bridge with `NATIVE_CHAT_URL=http://127.0.0.1:8870` and
the same `NATIVE_BRIDGE_SECRET`. It is disabled by default. Build the compatibility
server with `npm run build` before `npm start`.

The Linux native image is built with:

```sh
docker build -f Dockerfile.native -t archipel-native:dev .
```

Its runtime image contains the compiled executable and system certificates, with
no Node, Rust compiler or TypeScript loader. The tested image was about 34 MB.
For the existing PostgreSQL deployment, put the bridge secret and optional worker
settings in `.env.container`, then include the native overlay:

```sh
docker compose -f compose.yaml -f compose.postgres.yaml -f compose.native.yaml up --build -d
```

The native service joins the private database network and publishes no host port.
The overlay preserves the current application and database. On an empty database
the native executable initializes the schema itself. Node and Rust initialization
share a PostgreSQL advisory lock, including schema creation. Embedded SQL is
generated from the existing migrations; a source fingerprint detects stale data.
The generator is optional development tooling:
`node --import tsx scripts/generate-native-schema.ts`. Building or starting Rust
does not invoke Node. Schema 26–28 upgrades are embedded too; older databases
still need the compatibility migrations before native startup.

Each worker keeps at most 16 MiB of raw message pages, with 256 entries and a
two-second lifetime. Every lookup validates page membership and PostgreSQL tuple
versions in its read-only snapshot. Legacy edits and deletes invalidate reuse
even when they emit no native notice. Author profiles, aliases, avatars, blocks,
permissions, reactions, hidden threads and emoji metadata are projected afresh.
The worker emits the public page/overview projection directly. The supervisor
forwards JSON bytes, and Node returns those bytes without reparsing/reserializing
every message. This preserves native authorization at apply time and explicit
unsupported fallback. Failed reads cannot silently re-enter compatibility.

Content-only browser refreshes now carry the prior window's cursor/fingerprint.
The current repeatable snapshot validates message and author tuple versions before
returning new records. Edits, tombstones, author changes, a mismatched cursor or
more than 100 new records return the complete latest window. Metadata/reaction
notices request full projection; expanded or scrolled history continues to refresh
all loaded pages. Ordinary recent views retain 100 messages with earlier history
available through pagination. The fingerprint is a change detector, not an
authorization token: every request still checks current session and channel policy.

Window validation now limits the indexed message range before fetching author
versions through indexed lateral lookups. Live plans from an isolated fixture
showed the old custom plan hashing all 3,000 accounts for each 100-row window;
the new plan looks up only authors in the window and reuses repeated authors.
The saved examples are diagnostic plans, not a standalone capacity claim.

## Verification and measurements

The last full PostgreSQL suite passed 222 tests with 11 backend-specific skips;
the SQLite suite passed 204 with 29 skips. The subsequent native/HTTP suite passed
72 tests after SSE audience/authentication and the atomic read-mark change.
The 29-test native suite then passed with Follow receipt and read-mark batching.
The October 13 continuation subsequently validated batching, revocation, overview,
incremental pages and sender changes in the full suite described below.
Coverage verifies active permissions,
exact message/page projections, no replay after errors, read-position clamping,
concurrent duplicate IDs, worker replacement, current SSE updates and progress in
another channel while one is locked in PostgreSQL. New coverage verifies signed
outbox replay, grant revocation, titles/replies/topics and attachment publication,
schema-scoped notices across two front ends, overview parity and real three-instance
Follow/Accept/Create/Announce receipt with valid native proofs. Rust release builds and Clippy
with warnings denied passed. The Linux runtime successfully handled authenticated
posts, reads and read marks; its executable had an ELF header and no Node command
was present. Native health and Compose configuration checks passed.
Compiled compatibility startup also served both health and browser assets without
a TypeScript loader. The build copies its migrations and browser assets into the
generated runtime tree. Temporary verification containers and their private
network were removed; unrelated services remained running.

The local native microbenchmark offered 320 plain posts across 32 channels, with
one session and 32 requests in flight. It checked committed database rows, not
only HTTP acceptance:

| Configuration | Committed | Posts/second | Posting p95 |
|---|---:|---:|---:|
| 1 worker, 4 total SQL connections | 320/320 | 420 | 85.6 ms |
| 4 workers, 16 total SQL connections | 320/320 | 880 | 51.2 ms |

This measures the combined process and connection-budget change on this workstation.
It does not isolate native language speed, prove sustained throughput, include
browser refresh/SSE/WAN cost, or establish the 3,000-user FWDXP target. The earlier
failed full-load results remain relevant until an equivalent native workload passes.
Run `npm run benchmark:native` with `ARCHIPEL_TEST_POSTGRES` pointing at an isolated
test database to repeat it. Logs/reports are under `test-results/native-*`.

## FWDXP load harness

The shared-channel harness supports isolated PostgreSQL schemas and Linux native
workers. It records native completion/fallback/error counters alongside API,
replica and recipient metrics. A native run must exercise posting and pages with
no unsupported fallback to pass. Build `archipel-native:dev` first, then run:

```sh
npm run benchmark:fwdxp -- --instances 3 --members 1000 --rooms 99 \
  --postgres 1 --native-chat 1 --peer-rate 2000 --inbox-rate 4000 \
  --batch 100 --interval 100 --concurrency 4
```

The harness creates and removes its database, workers and network namespace.
PostgreSQL snapshots contain synthetic message bodies and queue summaries rather
than SQLite database files. Recorded pacing settings remain part of the result.
Front-end RSS/event-loop metrics cover Node, not total Rust/PostgreSQL resources.

A Linux smoke run with 3 instances, 12 active members each and 6 offered posts/sec
passed: 72/72 measured posts accepted and committed on each replica, 864/864
recipient observations, posting p95 75.9 ms and visibility p95 1.92 seconds. No
native unsupported fallback occurred. This validates the integrated path at small
scale and does not establish the 3,000-user target. Artifacts:
`test-results/fwdxp/2026-10-12T18-47-23-674Z/`.

The first 3,000-member native/PostgreSQL attempt completed signed subscriptions
and retained all streams, but timed out during initial web reads before chat
measurement. The generator dropped failed initial refreshes out of its queue.
It now retries those refreshes through the bounded queue and records startup
attempts, failures and HTTP statuses separately from measured chat. PostgreSQL
authentication/channel-discovery round trips were also reduced; see
[PostgreSQL optimizations](postgres-optimizations.md). The aborted run remains in
`test-results/fwdxp/2026-10-12T18-53-29-495Z/` and is not a chat-capacity result.

The next completed 3,000-member run, at
`test-results/fwdxp/2026-10-12T19-16-38-741Z/`, accepted all 6,000 measured posts
through Rust and retained 3,000 streams, with no native unsupported/error response.
It still failed: only 11.11% of recipient observations arrived, with zero measured
foreign copies. The sender made only 611 physical POST attempts across all three
instances during warmup/chat/drain, leaving 91,614 delivery rows pending at its
saved stop. Most pending rows had never been attempted. This run precedes the
native overview, private-only submission notices and batched follower-policy
checks. It establishes that producer success alone does not repair the delivery
bottleneck and is not a result for the later fixes.

The final hot-route authentication run is at
`test-results/fwdxp/2026-10-12T20-16-40-191Z/`. All 6,000 measured posts were
accepted, all 3,000 streams remained connected, and native completion counters
recorded zero unsupported/error responses. It still failed the delivery target:
20,124/181,980 recipient observations (11.06%), posting p95 2.02 seconds,
observed visibility p95 34.24 seconds, and 668/666/666 measured copies per
instance with no measured foreign copies. Native counters include warmup/setup,
while the offered/observed totals above cover the measured window.

The sender continued advancing, but could not drain its warmup backlog before
measured foreign submissions. The saved snapshots ended with 93,477 pending
delivery rows. Live read-only EXPLAIN captured during this run returned a
delivery head in about 0.25 ms using the existing indexes; a speculative extra
index was not added. Removing foreground synchronous authentication improved
physical sender attempts, but did not meet end-to-end latency/delivery goals.
Protocol receipt/delivery were still compatibility paths in that run. The tiny
sender deadline-crossing guard was added afterward and has a deterministic test
on both backends; it is not claimed as a measured performance fix.

## Remaining native port

The next slices are the remaining message mutations/hooks and FWDXP protocol
extensions, then native public HTTP authentication, admission, management and
the remaining APIs. Existing permission, media and cross-instance tests must
exercise each native implementation before its compatibility path is removed.
Per-channel concurrency does not make edits, deletes or membership decisions
independent of their earlier state; those need explicit revision/order rules.

The first full run after native transport/receipt and batched SSE session review
(`test-results/fwdxp/2026-10-12T21-24-07-090Z/`) accepted 6,000/6,000 measured posts
and retained every stream, but delivered only 20,220/181,980 recipient observations
(11.11%). Native receipt and delivery counters confirmed these paths ran. During
warmup, PostgreSQL had 34 sessions waiting on `Lock / object`, while Rust used
about a quarter of one CPU core per instance. PostgreSQL's
[notification implementation](https://github.com/postgres/postgres/blob/REL_17_STABLE/src/backend/commands/async.c)
holds a global object lock across commits that notify listeners. This was the
basis for migration 29 and the durable batch relay; the replacement needs an
equivalent end-to-end load result before a capacity improvement can be claimed.

Subsequent 3,000-member runs kept the same 50-post/sec workload and pacing:

| Run / change | Accepted posts | Recipient observations | Post p95 | Visibility p95 |
|---|---:|---:|---:|---:|
| `2026-10-12T23-18-41-515Z`, durable change relay | 5,999 / 6,000 | 11.11% | 235 ms | 5.36 s |
| `2026-10-12T23-31-09-538Z`, read-only session/page queries | 6,000 / 6,000 | 12.57% | 213 ms | 138.51 s |
| `2026-10-12T23-45-43-832Z`, bulk cached actor reads | 5,985 / 6,000 | 13.37% | 259 ms | 134.22 s |
| `2026-10-13T00-00-08-465Z`, actor exports / channel lanes | 5,999 / 6,000 | 11.11% | 224 ms | 4.41 s |
| `2026-10-13T00-37-57-949Z`, raw-page reuse / direct projections | 6,000 / 6,000 | 11.88% | 184 ms | 137.93 s |
| `2026-10-13T00-58-24-996Z`, SSE metadata / atomic read marks | 6,000 / 6,000 | 11.11% | 203 ms | 4.20 s |

All retained 3,000 streams, but none met delivery capacity. The channel-lanes run overlapped
local compilation/testing, so it does not isolate the performance effect of its
changes. Its single-room-per-member topology also does not exercise bypassing a
retry in another channel. Visibility includes
only observations that arrived; missing observations have no latency sample.
Removing global notification contention improved posting substantially, while
federation continued accumulating a backlog. The last two runs include emoji
posting/receipt/bans, batched pending-page reads, combined actor-policy reads and
in-flight authentication coalescing. They precede Follow receipt, batched read
commits and the new unread-query shape. The last run's 56 activity samples recorded
194 active-backend observations waiting on commit WAL writes and 134 executing
unread overview SQL. These are sampled backend counts, not query durations.
Reconstructed synthetic-data plans are saved beside the run; they do not reproduce
live contention or establish capacity.

The native HTTP and database infrastructure uses the official
[Axum server API](https://docs.rs/axum/latest/axum/fn.serve.html),
[SQLx PostgreSQL pool](https://docs.rs/sqlx/latest/sqlx/postgres/type.PgPool.html)
and [Cargo release build](https://doc.rust-lang.org/cargo/commands/cargo-build.html).

## October 13 continuation: six instances / 3,000 active members

The continuation added guarded incremental HTTP/browser refreshes, coalesced page
policy reads, bounded indexed author-version lookup, read batches outside channel
lanes, reusable sender-lock connections with cancellation-safe cleanup, current
sender authority batching and eager release/filtering of active recipient claims.
Actor refresh removes an obsolete avatar and queues its notice in one statement;
unchanged remote authors avoid repeated initialization/update queries. Home edits
and signed Update propagation were also verified. No permission cache or weaker
commit durability was introduced.

The fixture now records explicit native worker/pool budgets, database connections,
source/image hashes, ten-second container resource samples and SQL statement totals.
Cursor query values share one bounded metric key; generators wait for their final
IPC result to flush. Native history setup has a separate, checked mode: signed
Follow/Accept joins empty rooms, then native owner posts populate 100 retained
messages in every room on every replica before client startup. This excludes
existing-history Accept/bootstrap, which remains a slow compatibility path.

Final source validation passed **232 tests / 11 backend-specific skips** (243 total)
against PostgreSQL, including the opt-in native browser test. All seven harness
tests passed. Windows/Linux release builds, Clippy with warnings denied, TypeScript
checks and client/server builds passed. Browser coverage verifies incremental
arrival, preservation of draft/focus and full refresh after edits/deletion. Native
tests cover overflow, stale fingerprints, changed authors and fresh authorization,
blocked read batches, sender connection reuse/recovery, retry/barrier semantics and
atomic avatar-removal notices.

The final full result is
`test-results/fwdxp/2026-10-13T16-12-46-613Z/report.json`:

| Measurement | Result |
|---|---:|
| Instances / active members | 6 / 3,000 total (500 each) |
| Shared rooms / retained history | 96 / 100 messages per room per replica |
| Warmup / measurement / drain | 120 / 120 / 20 seconds |
| Offered posting rate | 50 posts/second; one per member per minute |
| Measured API accepted | 6,000 / 6,000; no failed/dropped offers |
| Streams retained | 3,000 / 3,000 |
| Native unsupported / errors | 0 / 0 |
| Measured incremental pages | 78,387; no measured full-page reset |
| Authors observing committed posts | 1,130 / 6,000 |
| Recipient observations | 23,753 / 188,640 (12.59%) |
| API post p95 | 272.4 ms |
| Observed visibility p95 | 121.74 seconds |
| Pending delivery rows at saved stop | 90,916 |
| Sampled peak run-owned container memory | 4.10 GiB |
| Sampled peak host generator RSS | 773.6 MiB, reported separately |

**The 3,000-active-user delivery target is not met.** Missing observations have no
latency sample. Successful native POST acknowledgement for a foreign room still
means a durable submission; every replica and recipient must also catch up.
The latest profile has two workers/four SQL connections per process, eight sends
in flight, no peer cap, a 10,000/minute inbound cap and 512 MiB shared PostgreSQL
buffers. These are recorded experimental settings, not new production defaults.
Increasing concurrency, lifting transport caps and enlarging the SQL cache did
not repair the backlog. The new indexed window reduced its aggregate measured
statement means from roughly 3 ms to roughly 1 ms in these different combined
profiles; that is not an isolated throughput comparison or a capacity success.

Remaining profiling should focus on sustained sender selection, inbound channel/
activity serialization and foreground/delivery pool contention. The final SQL
snapshot still records about 94 seconds of cumulative advisory-lock statement time
across the run, plus substantial sender-head work. Those totals include concurrent
backend time and do not by themselves isolate one lock or establish a root cause.
Public HTTP/SSE and existing-history membership receipt remain compatibility work.
The signed 36-member / 100-history native smoke run passed at
`test-results/fwdxp/2026-10-13T14-58-25-524Z/`; it does not override the failed
large result. All continuation fixture containers were removed; existing services
and deployment configuration were preserved.

## Sender scheduling and queue profiling continuation (13 October)

Outgoing jobs now survive the front end's scheduling ticks, with a one-second
dispatch window and persistent recipient claims. A stalled peer does not make
each tick drain all other jobs. The dedicated session-lock socket remains held
while work is active, including gaps between ticks and cancelled RPCs. Idle
sockets are reused unlocked; loss of the socket aborts/joins jobs and drains
submitted completions before this supervisor reconnects. Shutdown uses an
explicit drain without selecting new work. Completed jobs are reaped again after
selection queries, so they cannot occupy newly available dispatch slots.

Bounded health timers and ten-second samples separate sender selection, policy,
discovery, signing, transport and completion, plus receiver connection, activity
and channel waits. Differences of cumulative samples describe the measurement
interval; nested stages overlap and sum concurrent work. Lifetime maxima also
contain setup and are not measurement percentiles.

The queue-index experiments exposed regressions as well as improvements:

| Experiment/report timestamp (UTC) | API accepted | Recipient observations | Result |
|---|---:|---:|---|
| Materialized lane scan, `2026-10-13T17-53-13-625Z` | 6,000 / 6,000 | 25.61% | Selection averaged 104.01 ms in sampled measurement |
| Head index with row triggers, `2026-10-13T18-59-04-695Z` | 6,000 / 6,000 | 18.86% | Expensive advancement; two sender errors |
| Pending-lane index with row triggers, `2026-10-13T19-16-08-455Z` | 6,000 / 6,000 | 12.96% | Completion averaged 144.22 ms; no sender errors |
| Statement triggers, `2026-10-13T19-39-01-537Z` | 5,997 / 6,000 | 24.78% | Completion averaged 71.31 ms; three client connection resets |

All four are failed 3,000-user capacity runs with six instances, two workers and
four SQL connections per process, 96 rooms, 100 seed messages, 16 sends in flight,
120-second warmup/measurement and the same experimental transport limits.
Reports are under `test-results/fwdxp/<timestamp>/`. Queue populations differ as
each implementation falls behind; the stage averages are not isolated causal
comparisons. The row-trigger implementations were replaced by bulk transition
table maintenance. Successful completion batching and 32-send validation follow
these experiments. No production pacing defaults were raised on their evidence.

The isolated current SQL probe (`test-results/native-queue-write-profile.json`)
uses 48,000 pending rows, 480 lanes and 300 five-recipient completion statements.
It verifies heads against the durable queue. Its roughly 2.4 ms end-to-end / 0.44
ms PostgreSQL statement means exclude contention, signatures, network and readers;
they do not establish user capacity. The complete PostgreSQL suite passed 237
tests with 11 expected skips after completion batching, and all 42 native
integration tests passed after the final refill adjustment. The native suite
includes browser refresh, compatibility queue mutations, restart backfill,
concurrent writers, retry/state-change barriers, reserved/borrowed connection
capacity, stalled peers and holding the sender lock until accepted requests are
durably marked.

The first completion-batch profile, `2026-10-13T20-17-34-073Z`, used two workers,
four SQL connections per process and 32 sends in flight. It accepted all 6,000
posts, retained all 3,000 streams, copied all 6,000 messages to every instance and
recorded all 188,640 expected recipient observations. Sender/native API errors
were zero. Post p95 was 331.3 ms, but visibility p95 remained 28.17 seconds: the
responsive-chat target is still unmet. Sampled run-owned container memory peaked
at 4.55 GiB; host generator RSS peaked at 717.4 MiB separately. The sampled
measurement completed 37,779 physical delivery groups through 14,988 audit batches
(about 2.5 groups per batch); setup batches were denser. Receiver checkout means
varied substantially between workers, up to 46.5 ms versus 5.3 ms in one pair.

Raising that profile to six SQL connections per process in
`2026-10-13T20-31-35-672Z` did not fix latency. It accepted 5,999 / 6,000 posts
(one load-client connection reset), copied those 5,999 to every instance and
recorded 188,610 / 188,640 observations (99.98%). Visibility p95 worsened to
37.75 seconds, with no sender errors. Larger pools are not established as the
solution. These profiles remain experiments, not new production defaults.

Three workers/four connections in `2026-10-13T20-54-54-814Z` accepted all posts but
observed only 93.70% of recipients; visibility p95 was 67.79 seconds. One instance
recorded a 4.35-second selection maximum while others stayed below half a second.
The next implementation keeps the predecessor test as a correlated scalar
`SELECT ... LIMIT 1` instead of an anti join. It applies the same recipient,
channel, pending-status and state-change conditions, while preventing the planner
from expanding that check into a broad join before applying the outer head limit.
All 42 native integration tests passed after this query-shape change.

Final correlated-query profile: `2026-10-13T21-10-16-368Z`, two workers/four SQL
connections per process, 32 sends in flight. All 6,000 posts were accepted and
observed by their authors, all six instances committed 6,000 copies, all 188,640
recipient observations arrived, and all 3,000 streams remained connected.
Native sender/API errors were zero. Post p95 was 365.4 ms; visibility p95 improved
to 14.94 seconds. **Delivery completeness is now established for this workload;
the three-second visibility target remains unmet.** Run-owned container memory
peaked at 4.54 GiB, with host generator RSS at 732.5 MiB separately. Container CPU
peaked at 2,759% in the sampled data (sum across processes, using logical CPUs).
The captured head plans show limited correlated predecessor subplans. Lifetime
selection maxima stayed below 353 ms across instances, including setup, rather
than the multi-second outliers in earlier profiles.

Sampled measurement receiver checkouts still averaged 15.82 ms and sender
checkouts 11.50 ms; these waits overlap transaction/transport stages. They are the
next profiling priority alongside sustained pipeline/commit scheduling. Increasing
SQL pools or worker count alone did not fix the latency. This profile has a
90-connection application budget, with the fixture allowing 100. It uses
experimental batch/interval/concurrency, transport-rate and buffer settings;
production defaults remain unchanged. All run-owned containers and temporary
test database fixtures were removed. The saved reports retain earlier failed
experiments as well as the final complete-delivery result.
