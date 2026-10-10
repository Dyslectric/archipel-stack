# Federation in Archipel Server

Archipel Server federates with other servers over [FWDXP](fwdxp.md) version 1.
That document describes what is exchanged; this one describes how an instance is
set up for it, who is allowed to use it, and how Archipel Server paces and limits
it. The settings named here are those of Archipel Web. Lemmy, PieFed, generic
ActivityPub clients, federated mirrors, and writable failover are not supported
yet. Local mirrors are described at the end of this document.

## Enable and grant access

1. An administrator opens **Settings → Instance federation** and enables
   federation, then under **Settings → Roles** creates a role with the grants
   below (or adds them to the default role) and gives it to accounts under
   **Settings → People**.
2. A local channel's owner, moderator, or instance admin opens channel settings →
   **Federation and remote followers** and enables that channel.
3. Users open **Profile → Federated conversations** to subscribe to
   `#channel@instance.domain`, use an actor URL, or send to `user@instance.domain`.
4. Home moderators approve pending followers on invited channels. Open channels
   admit unblocked remote followers automatically. Refresh subscriptions to see
   an approval and open the channel.

All switches and grants start disabled, including for admins. They are persisted
in the database and do not require a restart. Open browsers are told of a change as it happens.
Admins can block an entire instance origin or a specific remote actor URL and
inspect recent delivery results in the same panel. Changes are audited.

| User grant                   | Controls                                                                 |
| ---------------------------- | ------------------------------------------------------------------------ |
| Send federated messages      | Outgoing direct messages and channel messages/edits                      |
| Receive federated messages   | Incoming direct messages and visibility of foreign messages              |
| Subscribe to remote channels | Creating and retaining remote channel subscriptions                      |
| Post in federated channels   | Posting/editing in opted-in home channels and subscribed remote channels |

Subscribing requires receive and subscribe. Posting on a remote channel requires
all four grants and accepted membership. Posting in an opted-in home channel
requires send and post. Local channels without federation retain ordinary local
permissions. Admin privileges do not bypass federation grants. A role also says
whether its accounts may open their own channels to federation at all.

Revoking receive or subscribe withdraws remote subscriptions, removes access,
and queues an `Undo`. Queue processing rechecks the current policy before every
delivery. Blocks, suspension, lost admission, or revoked sending/posting cancel
affected unsent content. Earlier pending deliveries hold later deliveries to
the same recipient, preserving order across retries. Withdrawal and removal
activities can still be sent after a user's grant is revoked.

Turning the instance off rejects incoming activities and cancels outbound work
when the worker checks it. Re-enabling does not replay cancelled work or recover
events missed while disabled. Turning a home channel off withdraws remote
admission; existing followers need approval again after it is re-enabled.
Policy changes cannot erase copies that a peer already received.

## Channels, members and history

