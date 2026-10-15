# Benchmarking active chat users

For a same-host comparison of room delivery against Prosody and ejabberd, see
[room delivery parity](parity-benchmark.md).

Run from the repository with Node 24+ and `npm ci` dependencies installed:

```sh
npm run benchmark
```

The default workload uses **10,000 distinct authenticated users**, one SSE connection
per user, 100 members-only timeline channels (100 members each), and one post per
user per minute: **166.7 scheduled chat posts/second**. Each channel starts with 100
history messages. Connections ramp for 30 seconds, activity warms up for 15 seconds,
and metrics are collected for 120 seconds. Four separate generator processes drive a
separate application process with a fresh on-disk SQLite WAL database. The existing
instance and `.env` files are never used. Default production API limits remain active.
Sessions are seeded through the Store, so this measures authenticated chat, not OIDC login.

Clients consume live notifications and coalesce refreshes at the browser's 1.5-second
interval. A channel notice reads `/api/overview`; if the open channel changed, it also
reads channel details and the latest message page and updates the read mark. An
account notice adds session, emoji, and channel-list reads. This approximates the
foreground timeline API path, including the feedback from read-mark notifications.
It excludes DOM rendering, browser initial boot/static assets, scrolling older pages,
and other views. All users have one open channel and one membership.

Posts follow an **open-loop schedule** distributed across users. If the generator
cannot issue a due post within its concurrency budget, the post is counted as dropped;
it is never silently slowed to match the server. Post latency includes scheduler lag.
Refresh latency includes waiting for a generator slot. HTTP deadlines and latency
include waiting in the connection pool. This makes generator overload visible.

The output directory is `test-results/benchmarks/<timestamp>/`, containing:

- `report.md`: readable results and pass/fail checks.
- `report.json`: endpoint/status counts, merged latency histograms summarized to
  percentiles, workload configuration, environment, and resource peaks.
- `telemetry.ndjson`: one-second server/generator observations.
- `fixture.sqlite`: synthetic data only; session plaintext is passed over process IPC,
  and is not written to the report. SQLite WAL files may also remain after interruption.

Pass criteria are all requested streams connected without failures, at least 99% of
expected posts offered and successful, less than 1% HTTP errors, post p95 at most one
second, refresh p95 at most three seconds, and generator event-loop p95 below 100 ms.
The thresholds are initial service targets, not published Archipel capacity guarantees.
Exit code 2 means the target was missed and results are still saved; 1 is a harness error.
Histograms use logarithmic buckets with up to 5% percentile rounding. In-flight work
from the measured interval is drained at the end and belongs to that interval.

Useful variants:

```sh
# Quick validation of the harness.
npm run benchmark -- --users 20 --channels 2 --workers 1 --ramp 1 --warmup 2 --duration 8 --message-interval 2

# More aggressive writing: 1,000 scheduled posts/second.
npm run benchmark -- --message-interval 10

# Public channel notices reach every approved connected user. Compare this separately.
npm run benchmark -- --visibility public

# Longer steady-state measurement.
npm run benchmark -- --duration 600
```

Use `npm run benchmark -- --help` for all controls. If generator lag is high, compare
runs with more workers/concurrency; increasing concurrency can also make server queueing
worse. A run on one workstation cannot establish a rented VPS's capacity: generators
share its CPU, disk and network stack, and the local route excludes TLS, reverse-proxy,
and Internet costs. XMPP, remote federation, media uploads/downloads, identity-provider
login, push subscribers, more memberships, and a larger retained archive require their
own workloads before estimating production capacity. The fixture uses `createApp`;
production background federation/push timers and Prosody are not running.

The current harness starts its measured interval after a fixed warmup, without a
barrier confirming every client's initial page load has finished. Under overload,
results can combine startup backlog with ongoing chat. Its refresh percentile
includes generator admission time and covers completed cycles; unfinished refreshes
must also be assessed through pending counts and age. See the
[five-instance scale review](scale-review.md) for interpretation of the first
10,000-session result, native-XMPP adapter probes and the next workload specification.
Run `npm run benchmark:diagnose` to repeat the targeted five-fixture diagnostics;
these are not a full native-client load generator.

