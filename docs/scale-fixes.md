# First scaling fixes

These changes target repeated work and transport recovery without increasing hosting
resources or caching permission decisions across requests.

| Change | Purpose | Important boundary |
| --- | --- | --- |
| Cancel completed watchdogs and diagnose private HTTP failures | Reduce timer churn; distinguish transport failure and invalid responses | Retains Prosody's verified default transport, five-second deadline and fail-closed policy |
| Batch room heartbeat writes and suppress fresh-heartbeat notices | Reduce commits and full browser refreshes on each poll | Stale recovery, role/state changes and revocation still notify |
| Scoped `read` and `rooms` SSE notices | Read marks refresh overview/inbox; room changes refresh room views | Account/permission/profile notices retain full refresh behavior |
| Timeline content hints and page-scoped author/channel rendering | Avoid room-detail reloads for message-only updates and repeated metadata queries per page | Mixed metadata notices conservatively force refresh; API access checks, personal blocks, avatars and contact names remain reader-specific |
| Stage at most ten bridge joins per poll | Bound initial/retry join bursts | All desired resources remain queued for later polls |
| Request archive history on the bridge listener, not every bridge author | Avoid replaying the same history on each author join | Personal room subscriptions retain history; the listener requests 100 messages |
| Deduplicate trusted room stanza IDs before bridge-only HTTP callbacks | Avoid a callback for every author resource hearing the same message | Bounded 10,000-key cache; mark only after successful callback; author echoes and personal histories still pass through; bridge replacement changes the namespace |
| Index native inventory by JID/room and scan past unoccupied channel events | Reduce repeated scans and irrelevant projection work | At most 1,000 events scanned and 100 relevant events processed per call; current policy still checked |
| Build protocol message metadata once per projection event | Avoid fetching web-only author/avatar/emoji metadata for every native recipient | Per-recipient visibility and personal block checks still apply; edits/removals retain protocol IDs |
| Prompt bounded projection catch-up | Avoid a fixed one-second pause while backlog remains | `has_more` permits a 100 ms poll schedule, with one active poll at a time |
| Batch periodic native foreign-room policy checks into the room inventory request | Replace hundreds of serial HTTP calls per poll with one request | Validates current app credentials and room grants; per-stanza checks still run |
| Batch native foreign-room receive checks over 25 ms | Remove per-recipient HTTP waits from the shared s2s stream | Current credentials/grants checked before delivery; ordered batches of 128; queue capped at 1,000 stanzas / 8 MiB plus one active batch; overload/outage closes affected clients; old sessions cannot receive resumed-session packets |
| Membership and pending-room-message indexes | Speed user membership and queued-message lookup | Additive migration 27, compatible with existing data |

The bridge callback cache is an optimization over durable database deduplication.
Peers lacking trusted room stanza IDs still use the adapter for each callback. It
does not independently authorize a message or replace native recipient checks.

## Validation

Before the full rerun: TypeScript checks/client build, 183 unit tests (one
PostgreSQL-dependent test skipped), three benchmark tests and the real XMPP
integration suite passed. The messenger browser suite passed 24 of 25 tests on its
first run; the timed-out federated media test passed when repeated in isolation.
The small new recovery-runner change is also checked by the following integration
and load runs.

Playwright's default output directory initially overlapped `test-results/` and
cleared the earlier benchmark artifacts. That interrupted one rerun. Its output
directory is now `test-results/browser`, separate from benchmark results. The
earlier observations in `scale-review.md` remain the recorded baseline; a recovered
summary under `test-results/comparisons/baseline-summary.json` contains reported
metrics, **not recovered raw telemetry**. The interrupted run is excluded from
performance comparisons. No production database was used by these tests.

Connection pooling was evaluated and removed before shipping. Inspection of the
pinned image's `prosody/net/http.lua` found that response cleanup closes persistent
connections while cancellation can return a failed connection to the experimental
pool. Enabling that pool did not provide a reliable optimization. Fixing/upgrading
that dependency needs separate validation; normal transport remains active.

The first completed follow-up,
`test-results/five-instance/2026-10-12T01-11-59-525Z/report.json`, includes the first
changes and the now-removed pooling experiment, **not** the later batched native
policy check. It used 100 retained history messages per room, uniform transport
scheduling, 240 seconds of warmup and 120 seconds of measurement. All 400 initial
bridges joined and their history projection caught up before native ramp. This
improves the prior missed cold-start gate; it is not a controlled latency comparison
against the old empty-history, shorter-warmup run.

That follow-up still failed active chat: private adapter requests timed out and all
native clients disconnected. It accepted 14,977 / 15,000 web posts; posting p95 was
724 ms and observed web visibility p95 67.8 seconds. Those samples follow native
collapse and must not be presented as healthy mixed capacity. Queue/callback logs
and synthetic database snapshots are retained. The next run checks the final
transport and batched native validation; its result follows below.

## Final code validation and measurements

The final TypeScript/client build and 184 unit tests passed (one PostgreSQL test
skipped), as did all three benchmark tests and the real XMPP integration suite.
Focused browser tests for live exchange/history, edits, invitation/revocation and
inbox updates passed after the content-only timeline fast path was added.

The repeated five-fixture diagnostic is
`test-results/scale-diagnostics/2026-10-12T01-34-24-853Z/probes.json`:

| Diagnostic | Earlier operations | After operations | Reduction |
| --- | ---: | ---: | ---: |
| Latest 100-message page (single-author seed fixture) | 615 | 119 | 80.7% |
| Native poll: 33 events / 825 deliveries | 15,107 | 7,814 | 48.3% |
| Native poll: 100 events / 2,500 deliveries | 35,502 | 13,402 | 62.2% |

