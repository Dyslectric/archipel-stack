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

## Authority and conversation structure

A channel has one authoritative home `Group`. Messages are plain-text `Note`
objects. The home distributes channel messages through `Announce`. `Create`,
`Update`, `Delete`, `Follow`, `Accept`, `Reject`, and `Undo` carry delivery,
editing, removal, and membership decisions.

The home enforces admission and blocks for both new writes and signed history
requests. Remote users can edit and remove their own channel messages; moderation
of other authors belongs to the home channel. A cached copy of a channel grants
no management rights. Topics are created at the home. Timeline, topical, and
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

## Not in version 1

Key rotation, federated mirrors, writable failover between homes, and
reconciliation between copies of a channel are not defined.
