# Five-instance scale review

See [the implemented scaling fixes and follow-up validation](scale-fixes.md).
The original raw benchmark directories described below were cleared by a
Playwright output-directory collision during follow-up testing. Their recorded
results remain here; `test-results/comparisons/baseline-summary.json` preserves
the reported comparison metrics without claiming to reconstruct raw telemetry.
Browser output now uses its own subdirectory.

The intended baseline is five independent stacks with **2,000 local members each**:
**1,500 foreground web users and 500 native XMPP users per stack**. That is 7,500
web sessions and 2,500 real native clients overall, not 10,000 web sessions plus
2,500 extra native clients. Native users are included in the 2,000 accounts.
The initial writing rate remains one message per member per minute: 33.3 posts/sec
per instance and 166.7 across the cluster. Native users account for 8.3 posts/sec per
instance, web users 25. The [workload specification](five-instance-benchmark.json)
defines separate local-room, cross-instance XMPP and optional FWDXP phases.

The user's selected emphasis is **rooms shared by all five instances**, replacing
the earlier ring topology. The primary phase has 100 authoritative XMPP rooms,
20 hosted per instance. Every room has 15 web and 5 native members from each of the
five origins: 100 participants in total. Thus 80% of each origin's users participate
in a room hosted elsewhere. Web users use ordinary Archipel channels with explicit
bridges for foreign rooms, so they share the native clients' actual conversation.
FWDXP stays out of this phase; it does not implicitly provide this cross-protocol path.

The native count remains 500 c2s sessions per instance. Once every web member has
posted, foreign-channel bridges create approximately **1,200 additional per-author
virtual resources per origin**. Each room host sees 500 native occupancies across
its rooms plus approximately 1,200 foreign bridge occupancies: **1,700 MUC
occupancies per host**, assuming one assigned room/resource per user and bridge
owners drawn from the participating web users. These counts are derived from the
topology and current `RemoteRooms.relay`/`occupy` implementation, not measured load.
That inventory and the bridge receive/sync paths need separate tests beyond the
500-native-session probe below.

There is a further projection-rate consequence: each instance records its own hosted
rooms' roughly 33.3 messages/sec plus approximately 133.3 messages/sec from the other
80 rooms through bridges. `RemoteRooms.bridgeIn` appends `xmpp_events` for imported
bridge messages, while ordinary local posts append events through the XMPP hook.
With relay echoes suppressed, that is approximately **166.7 projection events/sec
per instance**, above the current nominal 100-event/sec native-sync drain ceiling,
even though there are still only 500 native clients. This is a code/topology-derived
expectation requiring verification in the full run. Most bridge channels have no
native occupants in this workload, but their events still consume the scan budget.
Test filtering irrelevant channel events before the page limit or bounded immediate
catch-up, with correct cursor advancement and delivery when subscriptions change.

`RemoteRooms.sync` also writes `updated_at` for each active virtual room on every
poll. Those writes are watched as per-user room changes, resulting in `me` notices
and broad browser refreshes even if the room state/content is unchanged. At the
projected 1,200 bridge resources per origin, distinguish heartbeat bookkeeping from
user-visible room-state changes and measure this notification amplification.

Per-author room resources also multiply incoming traffic before application
deduplication. With 15 foreign web authors per room and origin, the steady shared
topology can generate roughly **2,000 `/remote-rooms/receive` message callbacks/sec
per origin** (80 foreign rooms × 15 resources × 100 participants / 60 seconds),
despite only about 133 unique foreign messages/sec. Incoming native foreign-room
stanzas additionally call the policy adapter per recipient, including presence.
These are code/topology-derived offered rates, not attained throughput. Keep the
author resources needed for attribution, but evaluate one elected/bounded bridge
ingestion path per room, batched callbacks and bulk policy validation. Preserve
per-resource acknowledgements, permission revocation and deduplication correctness.