## Five real instances with native clients

With Docker running, use the executable mixed-client harness:

```sh
npm run benchmark:five -- --duration 600

# Three instances with 1,000 active members each (750 web + 250 native).
npm run benchmark:five -- --instances 3 --members 1000 --native 250 --rooms 99 --history 10 --warmup 120 --duration 120
```

The default creates five isolated Linux application containers, independent SQLite
databases and five pinned Prosody containers. Each instance has 2,000 members:
1,500 web protocol clients and 500 real native clients. One hundred authoritative
rooms are shared across all five origins; 20 rooms live on each host. Each room has
15 web and 5 native participants from every origin. Native clients connect to their
home server over TLS and reach foreign rooms through s2s; foreign web channels use
explicit XMPP bridges. FWDXP delivery is a separate workload.

Use `--instances` to change the number of hosts. The global room count must be
divisible by that number. Delivery expectations use each room's actual offered
post and receiver counts, including workloads with uneven membership.

The harness waits for all services and bridge subscriptions, then ramps native
clients over 120 seconds. Every native client must bind, receive room self-presence
and finish a MAM request. Web clients subsequently connect SSE and complete their
initial API reads. Only then does chat begin, with 120 seconds of warmup followed
by measurement (120 seconds by default, 600 in the command above). Pre-existing
archive seed messages are excluded from the live projection outbox. Native room
nicknames include the origin instance to avoid cross-origin collisions.

If bootstrap fails, the report says which phase failed and does not claim
steady-state throughput. Results distinguish web API acceptance, native socket
writes, native room self-echoes and first observed delivery. A successful API write
to a bridged channel does not by itself prove foreign-room delivery. Missing
deliveries have no percentile sample. Native history/authentication and protocol
traffic are real; web DOM rendering, web TLS/proxy, OIDC login and WAN latency are
excluded. Applications, Prosody and generators share this workstation, alongside
its other running services, so this is not a VPS sizing certificate.

Reports, one-second telemetry, bootstrap Docker resource snapshots, synthetic
database snapshots and container logs are saved under
`test-results/five-instance/<timestamp>/`. Run-specific credential manifests are
deleted at shutdown. The harness removes only its uniquely named containers and
network. Use `npm run benchmark:five -- --help` for a smaller validation workload
and all controls. See [the scale review](scale-review.md) for measured results,
limits and prioritized improvements.

## Signed FWDXP between instances

`npm run benchmark:native` separately measures committed plain local posts across
one and four native Rust worker processes, using `ARCHIPEL_TEST_POSTGRES` and a
release executable from `npm run build:native`. See the
[native server slice](native-server.md) for the supported paths and resource bounds.
This microbenchmark is separate from the signed FWDXP workload below.

PostgreSQL has a separate targeted path benchmark, `npm run benchmark:postgres`,
using `ARCHIPEL_TEST_POSTGRES` and fresh temporary schemas. See the
[PostgreSQL optimization results](postgres-optimizations.md) for the setup,
query-count measurements, correctness checks and remaining limitations. The
FWDXP Docker harness below defaults to SQLite and supports isolated PostgreSQL
schemas with `--postgres 1`. Backend settings are recorded in each report.

```sh
npm run benchmark:fwdxp -- --instances 3 --members 1000 --rooms 99 --peer-rate 1000 --inbox-rate 2000
```

This workload uses three independent Linux Node/SQLite instances and 1,000 active
web protocol users per instance. All 99 channels are shared through FWDXP, with
33 authoritative homes on each instance and one assigned conversation per member.
No native XMPP clients, Prosody servers or XMPP bridges run. Each member offers one
post per minute: 50 posts/second globally, with 120 seconds each of active warmup
and measurement, then a 20-second observation drain.

