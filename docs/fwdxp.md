# FWDXP

FWDXP, the Federated Web Discussion Exchange Protocol, lets independent servers
share channels and direct messages. A channel may be a single timeline, a set of
topics, or titled threads with nested replies. This document describes version 1
(`fwdxpVersion: 1`) as it is exchanged between servers. It does not depend on any
one server or client. [Archipel Server](federation.md) is its first implementation.

FWDXP is an ActivityStreams profile. It follows the
[ActivityPub server-to-server interaction model](https://www.w3.org/TR/activitypub/#server-to-server-interactions)
and the legacy RSA HTTP signature format described by the
[Social Web HTTP Signature guide](https://swicg.github.io/activitypub-http-signature/),
and adds extensions for channel modes, topics, emoji, and origin proofs. The
extensions are a development profile: they are not yet stable, and Lemmy, PieFed
and generic ActivityPub software do not interoperate with them.

## Actors and discovery

Users are `Person` actors and channels are `Group` actors. Every actor carries
`fwdxpVersion: 1`, an `inbox` on its own origin, an `outbox`, and a `publicKey`
whose `id` is the actor ID followed by `#main-key` and whose `owner` is the actor
ID. Keys are RSA with a modulus of at least 2048 bits. Actor and object URLs
remain stable for the life of the instance.

WebFinger resolves user and channel handles separately: `acct:user@host` for a
user and `acct:#channel@host` for a channel. The actor is the `self` link of type
`application/activity+json`. Actor requests use `Accept: application/activity+json`.

Version 1 was first published under the name `archipelVersion`. An implementation
may send both names and should accept either from a peer.

## Extension terms

The extensions use the prefix `fwdxp:`, declared in the `@context` of every
activity and actor.

| Term             | On             | Meaning                                                    |
| ---------------- | -------------- | ---------------------------------------------------------- |
| `fwdxpVersion`   | Actor          | Protocol version; `1`                                      |
| `channel`        | Note           | The channel a message belongs to                           |
| `mode`           | Group          | Timeline, topical or threaded                              |
| `admission`      | Group          | Open or invited membership                                 |
| `visibility`     | Group          | Public or members-only reading                             |
| `showMembers`    | Group          | Whether the member list is shared with followers           |
| `hideHandles`    | Group          | Whether handles behind display names are withheld          |
| `optionalTitles` | Group          | Whether a threaded channel accepts untitled threads        |
| `topic`          | Note           | The topic a message belongs to                             |
| `topics`         | History page   | The channel's topics                                       |
| `proof`          | Note           | The author's signature over the note                       |
| `emoji`          | Note           | Custom emoji used in the note, each with its name and image |
| `channelRole`    | Member entry   | The role a member holds: its name and what it allows       |

## Authority and conversation structure

A channel has one authoritative home `Group`. Messages are plain-text `Note`
objects. The home distributes channel messages through `Announce`. `Create`,
`Update`, `Delete`, `Follow`, `Accept`, `Reject`, and `Undo` carry delivery,
editing, removal, and membership decisions.

The home enforces admission and blocks for both new writes and signed history
requests. Remote users can edit and remove their own channel messages; moderation
of other authors belongs to the home channel. A cached copy of a channel grants
no management rights. The home may let a follower moderate through a role, as
described under [Delegated moderation](#delegated-moderation). Topics are created at the home. Timeline, topical, and
threaded messages retain their channel, topic, and parent relationships.

Incoming activity IDs are deduplicated; conflicting reuse is rejected. A note's
ID must be on its author's origin. The author's embedded RSA `proof` covers the
note, so a relaying channel cannot silently replace authorship or message
content. The proof is an RSA-SHA256 signature over the note's JSON serialization
without the `proof` member. It is an FWDXP extension, not a general JSON-LD
signature.

A note carries the first eight distinct custom emoji it uses. Further custom
shortcodes remain text at the receiver. Standard Unicode emoji have no such limit.

## Membership and history

A follower sends `Follow` to the channel. The home answers `Accept` at once for an
open channel and after a moderator's decision for an invited one, or `Reject`.
`Undo` withdraws a follow.

The home serves the channel's member list at `<channel actor>/members` to
accepted followers, as a signed request, with up to 500 entries. It includes the
home's own members and its accepted remote followers. A channel that keeps its
member list to itself does not serve it.

Channel history is served at `<channel actor>/outbox` to signed requests, in
pages of up to twenty records. A full page names the page of older records in
`next`, and a removed message appears as a `Tombstone`. History is available
only to an accepted follower, even for a channel that is public at its home.
A parent that falls outside the pages a follower reads is represented by a
placeholder; a removed parent keeps a removal marker so its surviving replies
still have a place. A later authenticated update can fill a placeholder without
changing its ID. User outboxes and generic object fetching are not part of the
protocol.

## Delegated moderation

A home may give an accepted follower a role that allows some of: allowing access
(`allow_access`), removing
members (`kick_members`), banning people (`ban_members`), banning instances
(`ban_instances`) and deleting other authors' messages (`delete_messages`).

The home tells the holder with an `Update` it signs as the channel, delivered to
the holder's inbox:

```json
{ "type": "Update", "actor": "<channel>", "object": {
  "type": "ChannelRole", "channel": "<channel>", "holder": "<follower actor>",
  "role": { "name": "Helper", "permissions": ["delete_messages"] } } }
```

`role` is `null` when the follower holds none. A receiver takes it only from the
channel itself, for one of its own accepted subscribers. Entries of the member
list carry the same `role` value as `channelRole` when the member holds one.
This is information for the holder's instance; it authorises nothing.

The holder's instance sends the home, signed as the holder:

| Activity | Object                                                                    | Asks the home to                |
| -------- | ------------------------------------------------------------------------- | ------------------------------- |
| `Delete` | `Tombstone` with the message `id` and `channel`                           | Remove another author's message |
| `Remove` | `Person` with the member's actor `id` and `channel`                       | Remove a member or end a follow |
| `Block`  | `Person` with the actor `id`, `channel` and `on` (`true` ban, `false` lift) | Ban someone, or lift their ban  |
| `Add`    | `Person` with the actor `id` and `channel`                                | Add a person to the allow list |

The home applies one only when the signer is an accepted follower whose role, in
the home's own records, grants that action, and never against the owner, a
moderator or another role holder. It answers anything else with 403. Results are
distributed as any moderation by the home is: an `Announce` of the `Delete`, and
a `Reject` of a removed or banned follower's follow. Banning instances has no
activity in version 1.

An `Add` resolves the named user actor at its home, records an allow-list entry,
and accepts an existing pending follow. The `allow_access` permission cannot
replace a block. Invitations are direct `Note` messages with a channel Join
link; an authorized sender separately requests or grants access. A Join link
has the form `<channel home>/#/join/<URL-encoded channel actor>` and is opened
through the reader's own instance by Archipel Web.

Direct messages are delivered from the sender's server to the recipient's inbox.
They are stored on the participating servers and are not end-to-end encrypted.

## Transport

Activities are delivered by POST to the recipient's inbox as
`application/activity+json`. HTTP signatures cover the request target, `Host`,
and `Date`, plus a SHA-256 `Digest` for POST bodies. A receiver rejects a request
whose date is more than five minutes from its own clock. Public HTTPS is
required, and redirects are not followed.

An inbox request is at most 64 KiB. Responses fetched from a peer, and emoji
images, are at most 256 KiB.

Channel `Announce` activities address the channel actor in `to`. The sender keeps
the authorized followers in its durable delivery queue and may consolidate
recipients sharing an inbox into one POST. This keeps the announcement body
independent of subscriber count, with one stable activity ID and body across
peers and retries. Receivers continue to accept older announcements that list
individual followers. Current local subscriptions and permissions determine
who may read the imported channel copy.

## Optional channel event transport

Peers may negotiate `channelEvents: { "version": 1 }` on a Person actor.
A supporting home Group advertises `channelEvents` with `version: 1`, `batches`
(`<channel actor>/events`) and `stream` (`<channel actor>/stream`) URLs. Both
endpoints must remain on the Group's origin and exact channel path. This is an
optional FWDXP extension; individual inbox activities remain version 1.

When accepting a capable follower, the home includes
`channelEvents: { "version": 1, "cursor": <integer> }` in the embedded Follow
object. The cursor marks the admission boundary before history is fetched. The
home retains one immutable channel broadcast event per change, in channel commit
order, rather than creating delivery rows for each capable follower. Followers
without this negotiation retain inbox delivery. Direct messages, user posts to
the home, membership decisions and individual roles continue to use inboxes.

A follower authenticates GET requests with its ordinary HTTP signature and an
`after=<cursor>` query parameter. Batch responses are JSON:

```json
{"type":"ChannelEvents","channel":"<Group actor>","follow":"<Follow ID>",
 "after":10,"cursor":12,"events":[
   {"seq":11,"activity":"<original serialized activity JSON>"},
   {"seq":12,"activity":null}]}
```

Activities preserve their original IDs, serialization and author proofs. A null
activity advances past content cancelled by current sending policy. Cursors
also advance past authors blocked or inactive on the receiver, preserving the
activity ID/digest for conflict detection while discarding the content. Blocking
the channel's home or losing all permitted local subscribers stops consumption.
Sequences must be contiguous, and the response must belong to the requested channel and
current follow. Each receiver consumes once per channel regardless of its number
of local subscribers; importing an event and advancing its durable cursor must
commit atomically. Duplicate activity IDs remain subject to conflict detection.

The stream endpoint sends the same bounded pages as SSE `data` frames, with the
last sequence in `id`. Requests identify the receiving follower; authenticated
HTTPS to the advertised home authenticates response content. Author proofs still
require independent verification. A receiver must not treat an arbitrary inbox
body as authenticated stream content. Production redirects and private-address
targets remain prohibited. Loopback HTTP retains the development exception.

Live authorization is checked before each page, including channel federation,
follower admission, blocks and sender permissions. Streams use thirty-second
leases and reconnect with a fresh signed request and the last committed cursor.
Pages contain at most 32 events and 240,000 bytes of event JSON; frames/responses
remain below 256 KiB and individual activities below the 64 KiB inbox limit.
Slow readers are disconnected instead of accumulating an unbounded buffer.

Archipel retains at most seven days or 100,000 events per channel, pruning on
reads. A cursor older than retained history returns HTTP 410; it is never advanced
silently. Recovery requires leaving and rejoining to import the existing bounded
history snapshot. This does not promise full archival recovery. A new admission
cannot resume before its admission cursor, even when requesting an older cursor.

## Multiplexed instance feed extension

A Group can additionally advertise `channelEvents.instanceStream` and
`channelEvents.instanceBatches`, at `/federation/stream` and `/federation/events`
on its own origin. Accept's Follow object includes `channelEvents.instanceCursor`
alongside the channel admission cursor. A receiver starts one consumer per
origin, regardless of its channel or local follower count. Older peers continue
to use the channel endpoints or individual inbox deliveries.
Existing admissions without an instance cursor retain the channel transport
until they renegotiate by leaving and rejoining; upgrading does not silently
move a durable consumer past unseen history.

The instance sequence is assigned under a transactional row lock when the
channel event is appended, so committed events cannot arrive out of order.
An `InstanceEvents` page contains `origin`, `after`, `cursor` and up to 32 events,
within the same page/frame limits as the channel transport. Each event contains
`seq`, `channel` (the Group actor), `channelSeq` and `epoch`. Public events have
`payload: {activity, actors}`. The original activity JSON and its origin proof
remain unchanged. Same-origin actor documents may accompany the activity to
avoid an author-discovery request on the ordered import path. A relayed author's
identity must still be obtained from that author's own origin.

Private events instead have `encrypted: {iv, tag, data}` using AES-256-GCM,
with a random 96-bit nonce, a 128-bit tag and a random 256-bit channel epoch key.
Associated data is UTF-8 JSON `[1,origin,seq,channel,channelSeq,epoch]`.
The whole payload, including actor metadata, is encrypted once and the frame is
persisted. All peers receive the same ciphertext. Public events and private
ciphertext can be read through the same public origin feed; this exposes channel
actor IDs, sequence numbers, epochs and timing, not private message bodies.

Keys are obtained through signed GETs to `/actors/channels/:id/keys/:epoch`,
with current follower admission, account, channel and instance block checks.
The response `{channel,epoch,secret}` uses base64 key bytes and is never cached
by HTTP intermediaries. Production requires authenticated HTTPS. Admission
changes, rejoining with a new Follow ID, privacy/federation changes and block
changes rotate the epoch. A new admission cannot fetch keys from before its
grant; a revoked admission cannot fetch subsequent keys. Revocation cannot
erase previously downloaded plaintext or keys. This is encryption between
instances, not encryption that excludes their administrators.

Receivers atomically stage the bounded raw page and advance the origin cursor
before resolving keys, authors or optional assets. Up to eight channel
materializers run independently; each message import and channel checkpoint
remain atomic. A stalled channel does not stop raw intake or another channel.
Avatars use a separate bounded background queue. Source retention maintenance
deletes at most 1,000 old events per round outside the read path, targeting seven
days or 100,000 events per origin, and advances the corresponding channel floors.
Received unclaimed frames retain a 100,000-event admission-race horizon. Falling
outside replay history produces an explicit gap instead of skipping messages.

Publication does not enumerate negotiated followers. One fixed set of message,
activity and feed appends remains; legacy recipients still require their delivery
rows. Transport intake has bounded work per page. Delivering bytes to multiple
peers or browser connections necessarily scales with those connections.

## Not in version 1

Federated mirrors, writable failover between homes, and
reconciliation between copies of a channel are not defined.