Cold starts are harsher: every newly joined bridge resource currently requests up
to 100 history messages. Eighty owner subscriptions can therefore import 8,000
history messages per origin before active chat; 1,200 author resources could request
120,000 historical copies on a restart. Most copies are discarded by deduplication
only after an HTTP callback and policy/database work. Separate archive catch-up
from author-resource joins and stage initial/retry joins with bounded work. Do not
simply discard history without a durable cursor and recovery plan.

Splitting into five processes should reduce contention for one application's event
loop and reduce per-instance account/channel scans. Moving 25% of the users to native
clients removes their web refresh traffic, but native policy checks and archive
projection still execute in Archipel Server. These are expectations, not measured
five-stack capacity or a fivefold latency improvement. A shared room's home remains
a potential hotspot regardless of how many instances host its users.

## What the original result establishes

The original single-process Windows/SQLite run kept all 10,000 SSE streams connected.
Of 20,000 scheduled posts, 16,789 succeeded, 64 requests failed, and 3,147 were dropped
at the generator's write-concurrency limit. Thus **83.945% of the offered writes
succeeded**. The 0.204% HTTP error rate excludes the 15.735% of offered posts that
were never issued; it is not a measure of total offered-load success.

The post p95 was 2.12 seconds including admission/queueing. Refresh p95 was 124.35
seconds including waiting for one of 256 generator refresh slots. The run completed
2,972 successful refresh cycles and ended with 9,998 users having a pending refresh.
Every recorded refresh issued session, emoji and channel-list reads, consistent with
initial/full refresh work dominating. The harness does not wait for all initial
bootstrap reads before starting its measured interval. This is evidence of overload
and startup backlog, **not a clean steady-state per-message delivery benchmark**.
Percentiles over completed refreshes also omit unfinished cycles. A corrected test
must report their age/completion rate and distinguish admission delay, request time,
and first-visible message latency.

All endpoint latencies clustered near 1.7 seconds despite different handler costs.
That supports a shared queue/event-loop bottleneck. Server RSS peaked at 495 MiB,
server sampled event-loop p95 reached 797 ms, while generator event-loop p95 stayed
under 35 ms. Low generator lag does not establish unlimited generator capacity:
the bounded admission queues were visibly full. The result does not certify VPS
capacity, establish PostgreSQL performance, or measure XMPP/federation throughput.

## Targeted measurements and likely improvements

`npm run benchmark:diagnose` now builds five **independent fixtures**, each with a
fresh on-disk database, 2,000 real local identities, 20 timeline channels with 100
members each, 100 historical messages per channel, and 500 issued XMPP credentials.
It probes them sequentially. These are HTTP/adapter/queue diagnostics, not a
simultaneous native-client or federation network load test. The latest evidence is
in `test-results/scale-diagnostics/2026-10-11T23-17-35-064Z/probes.json`.
Statement counts refer to Store-visible prepared-statement operations, including
reads and writes, and exclude internal SQL issued by database change tracking.
Direct adapter timings include the light counting instrumentation.

1. **Native inventory transport: fixed for the mixed-client run.** All five fixtures
   returned **HTTP 413** for 500 authorized native sessions and 500 room occupancies.
   The actual request was **95,788 bytes**, above the **65,536-byte** generic parser
   limit in `src/app.ts:219`. The private router runs after that parser. In
   `prosody/modules/mod_archipel.lua:186`, a failed sync causes all local native
   sessions to close. The intended session/occupancy validation allows 2,000/4,000
   entries, so the byte limit is inconsistent with that intended capacity.
   The private router now authenticates before parsing, permits 1 MiB for native
   and remote-room inventories, retains 3 MiB for avatars, and keeps operations
   and public mutations at 64 KiB. A regression test exercises 500 distinct clients,
   unauthorized oversized bodies and the upper/public limits. Larger or more
   verbose inventories may still require a bounded chunked inventory protocol.
   Two rooms per client and multiple resources make the mismatch worse.

