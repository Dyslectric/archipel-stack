# Prosody XMPP backend

Archipel now integrates with Prosody 13.0 for standard XMPP streams, TLS,
authentication, routing, roster/presence, stream management, and MUC presence.
The integration modules expose local timeline channels and direct messages using
the existing Archipel archive and permission checks. The browser remains a REST
client of the same archive; Express also handles OIDC, account approval, application
settings, richer channel views, and the existing ActivityPub federation.

## Supported interoperability profile

| Capability | Support |
| --- | --- |
| XMPP client streams, STARTTLS, SASL PLAIN, resource binding | Prosody; app passwords required, encryption mandatory |
| Service discovery, roster, presence, ping | Prosody |
| XEP-0198 stream management | Prosody |
| Local direct messages | Native clients and browser share history and blocks |
| XMPP server-to-server direct messages | Certificate-authenticated TLS; instance federation and per-user send/receive grants required |
| XEP-0045 rooms | Local timeline channels; authorized join, presence, chat, discovery |
| Occupants from other home servers | Federated public timeline channels; s2s join, bounded join history, live messages, posting, room MAM; moderation in Archipel |
| Foreign XEP-0045 rooms | Native client participation; browser join/leave, subjects, speaking roles, live messages and bounded join history |
| XEP-0313 MAM v2, XEP-0059 paging | Personal and room archives; bounded pages, timestamps, direct peer filter, before/after cursors |
| XEP-0359 stanza IDs | Stable archive IDs; native stanza IDs and origin IDs retained |
| XEP-0308 corrections | Timeline messages; author and room checks |
| XEP-0054 vCard photos, XEP-0153 avatar presence | Shared profile pictures; native reads/uploads/removals and federated picture caching |
| Room configuration, affiliations, kicks, invitations | Managed through Archipel; native management commands rejected |
| Offline messages | Retrieve through MAM after reconnect; no independent Prosody offline queue |
| Topics, nested threads, attachments, OMEMO in the browser | Not exposed by this profile |

This is a defined XMPP interoperability profile, not a claim that every XEP or
every client's optional feature is supported. Remote users can exchange direct
messages with local accounts, Archipel accounts can join foreign rooms, and
accounts on other home servers can join local rooms that opted into federation.
Local-room nicknames are assigned by Archipel: the account's stable XMPP node
for local accounts and the full bare address (`user@domain`) for occupants of
other servers. Foreign rooms use a chosen nickname, subject to the hosting
room's rules.

A native client finds the local timeline channels its account belongs to in its
bookmarks (private XML storage, `storage:bookmarks`), marked to join
automatically, beside any bookmarks the client saved itself. Clients read
bookmarks when they sign in, so a channel joined in the browser shows up after
the client reconnects; leaving is done in Archipel, since a bookmark removed in
the client comes back while the membership lasts. When Archipel refuses a join or
a message, the error the client shows carries Archipel's own reason — for
example that the account's role does not allow posting in a federated channel.
Attachments reach XMPP clients as written, `![name](https://…/media/…)`: the
address opens the file.

## Join a room hosted elsewhere

Use the **+** beside **XMPP rooms** in the conversation sidebar (or **Channels →
Join an XMPP room**). Enter a bare room address, such as `jdev@muc.xmpp.org`, and
a nickname. The room appears under **XMPP rooms**, which folds, groups and
reorders like the channel and direct-message sections; a room that is not
currently joined shows its state beside its name. Archipel shows the room subject,
nickname and role, and displays errors such as nickname conflicts or a required
invitation. Use **Leave room** to stop participating; saved history stays private
to your account. A room that drops you because either server restarted, or the
connection between them failed, is joined again automatically; use **Join again**
after being kicked, banned or refused.

The instance must have XMPP and federation enabled. The account's role must allow
joining XMPP rooms, with receiving and subscription grants to join/read, and
sending and posting grants to write.
The hosting room must also grant a participant or moderator role. Instance,
identity and personal room blocks apply on every receive/send and archive read.
Revoking access removes active browser and native occupants and cancels pending
browser posts.

