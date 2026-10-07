# Archipel

A federated messenger with server-hosted identities, channels addressed as
`#channel@instance.domain`, and timeline, topical, and nested-thread conversations.

The original product brief lives in [ARCHIPEL.md](ARCHIPEL.md). The
[architecture proposal](docs/architecture.md) and [milestones](docs/milestones.md)
describe the longer-term direction.

## Run locally

Requires Node.js 24 or newer. SQLite is built into Node; no database server is needed.

```sh
npm ci
npm run setup -- --mode local
npm run dev
```

Open **http://127.0.0.1:8788**. Choose Alice, Bob, or Charlie. Alice is the explicit
development administrator. Use separate browser profiles or a private window to
try two users. Create a channel, join it from the other session, and send messages.
New messages and permission changes appear within about 2.5 seconds.

For containers, external proxy networks, trusted proxy addresses, and Traefik
routing, see [setup and deployment](docs/deployment.md). Start with
`npm run setup -- --mode traefik`, then `docker compose up --build -d`.

Development login is available only with `DEV_AUTH=true`, a loopback listener,
and a loopback HTTP `BASE_URL`. `npm run dev` sets that flag; `npm start` does not.
Development identities are separate from real OIDC identities, even when their
usernames match. New instances start without fabricated channels or conversations.

## Available now

- Persistent users, channels, memberships, sessions, messages, and custom emoji in SQLite.
- Standard :emoji: shortcodes, a searchable picker, admin-managed instance images,
  and personal uploads or locally saved emoji adopted from other instances.
- Author-only message editing, edited markers, and conflict checks.
- Invite-only instance registration with a private admin approval queue for provider identities and verified socials.
- Timeline channels, topics, and titled threads with nested replies.
- Public or members-only reading; open or invited membership.
- Identity allowlists, blocks, member removal, and delegated moderators.
- Owner protection, backend permission checks, instance account suspension,
  administrator inspection, audited message removal, and deletion placeholders.
- OIDC authorization code login with PKCE, state, nonce, signed token validation,
  and subject-matched UserInfo. Accounts use the exact issuer and subject.
- Optional verified social disclosure and a responsive browser interface.
- Opt-in Archipel federation: signed channel subscriptions, messages, edits,
  removals, and direct messages, with durable retries and verified author provenance.
- Administrator controls for each user's federated sending, receiving,
  subscriptions, and channel posting, plus remote instance/actor blocks.
- Stable actor URLs with ActivityStreams discovery and signed, authorized channel history.

The server is Express/TypeScript; the browser uses TypeScript and Vite. Runtime
files live in `data/`. Preserve the database and `BASE_URL` across restarts: they
hold identity and object continuity. To back up a running instance, use SQLite's
backup facilities; to copy files directly, stop the server first and copy the
whole data directory. Do not copy only a live WAL database's main file.

## Connect FedIdP or another OIDC provider

1. Run `npm run setup` to configure the environment, or copy `.env.example` to
   `.env` for a native instance and set `OIDC_ISSUER` and `OIDC_CLIENT_ID`.
2. Register `${BASE_URL}/auth/callback` as an exact redirect URI at the provider.
   For the default local instance this is `http://127.0.0.1:8788/auth/callback`.
3. Use a public PKCE client with `OIDC_AUTH_METHOD=none`, or configure its secret
   and `client_secret_basic` / `client_secret_post` as appropriate.
4. Run `npm run build` and `npm start` for OIDC-only mode. A loopback HTTP issuer
   is permitted only in local development; use `npm run dev` for that case.

No provider configuration is changed automatically. FedIdP's `openid profile`
claims supply its permanent username and consent-selected `verified_socials`.
Archipel also asks whether to show those socials to other members; the default
is off. Claims omitted on a subsequent login are removed from the local profile.

To appoint a production administrator, sign in once, run `npm run identities`
locally, and add the exact OIDC subject to the comma-separated `ADMIN_SUBJECTS`
setting for the configured issuer. Restart to apply it. Removing a subject
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

## Emoji, editing, and instance membership

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
that change; reopen the editor to load the current version. Administrators and
moderators can remove other people's messages but only authors can edit them.

For approval-based admission, open **Instance administration** and set **New user
access** to **Invite only**. New users still authenticate with FedIdP; their
accounts become pending and they see a waiting page without access to channels,
member lists, or messages. The **Membership applications** queue shows their
provider issuer/subject and the `verified_socials` they consented to disclose to
Archipel in FedIdP. The sign-in page explains this administrator review. Applicants
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

Federation starts disabled, and all four per-user permissions start disabled,
including for administrators. Open **Profile → Instance administration →
Federation controls** to enable it and grant sending, receiving, subscribing,
and channel posting separately. Owners/moderators must also opt each local
channel in through its settings → **Federation and remote followers**.

Users open **Profile → Federated conversations** to subscribe to
`#channel@instance.domain` or send a direct message to `user@instance.domain`.
Invited channels wait for a decision from their home owner/moderators before
sharing history. Controls are enforced by the server and checked again before
queued delivery. See [federation operations and protocol](docs/federation.md)
for the permission matrix, deployment requirements, and current limits.

## Checks

```sh
npm run build
npm test
npx playwright install --with-deps chromium
npm run test:browser
```

Backend tests cover access control, persistence, identity isolation, social
disclosure, a real signed local OIDC fixture, and real HTTP federation between
two and three instances, including forgery, retries, and permission revocation.
Browser tests use isolated temporary databases and two separate local servers.

## Next

The current federation profile connects Archipel instances. Lemmy/PieFed adapters,
mirrors/rehoming, service-worker push, attachments, and Jitsi calls remain future
work. Live browser updates currently use polling; see [milestones](docs/milestones.md).