2. **Reduce web refresh amplification.** Read-mark changes produce `me` notices;
   `client/main.ts:411` then reloads the session, emoji and channel catalogue in
   addition to overview and the open channel/history. Replace this broad notice with
   typed changes such as read marks, profile, membership and permissions. Refresh
   the data that changed, and retain full refreshes for permission/identity changes
   and reconnect recovery. Prefer channel-scoped deltas/versioned invalidation over
   downloading the latest 100 messages and every member on every message notice.
   Delta handling must include edits, removals, reactions, and revocation, not just
   newer message sequence numbers.

3. **Bulk-load message/member rendering data.** In the 2,000-member fixture, one
   latest-100-message request executed **615 statement operations**; channel details
   with 100 members executed **234**, and the channel catalogue **87**. See
   `src/store.ts:2058`, `src/store.ts:2108`, `src/store.ts:1506` and
   `src/store.ts:1296`. The page already joins author names but then re-fetches users,
   avatars, channel/visibility and moderation data while decorating individual rows.
   Fetch those sets once per request, use request-local maps, and derive shared
   channel policy once. Preserve personal blocks, hidden handles and remote-contact
   names; a response cache shared indiscriminately across users would be incorrect.

4. **Batch XMPP policy checks and projection.** Idle inventory processing performed
   **5,002 operations** in about **35 ms**. A poll with 33 events produced **825
   deliveries**, **15,107 operations**, and took **182–186 ms**. These direct calls
   bypassed the failing HTTP parser solely to inspect the hidden work. Each session
   and occupant is re-authorized; `src/xmpp.ts:559` linearly searches sessions, and
   each message filters the occupant list and re-queries policy/rendering data per
   recipient. Index the current inventory by JID and room, bulk-load current policy,
   and reuse safe per-poll/message data while keeping recipient-specific filtering.
   In addition, each client stanza triggers a private HTTP authorization check in
   `prosody/modules/mod_archipel.lua:160`. Optimize that path without weakening
   immediate revocation or admitting stale policy indefinitely.

5. **Allow backlog catch-up without unbounded work.** Native sync fetches at most
   100 events per poll (`src/xmpp.ts:573`); Prosody polls once per second. The probe
   offered 167 events and observed a cursor advance of 100 with 67 still pending,
   taking roughly 400 ms for 2,500 projected deliveries. The ceiling is 100 events
   per poll and at most approximately 100/sec on the one-second schedule; slow calls
   and skipped busy rounds lower it. The balanced local workload's 33.3 events/sec
   is below that nominal cap, while a single popular shared room could exceed it.
   Add a `has_more` indicator and promptly drain bounded batches, with byte/delivery
   budgets, measured cursor lag and room fairness. Raising the row limit alone can
   create a larger synchronous pause or an oversized response.

6. **Consolidate FWDXP delivery by destination instance.** This is separate from
   XMPP s2s. `src/federation.ts:959` creates a delivery row per follower actor, and
   `src/federation.ts:1063` uses every accepted user follower as a recipient. A
   queue-only probe with 1,000 followers on **one** peer created **1,000 delivery
   rows for one post**. The duplicated activity was **75,481 bytes**, already above
   the peer inbox's 64 KiB limit. No outbound traffic was attempted in this probe.
   Design per-origin delivery with bounded recipient envelopes and current
   recipient-policy validation; retain individual follow/permission records.
   Increasing limits or worker counts alone does not remove this amplification.

7. **Treat federation defaults as pacing, not maximum capacity.** Current defaults
   allow 20 deliveries per round, wait one second after a round finishes, and cap
   each peer at 100 deliveries/minute. The round sends sequentially, and inbound
   requests are limited to 120/minute per client IP. Even one delivery per origin
   per post can exceed these defaults at the intended writing rate; per-user
   duplicates are much worse. First record a defaults run, then an explicitly
   configured throughput run. Track queue age, throttles and retries. Local tests
   must account for several peers sharing the same source IP. After consolidation,
   bounded parallelism across peers while preserving per-recipient ordering is a
   useful next experiment.

