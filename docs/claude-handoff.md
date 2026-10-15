# Federation performance handoff

The user requested committing the current work to `main` and winding down
benchmarks to continue in Claude. The final benchmark completed normally;
there are no remaining run-owned containers or benchmark Node generators.
Unrelated `.claude/` and `marketing/` files were left out of the commit.
No push was requested.

## Implemented

- Schema 30 channel logs and schema 31 commit-ordered origin logs, with
  equivalent SQLite/PostgreSQL triggers and native schema upgrades.
- One multiplexed origin stream for negotiated public and private channels;
  immutable shared frames; AES-256-GCM private payloads and admission/access
  driven key epochs. Legacy inbox and channel-feed fallback remain supported.
- Durable bounded raw intake before metadata resolution; independent bounded
  channel materialization, atomic channel checkpoints and replay/retention.
- Indexed legacy-only recipient lookup on publication, cached routing on
  control changes, and no follower enumeration for negotiated publication.
- Shared browser message projections and encoded buffers, cached connection
  routing, paged rosters, phased read acknowledgements and unread watermarks.
- PostgreSQL synchronous worker handoff race fix, plus expanded correctness
  tests and benchmark instrumentation/sharded generators.

See [implementation and validation](constant-work-implementation.md),
[protocol](fwdxp.md) and [benchmark results](channel-stream-benchmarks.md).
Delivery/network writes and recipient-specific filtering still scale with
active connections. Hidden thread/topic preferences use legacy reconciliation.
Older admissions without `instance_start` need leave/rejoin to negotiate the
origin feed. This is not a claim of constant total instance work or a proven
40-post/sec capacity.

## Validation already performed

TypeScript checks, client/server builds, Windows Rust release and Linux native
image builds passed. Federation, HTTP delta/privacy, paged roster, PostgreSQL
migration/handoff/query bounds and native integration checks passed as recorded
in the implementation note. The broad native run initially had an outdated
message-notice expectation; it was updated and affected tests rerun successfully.
A real Chromium/native test passed live deltas without message-page requests,
composer/focus preservation, old edits/deletes and unread overlap handling.
All ten benchmark harness tests passed. No new broad test run was started for
the handoff.

## Final population results

Both complete runs used 10,000 local web clients, twelve real listening peers,
one private room, PostgreSQL/native workers, and 40 offered posts/sec for 120
seconds after all initial reads completed. Both failed the target.

| Run (UTC directory) | HTTP success / failure / dropped | Home commits | Peer copies | Recipient observations |
|---|---:|---:|---:|---:|
| `2026-10-15T03-15-20-361Z` | 1,084 / 501 / 3,215 | 1,530 | 1,448–1,530 | 26.67% |
| `2026-10-15T03-33-11-309Z` | 665 / 715 / 3,420 | 1,357 | 1,212 each | 21.91% |

Both retained all 10,000 streams. The second includes shared encoded buffers
and phased reads; it did not establish a performance improvement. HTTP timeout
does not imply rollback, so commit counts can exceed HTTP successes. Peer
counts at shutdown measure backlog/deadline completion, not permanent loss.
The earlier `2026-10-15T01-22-06-613Z` attempt never completed initial reads,
so its extra posting phase is not a controlled steady-state comparison.

Raw reports, telemetry, native stage samples, SQL statistics and independent
post-shutdown PostgreSQL snapshots are retained locally in
`test-results/fwdxp/<run>/`. That directory is intentionally ignored by Git;
the committed benchmark notes preserve the conclusions. The small full-path
smoke `2026-10-15T03-03-40-020Z` passed 48 posts and all 1,152 observations
with 24 readers and two peers.

## Next investigations (not implemented)

1. Profile the source event loop and attribute PostgreSQL work before further
   changes. In the first complete run the source event-loop p95 reached 3.64
   seconds. A single Node TCP forwarding process used about 1.07 cores on
   average, so the harness itself is a material confounder. Consider a
   multiworker/native forwarding layer before interpreting capacity results.
2. Inspect `InstanceFeed.page()` repeated publication-policy checks on cache
   misses for staggered peer cursors. A bounded per-event policy/frame cache
   invalidated by control revisions may help, but this is an unprofiled
   hypothesis. Existing SQL statistics include substantial settings reads.
3. Inspect cold Follow supersession in both TypeScript and Rust follower
   UPSERTs: `stream_start` resets when the Follow ID changes, but
   `instance_start` may retain the old value through COALESCE. If Undo was
   lost, a replacement Follow could retain an expired origin boundary.
   Normal unsubscribe/rejoin coverage passes because it deletes the old row.
   Consider clearing `instance_start` on changed Follow ID and add that
   specific regression test. No fix was made during wind-down.

The existing `archipel-native-port-pg` service on port 62688 was left running.
Use `docs/benchmark.md` for workload commands; do not restart population
benchmarks without the user's next instruction.
