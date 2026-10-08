# Setup and container deployment

Install Python 3.9 or newer, Docker, and Docker Compose 2.30 or newer on the host.
Run setup directly; it uses only Python's standard library:

```sh
python3 scripts/setup.py
```

Setup validates the application settings, writes private configuration files with
mode `0600`, and backs up existing files before replacing them. It keeps current
values as prompt defaults. Press Enter to retain a value or enter `-` to clear it.
Client secrets are hidden while typing and omitted from the printed summary.
Setup configures deployment; it does not start containers or change your proxy.

Setup also asks for an optional XMPP account domain. Supplying it adds a pinned
Prosody service and keeps a generated bridge secret in `.env.container`. Provide
XMPP TLS certificates, DNS, and TCP ports before starting that service; web proxy
TLS does not configure XMPP TLS. See [Prosody deployment](xmpp.md).

Choose one of three modes. Setup defaults to `container`; `--mode local` is a
compatibility alias for that same loopback Docker deployment.

| Mode        | Listener and access                                                   | Start command                  |
| ----------- | --------------------------------------------------------------------- | ------------------------------ |
| `container` | OIDC-only container, published on host loopback                       | `docker compose up --build -d` |
| `proxy`     | HTTPS behind a generic proxy, on an external network or host loopback | `docker compose up --build -d` |
| `traefik`   | HTTPS behind Traefik on an external network, with routing labels      | `docker compose up --build -d` |

To start directly with a mode:

```sh
python3 scripts/setup.py --mode traefik
```

All modes disable development personas and bind the application to
`0.0.0.0:8788` inside the container. The `PORT` prompt controls host publishing
only when using the loopback overlay. The database lives in the named
`archipel-data` volume at `/app/data/archipel.sqlite`. Keep this volume across
rebuilds and updates.

## External proxy network and trusted proxy

For a Traefik deployment, setup asks for:

- The public HTTPS `BASE_URL`, such as `https://chat.example.org`.
- The existing external network name, such as `traefik` or `proxy`.
- The proxy peer's actual IP on that network, such as `172.20.0.2`.
- Your OIDC issuer, client ID, authentication method, and secret when required.
- An existing Traefik HTTPS entrypoint, normally `websecure`.
- An optional existing certificate resolver. Leave it empty when Traefik already
  supplies certificates by another means.

The proxy and Archipel must share that network. Check its actual name and proxy
address on the Docker host:

```sh
docker network inspect proxy
```

Use the proxy container's address, not the network gateway, public client IP,
or Docker hostname. Reserve a stable proxy address in your proxy deployment,
or explicitly trust an appropriate CIDR when its address can change.
`TRUSTED_PROXY` accepts exact IPv4/IPv6 addresses or a comma-separated list of
addresses/CIDRs. An empty value disables trust. It rejects blanket trust,
hop counts, hostnames, and `/0` networks. If you trust a subnet, every peer in that
subnet is trusted to supply forwarded headers.