8. **Add the missing membership lookup index; avoid assuming PostgreSQL solves
   blocking.** `EXPLAIN QUERY PLAN` for membership-by-user and joined-channel queries
   scanned the whole covering membership index in all five fixtures. The primary
   key orders `(channel_id,user_id)`; add `(user_id,channel_id)` and verify plans.
   PostgreSQL currently sends each query to one worker connection and synchronously
   waits using `Atomics.wait` (`src/db.ts:388`). Hundreds of small statements would
   remain serialized and gain network/thread handoff costs. Reduce statement count
   before comparing SQLite and PostgreSQL; an asynchronous/pool-based database path
   is a broader architectural change requiring transaction and authorization tests.

Further candidates are indexing SSE streams by user/channel rather than scanning
every stream for every change, and handling `res.write()` backpressure with bounded
buffers/recovery. The original generators continuously consumed SSE; the low RSS
result does not test slow readers.

## Running the shared-room test

Use one application process, one database and one real Prosody service per instance.
Measure cold start separately and require completed web bootstrap, native SASL/resource
binding, self-presence and MAM history before steady-state measurement. Make the
100-room, all-five-origins topology above the primary phase, with balanced room
ownership and one assigned shared room per user. Keep the local-room phase as a
comparison. Native clients connect to their home server; remote web channels use
explicit bridges to the same authoritative rooms. Count the projected 1,700 MUC
occupancies per host and 1,200 virtual bridge resources per origin, rather than
assuming the only XMPP work is 500 native sessions. Keep the total posting rate
unchanged and measure bridge synchronization and per-resource receive callbacks.

Follow with 10 shared rooms (two hosted per instance), 1,000 participants per room,
and the same user count/writing rate. This keeps approximately the same aggregate
occupancy but increases recipients per room/message tenfold. A single-room test
with all 10,000 users is a separate hotspot/limit test: with foreign web bridges,
one host would have about 8,500 MUC occupancies, above the current 4,000-entry
native-sync inventory limit. Five user home servers do not distribute that room's
authoritative archive, policy or projection work.

Run ten-minute steady-state phases and report each instance separately. Measure
commit-to-first-visible latency with stable message IDs for web and native receivers,
missing/duplicate delivery, native disconnects and MAM, inventory HTTP failures,
cursor lag and federation queue age, plus CPU/RSS/event-loop delay and generator
admission lag. Follow with reconnect churn, a heavily shared room, more memberships,
and retained-history growth. Browser XMPP virtual occupants, native clients joining
foreign rooms, and FWDXP followed channels are different paths. The code deliberately
does not forward FWDXP-cached channel content into local native rooms automatically
(`src/xmpp.ts:40`); test routes must reflect the product's actual behavior.

Docker became available and the executable harness is now
`npm run benchmark:five -- --duration 600`. Its documented 120-second default is
useful for finding failures before a longer steady-state run. It launches five
real Linux application/Prosody pairs and requires service, bridge, native and web
readiness before measuring chat. Existing unrelated containers remain running.

Early Windows-hosted application experiments lost native clients even though
adapter requests returned HTTP 200. A small containerized application run retained
all 25 native clients and confirmed all 50 scheduled native posts plus all 150 web
API writes over 20 seconds. This isolates a deployment/test-path difference; it
does not establish the reason for the Windows failures or certify large capacity.
That small run also had incomplete bridge warmup, so its latency samples are not a
clean steady-state capacity baseline.

Earlier full bootstrap attempts started bridges before all peers existed. Their
join counts must not be treated as clean capacity evidence. Client nicknames were
also made origin-qualified, but Archipel MUC actually assigns foreign nicks from
the full bare JID, so duplicate requested nicks were not the cause. The corrected
harness gates bridge setup on service readiness, waits for subscriptions and excludes
static archive seed messages from the live outbox. Its latest
results follow.

### History-bearing cold start

