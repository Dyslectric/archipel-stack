# Architecture proposal

Status: evolving design, 2026-10-07. The implementation is described in
[README.md](../README.md). FWDXP federation between Archipel Server instances is implemented;
its current boundaries are documented in [federation.md](federation.md).
The requirements come from [ARCHIPEL.md](../ARCHIPEL.md); choices marked
"proposed" are defaults for the first implementation.

## Instance and identity

An instance owns its local users, inboxes, channels, storage, and administrative
policy. A browser talks to its user's home instance. That instance authenticates
the user, enforces policy, and performs remote delivery on their behalf.

Use an immutable local user ID and a stable ActivityPub actor URL. Handles are
discovery and display names, not database keys. A channel handle such as
`#general@chat.example` resolves to a distinct channel actor URL; it is not itself
an ActivityPub object ID.

OIDC accounts are keyed by the exact `(issuer, subject)` pair, never a username,
email address, or verified social handle. An authenticated OIDC identity is
bound to an Archipel Server user and its actor. Account linking and relocation need
explicit flows; a matching handle cannot grant someone another user's history
or permissions.

Local [FedIdP](../../FedIdP/README.md) already supplies a permanent
`preferred_username` and consent-selected `verified_socials`. Request `openid
profile` and treat the selected socials as optional profile data. Login must
work when none are disclosed. Archipel Server needs its own disclosure choice before
publishing a received social claim to other users or federating it. Refreshing
profile data must remove claims no longer supplied; that cannot retract copies
already delivered to peers.

The OIDC implementation must validate issuer, audience, signature, nonce,
state, and PKCE, and require UserInfo's subject to match the authenticated
subject. Instance administration is an explicit local grant, never a privilege
inferred from a handle or a social claim.

## Channels and conversations

Proposed: a channel has one home instance and one authoritative channel actor.
Its creator becomes its owner. Owners can appoint moderators, who can manage
membership and access rules but cannot replace the owner. Ownership transfer
is a separate action. Instance administrators retain the inspection and
moderation powers requested in the brief, including over restricted channels.

Store messages independently of their visual presentation:

| Entity     | Identity and relationships                                                                |
| ---------- | ----------------------------------------------------------------------------------------- |
| User       | Internal ID, stable actor URL, home instance, OIDC bindings                               |
| Channel    | Internal ID, actor URL, local name, owner, mode, visibility, access policy                |
| Membership | Channel, user actor, role, membership status                                              |
| Topic      | Stable ID, channel, title; used by topical channels                                       |
| Message    | Stable object URL, channel, author actor, body, optional title, topic, parent, timestamps |
| Activity   | Stable activity URL, actor, verb, object, processing state                                |
| Delivery   | Activity, recipient inbox, attempts, next attempt, result                                 |

The three modes have explicit invariants:

- **Timeline:** a chronological channel stream. A message may reply to another
  in the same channel, and links back to it.
- **Topical:** every message belongs to a topic in the same channel; replies
  stay within that topic.
- **Threaded:** titled root posts with nested replies. Parent references stay
  within the channel. A channel setting (`optional_titles`, federated as
  `optionalTitles`) lets roots go untitled; moderators can change it at any time. Preserve the tree independently of comment sorting.

Implemented: keep channel mode fixed during the first milestone. A later conversion
requires a defined treatment of existing topics and replies.