Prosody maintains a separate browser resource for each subscription and rejoins
after a restart. When the room ends a session without removing the member on
purpose — a shutdown notice, an unreachable or restarting server, a join that goes
unanswered — Archipel tries again after 5 seconds, doubling the wait up to ten
minutes, and gives up after 200 failures in a row. A kick, a ban, loss of
membership or a refused join (wrong nickname, invitation required) is final until
the member joins again. Every two minutes each occupant pings its own nickname
(XEP-0410) and rejoins if the room no longer knows it, which covers a room that
restarted without a word. Browser subscriptions continue receiving while the browser is
closed. Join history is requested with limits of 100 messages and 100,000 XML
characters; the remote room chooses what it supplies. Older *locally received*
messages can be paged in the browser. This does not backfill the remote MAM
archive or guarantee messages sent while disconnected. Replayed history with
room-issued stanza IDs, sender-scoped message IDs or delayed timestamps is
deduplicated. Authors remain `room@service/nickname`, without inferring their
real identities from room nicknames. A room that discloses its occupants'
addresses (non-anonymous, or to moderators) names them in presence; live
messages then also show the sender's own `user@server`, from which they can be
sent a direct message or blocked everywhere. Replayed history is not attributed
this way, since a nickname may have changed hands. Where the room hides
addresses, a member can only be blocked by nickname in that room, and cannot be
messaged directly.

Browser messages show **Queued**, then **Awaiting room confirmation**, and are
confirmed when reflected by the room. Errors are shown separately. Dispatches
are recorded before routing; uncertain sends are not automatically retried after
an adapter crash, to avoid duplicate posts. If a confirmation never arrives,
check the room before sending again.

Native clients can join using **Settings → XMPP clients** credentials and their
client's usual group-chat dialog, including password-protected rooms and remote
MAM where supported by the room/client. They maintain their own room sessions;
opening a native room does not create a browser subscription. The browser
supports rooms that accept an ordinary presence join (including members-only
rooms when the account already has membership); password entry, room management,
occupant private messages, corrections, attachments and OMEMO are not exposed in
the browser view. Foreign content is not mirrored into local or ActivityPub
channels or the personal direct-message archive, except through a bridge.

## Bridge a channel with a foreign room

The owner of a local timeline channel (or an administrator) can bridge it with
one room on another server under **Settings → Channel → XMPP bridge**. The
owner needs the send, receive, subscribe and post grants, and joins the room as
the bridge's first occupant.

- Room to channel: each room message enters the channel once, however many
  bridged occupants hear it. Its author is the sender's own address when the
  room discloses it, otherwise `room@service/nickname`. These authors are
  `xmpp:` identities: readers need the receive grant to see them, personal and
  administrator blocks apply, and nothing is relayed onward to ActivityPub
  followers.
- Channel to room: a new message from a local member is repeated in the room by
  that member's own occupant, joined under their XMPP node the first time they
  write. This needs the member's own four grants; without them the message
  stays in the channel. These occupants are not listed under the member's
  **XMPP rooms** and keep no private archive.

Edits and removals are not carried across in either direction, and messages
from ActivityPub subscribers or from other servers' occupants of the channel's
own room are not repeated in the foreign room. A private subscription to the
same room never feeds a channel bridged by someone else. Removing the bridge,
or deleting the channel, retires the occupants made for it.

## Let other servers join a local room

Two Archipel instances share a room when one hosts it and members of the other
join it through **Channels → Join an XMPP room**, entering
`channel-name@channels.<XMPP_DOMAIN>` of the hosting instance. Any standard
XMPP client on another server can join the same way.

A local room admits accounts from other home servers only when all of these
hold, and each is checked again on every stanza and every delivery cycle:

- XMPP and federation are enabled on the instance, and the stanza arrived on a
  certificate-authenticated server-to-server stream;
- the channel is a timeline channel with **Federation** enabled in its
  settings and **Who can read** set to everyone (public);
- the channel has open membership, or a moderator has set an *Allow to join*
  rule for that identity after it was first seen;
- neither the sender's domain (administrator instance block) nor its
  `xmpp:user@domain` identity is blocked, and no channel rule blocks it.

The first admitted join creates a remote identity keyed `xmpp:user@domain` and a
channel membership. It is listed under the channel's **Members** with its full
address, and moderators remove or block it there exactly like a local member.
It cannot be made a moderator. Removal, a channel or instance block, or
disabling channel or instance federation evicts the occupant within the
one-second delivery cycle and refuses further posts and archive reads. A removed occupant
of an open channel may join again; use a block to keep it out. As for local
accounts, leaving the room keeps the membership.