Subscription bootstrap uses actual actor discovery, signed Follow/Accept, signed
history and roster requests. Setup alone uses a 1,000-delivery round, 100 ms round
interval, no per-peer cap and 100,000 incoming requests/minute. After every follow
is accepted and the setup queues drain, the apps reset to the recorded chat limits
before web startup. Default chat settings for this harness are 1,000 deliveries
per minute per peer, 2,000 incoming federation requests per minute per client
address, and the production default of 20 deliveries per round with 1,000 ms
between completed rounds. These are explicit test settings; production defaults
and deployment configuration are unchanged. `--peer-rate`, `--inbox-rate`,
`--batch`, `--interval` and `--concurrency` support other pacing profiles.
`--concurrency` defaults to 4 and accepts 1–32 independent deliveries in flight.
`--postgres 1` uses a fresh PostgreSQL 17 container with an isolated schema per
instance. Add `--native-chat 1` for compiled Rust posting, pages and read marks
through the existing APIs. This requires a prebuilt `archipel-native:dev` image.
Native completion/fallback/error counters are recorded; passing requires completed
native posts/pages without unsupported fallbacks. Authentication, overview, signed
delivery and supported inbox receipt also use Rust. Membership/history bootstrap
and unported APIs retain compatibility. PostgreSQL runs save JSON message/queue
summaries; SQLite runs retain database snapshots. Front-end RSS/event-loop metrics
cover Node. `resources.ndjson` samples every run-owned container (including Rust
children and PostgreSQL) every ten seconds during chat; host generator RSS is
reported separately. Reports record sampled peaks, source hashes and the native
image ID. These samples exclude peaks between samples and unrelated services.

For six instances and 3,000 total active members, use 500 members per instance and
a room count divisible by six, for example:

```sh
npm run benchmark:fwdxp -- --instances 6 --members 500 --rooms 96 \
  --postgres 1 --native-chat 1 --native-workers 2 --native-pool 4 \
  --history 100 --native-history 1 --bootstrap-timeout 900 \
  --peer-rate 2000 --inbox-rate 4000 --batch 100 --interval 100 --concurrency 8
```

For one channel hosted on the first of eight instances, with 2,000 users there
and 200 on each other instance, use explicit populations and a zero-based room host:

```sh
npm run benchmark:fwdxp -- --instances 8 --members-per-instance 2000,200,200,200,200,200,200,200 --rooms 1 --room-host 0 \
  --postgres 1 --native-chat 1 --native-workers 2 --native-pool 4 \
  --history 0 --bootstrap-timeout 900 \
  --message-interval 600 --warmup 120 --duration 600 \
  --peer-rate 0 --inbox-rate 10000 --batch 100 --interval 100 --concurrency 32 --postgres-buffers 512
```

All 3,400 users subscribe to the same channel. A 600-second per-user message
interval offers 0.1 messages per user per minute: 340 per minute globally, or
5.67 per second. The ten-minute measured interval schedules one post per user.
Delivery expectations, bootstrap barriers, stream checks and reports use each
instance's actual population. The channel's home instance has no foreign
subscriptions; other instances use real signed Follow/Accept to join it.
These commands use explicit fixture pacing and process/pool budgets.

This is a capacity experiment, not a confirmed production sizing recommendation.
`--native-workers` and `--native-pool` select the process and connection budgets.
Two workers with four connections each reserve up to 15 database connections per
instance, including the supervisor, dedicated sender and Node SQL/LISTEN connections
(90 across six instances). The fixture sizes PostgreSQL's connection limit from
the selected budgets, with ten connections reserved for diagnostics/startup.
Production defaults remain unchanged.

Native workers with a four-connection budget partition it into three foreground
connections and one reserved receiver connection. The overall PostgreSQL limit
does not increase. Receipt can borrow immediately idle foreground connections
when its reservation is occupied. The fixture PostgreSQL container has a recorded
512 MiB `/dev/shm` limit, avoiding Docker's default 64 MiB dynamic shared-memory
ceiling; allocated memory still counts in resource samples. Timer calls use
non-draining native ticks so a slow peer does
not stop independent slots being refilled. The pause/shutdown handshake explicitly
drains in-flight jobs without selecting new work before receivers stop.