`test-results/five-instance/2026-10-12T00-26-14-353Z/report.json` used 100 existing
archive messages per authoritative room and no live seed-message outbox events.
All five services were listening before subscriptions began. At the five-minute
bridge-readiness deadline:

| Origin instance | Joined bridges / 80 | Imported projection events | Receive callbacks |
| --- | ---: | ---: | ---: |
| 0 | 79 | 7,900 | 25,589 |
| 1 | 80 | 8,000 | 20,410 |
| 2 | 80 | 8,000 | 13,501 |
| 3 | 79 | 7,900 | 18,856 |
| 4 | 80 | 8,000 | 18,239 |

The gate stopped before native/client ramp or chat: **this is a cold bridge
bootstrap failure, not measured 10,000-user throughput**. That harness revision
labels this generic `harness-error`; subsequent runs use `bridge-bootstrap-failed`.
No Docker/setup command failed. Receive callbacks include state/subject updates
alongside messages; their 96,595 total reflects repeated work as well as the
39,800 imported events. Adapter responses were HTTP 200. Prosody logs show repeated
s2s `connection-timeout` closures and sessions destroyed with unacknowledged
stanzas. Some subscriptions eventually recovered; two still missed the deadline.
This points to history ingestion/join recovery as a priority, without proving a
single root cause. Increasing the startup deadline might admit this run but would
not remove the duplicated work.

The adapter waits for a private HTTP request inside stanza handling. Prosody's
pinned `mod_smacks.lua` defaults to a 30-second maximum acknowledgement delay.
Check whether serial history callbacks delay processing of stream-management
acknowledgements; this is a hypothesis supported by the queue/timeout pattern,
not yet a demonstrated causal result. Benchmark bounded/batched ingestion and
staged joins before changing timeouts. Disconnect recovery also reached
`async.waiter()` outside an async context in earlier attempts; ensure bounced
stanzas and disconnect callbacks use an appropriate runner while preserving
ordering, bounded queues and fail-closed policy.

### Full mixed-client attempt with empty archives

The follow-up `test-results/five-instance/2026-10-12T00-32-35-877Z/report.json`
kept the requested five-instance, 100-shared-room, 10,000-member topology and used
empty archives to isolate client/active-chat work. All **2,500 native clients**
bound, joined and completed MAM; all **7,500 SSE clients** connected and finished
their initial reads before chat began. The run used 120 seconds of chat warmup
and a 120-second offered-load measurement, followed by a 20-second delivery drain.

**The mixed-client target failed.** Native clients disconnected during warmup,
and all 2,500 were offline before the measured phase. Native errors included
`internal-server-error`, `not-authorized`, and adapter `service-unavailable`.
The application returned HTTP 200 for completed inventory/policy calls, but that
does not establish that Prosody received or processed every response. Private poll
counts/cursors stopped advancing for long periods. Investigate transport timeouts,
poll-runner liveness and fail-closed disconnects alongside database/CPU work;
the exact initiating cause has not been isolated.

| Instance | Web posts accepted / 3,000 | Native online at end / 500 | Queued bridge posts | Projection backlog | Pending web refreshes |
| --- | ---: | ---: | ---: | ---: | ---: |
| 0 | 2,983 | 0 | 4,799 | 5,873 | 1,167 |
| 1 | 2,979 | 0 | 4,794 | 5,784 | 1,229 |
| 2 | 2,982 | 0 | 4,800 | 5,746 | 1,500 |
| 3 | 2,978 | 0 | 4,797 | 5,880 | 1,500 |
| 4 | 2,965 | 0 | 4,799 | 5,866 | 1,231 |

Across the measured interval, 20,000 posts were scheduled. **14,887 / 15,000 web
posts were API-accepted (99.25%)**, with 113 failures and no generator-dropped web
posts. All 5,000 native scheduled posts failed before socket submission because
those clients were disconnected. API-accepted/confirmed throughput was therefore
124.1/sec versus 166.7/sec offered, and does not prove cross-instance delivery.
All 7,500 SSE streams remained connected without recorded SSE errors.