Foreign occupants receive up to 100 messages of join history (25 unless the
client asks otherwise), live messages, corrections and removal notices, and can
page the room archive with MAM. They are only sent messages whose local author
currently holds the sending and posting federation grants; removed messages
appear as removal notices. Their own posts are committed to the Archipel
archive under the remote identity before any occupant sees them, deduplicated
by stanza ID within the server-to-server stream, and shown in the browser with
the full address as handle and an **XMPP** marker. Local members need the
receiving federation grant to see those posts in the browser, in native
clients and in unread counts; personal blocks of `xmpp:user@domain` hide them
like any other author. Corrections sent by foreign occupants, room discovery
on `channels.<XMPP_DOMAIN>`, private messages to occupants and room
administration from other servers are rejected. These posts are not relayed to
ActivityPub subscribers of the same channel.

Occupancy is live presence only: after the hosting Prosody restarts, or during
an Archipel policy-service outage, foreign occupants are removed. Occupants that
joined from another Archipel instance's browser come back by themselves once this
instance answers again; native clients rejoin as their own software decides.

## Configure a deployment

1. Run `python3 scripts/setup.py` and supply a lowercase **XMPP account domain**,
   such as `chat.example.org`. Setup adds `compose.xmpp.yaml` and generates a
   random bridge secret in `.env.container`. Re-running setup preserves that
   secret. Keep this file private. The client STARTTLS port defaults to 5222 and
   the federation port to 5269; setup prompts for both when XMPP is enabled and
   offers the next free ports when another service on the machine holds them.
   Setup also asks for the SRV target and how certificates are obtained, then
   prints the exact DNS records to publish.
2. Set up A/AAAA records for that domain and `channels.chat.example.org`, pointing
   to the server. Publish `_xmpp-client._tcp.chat.example.org` and
   `_xmpp-server._tcp.chat.example.org` SRV records using your configured client
   and federation ports (defaults 5222 and 5269).
   Publish a server SRV record for `channels.chat.example.org` as well. The SRV
   target must be a DNS host, not an IP literal.