`native-stages-<instance>.ndjson` records authenticated native stage snapshots every
ten seconds, including sender selection, policy, discovery, signing, HTTP, pool
acquisition and receiver lane/activity/channel waits. The corresponding JSON file
contains the last snapshot. After a run, use:

```sh
node scripts/interpret-native-stages.mjs test-results/fwdxp/<timestamp>
```

This writes `native-stage-summary.json` with differences between samples nearest
the measurement boundaries. Nested timers overlap and concurrent work is summed;
the result is a sampled interval, not a decomposition of wall time. Lifetime
maxima include setup and are excluded from that summary.
Native sender RPC failures are counted separately from API errors and prevent a
passing native capacity result, even if accepted posts and streams look healthy.

`--native-history 1` joins initially empty rooms through real signed Follow/Accept,
then posts the requested seed history through Rust using each room owner's current
session and permissions. Delivery queues must drain and every room on every replica
must contain exactly the configured history before web clients start. This excludes
the unported existing-history Accept/bootstrap path from setup; it does not change
the measured user posting rate, signatures, delivery or page permissions. Without
this flag, history is present when each subscription joins. A 100-message legacy
history bootstrap can exceed the default five-minute fixture startup limit.

Native message pages expose a refresh cursor and fingerprint. The current snapshot
checks the previous 100-message window and author tuple versions before returning
only appended records. Changes and overflow return the full current window. The
web client and generator use this optimization for content refreshes; metadata
notices still reload full pages. Browsers viewing expanded history keep refreshing
all loaded pages. Replica/recipient completeness and latency checks remain the same.
Failed initial web refreshes retry through the same bounded queue. Startup
attempt/failure/status counters are reported separately; they do not disappear
when chat measurement begins. An incomplete bootstrap remains a setup failure,
not a measured chat result.
Optional `--profile 10` records ten seconds of CPU samples from each app during
measurement; profiling adds overhead, so use a separate unprofiled capacity run.

Docker instances share an isolated loopback network namespace so the supported
development HTTP transport can reach peers. Each app still has its own process,
database and signing key. A transparent port forwarder exposes only this run's
web ports to host generators. RSA request signatures, origin proofs, current
policy, inbox size limits, deduplication, per-recipient queues and retry behavior
use the real implementation. HTTPS/proxy/WAN cost and browser rendering are
excluded, so this does not establish rented-server capacity.

Reports under `test-results/fwdxp/<timestamp>/` separate API acceptance (remote
posts are queued) from authors seeing their committed posts, recipient observations
and measured-marker messages actually committed on each instance. Pass checks
require at least 99% of offered posts copied to every instance and observed by
recipients, plus retained connections and latency targets. Expected observations
use actual offered counts and membership for each room. Pending composer entries
are not counted as committed messages. Reports also retain wire status counts,
queue states/retries, physical POST and per-recipient attempt counters, logs and
synthetic database snapshots. A shared inbox POST can complete several recipient
rows; row counts alone do not measure network request volume. Cleanup removes only
the run's named containers and credential manifests.

Use `npm run benchmark:fwdxp -- --help` for all controls. The small validation uses
`--members 12 --rooms 3 --history 2 --ramp 1 --boot-ramp 1 --warmup 10 --duration 10
--message-interval 10 --timeout 10` and exercises all signed delivery stages.

`node --import tsx scripts/benchmark-native-queue.ts` profiles the current routing
index SQL in a temporary schema on `ARCHIPEL_TEST_POSTGRES`. It requires an isolated
test database with `pg_stat_statements` preloaded. The probe creates 48,000 pending
rows across 480 lanes, completes 300 five-recipient groups, checks heads against
the durable queue, and saves nested statement timings to
`test-results/native-queue-write-profile.json` (or its first argument). It drops
its temporary schema on exit. Single-connection SQL timings exclude signatures,
network, readers and contention; use the FWDXP workload to establish capacity.