Express only uses forwarded client IP and protocol headers when the connecting
peer matches that list. This also makes rate limits count clients rather than
the proxy connection. The public instance URL and OIDC callback continue to come
from `BASE_URL`. The proxy must preserve Origin and overwrite/sanitize forwarded
headers. See [Express's proxy configuration](https://expressjs.com/en/guide/behind-proxies/).

Setup selects the Compose overlays using `COMPOSE_FILE` in `.env`:

- `compose.yaml`: application, persistent volume, health check, and container settings.
- `compose.proxy.yaml`: attachment to the existing external network; no host port.
- `compose.local.yaml`: loopback host port for direct access or a proxy on the host.
- `compose.traefik.yaml`: HTTPS router, selected network, and backend port labels.
- `compose.acme.yaml`: optional certificate resolver label.

Compose does not create an external network. It must exist before startup, as
described in [Docker's network documentation](https://docs.docker.com/reference/compose-file/networks/#external).
For a newly provisioned proxy network, create it deliberately and attach your
proxy to it before starting Archipel.

Validate and start from the project directory:

```sh
docker compose config --quiet
docker compose up --build -d
docker compose ps
docker compose logs -f archipel
```

For nginx, Caddy, or a manually configured Traefik router, choose `proxy` mode.
On the external network, use `http://archipel:8788` as the backend. If the proxy
runs on the host, decline the external network during setup and point it at the
selected host loopback port. Trust the peer address actually seen by the container.

## Configuration files and OIDC

`.env` contains application/deployment settings and Compose file selection.
Container client secrets live in `.env.container`; Compose reads that file with
`format: raw`, preserving dollar signs, hashes, backslashes, and quote characters.
This requires Docker Compose 2.30 or newer. Neither file nor its backups belong
in version control, and `.dockerignore` excludes them from image builds.

Run setup again to change configuration. It retains the existing container
secret unless you replace or clear it. Changes to `.env` are used when Compose
recreates the container; changing the container secret directly requires editing
`.env.container`. Do not put a container secret in `.env`'s `OIDC_CLIENT_SECRET`
field: the runtime takes it from the raw credential file.

Setup prints the exact `${BASE_URL}/auth/callback` URI to register with your
OIDC provider. It can leave OIDC unconfigured for later, but container users
cannot sign in until issuer and client settings are supplied.

To obtain the subject for administrator configuration in a container:

```sh
docker compose exec archipel node scripts/identities.js
```

Set that subject in `ADMIN_SUBJECTS` using setup or `.env`, then recreate the
container with `docker compose up -d`. No administrator is created automatically
for a real OIDC account.

For unattended setup, supply the settings as environment variables and run
`python3 scripts/setup.py --mode traefik --non-interactive`. Proxy modes require an
explicit `TRUSTED_PROXY`; setup does not guess a network's IP range. `--directory`
can write into another existing directory for staging or validation.

The host does not need Node, npm, pip packages, or application dependencies.
Docker installs and builds the application. Existing `.env` files from the old
Node setup are read as prompt defaults, and `.env.container` credentials are
retained when reconfiguring an existing container deployment.
For a previous native installation, transfer its SQLite database to the named
Docker volume before startup if you need to retain its accounts and history.

The image builds the browser and compiles the server to JavaScript, installs
production dependencies, and runs as the unprivileged `node` user. Compose uses
a read-only root filesystem with the data volume and a temporary `/tmp` mount.
Stop the service before a filesystem copy of the data volume, or use a proper
SQLite backup. `docker compose down` retains the named volume; `down --volumes`
removes it.

## Initial instance admission

Setup asks for `REGISTRATION_MODE` (`open` or `invite_only`) and passes it through
Compose. It initializes the policy only when the database has no saved setting.
For an existing database, use **Profile → Instance administration → New user
access** to change the policy. Existing users retain their membership.

In invite-only mode new FedIdP identities enter an administrator review queue.
The queue includes only verified socials the provider actually disclosed. Make
sure applicants can select disclosure for the Archipel OIDC client in FedIdP.
They can sign in with no socials and wait for a decision. Administrators named in
`ADMIN_SUBJECTS` are automatically approved; if needed, let your administrator
sign in pending, identify their subject with the identities command above, add
it to configuration, and restart. Their existing session then gains admin access.

Custom emoji images, admission decisions, and message edits are part of the
SQLite database and use the existing persistent volume and backup procedure.

## Diagnose sign-in failures

After updating the code, rebuild/recreate the application and follow its logs:

```sh
docker compose up --build -d
docker compose logs --tail=100 -f archipel
```

Failed login starts and callbacks emit a JSON `oidc.signin_failed` event to
standard error. It includes a reference ID, the failed stage, configured issuer
and callback, client authentication method, safe provider/network/validation
codes, and a diagnostic hint. The failure response carries the same reference
in `X-Request-ID`. Browser errors remain generic. Tokens, client secrets,
callback query values, claims, provider descriptions, and response bodies are
omitted from these logs.

For `invalid_client`, compare the client ID, secret, and `OIDC_AUTH_METHOD` with
FedIdP's downstream client registration. For `invalid_grant`, start a fresh
sign-in and check the exact registered `${BASE_URL}/auth/callback` URI. Missing
flow-cookie errors point to expired/replaced sign-in attempts, browser cookie
handling, or an incorrect public `BASE_URL`. Discovery, JWKS, token, and UserInfo
requests must reach the provider from inside the container; proxy/WAF pages
and TLS/DNS failures are identified by the logged stage and codes.

## Federation and personal emoji

Federation is enabled in **Instance administration → Federation controls**;
the instance setting and per-user grants live in SQLite and survive restarts.
Channels require their own opt-in. No additional environment variable or
container service is needed. Preserve `BASE_URL` and the database, including its
private signing key, to retain actor identity and queued delivery.

Your proxy must route `/.well-known/webfinger`, `/actors/*`, and `/federation/*`
to Archipel and preserve the public Host, Date, Digest, and Signature headers and
request body. Production peers require public HTTPS endpoints. Outbound requests
to private/reserved addresses are rejected; loopback HTTP is restricted to local
development. See [federation.md](federation.md) for policy and transport details.

Personal uploads, adopted copies, and received emoji images also use the
existing database volume. Their setup requires no separate image service.