3. Let setup obtain certificates (see [Certificates](#certificates)), or choose
   `manual` and obtain certificates covering `chat.example.org` and
   `channels.chat.example.org` yourself. Put the full certificate chains and matching
   unencrypted private keys in the configured `XMPP_CERTS_PATH`, default
   `./data/xmpp-certs`. Use Prosody's `domain.crt` / `domain.key` filenames.
   A single certificate with both names can be named `chat.example.org.crt`
   and `chat.example.org.key`; Prosody discovers its subject alternative names.
   The Prosody container user must be able to read the keys. Its default UID is
   100; confirm it for your platform with the pinned image's `id prosody`.
4. Allow inbound TCP on your configured client and federation ports, outbound
   connections to remote XMPP server ports (usually 5269), and DNS queries.
   Web proxy/Traefik HTTPS certificates and port 443 do not
   automatically configure XMPP TLS. Only publish IPv6 records when IPv6 works.
5. Run `docker compose config --quiet`, then `docker compose up --build -d`.
   Inspect `docker compose logs prosody` and run
   `docker compose exec prosody prosodyctl check config`.
6. Sign in through OIDC, then open **Settings → XMPP clients**. Create a password
   for each client and use the displayed JID and port with STARTTLS. Passwords
   are shown once. Do not use your OIDC password or ID token.

The overlay uses the official Prosody 13.0 image pinned to the tested digest.
Upgrade the image and integration together after running the real XMPP checks.
The service has a separate `prosody-data` volume for roster, presence-related
settings, stream state, and the projection cursor. Back up that volume alongside
`archipel-data`, configuration, bridge secret, and certificates. Avoid changing
`XMPP_DOMAIN`: it is an identity domain, not a cosmetic setting. Archipel refuses
to start with a different domain once the integration has been configured.

For a manually configured Archipel process, set `XMPP_DOMAIN` and
`XMPP_BRIDGE_SECRET` in its environment, and configure the same secret plus
`ARCHIPEL_API_URL` in Prosody. The supplied Lua configuration reads those values.
Mount the supplied modules under `/etc/prosody/archipel-modules`. Optional
`XMPP_CA_FILE` can select a private PKI trust anchor for Prosody; public servers
normally use system certificate roots.

### Certificates

Setup asks **XMPP certificates (manual / acme / traefik)**. Both automatic
choices issue one certificate naming the account domain and
`channels.<XMPP_DOMAIN>`, keep it renewed, and reload Prosody when it changes.
Prosody starts without a certificate and picks the first one up within a minute
of it being issued; until then clients and other servers cannot connect.

- **`acme`** adds a small [lego](https://go-acme.github.io/lego/) service
  (`compose.xmpp-acme.yaml`) that requests the certificate from Let's Encrypt.
  Setup asks for a contact email and for your agreement to the certificate
  authority's terms of service, then for the challenge:
  - `dns` proves control through your DNS provider's API and works behind any
    proxy or CDN. Give lego's provider code (for example `cloudflare`) and the
    credentials that provider documents, as `NAME=value` pairs
    (`CLOUDFLARE_DNS_API_TOKEN=...`). They are kept in `.env.acme`, readable only
    by the certificate service. Use a token limited to editing that DNS zone.
  - `http` uses public port 80. In `container` mode lego binds the host port
    directly (`compose.xmpp-acme-http.yaml`), so that port must be free. In
    `traefik` mode setup adds `compose.xmpp-acme-traefik.yaml` and attaches lego
    to `PROXY_NETWORK`. Traefik forwards only `/.well-known/acme-challenge/`
    requests for the account and channels domains to lego's container port 80,
    without publishing a host port. Setup asks for the existing HTTP entrypoint
    (`XMPP_ACME_HTTP_ENTRYPOINT`, default `web`); the app's HTTPS entrypoint stays
    separate. Both names must reach that Traefik on public port 80. Generic
    `proxy` mode supports DNS challenges instead.

  Follow issuance with `docker compose logs -f xmpp-acme`. A failed request is
  retried hourly. Set `XMPP_ACME_SERVER=letsencrypt-staging` in `.env` to
  rehearse against the staging authority; its certificates are not trusted by
  other servers.
- **`traefik`** reuses the certificate resolver already configured for the web
  router (`compose.xmpp-traefik-certs.yaml`). A label asks Traefik to issue the
  two XMPP names, and Prosody's container reads the result from Traefik's
  `acme.json`. Setup asks for that file's path on the host; for a named Docker
  volume this is under `/var/lib/docker/volumes/<volume>/_data/`. The resolver
  must be able to validate both names: with an HTTP or TLS challenge,
  `channels.<XMPP_DOMAIN>` needs a DNS record that reaches Traefik. The store is
  mounted read-only and read as root before Prosody drops privileges; the
  Prosody process itself cannot read Traefik's other keys.
- **`manual`** keeps the previous behaviour: you place the files in
  `XMPP_CERTS_PATH` and reload Prosody after renewing them.

### HTTP challenges through an existing Traefik

Run `python3 scripts/setup.py --mode traefik`. Keep your existing proxy network
and HTTPS entrypoint, choose `acme` certificates and the `http` challenge, and
answer `web` for **Existing Traefik HTTP challenge entrypoint**. For an existing
configuration, the relevant settings in `.env` are:

```dotenv
XMPP_CERT_SOURCE=acme
XMPP_ACME_CHALLENGE=http
XMPP_ACME_HTTP_ENTRYPOINT=web
```

Re-run setup after editing these settings so it selects the correct Compose
overlays and regenerates `.env.acme`. A contact email and agreement to the CA's
terms are also required. Setup does not modify the existing Traefik service.

If Traefik redirects `web` to HTTPS or uses its own HTTP ACME resolver on `web`,
enable challenge routing in Traefik's **static** configuration:

```yaml
entryPoints:
  web:
    address: ":80"
    allowACMEByPass: true
```

The CLI equivalent is `--entryPoints.web.allowACMEByPass=true`. Restart Traefik
after changing its static configuration. On current Traefik, this allows custom
challenge routers to precede its internal ACME handler and excludes challenge
paths from entrypoint HTTPS redirects; see the
[Traefik entrypoint documentation](https://doc.traefik.io/traefik/reference/install-configuration/entrypoints/#allowacmebypass).
If your version still redirects these requests, lower the entrypoint redirect
priority with `--entryPoints.web.http.redirections.entryPoint.priority=1` so the
challenge router (priority 10000) wins. Any authentication or redirect middleware
attached to the HTTP entrypoint must also allow challenge requests through.

Ensure both `XMPP_DOMAIN` and `channels.<XMPP_DOMAIN>` reach Traefik on public
port 80, then run:

```sh
docker compose config --quiet
docker compose up --build -d
docker compose logs -f xmpp-acme
```

Lego's challenge listener runs during validation; a 404 or 502 outside an active
challenge does not by itself indicate a routing failure. Certificate files and
renewal continue to use the shared ACME volume and Prosody reload mechanism.

### Behind Cloudflare or another HTTP proxy

XMPP is not HTTP. A proxied (orange-cloud) Cloudflare record, or any CDN or web
proxy address, does not forward ports 5222 and 5269, so clients and other servers
cannot reach Prosody through it. Keep the web hostname proxied if you wish, and
publish a separate DNS-only record for the machine, such as `xmpp.example.org`.
Point every XMPP SRV record's target at that name. The account domain stays
`chat.example.org`: SRV changes where connections go, not the identity, and the
certificate must still name the account domain and `channels.<XMPP_DOMAIN>`,
not the SRV target. Without SRV records, other servers connect to the account
domain's own address on port 5269 and time out at the proxy; room joins then
typically end with "The room did not answer the join request".

Setup asks for this name as the **DNS name of this machine for XMPP SRV
records**, stores it as `XMPP_SRV_TARGET`, and prints the three SRV records with
your ports filled in. A web proxy's certificates are not used by Prosody unless
you choose the `traefik` source above; the `acme` source with a `dns` challenge
works while the web names stay proxied.

### Several instances on one machine

Each instance is its own clone with its own instance name (see
[deployment](deployment.md#several-instances-on-one-machine)) and runs its own
Prosody. Give every instance its own pair of ports
and let SRV records carry them; no TCP proxy is needed. Setup proposes ports that
nothing on the machine is listening on, so configure and start the first instance
before running setup for the second:

```dotenv
# instance one                # instance two
XMPP_DOMAIN=one.example.org   XMPP_DOMAIN=two.example.org
XMPP_CLIENT_PORT=5222         XMPP_CLIENT_PORT=5223
XMPP_SERVER_PORT=5269         XMPP_SERVER_PORT=5270
```

```text
_xmpp-client._tcp.one.example.org.          SRV 0 5 5222 xmpp.example.org.
_xmpp-server._tcp.one.example.org.          SRV 0 5 5269 xmpp.example.org.
_xmpp-server._tcp.channels.one.example.org. SRV 0 5 5269 xmpp.example.org.
_xmpp-client._tcp.two.example.org.          SRV 0 5 5223 xmpp.example.org.
_xmpp-server._tcp.two.example.org.          SRV 0 5 5270 xmpp.example.org.
_xmpp-server._tcp.channels.two.example.org. SRV 0 5 5270 xmpp.example.org.
```

Open all four ports in the firewall. Each instance obtains its own
certificates. In `traefik` mode, multiple instances can use `acme` with `http`
through the same `web` entrypoint: each router matches its own XMPP domains and
uses its unique instance name. In `container` mode, only one instance can bind
host port 80, so use DNS challenges or Traefik routing for the others.
The instances federate with each other like any two servers, including when
they share an address: accounts exchange direct messages and can join the other
instance's public timeline channels that opted into federation.

### Custom listener ports

For example, set these values in `.env` or enter them during setup:

```dotenv
XMPP_CLIENT_PORT=55222
XMPP_SERVER_PORT=5269
```

Both ports accept integers from 1 to 65535 and must differ. Compose publishes
the configured ports, and Prosody listens on the same ports inside its container.
Archipel's **Settings → XMPP clients** displays the configured client port.
Changing a port preserves account addresses, passwords and history.

After changing the client port, update `_xmpp-client._tcp.<XMPP_DOMAIN>` to that
port, adjust the firewall, and run `docker compose up --build -d`. Clients using
automatic discovery read the SRV record; clients with a manual port setting need
the new value. If you change the federation port, update the server SRV records
for both the account domain and `channels.<XMPP_DOMAIN>` as well. These remain
STARTTLS listeners; changing the port does not enable direct TLS.

### Shared profile pictures

Pictures uploaded under **Settings → Profile** are shared with permitted remote
contacts over XMPP vCard photos. XMPP clients can read, replace or remove their
own photo using `vcard-temp`; the same picture appears in Archipel. Native vCard
writes update the photo only; other vCard fields remain managed in Archipel.
Available presence advertises the authoritative SHA-1 avatar hash, including an
empty photo element after removal. Foreign photos are fetched through Prosody
when a conversation opens, a message arrives or a changed presence hash is seen.
Remote photos are cached locally and used in browser messages and conversations.
PEP user-avatar (XEP-0084) is not implemented by this profile.

ActivityPub actors advertise a public home-instance image URL when the account
has federation permissions. Signed profile updates notify existing contacts and
channel subscribers, including authors relayed through a channel's home server.
Receivers refresh the author's own profile and cache validated raster bytes;
foreign URLs are never loaded directly by the browser. Downloads are limited to
2 MiB, use the existing federation network restrictions, and accept only the
supported raster formats. An unavailable image does not reject the conversation.
Updates preserve personal contact names. Removing a picture removes its remote
cached copy after notification; current blocks, federation settings and account
admission apply to profile reads and queued requests.

## Policy, archive, and protocol boundaries

`xmpp_accounts` explicitly binds a stable node to the immutable local user ID.
Existing users get a binding when they configure XMPP or participate in a local
message delivery. Usernames are only suggestions when creating a binding; matching
OIDC claims or remote JIDs never link identities. App passwords contain random
256-bit secrets; only their SHA-256 digests are stored. Password revocation,
suspension, and pending/declined admission reject login and subsequent operations.
Active streams are checked on incoming stanzas and during the one-second delivery
cycle; revoked streams are disconnected. An unavailable policy service rejects
operations and disconnects active clients.
Changing the configured OIDC issuer or disabling development authentication
also revokes app credentials for identities outside the resulting auth policy.

The private `/internal/xmpp` adapter requires its own bearer secret. Keep it off
public proxy routes; it must only be reachable by the trusted Prosody service.
Cookie authentication cannot substitute for this secret. The adapter trusts
Prosody to assert authenticated c2s/s2s sender identities, so protect both the
service network and secret. Browser endpoints retain OIDC sessions, Origin checks,
CSRF, and admission checks.
The supplied Traefik router excludes `/internal/`. Configure nginx, Caddy, or any
other public proxy to reject that prefix rather than forwarding it to Archipel.

Archipel is authoritative for messages and membership. Prosody commits incoming
messages through Archipel before distribution. Browser and native writes create
transactional outbox references; delivery fetches current content and policy.
Membership removal evicts occupants, channel blocks prevent posting/history,
and personal blocks redact room messages and reject direct messages. Built-in MUC
history, independent MAM archives, offline queues, carbons, and native room
administration are disabled to prevent alternative writes or reads bypassing
these controls. Join history for occupants of other servers is produced by
Archipel under the same checks, not by Prosody. A room join may create membership in an open channel; closing a
client's room window only leaves its live presence, retaining Archipel membership.

Native remote contacts use `xmpp:user@domain` identity keys. An ActivityPub actor
with a matching name remains a separate identity. Enter `xmpp:user@domain` in the
browser's direct-message recipient field to select XMPP explicitly. Instance
domain blocks and per-user federation send/receive grants apply to these messages.
ActivityPub channel content is not automatically forwarded into XMPP rooms, and
XMPP content is not attributed to an ActivityPub remote author. Public local
channel posts still follow that channel's existing ActivityPub opt-in policy.

Outbox projection is at least once across a cursor-store failure; use stable
message IDs to deduplicate. Offline users retrieve committed content through
MAM. External s2s delivery uses Prosody's queue and errors; this first profile
does not provide durable offline retry across a Prosody restart or guaranteed
delivery acknowledgements to the browser. An accepted browser send means the
local archive accepted it, not that a remote client read it.

Incoming native stanza IDs are deduplicated within their authenticated stream.
Different resources and later streams can reuse those IDs. Corrections prefer
the current stream's reference in the target room; if a reference from another
stream is ambiguous, use the stable archive ID. Administrator instance blocks
apply to XMPP accounts on the blocked URL's hostname as well as ActivityPub.

## Checks

```sh
npm ci
npm run build
npm test
npm run test:xmpp
```

The real XMPP integration check requires Docker and Node 24 or newer. It creates
temporary Prosody containers, test certificates, a separate standard Prosody
peer, and a temporary network. It checks real TLS/SASL streams, MUC discovery,
native/browser delivery, stable IDs, corrections, personal/room MAM, policy
rejection and revocation, foreign rooms, and the peer's user joining, reading
and posting in a federated local room. Fixtures are cleaned up on completion. Certificates
and DNS overrides are limited to the disposable test network.

One executable with bundled Prosody remains future work; see
[standalone packaging](xmpp-packaging.md).
