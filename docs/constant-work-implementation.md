# Constant message work implementation

Authorized scope: remove per-follower work from publication, bound receiver
ingestion, maintain browser routing and deliver shared deltas, bound initial
roster reads, multiplex federation by origin and encrypt private channel events
with membership-driven key epochs. Preserve current authorization, origin proofs,
personal blocks/aliases, replay, edits/deletes and older peer compatibility.

Implementation order:

1. Repair synchronous PostgreSQL worker response handoff; remove negotiated
   follower enumeration and add a legacy-recipient lookup index.
2. Add bounded roster APIs and lazy roster loading. Maintain browser connection
   indexes and routing on control changes; add shared bounded message deltas
   with recipient-specific filtering without database queries per recipient.
3. Add a commit-ordered instance feed, shared serialized frames, private channel
   key epochs and authenticated key distribution. Negotiate origin-level
   consumers with channel-feed fallback for older peers.
4. Durably stage received frames independently of metadata resolution; keep
   message materialization and channel checkpoints atomic. Supply trusted
   same-origin author metadata through the stream and resolve other dependencies
   outside ordered transport ingestion.
5. Validate correctness and fixed query counts with small workloads, then rerun
   the 10,000-local-reader, 40-post/sec, twelve-listening-peer benchmark after
   completed initial reads. Keep startup and offered/issued/committed/observed
   counts distinct. Do not claim a passing workload if its target fails.

Network fan-out remains proportional to recipients. Message production and raw
replication intake must not enumerate them. Membership changes, key rotation,
viewer-driven reads and delivery have separate work budgets.

Implemented all five architecture areas. Schema 31 installs equivalent SQLite
and PostgreSQL append/epoch triggers, including native-only startup and upgrades.
Native and compatibility publication select only indexed legacy recipients.
Shared browser projections have equal database-call counts with one and 64
connections. Browser deltas retain handle redaction, personal blocks and contact
labels; readers with hidden-thread preferences retain the existing page path.
Initial chat metadata omits the roster, whose API pages are limited to 200.
Member counts are cached until membership control changes. Browsers send no read
marks while watching a channel; the server records one when the watching event
stream closes. Ordinary deliveries reuse one immutable encoded Buffer. Overview
sequence watermarks prevent queued deltas from double-counting unread messages.

The origin feed shares immutable frames, encrypts private payloads with
AES-256-GCM and rotates keys on admissions, new Follow IDs and access/block
changes. Raw page staging and the origin cursor commit together. Imports keep
their existing atomic channel checkpoint. Eight independent channel jobs and
two optional avatar jobs keep dependency resolution outside ordered raw intake.
Admission routing is rebuilt only on control revisions, and failed channel jobs
have independent retry timers. Stream imports validate their elected Follow by
unique ID instead of searching local subscribers. Fresh admissions can advance
an expired origin transport cursor to the boundary covered by their history.
Retention maintenance uses bounded rounds; expired channel or origin cursors
report a gap. Older peer protocols remain supported.

Validation before the population run:

- TypeScript check, client build and server build pass; Rust release builds and
  the Linux native image build pass.
- Federation suite passed its 56 existing tests plus multiplexing, private
  encryption/rotation, restart replay, stalled-channel isolation, instance-block
  rotation and deletion-continuity coverage. Channel-feed fallback tests remain
  explicit compatibility tests.
- PostgreSQL handoff race, migration/copy, roster query bounds and message page
  query bounds pass. Native tests pass after updating the expected message-ID
  notice; the four affected schema/notice/batch/stream tests were rerun cleanly.
- Browser HTTP tests pass for delta privacy, blocks, revocation and paged roster
  permissions, including PostgreSQL. A one-versus-64-browser test proves equal
  publication/projection database call counts.
- A real Chromium/native test passes shared deltas without page requests,
  preserves the composer/focus, updates older edits/deletions and verifies own
  messages and overlapping overview/delta responses do not inflate unread counts.
- All 10 benchmark harness tests pass, including sharding and overload counts.
- Small full-path smoke: `2026-10-15T03-03-40-020Z`, 24 local clients and two
  listening peers, 6 posts/sec for 8 measured seconds. 48/48 HTTP acceptance,
  1,152/1,152 observations, 48 committed copies on every instance, no errors or
  drops. Posting p95 41.8 ms, visibility p95 151.2 ms.

The requested population run is recorded separately in
`docs/channel-stream-benchmarks.md`. Results distinguish startup, offered
requests, HTTP acceptance, committed messages, browser observations and peer
materialization. Network writes and per-recipient privacy projection remain
proportional to active delivery connections; this is not an O(1) total fan-out
claim. Private encryption excludes unauthorized peers, not instance operators.