Actors, activities, origin proofs and the rules of authority are those of
[FWDXP](fwdxp.md#authority-and-conversation-structure). What follows is how
Archipel Server applies them.

A channel's member list is shared across the instances it reaches. A following
instance fetches the home's list on admission and again, at most once a minute,
when a subscriber opens the channel; it shows it beside its own subscribers and
applies the channel's handle setting. Remote followers are admitted and removed
under **Federation and remote followers**, not in the member list.

Admission imports up to five history pages of twenty records each. This is
bounded initial history, not complete archival replication. History is served
only to an accepted follower, even for a public home channel; the browser's
normal public/member rules remain separate.

## Deployment and delivery

Use a stable public HTTPS `BASE_URL` and preserve the SQLite database. It contains
the signing key, actor identities, subscriptions, received objects, activity
deduplication, delivery queue, and saved emoji. Current keys are instance-managed
RSA-2048 keys advertised with each actor; automatic key rotation is not implemented.

The shared inbox is `/federation/inbox`; a channel's actor is
`/actors/channels/<id>`, with its history and member list beneath it. Incoming
dates must be within five minutes, so keep server clocks synchronized. Proxies
must preserve the Host, Date, Digest and Signature headers and the request body.

Outbound requests use a fifteen-second timeout, bounded response sizes, and no
redirect following. DNS results are checked for private/reserved addresses and
the selected public address is pinned to the connection. Public HTTPS is required
in production. Local two-instance testing permits loopback HTTP only when
development authentication is enabled on a loopback listener and base URL.

The single server process sends queued deliveries in rounds. An administrator
sets the pace under **Settings → Federation → Instance federation → Sending to
other instances**: how often a round runs (0.1 to 600 seconds) and how many
deliveries a round sends across all peers (1 to 1000). The change applies at
once, is audited, and is kept with the instance. Until it is set there, the pace
comes from `FEDERATION_SEND_INTERVAL` (milliseconds between rounds, default
1000) and `FEDERATION_SEND_RATE` (deliveries per round, default 20). A slower
or smaller pace is gentler on small peers; a faster or larger one makes posts in
federated channels arrive sooner. Whatever the pace, no more
than `FEDERATION_PEER_SEND_RATE` deliveries per minute (default 100; 0 removes
the cap) go to any one peer host. A peer at its cap keeps its queue in order
while other peers continue. Incoming `/federation` requests are limited to
`RATE_LIMIT_FEDERATION` per minute per client address (default 120), so keep
the peer send rate below the limit your peers accept. Temporary errors retry
with exponential backoff starting at five seconds, capped at one hour, with up
to twelve attempts. Policy failures cancel; permanent rejection and exhausted
retries fail. Admins can inspect results; automatic replay of failed deliveries
is not implemented. Inbox requests are limited to 64 KiB; peer responses and
emoji images to 256 KiB.

Actors also carry `archipelVersion`, the protocol's earlier name, and either name
is accepted from a peer.

## Personal and adopted emoji

Every approved user can open **Profile → Your emoji** to upload PNG, JPEG, GIF,
or WebP images up to 256 KiB. Each account can save up to 200 entries, choose its
own shortcode, and rename or remove its entries. Standard and instance emoji
names are reserved when creating or renaming personal emoji.

The same panel loads another Archipel Server instance's public emoji catalog
and adopts a selected image under a chosen name. The image is copied into the
local database and survives changes or deletion at the source. Adoption can
work while federation is disabled locally; the source must expose its catalog.
Remote instance/actor blocks and safe network checks still apply.

Personal collections appear only in their owner's picker. Message metadata
captures the asset and name used, so other readers can render it and older
messages survive a personal rename/removal. Removal retains the stored image
for those references. Images shared in federated messages are downloadable by
asset URL; personal collections are not published as a public catalog.
Receivers download and render cached local copies. A federated note carries the
first eight distinct custom emoji used; further custom shortcodes remain text
at peers. Standard Unicode emoji have no such image-transfer limit.

## Mirrors

A mirror is a local timeline channel that its creator owns and fills from
sources hosted elsewhere: channels followed from other instances, and XMPP rooms
the owner has joined. Channels hosted on this instance are never sources. Start
one with **Mirror this channel** in a followed channel's settings, or **Mirror**
in an XMPP room; add further sources to the same mirror the same way.

- The mirror copies what the owner's own subscriptions receive, including what
  they already hold when the source is added. Nothing is sent to a source, and
  the mirror is not announced; the owner invites or tells whoever should know.
- Copies are kept as they arrived. A later edit or removal at the source does
  not change them; the mirror's owner and moderators moderate it.
- Nobody can write in a mirror until its owner opens it. It is then a fork:
  what is written there stays there, and its sources keep arriving alongside.
- The owner can stop consuming a source, resume it (catching up on what their
  subscription received meanwhile) or remove it. If the owner unfollows a
  channel, leaves a room or loses the federation grants, that source stops and
  what was copied stays.
- Copies count as remote content: readers need the receive grant, personal
  blocks apply, and they are not shown to XMPP clients of the mirror's own room.
- A mirror has the format of its first source and only takes further sources
  in that format: timeline, topical or threaded. Topics are matched by title,
  thread titles and reply structure are kept, and a message the source had
  already removed, or the owner never received, is kept as the same empty place
  so its replies still hang from it. XMPP rooms are timelines.
- A mirror cannot itself be federated or bridged, so it serves the members of
  the instance that holds it.
