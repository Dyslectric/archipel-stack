# Archipel Stack

A federated messenger with server-hosted identities, channels addressed as
`#channel@instance.domain`, and timeline, topical, and nested-thread conversations.

This repository holds the whole stack. Its parts have their own names and can be
described, used and replaced separately:

| Name | What it is | Where |
| --- | --- | --- |
| FWDXP | The Federated Web Discussion Exchange Protocol, spoken between servers | [docs/fwdxp.md](docs/fwdxp.md) |
| Archipel Server | Identities, channels, policy, the archive, and FWDXP and XMPP federation | `src/` |
| Archipel Web | The browser application | `client/` |
| Archipel Stack | Archipel Server, Archipel Web and the Prosody XMPP backend, as deployed together | this repository |

"Archipel" on its own is not the name of any of these.

The original product brief lives in [ARCHIPEL.md](ARCHIPEL.md). The
[architecture proposal](docs/architecture.md) and [milestones](docs/milestones.md)
describe the longer-term direction.

## Run with Docker

Requires Python 3.9 or newer, Docker, and Docker Compose 2.30 or newer on the host.
Setup uses Python's standard library. Node, npm, and application dependencies are
installed and used inside Docker; no host npm or pip installation is needed.

```sh
python3 scripts/setup.py --mode container
docker compose config --quiet
docker compose up --build -d
```

Configure your OIDC issuer/client during setup, then open
**http://127.0.0.1:8788** and sign in. Use separate browser profiles or a private
window to try two users. Create a channel, join it from the other session, and send messages.
New messages and permission changes are pushed to open browsers as they happen.

For containers, external proxy networks, trusted proxy addresses, and Traefik
routing, see [setup and deployment](docs/deployment.md). Start with
`python3 scripts/setup.py --mode traefik`, then `docker compose up --build -d`.

Container deployments disable development login. Tests use development accounts
only with `DEV_AUTH=true`, a loopback listener, and a loopback HTTP `BASE_URL`.
Development identities are separate from real OIDC identities, even when their
usernames match. New instances start without fabricated channels or conversations.

## Available now

