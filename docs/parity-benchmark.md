# Room delivery parity with Prosody and ejabberd

October 15. The same room workload was offered to Prosody 13.0, ejabberd 26.09 and
Archipel Server (PostgreSQL 17, native workers) on one workstation, through the same
thin load clients. This compares single-instance room delivery; it does not measure
federation, TLS, browser rendering or a VPS.

## Method

`scripts/benchmark-parity.mjs` starts the server under test in Docker, then shards
clients across eight load containers sharing its network namespace. Clients scan
received bytes for benchmark markers instead of parsing XML or JSON, so generators
stay cheap; their peak CPU is reported with each result.

| | XMPP clients | Archipel clients |
|---|---|---|
| Sign-in | SASL ANONYMOUS, plaintext, resource bind | Pre-created sessions, cookie |
| Join | MUC presence; history disabled on join | `GET /api/events?deltas=1&watch=…` |
| History | MAM query for the last 10 messages | `GET /api/channels/:id/messages` |
| Posting | `groupchat` stanza on the client socket | `POST /api/channels/:id/messages` |
| Delivery | Message stanza from the room | Shared delta frame on the event stream |

Each client posts once per interval, phased by its index; every room member,
including the author, must observe every measured post. Visibility runs from the
scheduled post time to observation and includes the generator's 10 ms posting tick.
CPU is cgroup time across every server container (for Archipel: Node, native workers
and PostgreSQL), memory is cgroup memory, and idle figures are taken after all
clients joined, before posting.

Prosody uses its default `internal` storage with `muc_mam`, presence broadcast
disabled for new rooms and its descriptor limit raised. ejabberd uses Mnesia with
`mod_mam`, no shapers, and room limits raised above the default 200 occupants.
Archipel commits each message durably in PostgreSQL before it is delivered, as the
architecture requires; the XMPP servers route a stanza independently of archiving.

```sh
node scripts/benchmark-parity.mjs --target prosody|ejabberd|archipel \
  --clients 10000 --rooms 100 --interval 250 --ramp 60 --warmup 15 --duration 60 --drain 15 --shards 8 --inflight 2000
node scripts/interpret-parity.mjs test-results/parity/<run>...
```

`--profile 1` writes a Node CPU profile; Archipel runs also save PostgreSQL
statement statistics for the join phase and the measured interval.

## Results

All runs: 60 seconds measured after 15 seconds of warmup.

| Workload | Server | Delivered | Visibility p50 / p95 | Cores | Peak memory |
|---|---|---:|---:|---:|---:|
| 1,000 clients, 1 room, 10 posts/s (10,000 deliveries/s) | Prosody | 100% | 124 / 348 ms | 1.00 | 51 MiB |
| | ejabberd | 100% | 14 / 21 ms | 1.10 | 224 MiB |
| | Archipel | 100% | 29 / 38 ms | 0.34 | 405 MiB |
| 10,000 clients, 100 rooms, 40 posts/s (4,000 deliveries/s) | Prosody | 100% | 14 / 213 ms | 0.60 | 428 MiB |
| | ejabberd | 100% | 6 / 11 ms | 0.50 | 1,124 MiB |
| | Archipel | 100% | 17 / 22 ms | 0.46 | 729 MiB |
| 10,000 clients, 1 room, 40 posts/s (400,000 deliveries/s) | Prosody | 0.13% (3,995 joined) | — | 1.00 | 599 MiB |
| | ejabberd | 0% within the window | — | 5.83 | 976 MiB |
| | Archipel | 100% | 151 / 247 ms | 1.50 | 744 MiB |

Reconnect storm: 10,000 clients joining 100 rooms within 10 seconds, then the same
40 posts/s.

| Server | Joined | Time to join all | Delivered |
|---|---:|---:|---:|
| Prosody | 9,904 | 72 s | 96.87% |
| ejabberd | 10,000 | 11 s | 100% |
| Archipel | 10,000 | 13 s (join p50 1.4 s, p95 1.9 s) | 100% |