Web API post p95 was **444 ms**, while web first-observed message p95 was **48.18
seconds**. The latter includes scheduling, forwarding and refresh admission and
covers only observed deliveries; native visibility had no samples. Web clients
observed **223,581 of 1,500,000 expected offered message/recipient pairs (14.91%)**;
native clients observed **0 of 500,000**. Expected counts include the failed offered
posts, and are not a count of committed messages lost by the network. Missing
observations include failed writes, absent forwarding and refresh backlog. The
20-second observation drain still left 6,627 users with a pending refresh.

Stored bridge state showed only 80 joined resources of 1,200 desired per origin;
the joined flags are not proof of live sessions when heartbeats/polls are stale.
The cluster retained **23,989 queued bridge posts** and **29,149 unscanned projection
events** at shutdown. These queues and the visibility shortfall are more useful
capacity signals than the comparatively fast HTTP post acknowledgement.
Measured application RSS peaks were 279–345 MiB per process and worst sampled
event-loop p95 was 362–462 ms. Those samples were taken after native traffic had
collapsed; they cannot size a healthy full mixed workload or justify a RAM-only fix.

The historical full attempt kept aggregate offered rate steady but phased web
posts into the first 45 seconds of each minute and native posts into the last 15.
The current harness spreads both protocols throughout the minute; that improved
schedule has been validated at small scale, **not rerun at 10,000 members**. The
full attempt is classified `chat-load-with-incomplete-warmup`, not steady state.
Its telemetry/logs and derived `interpretation.json` remain available. Database
exports failed because of Docker Desktop's nested read-only bind-mount export
behavior; subsequent fixtures export their checkpointed database from inside the
container on shutdown. No offline message-content audit of this full attempt is
claimed.

### Validation and next experiments

The final small run, `test-results/five-instance/2026-10-12T00-43-50-159Z/report.json`,
used five instances with 20 members each (15 web, 5 native), five shared rooms and
10 seeded history messages. It completed readiness, 20 seconds of warmup and 20
seconds of measurement with the corrected mixed schedule. All 25 native clients
stayed online, all 50 native posts received room self-echoes, and all 150 web posts
were API-accepted. Web post p95 was 72 ms, native self-echo p95 1.18 seconds, and
first-observed message p95 was 1.83 seconds native / 2.84 seconds web. This validates
the protocol paths at small scale, not the large target. All 1,000 expected native
and 3,000 expected web message/recipient observations completed in this small run.

The production change is the authenticated inventory-parser fix described above.
`npm run check`, the full unit suite (181 passed, one PostgreSQL-dependent test
skipped), the three benchmark tests and the real `npm run test:xmpp` integration
suite passed. The integration suite was rerun idle after its timeout during a
concurrent large benchmark; its final run passed foreign rooms, shared bridges,
history, revocation, avatar federation and reconnect recovery.

Prioritize experiments in this order:

1. Instrument private HTTP outcomes and poll-runner progress so stalled/rejected/
   timed-out work can be distinguished from successful server responses. Test
   bounded HTTP connection reuse and recovery; do not weaken fail-closed policy.
2. Stage bridge joins and archive catch-up, remove repeated per-author history
   replay, and batch/elect room ingestion before application deduplication.
3. Filter irrelevant projection events and allow bounded catch-up; report queue
   age as well as cursor lag. The current nominal 100-event/sec drain is below the
   healthy shared topology's expected 166.7 events/sec per origin.
4. Replace read-mark/heartbeat-driven full web reloads with scoped changes, and
   bulk-load rendering/policy data. Validate visibility coverage, not only HTTP p95.
5. Repeat increasing member tiers, then the full corrected mixed schedule with
   retained history and ten minutes of healthy steady state on representative
   hosting hardware. The present failure does not establish a monthly hosting
   cost for a reliable 10,000-active-user deployment.