These counts exclude internal database change-tracking SQL. The single-author
fixture benefits especially from metadata reuse; a page with 100 different authors
has fewer repeated lookups to eliminate. Native direct batch timings improved from
roughly 400 ms to 242–268 ms for the 100-event fixture. The idle 500-session poll
still performs 5,002 operations in 32–35 ms. The membership plans now use
`memberships_user_channel` instead of a full index scan. FWDXP fanout is unchanged:
that separate delivery protocol still needs a broader consolidation change.

`test-results/five-instance/2026-10-12T01-34-14-150Z/report.json` checks the batched
native policy and protocol rendering changes with empty archives, uniform mixed
scheduling, 180 seconds warmup and 60 seconds measurement. It predates the final
content-only timeline optimization. All clients completed bootstrap, but adapter
response/connection timeouts still disconnected the native clients during warmup.
It accepted 7,469 / 7,500 web posts with post p95 467 ms and observed web visibility
p95 37.75 seconds. None of the 2,500 offered native posts completed. The different
duration, scheduling and warmup mean this is not a controlled percentage latency
comparison against the first run. **The 10,000-member target remains unmet.**

A five-instance tier with 500 members per instance (400 web / 100 native), retained
history and the final content hints follows. Its purpose is to find whether the
current transport failure also appears well below the large target, while validating
the final UI/protocol workload together.

The 2,500-member tier before receive-check batching is
`test-results/five-instance/2026-10-12T01-49-12-302Z/report.json`: all 500 native
clients remained online, all 1,000 offered web posts were accepted, but only
64 / 250 native posts received self-echoes within the observation window. Native
self-echo p95 was 41.6 seconds. The missing bridge joins/forwarding meant it did
not reach healthy steady state or meet the target.

After receive batching,
`test-results/five-instance/2026-10-12T02-00-53-056Z/report.json` retained all 500
native clients and accepted all 1,000 web posts; 168 / 250 native posts received
self-echoes, with p95 34.2 seconds. Warmup was also extended from 60 to 90 seconds,
so the difference cannot be attributed solely to batching. Bridge author joins and
forwarding still lag, and observed web visibility p95 was 31.1 seconds. Both tier
runs fail the end-to-end target despite connection stability. The receive-batching
path passed the real XMPP integration suite, including foreign native rooms, MAM,
roles and revocation. These are useful reductions in repeated work, **not a claim
that 2,500 or 10,000 active mixed users are production-ready**.

Next investigate the remaining bridge poll/dispatch and s2s join/acknowledgement
delays using the retained logs and database snapshots. Increasing hardware or
loosening authorization/timeouts has not been used to disguise this failure.

The final 100-member validation,
`test-results/five-instance/2026-10-12T02-12-03-300Z/report.json`, passed after all
code changes. All 150 web posts were accepted and all 50 native posts confirmed;
the 25 native clients stayed online. Web post p95 was 36 ms, native self-echo p95
874 ms, and observed visibility p95 was 1.58 seconds native / 2.46 seconds web.
This small functional load does not override the failed larger tiers.

## Three instances, 1,000 active members each

The October 12 run is
`test-results/five-instance/2026-10-12T12-50-25-171Z/report.json`, with
`interpretation.json`, logs, telemetry and all three synthetic database snapshots.
The harness now accepts `--instances`; room routing, bootstrap expectations,
container cleanup and offered delivery counts use that instance count. Per-room
offered counts make recipient expectations accurate for uneven membership.

Configuration: three hosts, each with 750 web and 250 native clients; 99 shared
rooms (33 authoritative rooms per host), 10 retained history messages per room,
60-second native ramp, 20-second web/boot ramps, 120-second active-chat warmup,
120-second measurement and 20-second delivery drain. Each member schedules one
post per minute, for 50 posts/second globally. About two thirds of assigned rooms
are foreign to each client's home instance. This is a different topology and load
from the historical five-host tiers, not a controlled before/after comparison.

All 198 initial bridges joined and caught up; all 750 native clients completed
room joins/MAM, and all 2,250 web clients completed initial reads. During chat
warmup all native clients disconnected, so the measured phase is classified as
`chat-load-with-incomplete-warmup`, **TARGET NOT MET**.

| Measurement | Result |
| --- | ---: |
| Measured offered posts | 6,000 |
| Web API accepted | 4,493 / 4,500 (99.84%) |
| Native socket writes / self-echoes | 0 / 0 of 1,500 scheduled |
| Web streams retained | 2,250 / 2,250 |
| Native clients retained | 0 / 750 |
| Web API post p95 | 444 ms |
| Observed web message visibility p95 | 15.68 s |
| Web recipient observations | 34,745 / 136,440 (25.47% of offered deliveries) |
| Native recipient observations | 0 / 45,540 |
| Bridge resources joined at end | 216 / 1,500 desired |
| Queued bridge posts at end | 5,866 |

Expected observations include the failed native offers; they measure completeness
of the requested workload, not only successfully submitted messages. Missing
observations have no latency sample. All 2,250 web clients also had pending refreshes
at stop. App measurement peak RSS was 257–262 MiB per host; worst one-second
event-loop p95 samples were 343–496 ms.

Prosody reports adapter response timeouts for sync, remote-room checks and
operations. Completed backend adapter calls were below 441 ms in recorded service
timing, but that timing excludes earlier network/admission delays and unfinished
requests. Dispatch callbacks also recorded 17 HTTP 403 responses. These observations
keep private HTTP transport, bridge joins and dispatch scheduling as the next
investigation; they do not isolate a root cause or justify hardware sizing.
Reducing to three hosts therefore did not establish healthy 1,000-active-member
capacity per instance. This run's six containers and network were removed; other
Docker services were preserved.
