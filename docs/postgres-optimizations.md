# PostgreSQL performance work

The October 12 changes address PostgreSQL's database round trips directly. The
SQLite FWDXP load results do not establish PostgreSQL capacity.

## Changes

- Latest message pages load all authors and avatar references with one bounded
  join instead of three queries per distinct author. Aliases, blocks, admission,
  reactions, hidden threads and emoji bans remain fresh for every reader. This
  improves both databases; persistent page caching remains SQLite-only, avoiding
  stale PostgreSQL data from other database connections.
- Batched write operations use their existing operation savepoint instead of an
  additional savepoint/release for every statement. Ordinary transactions retain
  statement-level recovery when a caller catches a SQL error. Batched storage
  failures roll back the whole batch; even a swallowed SQL error prevents an
  aborted transaction from being acknowledged. Responses still await commit.
- Simple SELECT `get()` calls are bounded to one row in PostgreSQL. Comments,
  compound command text and CTEs retain their original SQL. First-row and
  affected-count operations no longer transfer unused rows from the worker thread
  to the application.
- Connection statistics count SQL driver calls, application queries and
  transferred rows, exposing the savepoint/IPC overhead for diagnostics.
- Fresh installations put `citext` in `public`, so temporary instance schemas
  share it and dropping one schema does not remove the extension. Existing
  extensions are retained.

The federation pending-head and activity indexes from migration 28 and shared
inbox bulk writes also apply to PostgreSQL. This change does not weaken durable
commits or replace per-recipient admission/retry checks.

## Targeted measurements

An isolated PostgreSQL **17.11** Docker instance ran on this workstation. The
baseline was the compiled application saved before these PostgreSQL changes;
both implementations used fresh temporary schemas, the same driver, 100 authors,
100 retained messages and one warmup page read. Measurements ran sequentially
after the correctness suites finished.

| Operation | Before | After |
|---|---:|---:|
| 30 page reads with 100 authors each | 6,251 ms | 298 ms |
| Logical queries for those pages | 9,270 (309/page) | 300 (10/page) |
| 30 posts in one durable batch | 717 ms | 349 ms |
| Logical queries for those posts | 360 | 360 |

These are local microbenchmarks. Page-query traffic fell about 97%, while post
queries stayed the same and avoided the redundant worker-side savepoint traffic.
The timing measurements combine these optimizations; they are not a claim of a
21-fold increase in users or sustained federation throughput.

A second run reproduced the query counts: page reads took 6,282 ms before and
316 ms after; the post batch took 710 ms before and 351 ms after.

Artifacts, the baseline snapshot, source hashes and full logs are retained under
`test-results/postgres-optimizations/`. `comparison.json` records the measurements.
For a standalone repeat, point `ARCHIPEL_TEST_POSTGRES` at an isolated PostgreSQL
test database and run `npm run benchmark:postgres`. The script creates and drops
temporary schemas; it can install `citext` if absent. It does not use a production
instance's tables. Optional `ARCHIPEL_POSTGRES_BASELINE` points at the saved baseline
directory; `ARCHIPEL_POSTGRES_REPORT` selects a JSON output path.

## Verification and remaining work

The full PostgreSQL suite passed **193 tests**, with 11 SQLite-specific cases
skipped. The SQLite suite passed **199 tests**, with five PostgreSQL-specific
cases skipped. TypeScript checks passed. New PostgreSQL tests verify rollback,
recovery after an error, bounded transfers and page query counts independent of
the number of authors. The temporary test server was removed after validation;
unrelated services were preserved.

PostgreSQL still uses one synchronous worker connection. `Atomics.wait` blocks the
application event loop while statements execute, so adding database connection
pool capacity alone does not make HTTP requests or deliveries concurrent.
Removing that architectural limit requires asynchronous request/transaction
boundaries and corresponding ordering/policy tests. A full PostgreSQL FWDXP
workload remains necessary before claiming 3,000-active-user capacity. No such
capacity claim follows from these targeted measurements.

The [first native server slice](native-server.md) now supplies async PostgreSQL
pools in isolated compiled Rust processes for selected chat paths. The compatibility
server and unported protocol paths still use this synchronous adapter.

## Authentication and channel discovery

The native/PostgreSQL cold-load run exposed more round trips in the compatibility
front end. Session lookup now joins the current account instead of fetching it
separately. The lookup's expiry metadata also avoids no-op renewal UPDATEs; a due
renewal still checks the live row in SQL. Accounts and permissions are read again
on every request, including suspension and session revocation.

Channel discovery now joins membership/rules to filter the list in SQL. Previously
it examined every invisible channel using individual queries. Channel information
also computes permission flags from its already-fetched rule/effective role for
that response, instead of re-fetching them for each flag. No cross-request
permission cache was added.

A synthetic 99-room PostgreSQL fixture with one visible room compared a preserved
built Store with the changed source. Thirty channel listings went from 196 to 12
queries per listing (4.18 seconds to 294 ms). One hundred session/renewal reads
went from three to one query each (220 ms to 87 ms). These are round-trip
microbenchmarks on this workstation, not FWDXP or user-capacity measurements.
Artifacts are `test-results/postgres-discovery.json` and the preserved baseline
under `test-results/postgres-discovery-baseline/`. Repeat with
`npm run benchmark:postgres-discovery`, `ARCHIPEL_TEST_POSTGRES` and
`ARCHIPEL_BASELINE_STORE` pointing at the baseline's `src/store.js`.

Shared-announcement delivery now reads current follower admissions, account
suspension, channel rules and actor/instance blocks in one bounded query per
400 recipients, after async inbox discovery. Common channel/author policy retains
its existing fresh check. This replaces repeated admission/block queries during
the same synchronous send pass; it does not cache permissions across sends or
remove per-recipient cancellation, audit rows, retries or ordering. All 45
federation tests passed on both PostgreSQL and SQLite, including revocation during
discovery and different inboxes on one origin.

The unread overview is now also available through the async native service for
accounts without DM/XMPP projections. It preserves blocked authors, hidden
threads/topics, preferences, layout and initial marks. This removes repeated
synchronous overview SQL from foreground refreshes; unported conversation
projections continue through compatibility.

Native hot-route authentication also removes the compatibility adapter's session
queries around supported posts/pages/overview/read marks. The bridge uses a
request-local result for quota/CSRF checks, and the native operation checks again
at apply time. Unsupported operations reload the session before compatibility
execution. Tests replace synchronous session lookup with a throwing function while
native HTTP operations succeed. This is distinct from caching permissions.

Live delivery-head EXPLAIN during the final run used the existing partial indexes
and executed in approximately 0.25 ms. Query selection was not the dominant
remaining bottleneck in that sample. See the full limitations and capacity results
in [native-server.md](native-server.md); the three-instance target is not met.

The Rust path now queues transactional change notices in `native_changes` and
publishes batches through a separate relay. This removes the global NOTIFY commit
lock from every chat/read-mark transaction. Session lookups use plain reads, and
message pages use read-only repeatable snapshots rather than shared row locks
that generate WAL. Actor cache and policy reads share one query; shared inbox
discovery reads cached documents in bulk. Pending pages also batch existing-copy,
parent, topic, avatar and custom emoji metadata lookups. Concurrent quota requests
share an in-flight session lookup without retaining completed permission data.
See the results table in the native document: delivery capacity remains unmet.