[ThreadBNC](https://github.com/Dyslectric/ThreadBNC) is the reference for the
threaded reading experience. Inspect its comment templates and behavior before
implementing that view. Its private archival retention behavior is a separate
feature and is not implied by adopting the interface.

## Access and moderation

Separate visibility (public or members-only) from admission (open or allowlist).
An explicit block overrides admission and existing membership. Proposed:
posting requires active membership even when a public channel can be read
without joining. Joining an open channel creates membership; allowlisted users
must still join or accept an invitation. Adding someone to an allowlist does
not silently enroll them.

Channel ownership and instance administration do not automatically bypass an
instance block or a disabled local account. Blocked members lose access to
restricted content and cannot post. Delegated moderators cannot remove the
owner or grant ownership. The owner cannot leave until ownership is transferred
or the channel is closed.

Evaluate instance policy and channel policy for local writes, reads of restricted
content, incoming activities, outgoing deliveries, mirror subscriptions, and
call admission. Recheck current policy when retrying a queued delivery. A new
block must stop unsent restricted content from leaving the instance.

An instance can reject remote users or domains, and can separately disable a
local user's participation in federation while retaining local access.
Moderation actions need an audit record identifying the administrator, target,
action, and time. Delete or suppress content locally, and propagate appropriate
federated actions once supported; do not promise remote erasure.

## Federation

ActivityPub is the server-to-server transport. Implemented mapping: users are
`Person` actors, channels are `Group` actors, and ordinary messages/replies are
`Note` objects. Use `Create`, `Update`, `Delete`, `Follow`, `Accept`, `Reject`,
and `Undo` where their semantics apply. Presentation modes and topics need an
FWDXP profile; they are not standardized just by selecting these types.
The first profile uses signed HTTP requests, author-signed embedded notes,
home-channel distribution, and approval-controlled history. All federation
permissions default to disabled, with separate send/receive/subscribe/post
grants given to local users through instance roles. Local account privileges do not bypass these grants.

The [ActivityPub delivery specification](https://www.w3.org/TR/activitypub/#delivery)
defines inbox addressing, recipient deduplication, and asynchronous delivery
with retries. Persist outbound work with the message transaction. Deduplicate
incoming activities by activity ID and objects by object ID. A repeated activity
with conflicting content must not silently overwrite an existing object.

Authenticate senders and verify object authority before accepting mutations.
An `Announce` by a channel does not make the channel the original message
author. Relayed objects require origin verification. Fetching actor or object
URLs needs bounded requests, redirect validation, and protection against
accessing private network addresses. These follow the specification's
[verification and security guidance](https://www.w3.org/TR/activitypub/#security-considerations).

Lemmy interoperability requires its group profile, not just generic ActivityPub.
[Lemmy documents](https://join-lemmy.org/docs/en/contributors/05-federation.html)
communities as `Group`, posts as `Page`, replies as `Note`, and community
distribution through `Announce`. Proposed: make public threaded channels the
first interoperable channel mode. Map titled roots to posts and nested replies
to comments. Prove creation, reply, edit, deletion, and moderation semantics
against a local fixture before claiming compatibility.

PieFed needs its own adapter and fixture. Its community behavior and private
messaging behavior must be verified separately. Neither Lemmy nor PieFed
compatibility should imply support for Archipel Server's restricted channels or mirrors.

## Mirrors and rehoming

Mirroring a conversation and transferring its authority are different operations.
A mirror does not receive the origin's private signing key, become the original
author, or gain the right to impersonate the home channel.

Proposed initial mirror: an explicitly joined replica with its own channel actor
and a link to the origin. Preserve original message IDs and author provenance;
track replication state separately from membership and local moderation. Remote
URLs remain remote identities even when their content is cached locally.

For public channels, any participant may create a mirror as requested in the
brief. For restricted channels, the exact replication policy remains open:
membership alone should not implicitly authorize sharing the history with
another server. Decide whether the owner enables mirrors and whether members
must accept the destination instance before implementing restricted replication.

During an origin outage, users can read the mirrored history. Proposed: new
messages on a mirror are authored there, and its moderation authority is local.
Reconciliation, cross-mirror delivery, conflicting bans, and ordering need a
separate FWDXP extension. Do not advertise seamless writable failover until
two-instance outage tests establish those semantics.

Rehoming must define who may transfer ownership, how peers verify that transfer,
and how discovery changes without breaking old references. Start with an
explicit fork when the origin is unavailable. ActivityPub inbox delivery alone
does not supply a channel ownership-transfer or consensus mechanism.

## Notifications and calls

Deliver live browser events only after a message transaction commits. Keep the
browser API separate from federation so clients never sign server activities.
Add PWA installation and service-worker push after the basic messenger works.
Implemented: push notifications name the conversation and the author and omit
message content; logout, session expiry and revocation stop delivery to that
subscription. A worker in the server process finds new messages by sequence
number, so every way a message arrives (local, federated, bridged) notifies.

[ConsortStack](https://github.com/ConsortChat/ConsortStack) checks membership on
the server and issues Jitsi JWTs scoped to a conversation's derived room.
Its [local token implementation](../../ConsortStack/zulip-server-patch/files/jitsi_token.py)
is the integration reference. Archipel Server must apply its own channel and instance
policy before issuing a short-lived token for one room and tenant, using its
own stable actor ID for user context. Token expiry restricts future admission;
removing someone from an active call needs a separate enforcement mechanism.

## Implementation boundaries and open choices

The current implementation has one backend process with an in-process delivery
worker, a relational database, and a browser client. Keep identity, channels,
moderation, federation, push, and calls as modules with explicit service boundaries.

Implemented: Prosody hosts XMPP streams, authentication, routing and MUC presence,
while Archipel Server retains policy, the authoritative archive, and ActivityPub
support, and Archipel Web remains the browser frontend. The supported profile is documented in [xmpp.md](xmpp.md).
The eventual distribution
must be a single executable with its required application runtimes included.
Proposed: that executable supervises a bundled Prosody child process; users do
not have to deploy Prosody separately. Single-file distribution does not require
both runtimes to share a process. Extraction and target-platform support remain
packaging decisions to validate, not implemented capabilities.

See [XMPP and standalone packaging](xmpp-packaging.md) for the proposed authority
boundaries, account binding, deployment model, and acceptance criteria.

The initial implementation uses Node 24, TypeScript, Express, built-in SQLite,
and a Vite browser client. OIDC uses the same openid-client library family as
FedIdP. PostgreSQL can hold the instance instead of SQLite. Open browsers are
told of changes over a server-sent event stream and fetch what changed from
authorized endpoints; a durable delivery worker runs in the server process.

Resolve these product choices before their implementation milestone:

1. Implemented: instances choose open registration or invite-only administrator
   approval, including a private queue of consent-selected provider socials.
2. Whether channel allowlists match identities only or also whole instances.
3. Who can authorize restricted mirroring, and whether rehoming means a fork,
   an owner-authorized migration, or transparent failover.
4. Whether topical and timeline modes should have any Lemmy/PieFed mapping.
5. Retention, edits, attachment storage, and the extent of administrator inspection.
6. Initial standalone operating-system/architecture targets and whether runtime
   extraction is acceptable, or an executable that runs without extraction is needed.
7. The Prosody integration mechanism and authority boundary for messages,
   archives, and room membership, proven against the existing permission model.