## Channel event transports

Implementation details and completed high-population measurements are in
[Channel event transport measurements](channel-stream-benchmarks.md).

FWDXP runs accept `--channel-transport off|batch|stream` (default `stream`).
`off` exercises legacy follower delivery rows; `batch` and `stream` consume the
same durable channel log once per peer. Snapshots and telemetry include channel
log tails, receiver cursors, transport counters and recovery errors. Queue counts
alone no longer describe broadcast backlog. Replica message counts and receiver
observations remain the pass criteria; SSE connection counts do not prove receipt.

Native workers now handle supported Follow admission and outgoing queues during
setup, with the existing compatibility path handling Accept/history/roster reads.
For negotiated channel consumers, concurrent admissions share the first bounded
history/roster fetch and import; subsequent local followers reuse that channel
copy. Each individual Follow/Accept still authenticates and retains its admission.
The native-history barrier waits for seed messages committed on every replica,
including deliveries through streams, before opening web clients.

Use small runs for timing checks while changing transport code. High-population
measurements should start only after streaming receipt, replay and atomic cursor
checks pass. Keep measured runs separate from other benchmarks and test workloads.

## One large instance with listening peers

Schema 31 benchmarks negotiate one origin stream carrying clear public events
and encrypted private events. The fixture's room is private. Browser protocol
clients opt into shared message deltas, read compact channel metadata and
coalesce read acknowledgements for 30 seconds. This exercises transport and API
work without DOM layout or rendering. Reports include raw intake/materialization
counters and origin cursors separately from channel import cursors. Per-message
full-page reads are no longer expected; `liveDeltaMessages` proves incremental
delivery when no page refresh is needed. The same offered, accepted, committed
and observed-message criteria still apply.

`--listener-only-peers 1` keeps web clients and scheduled posting on the explicit
`--room-host`. Other instances retain real identities, signed admission and
durable channel consumers, but open no web clients and offer no posts. Use one
fixture identity per listening peer in `--members-per-instance`; these identities
are excluded from active-user and recipient-observation counts. All replicas
must still commit the measured messages.

`--web-workers 8` shards each active instance's generators across eight processes.
Global user indices and the instance's original scheduling denominator remain
unchanged, so sharding does not multiply the offered rate. The `--inflight` limit
applies to each shard. Telemetry sums their CPU/RSS and takes the worst shard's
event-loop p95; generator manager/root process overhead is additional. Histograms
are merged by sample counts rather than averaging percentiles.

For 10,000 local users at 40 posts/second, with twelve listening peers:

```sh
node scripts/benchmark-fwdxp.mjs --instances 13 \
  --members-per-instance 10000,1,1,1,1,1,1,1,1,1,1,1,1 \
  --rooms 1 --room-host 0 --listener-only-peers 1 --web-workers 8 \
  --connect-retries 2 \
  --postgres 1 --native-chat 1 --native-workers 4 --native-pool 4 --channel-transport stream \
  --history 100 --native-history 1 --ramp 120 --boot-ramp 120 --bootstrap-timeout 900 \
  --message-interval 250 --warmup 30 --duration 120 --inflight 16 \
  --peer-rate 0 --inbox-rate 10000 --batch 100 --interval 100 --concurrency 32 --postgres-buffers 512
```

This offers 10,000 / 250 = 40 posts/second from the local instance, independently
of the twelve peer identities. Every local client must complete initial reads
before measured chat. Optional `--connect-retries 2` retries failed initial SSE
connections after two seconds; attempts, status/error codes and recovered setup
failures remain recorded. Connection failures after setup still fail the retention
check. PostgreSQL runs now save independent final database
snapshots after application shutdown, retaining the application's original
snapshots as `app-snapshot-*.json`. This preserves replication evidence when the
compatibility database worker fails during the test. These instances still share
one workstation and PostgreSQL server; separate the local, peer and database
resource samples before interpreting hardware capacity.