With 10,000 idle connections Archipel used 0.04 cores and 702 MiB, of which
PostgreSQL held about 240 MiB; Prosody used 416 MiB and ejabberd 964 MiB, both
with no measurable idle CPU.

Prosody is single-threaded: it saturates one core at 1,000 occupants in one room,
and a 10,000-occupant room stalls admission itself. An ejabberd room is one Erlang
process; at 400,000 deliveries a second it fell behind and delivered nothing inside
the measured window. Archipel coalesces a busy room's messages into shared frames,
so beyond a fixed socket-write budget latency grows instead of CPU. In that
workload one generator shard peaked at 91% of a core, so the generator may also
contribute to the latency.

## Where Archipel started

The same harness against commit `f1592d3`, before these changes, and (second row,
not measured on that commit) after only the routing fix below:

| Workload | Delivered | Visibility p50 / p95 | Cores |
|---|---:|---:|---:|
| 1,000 clients, 1 room | 100% | 690 / 1,367 ms | 0.99 |
| 10,000 clients, 1 room | 98.38% | 1,832 / 25,548 ms | 1.13 |

Before the connection-storm changes below, the reconnect storm admitted 9,836
clients (161 connection resets, join p95 36 seconds) and observed 93.92% of
deliveries.

## Changes

- **Incremental stream routing.** Any write to a table outside a short list rebuilt
  routing for every open stream with four synchronous queries each. The push
  worker's cursor in `instance_settings` triggered it every 1.5 seconds, which made
  up 44% of the Node process's time at 1,000 streams. Shared routing tables now reload
  only for channel-wide policy changes; a member's own account, blocks, contact
  names and hidden threads reload for that member alone, in batches of 500, and
  membership changes are applied per member. Change rows for `users`, `user_roles`,
  `memberships`, `channel_rules` and `federation_follows` now carry their keys.
- **Scoped notices.** A join, leave, ban, follow, profile or role change notifies the
  member and that channel's viewers instead of asking every browser to reload. An
  unchanged OIDC sign-in no longer rewrites the user row.
- **Adaptive flushing.** An idle hub tells of a change immediately; changes within
  10 ms are combined. Flush spacing also follows a budget of 60,000 socket writes
  per second, so very large rooms batch several messages per frame.
- **Shared, pre-framed writes.** Each distinct frame is chunk-encoded once and
  written directly to the socket, skipping the response's per-write encoding.
- **Writing processes.** Above `EVENT_WORKER_THRESHOLD` open streams (512), stream
  sockets are handed to `EVENT_WORKERS` child processes (logical CPUs minus two,
  up to four). The server still decides each reader's frames; writers only copy
  bytes, so fan-out uses several cores. Handed-over responses are released from the
  server process.
- **Change relay.** The native gateway wakes the notice relay after each forwarded
  write instead of polling every 80 ms; the fallback interval is one second, and the
  relay commits without waiting for WAL, since a lost commit only repeats notices.
- **Connection storms.** The listen backlog is 4,096, streams opened within 10 ms
  share one viewer query batch, `/api/events` reuses the session the pacing middleware
  has just read, and Node calls the native service through kept-alive `node:http`
  connections rather than `fetch`. Read-only native calls no longer wake the relay.

Authorization is unchanged: sessions are still checked per request and reviewed every
25 seconds, revocation ends streams wherever their sockets live, and no permission
data is cached across requests. Tests cover constant routing work as streams grow,
scoped join notices, delivery, blocks, revocation and sign-out through a writing
process, and a replacement Follow after a lost Undo, which now resets its origin-feed
boundary.

## Limits of this comparison

All servers and generators shared one 32-thread Windows workstation through Docker
Desktop, without TLS. Archipel also ran three containers to the XMPP servers' one.
XMPP clients signed in anonymously and Archipel's used existing sessions, so sign-in
cost is excluded from both. Results describe this host and these settings; they are
not hosting sizes or capacity guarantees.