- Persistent users, channels, memberships, sessions, messages, and custom emoji in SQLite,
  or in PostgreSQL when `DATABASE_URL` names one; an existing instance moves over with
  one command. See [setup and deployment](docs/deployment.md#postgresql).
- Live updates over a server-sent event stream: an open browser is told when something
  it shows has changed, and only then asks for it.
- Standard :emoji: shortcodes, a searchable picker, admin-managed instance images,
  and personal uploads or locally saved emoji adopted from other instances.
- Author-only message editing, edited markers, and conflict checks.
- Markdown in channels, threads, direct messages and XMPP rooms: emphasis, code,
  quotes, lists, headings, links and spoilers, escaped and rendered in the browser.
- Image, GIF and video attachments (PNG, JPEG, GIF, WebP up to 10 MiB; MP4, WebM up
  to 50 MiB), attached with the paperclip, by pasting, or by dropping a file.
- Instance roles: a default role and any number of others, each granting channel
  creation, channel federation, direct messages, attachments, XMPP room joining,
  seeing the instance's member list and the four federation grants. See [roles](#roles).
- A sidebar that resizes and folds away, and a member list beside each channel.
- Invite-only instance registration with a private admin approval queue for provider identities and verified socials.
- Timeline channels, topics, and titled threads with nested replies. Timeline
  and topic messages can reply to one another and link back to what they answer.
  A threaded channel can make thread titles optional, when it is created or later
  from its settings.
- Per-channel privacy: the owner can keep the member list, and the handles
  behind display names, to the owner and moderators and the members they allow.
- Public or members-only reading; open or invited membership.
- Identity allowlists, blocks, member removal, and delegated moderators.
- Channel roles: the owner names roles that let chosen members remove members,
  ban people, ban whole instances, or delete messages, without making them
  moderators. See [channel roles](#channel-roles).
- Owner protection, backend permission checks, instance account suspension,
  administrator inspection, audited message removal, and deletion placeholders.
- OIDC authorization code login with PKCE, state, nonce, signed token validation,
  and subject-matched UserInfo. Accounts use the exact issuer and subject.
- Optional verified social disclosure and a responsive browser interface.
- Opt-in federation between instances over FWDXP: signed channel subscriptions, messages, edits,
  removals, and direct messages, with durable retries and verified author provenance.
- Role-based control of federated sending, receiving, subscriptions, and channel
  posting, plus remote instance/actor blocks.
- Stable actor URLs with ActivityStreams discovery and signed, authorized channel history.
- Shared profile pictures across ActivityPub and XMPP instances, with local caching
  and propagation of changes and removals.
- Prosody XMPP integration: native client login with revocable app passwords,
  direct messages, local timeline MUC rooms, authorized MAM history, and TLS
  server-to-server direct messaging. Join foreign XMPP rooms from the browser
  or a native client, with private browser histories and room role checks; rooms
  joined from the browser are rejoined by themselves after either server restarts.
  See [XMPP setup and supported profile](docs/xmpp.md).

The server is Express/TypeScript; the browser uses TypeScript and Vite. Runtime
files live in the persistent Docker volume at `/app/data`. Preserve the database and `BASE_URL` across restarts: they
hold identity and object continuity. To back up a running instance, use SQLite's
backup facilities; to copy files directly, stop the server first and copy the
whole data directory. Do not copy only a live WAL database's main file. With
PostgreSQL, use `pg_dump`.

For XMPP, supply an account domain during setup. Setup can obtain certificates
for it and `channels.<domain>` through ACME or an existing Traefik resolver, and
prints the DNS records to publish. Setup includes the Prosody service; users
connect through **Settings → XMPP clients**. Archipel Server retains its OIDC, policy,
archive and ActivityPub services while Prosody handles XMPP streams and routing.

## Connect FedIdP or another OIDC provider

1. Run `python3 scripts/setup.py` and configure `OIDC_ISSUER` and `OIDC_CLIENT_ID`.
2. Register `${BASE_URL}/auth/callback` as an exact redirect URI at the provider.
   For the default local instance this is `http://127.0.0.1:8788/auth/callback`.
3. Use a public PKCE client with `OIDC_AUTH_METHOD=none`, or configure its secret
   and `client_secret_basic` / `client_secret_post` as appropriate.
4. Run `docker compose up --build -d`. Containers use OIDC-only mode; the issuer
   must use HTTPS and be reachable from the container.

No provider configuration is changed automatically. FedIdP's `openid profile`
claims supply its permanent username and consent-selected `verified_socials`.
Archipel Server also asks whether to show those socials to other members; the default
is off. Claims omitted on a subsequent login are removed from the local profile.

To appoint a production administrator, sign in once, run
`docker compose exec archipel node scripts/identities.js`, and add the exact OIDC
subject to the comma-separated `ADMIN_SUBJECTS` setting using setup. Recreate the
container with `docker compose up -d` to apply it. Removing a subject
revokes that stored administrator grant on restart, including for existing
sessions. Disabling development authentication revokes development sessions;
changing issuers revokes sessions that no longer match the configured issuer.
There is no first-user administrator bootstrap.

For a public instance set an HTTPS `BASE_URL`, disable development auth, and
terminate TLS at your reverse proxy. Keep the application port private to that
proxy. Cookies are HttpOnly, SameSite=Lax, and Secure for HTTPS; mutations check
the configured origin and session CSRF token. Keep `.env` and `data/` private.
The provider must use asymmetric signed ID tokens. Reverse proxies must preserve
the browser's Origin header. Set `TRUSTED_PROXY` to the actual proxy IP or CIDR
to honor its forwarded headers and rate-limit clients individually. Setup can
configure this together with the container's external proxy network.

## Sign in a program without a browser

A terminal client or other program signs in through its user's browser. It asks
`POST /auth/device/code` and is given a `verification_uri` to show, with a short
`user_code` in it, and a `device_code` it keeps to itself. The user opens the
address, signs in through the provider if they are not signed in already, sees the
code and who they are, and answers. The program meanwhile asks
`POST /auth/device/token` with its `device_code` every `interval` seconds: it is
told `pending` until the answer is yes, then given a session `token` and `csrf`
once. It sends the token as the session cookie, the instance's address as Origin
and the CSRF token on changes, as the browser does.

That session is the program's own, and lasts as long as a browser's. A sign-in
waits ten minutes for its answer, in the database, so restarting the server
meanwhile does not lose it. Only an approved, unsuspended account can let a
program in.

## Emoji, editing, and instance membership

Open **Settings → Profile** to upload or remove your profile picture. PNG, JPEG,
GIF, and WebP files up to 2 MiB are supported, with a preview before upload.
Pictures fill the avatar square and appear in messages, direct conversations,
member lists, and your account menu. They are stored in SQLite and survive restarts;
removing a picture restores your initial.

Click a person's name in a message, member list, or direct conversation header
and choose **Set display name** to give a user on another host a personal contact
name. This works with XMPP and ActivityPub contacts. The name is shown in your
conversations, inbox, and remote message authors while their address remains
visible. It persists across sign-ins and restarts; leave the name blank to restore
their original name. Each member's contact names are private to that member.

Click a person's name in a message, member list, or direct conversation header
and choose **Block user** to stop direct messages between you and hide their
channel message content from your account. Replies by other people remain visible,
and blocked messages do not appear as new in your inbox. Past direct message
history is preserved. Choose **Unblock user** from the same menu to restore
contact and channel content. Personal blocks persist across sign-ins and restarts
and apply to local and remote users without changing anyone else's channel access.

Open the menu on a direct conversation in the sidebar and choose **Close
conversation** to take it out of your sidebar and inbox. Its messages are kept
and the other person isn't told. It comes back when either of you writes in it
again, or when you reopen it under **Settings → Closed conversations**.

Type `:smile:`, `:heart:`, `:+1:`, or another standard shortcode in a message.
The Emoji button searches standard and custom emoji and inserts a shortcode.
An instance administrator can open their profile → **Instance administration** →
**Custom emoji** to upload a PNG, JPEG, GIF, or WebP up to 256 KiB and choose a
unique lowercase shortcode. Emoji images live in SQLite; no additional storage
volume is required. Removing a custom emoji leaves its shortcode visible in
existing messages. Standard names cannot be replaced.

Every approved user can open **Profile → Your emoji** to upload personal images
or adopt an emoji from another instance under a chosen shortcode. Saved images
are copied into this instance's database and remain available if the source
disappears. Each user can keep up to 200 personal emoji and rename or remove
them. Their picker includes their own collection; other readers see the images
used in their messages. Renaming or removing a personal emoji preserves its
image and original shortcode in older messages.

Authors can use **Edit message** on their own messages while they remain channel
members. Thread roots can also have their title edited. Edits keep the message's
ID, position, topic, and reply relationships and show an edited marker. If another
edit happened while the editor was open, the save is rejected so it cannot overwrite
that change; reopen the editor to load the current version. Administrators,
moderators and members whose [channel role](#channel-roles) allows it can remove
other people's messages but only authors can edit them.

For approval-based admission, open **Instance administration** and set **New user
access** to **Invite only**. New users still authenticate with FedIdP; their
accounts become pending and they see a waiting page without access to channels,
member lists, or messages. The **Membership applications** queue shows their
provider issuer/subject and the `verified_socials` they consented to disclose to
Archipel Server in FedIdP. The sign-in page explains this administrator review. Applicants
can change disclosure in FedIdP and sign in again to refresh those claims. No
socials are required to apply; the queue explicitly shows when none were shared.
These claims are provider-verified accounts, not proof of a real-world identity.

Administrators can approve or decline applications, and reconsider declined
applications. Approval grants instance membership; the applicant's open page
updates automatically. Declined identities stay declined across sign-ins.
Existing members retain access when invite-only mode is enabled. Switching to open
registration admits future new users automatically; pending or declined accounts
still need an explicit decision. Approval does not enable public social sharing.
Only the applicant and instance admins can inspect their private application.

The setup script also asks for `REGISTRATION_MODE=open` or `invite_only` as the
initial policy. This seeds a database without a saved policy. Afterwards, the
admin setting is authoritative and survives restarts. Exact `ADMIN_SUBJECTS`
accounts are always approved, including an existing pending application, so the
administrator bootstrap described above works on an invite-only instance.
Database upgrades retain existing accounts as approved members.

## Federation

Federation starts disabled, and the default role grants none of the four
federation permissions, including to administrators. Open **Settings → Instance
federation** to enable it, then grant sending, receiving, subscribing, and channel
posting through a [role](#roles). Owners/moderators must also opt each local
channel in through its settings → **Federation**.

## Roles

**Settings → Roles** lists what each role allows; **Settings → People** gives an
account a role. Everyone without one has the default role, and new accounts start
on it. A role grants, separately:

| Grant | Covers |
| --- | --- |
| Create channels | Starting channels and mirrors |
| Open their channels to federation | Turning federation on for a channel they manage |
| Send direct messages | Writing to anyone, here or elsewhere; what others send still arrives |
| Attach images and videos | Uploading files into messages |
| Join XMPP rooms on other servers | Browser and native-client joins, and speaking through a bridge |
| See the list of everyone on this instance | Browsing all accounts when starting a direct message or changing a channel's access; without it a person is named by their handle. Administrators always see the list |
| Send / receive federated messages | As described under [federation](docs/federation.md) |
| Subscribe to remote channels, post in federated channels | Likewise |

The default role and new roles start with every local grant except the member
list, and no federation grant. Upgrading keeps everyone's other access: the default role is created that way, and accounts that had federation switches of their
own are moved to roles carrying exactly those. Deleting a role returns its accounts
to the default one. Administrators follow their role like anyone else.

## Banned emoji

A channel's owner and moderators can ban an emoji from it under channel settings →
**Overview**, and an administrator can ban one from the whole instance under
**Settings → Custom emoji**. A banned emoji cannot be written or given as a reaction,
under any of its shortcodes or typed as itself. Messages already posted are stored as
they were and shown without it, so lifting the ban brings it back; reactions given with
it are removed. A channel's list travels to the instances following it; an instance's
list holds on that instance only, in its channels and direct messages.

## Channel roles

A channel's owner and moderators can do everything in it. Its owner can let other
members do some of it: channel settings → **Roles** names up to 20 roles, and
**Members** gives one to a member, or to someone following the channel from
another instance. A role grants, separately:

| Grant | Covers |
| --- | --- |
| Remove members | Taking someone out of the channel; they can join again if it lets them. A follower on another instance has their follow ended |
| Ban people | Blocking someone from the channel, which removes them too, and lifting such bans under **Access rules** |
| Ban instances | Channel settings → **Banned instances**: everyone following from that instance is removed and nobody there can follow, post or react until the ban is lifted. `xmpp:example.org` bans an XMPP server from the channel's room |
| Delete messages | Removing other people's messages |

Someone acting through a role reaches members who hold no role: not the owner,
moderators or other role holders. Removing or banning members lets them see the
member list of a channel that otherwise hides it. Roles are kept on the channel's
home instance. Someone who holds one while following from another instance
deletes messages, removes and bans from there: their instance asks the home,
which decides from its own roles each time. Banning instances is done on the
home only. See [federation](docs/federation.md#channel-roles-across-instances). Only the
owner (or an administrator) creates, changes and gives out roles; leaving or being
removed gives the role up, and making someone a moderator replaces it.

## Attachments

Files are stored in the database and served from `/media/<name>`. The name is 256
random bits and is the only permission: a message carries the address, so anyone
who can read the message — including members of other servers it federates or is
bridged to — can fetch the file, and nobody else can find it. Responses cannot run
as pages. Removing a message, or deleting its channel, deletes the files its author
attached to it. Pictures and videos hosted anywhere else are shown as links, so
reading a message never contacts a third party. An account may upload 200 files or
500 MiB a day. If a reverse proxy sits in front, allow request bodies of 51 MiB.

Users open **Profile → Federated conversations** to subscribe to
`#channel@instance.domain` or send a direct message to `user@instance.domain`.
Invited channels wait for a decision from their home owner/moderators before
sharing history. Controls are enforced by the server and checked again before
queued delivery. See [federation operations](docs/federation.md) for the
permission matrix, deployment requirements, and current limits, and
[FWDXP](docs/fwdxp.md) for the protocol.

## How this was built

The code in this repository, including its automated tests, was written by an AI
coding agent working to the author's direction. The author has so far judged the
result by its behaviour and by the tests, not by reading the source. This section
says what stands behind each part, and will be updated as that changes.

### The author's design input

- The product brief in [ARCHIPEL.md](ARCHIPEL.md): server-hosted identities,
  `#channel@instance.domain` addresses, and the timeline, topical and threaded
  conversation shapes.
- What each feature does. Features were asked for one at a time, used, and
  corrected.
- The permission and privacy model: roles and their grants, federation off until
  it is granted, channel privacy, and saying what joining shares.
- Interaction details found by using the application: touch gestures, the emoji
  card's behaviour, sizes and spacing.
- The look of both interface styles, given as written descriptions and corrections.
  The Fusion mockups were AI-generated, then chosen and approved by the author.
- The protocols: federation between instances, named FWDXP, with XMPP beside it.
- The deployment shape: Docker only, a Python setup script, Traefik, and OIDC
  through FedIdP.
- PostgreSQL as well as SQLite, and Prosody for XMPP. TypeScript is what the
  author would have chosen; Express was the agent's choice. The author plans a
  native build that runs from a single executable.
- The names: FWDXP, Archipel Server, Archipel Web and Archipel Stack.

### What has been verified, and how

"Backend tests" are the suites in `test/`, run as described under
[Checks](#checks). "Browser tests" are the Playwright suites in `e2e/`, which drive
Chromium against local servers using development accounts. "By hand" means the
author used it on the two deployed instances, in Firefox and Chromium on a
desktop and on an Android phone.

| Area | Backend tests | Browser tests | By hand |
| --- | --- | --- | --- |
| OIDC sign-in | Signed local OIDC fixture | Development accounts only | Yes, through FedIdP, which is not yet public |
| Invite-only registration and approval | Yes | Yes | Yes |
| Instance roles and grants | Yes | Federation posting grant only | Yes |
| Channel roles and per-channel instance bans | Yes | No | Not yet recorded |
| Program sign-in without a browser | Yes | No | Yes |
| Timeline, topical and threaded channels; replies and quotes | Yes | Yes | Yes |
| Direct messages, blocks, contact names, closed conversations | Yes | Yes, except closing a conversation | Yes |
| Editing, Markdown, attachments | Yes | Yes | Yes |
| Moderation and channel privacy | Yes | Invitation and block only | Yes |
| Emoji picker, shortcodes and the emoji card | Shortcodes | Yes | Yes |
| Custom and personal emoji | Yes | Yes | Yes |
| Reactions | Yes | Yes | Yes |
| Live updates and push notifications | Yes | Notification choices; no push delivery | Yes |
| Fusion and Default styles, windows, time format | No | Yes | Yes |
| Sidebar, members panel and settings layout | No | Yes | Yes |
| Touch | No | Emulated touch in Chromium | Yes, on an Android phone |
| FWDXP: channels, messages, edits and removals between instances | Yes, two and three instances over HTTP | Yes, two instances | Yes, between the two deployed instances |
| FWDXP: direct messages | Yes | Yes | Yes |
| FWDXP: emoji, reactions, profile pictures, member lists | Yes | Adopting a remote emoji | Yes |
| Federation controls and blocks | Yes | Admin-controlled posting | Yes |
| XMPP: app passwords and native client login | Yes, with real Prosody in `npm run test:xmpp` | App passwords | Yes, with Monocles and Conversations: limited but promising |
| XMPP: local rooms and history | Yes | No | Yes, with the same clients |
| XMPP: rooms and servers elsewhere | Yes | Joining, posting and room roles | Yes |
| XMPP: bridges and mirrors | Yes | No | Not yet tested by hand |
| Setup script and Compose files | Python setup tests | No | Yes, on the deployed hosts behind Traefik |
| XMPP certificates and DNS | Setup tests | No | Yes |
| PostgreSQL | Yes, when `ARCHIPEL_TEST_POSTGRES` is set | No | Yes |

Nothing has yet been tested by hand on an iPhone or in Safari.

## Checks

```sh
python3 -m unittest discover -s test -p 'test_*.py' -v
docker build --target build -t archipel-checks .
docker run --rm archipel-checks npm test
# The same suite against PostgreSQL: every database a test opens becomes a schema there.
ARCHIPEL_TEST_POSTGRES=postgres://user:password@127.0.0.1:5432/archipel_test npm test
docker build --target browser-tests -t archipel-browser-tests .
docker run --rm --init --shm-size=1g archipel-browser-tests
```

Backend tests cover access control, persistence, identity isolation, social
disclosure, a real signed local OIDC fixture, and real HTTP federation between
two and three instances, including forgery, retries, and permission revocation.
Browser tests use isolated temporary databases and two separate local servers.
The Docker build checks TypeScript and compiles both client and server. The browser
test image installs Chromium and its dependencies inside Docker. Setup tests run
with Python only; Compose integration checks also run when Compose is installed.

## Next

FWDXP, the current federation profile, connects Archipel Server instances. Lemmy/PieFed adapters,
mirrors/rehoming, service-worker push, attachments, and Jitsi calls remain future
work. See [milestones](docs/milestones.md).
