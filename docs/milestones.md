# Implementation milestones

Status: the single-instance build and initial Archipel federation are implemented. [ARCHIPEL.md](../ARCHIPEL.md) remains the product
brief; [architecture.md](architecture.md) records proposed technical semantics.
Each milestone records its implementation scope and acceptance criteria.

## 1. One working instance

Implemented with Node 24, TypeScript, Express, SQLite and a Vite browser client.
Tests cover two-session messaging, persistence, channel authorization, and signed
OIDC success and failure paths. FedIdP client registration and a live sign-in
against a deployed broker remain deployment-specific configuration.

Select the stack and add the application scaffold, dependency lockfile,
configuration example, migrations, local run instructions, and checks.

- Authenticate using a configured OIDC issuer, including FedIdP.
- Bind `(issuer, subject)` to a stable Archipel identity and actor URL.
- Let a user create `#channel@instance`, join an open channel, and read/post
  persistent messages from a browser timeline.
- Support members-only visibility, identity allowlists, blocks, and delegated
  moderators; enforce policy in the backend.
- Provision the instance administrator explicitly and support account bans and
  audited local message removal, author-only edits, and custom emoji.
- Allow invite-only instance admission with FedIdP authentication and an admin
  queue displaying consent-selected verified socials.
- Offer optional social disclosure in the profile without making it a login
  requirement.

Acceptance: two browser sessions exchange messages; a restart preserves their
identities and history. An outsider cannot read a restricted channel. A blocked
member cannot read restricted history or post. A moderator cannot promote
themselves to owner. OIDC failure paths do not create sessions, and login with
no disclosed socials succeeds.

## 2. Two Archipel instances

Implemented with an Archipel ActivityStreams profile, signed HTTP requests,
author proofs, database-backed delivery, restricted-channel follower approval,
direct messaging, and four separately controlled user permissions. Tests use
real HTTP between two and three instances, including restart recovery and
revocation before delivery. See [federation.md](federation.md) for current limits.

Expose actor documents, discovery, inboxes, and paginated collections. Implement
authenticated delivery, durable retries, deduplication, origin verification,
membership approval, and instance federation controls.

Acceptance: a user on instance B joins a channel on A and exchanges messages.
Duplicate delivery produces one message. Forged mutation is rejected. A temporary
outage retries successfully, and a block added during that outage prevents queued
restricted delivery. Disabling a local user's federation leaves local participation
available but stops their remote participation.

## 3. Topics and nested threads

Local and federated topics and nested replies are implemented and tested.
Topics are created on the home instance. A closer ThreadBNC interface review
remains future work.

Add topics and nested replies while retaining stable message identities. Build
the threaded reading experience against ThreadBNC's comment UI reference.

Acceptance: topical messages stay in their selected topic; nested replies retain
their parent on both instances. Cross-channel parent/topic references are rejected.
Deleting a parent preserves enough structure to render surviving replies.

## 4. Lemmy and PieFed interoperability

Build each adapter against real local fixtures. Start with public threaded
channels, community follows, titled posts, and comment trees. Record supported
activities and versions in a compatibility document.

Acceptance: a fixture and Archipel exchange a post and nested reply in both
directions. Edits and deletes propagate with correct authority checks. Unsupported
channel modes and visibility are handled explicitly rather than published with
incorrect semantics. Record moderation differences for each peer.

## 5. Mirrors and rehoming

First decide authority, consent, outage writes, reconciliation, and discovery
semantics. Then add public mirrors preserving provenance, followed by any
approved restricted-channel and ownership-transfer behavior.

Acceptance: a mirror retains readable history during an origin outage; replay
does not duplicate messages; a replica cannot forge authorship or origin
moderation. Test whatever write/reconciliation behavior is selected. Test that
restricted content never reaches an unauthorized mirror.

## 6. PWA notifications and voice

Add service-worker push, subscription management, and conversation-scoped Jitsi
admission using the ConsortStack integration pattern.

Acceptance: an installed client receives a notification while its tab is closed,
and logout/revocation stops subsequent push. An authorized member receives a
token scoped to the requested conversation; an outsider, banned user, or blocked
member cannot obtain one. Document and test active-call removal separately from
token expiration.
