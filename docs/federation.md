# Archipel federation

This is the initial Archipel-to-Archipel federation profile (`archipelVersion: 1`).
It implements ActivityStreams actors and server-to-server activities with Archipel
extensions for channel modes, topics, emoji, and origin proofs. Lemmy, PieFed,
generic ActivityPub clients, federated mirrors, and writable failover are not
supported yet. Local mirrors are described at the end of this document.

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
in SQLite and do not require a restart. Browser controls refresh through polling.
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

## Authority and conversation structure

A channel has one authoritative home `Group`; users are `Person` actors and
messages are plain-text `Note` objects. The home distributes channel messages
through `Announce`. `Create`, `Update`, `Delete`, `Follow`, `Accept`, `Reject`,
and `Undo` carry delivery, editing, removal, and membership decisions.

The home enforces admission and blocks for both new writes and signed history
requests. Remote users can edit/remove their own channel messages; moderation
of other authors belongs to the home channel. Cached channel ownership grants
no management rights. Topics are created at the home. Timeline, topical, and
threaded messages retain channel, topic, and parent relationships.

Actor and object URLs remain stable across restarts. Incoming activity IDs are
deduplicated; conflicting reuse is rejected. An author's embedded RSA proof
covers the note, so a relaying channel cannot silently replace authorship or
message content. This proof uses this profile's JSON serialization and is an
Archipel extension, not a general JSON-LD signature implementation.

Admission imports up to five signed history pages of twenty records each.
This is bounded initial history, not complete archival replication. History is
linked through explicit placeholders when a parent falls outside that window;
removed parents keep a removal marker so their surviving replies can be imported.
An authenticated later update can fill an uncached parent without changing its ID.
History is accessible only to an accepted follower, even for a public home channel; the
browser's normal public/member rules remain separate. User outboxes and generic
object fetching are not exposed publicly. Direct messages are stored on the
participating servers and are not end-to-end encrypted.

## Transport and deployment

Use a stable public HTTPS `BASE_URL` and preserve the SQLite database. It contains
the signing key, actor identities, subscriptions, received objects, activity
deduplication, delivery queue, and saved emoji. Current keys are instance-managed
RSA-2048 keys advertised with each actor; automatic key rotation is not implemented.

WebFinger resolves user and channel handles separately, with `acct:#channel@host`
for channels. Actor requests use `Accept: application/activity+json`. The shared
inbox is `/federation/inbox`; channel history is `/actors/channels/<id>/outbox`.
HTTP signatures cover request target, Host, and Date, plus SHA-256 Digest for
POST bodies. Incoming dates must be within five minutes. Keep server clocks
synchronized. Proxies must preserve these headers and the request body.

Outbound requests use a fifteen-second timeout, bounded response sizes, and no
redirect following. DNS results are checked for private/reserved addresses and
the selected public address is pinned to the connection. Public HTTPS is required
in production. Local two-instance testing permits loopback HTTP only when
development authentication is enabled on a loopback listener and base URL.

The single server process runs the worker every second. Each run sends at most
`FEDERATION_SEND_RATE` deliveries (default 20) across all peers, and no more
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

The transport follows the [ActivityPub server-to-server interaction model](https://www.w3.org/TR/activitypub/#server-to-server-interactions)
and the legacy RSA HTTP signature format described by the
[Social Web HTTP Signature guide](https://swicg.github.io/activitypub-http-signature/).
The Archipel extensions are a development profile with compatibility limited to
this implementation.

## Personal and adopted emoji

Every approved user can open **Profile → Your emoji** to upload PNG, JPEG, GIF,
or WebP images up to 256 KiB. Each account can save up to 200 entries, choose its
own shortcode, and rename or remove its entries. Standard and instance emoji
names are reserved when creating or renaming personal emoji.

The same panel loads another Archipel instance's public instance emoji catalog
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
