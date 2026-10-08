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
| XEP-0313 MAM v2, XEP-0059 paging | Personal and room archives; bounded pages, timestamps, direct peer filter, before/after cursors |
| XEP-0359 stanza IDs | Stable archive IDs; native stanza IDs and origin IDs retained |
| XEP-0308 corrections | Timeline messages; author and room checks |
| Room configuration, affiliations, kicks, invitations | Managed through Archipel; native management commands rejected |
| Offline messages | Retrieve through MAM after reconnect; no independent Prosody offline queue |
| Topics, nested threads, attachments, OMEMO, remote room participation | Not exposed by this profile |

This is a defined XMPP interoperability profile, not a claim that every XEP or
every client's optional feature is supported. Remote users can exchange direct
messages with local accounts; joining Archipel rooms from a foreign home server
and joining foreign rooms with an Archipel account are not currently supported.
Room nicknames are assigned from the local account's stable XMPP node.

## Configure a deployment

1. Run `python3 scripts/setup.py` and supply a lowercase **XMPP account domain**,
   such as `chat.example.org`. Setup adds `compose.xmpp.yaml` and generates a
   random bridge secret in `.env.container`. Re-running setup preserves that
   secret. Keep this file private. The client STARTTLS port defaults to 5222 and
   the federation port to 5269; setup prompts for both when XMPP is enabled.
2. Set up A/AAAA records for that domain and `channels.chat.example.org`, pointing
   to the server. Publish `_xmpp-client._tcp.chat.example.org` and
   `_xmpp-server._tcp.chat.example.org` SRV records using your configured client
   and federation ports (defaults 5222 and 5269).
   Publish a server SRV record for `channels.chat.example.org` as well. The SRV
   target must be a DNS host, not an IP literal.
3. Obtain certificates covering `chat.example.org` and
   `channels.chat.example.org`. Put the full certificate chains and matching
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
these controls. A room join may create membership in an open channel; closing a
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
rejection and revocation. Fixtures are cleaned up on completion. Certificates
and DNS overrides are limited to the disposable test network.

One executable with bundled Prosody remains future work; see
[standalone packaging](xmpp-packaging.md).
