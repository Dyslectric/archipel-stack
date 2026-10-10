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
Prosody service and keeps a generated bridge secret in `.env.container`. Setup
proposes free XMPP ports, can obtain the XMPP certificates through ACME or an
existing Traefik resolver, and prints the DNS SRV records to publish. Web proxy
TLS does not configure XMPP TLS by itself. See [Prosody deployment](xmpp.md).

### Several instances on one machine

Clone the project once per instance and run setup in each clone. Setup asks for
an **instance name**, stored as `COMPOSE_PROJECT_NAME`; it defaults to the
directory's name, which is what Compose already uses. The name prefixes the
instance's containers and volumes and names its Traefik routers and services, so
instances behind one Traefik do not collide. Give each instance its own name,
public URL and, in `container` mode, host port. Do not rename a running instance:
Compose would start it on new, empty volumes. XMPP ports and DNS for several
instances are covered in [Prosody deployment](xmpp.md#several-instances-on-one-machine).

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

## PostgreSQL

SQLite is the default and needs nothing else. To keep the instance in PostgreSQL
instead, answer `postgres` when setup asks for the database (or run it with
`DATABASE=postgres`). Setup adds `compose.postgres.yaml`, which runs PostgreSQL 17
beside the application on a private network with its data in the
`archipel-postgres` volume, and writes a generated password to `.env.postgres`.
The application waits for the database to be ready, and creates its tables the
first time it starts.

```sh
DATABASE=postgres python3 scripts/setup.py --non-interactive
docker compose up --build -d
```

To use a PostgreSQL server you already run, leave `compose.postgres.yaml` out and
set `DATABASE_URL=postgres://user:password@host:5432/database` for the
application (the password can instead be given as `PGPASSWORD`; add
`?sslmode=require` for TLS). The database must be empty and its user able to
create tables and the `citext` extension, which Archipel Server uses for names that
match whatever their case. When `DATABASE_URL` is set, `DATABASE_PATH` is ignored.

### Moving an instance from SQLite

Reconfigure with `postgres`, then, with the application stopped, copy the
instance across before starting it again:

```sh
docker compose down
DATABASE=postgres python3 scripts/setup.py --non-interactive
docker compose build
docker compose run --rm archipel node scripts/migrate-postgres.js
docker compose up -d
```

The command reads the SQLite file in the data volume and writes every table,
attachment and counter into PostgreSQL in one transaction: either all of it
arrives, and is counted again to be sure, or PostgreSQL is left empty. It
refuses a database that already holds an instance. The SQLite file is not
removed; once you are satisfied, keep it as a backup or delete it. Outside
Docker the same command is
`npm run migrate:postgres -- --from ./data/archipel.sqlite --to postgres://…`.

Attachments, avatars and emoji stay in the database either way, so `pg_dump`
of the one database is a complete backup:

```sh
docker compose exec postgres pg_dump -U archipel -Fc archipel > archipel.dump
```

Archipel Server holds one connection and runs one statement at a time on it, as it does
with SQLite, so a small PostgreSQL is enough. Run a single application process
per database.

## Live updates behind a proxy

Open browsers hold one long-lived request to `/api/events` (server-sent events)
and are told through it when to look again. Traefik passes it through as it is.
Other proxies must not buffer or compress that response; nginx needs
`proxy_buffering off` for it (the response also asks for this with
`X-Accel-Buffering: no`). A comment line every 25 seconds keeps idle timeouts,
including Cloudflare's, from closing a quiet stream. Without HTTP/2 a browser
allows only six connections to one host; Archipel Server keeps a stream only for tabs
that are in view, so many open tabs do not use them up.

## External proxy network and trusted proxy

For a Traefik deployment, setup asks for:

- The public HTTPS `BASE_URL`, such as `https://chat.example.org`.
- The existing external network name, such as `traefik` or `proxy`.
- The proxy peer's actual IP on that network, such as `172.20.0.2`.
- Your OIDC issuer, client ID, authentication method, and secret when required.
- An existing Traefik HTTPS entrypoint, normally `websecure`.
- An optional existing certificate resolver. Leave it empty when Traefik already
  supplies certificates by another means.

The proxy and Archipel Server must share that network. Check its actual name and proxy
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
the proxy connection. The per-minute limits for one client are set in `.env`
with `RATE_LIMIT_API` (default 300, counted per signed-in user), `RATE_LIMIT_AUTH`
(30), `RATE_LIMIT_MEDIA` (600) and `RATE_LIMIT_FEDERATION` (120); outbound
federation pacing is described in [federation.md](federation.md). The public instance URL and OIDC callback continue to come
from `BASE_URL`. The proxy must preserve Origin and overwrite/sanitize forwarded
headers. See [Express's proxy configuration](https://expressjs.com/en/guide/behind-proxies/).

Setup selects the Compose overlays using `COMPOSE_FILE` in `.env`:

- `compose.yaml`: application, persistent volume, health check, and container settings.
- `compose.proxy.yaml`: attachment to the existing external network; no host port.
- `compose.local.yaml`: loopback host port for direct access or a proxy on the host.
- `compose.traefik.yaml`: HTTPS router, selected network, and backend port labels.
- `compose.acme.yaml`: optional certificate resolver label.
- `compose.xmpp.yaml`: Prosody, when an XMPP account domain is set.
- `compose.xmpp-acme.yaml`, `compose.xmpp-acme-http.yaml`: optional ACME client
  for Prosody's certificates, and its direct host port 80 listener in container mode.
- `compose.xmpp-acme-traefik.yaml`: HTTP challenges forwarded through the existing
  Traefik HTTP entrypoint (default `web`), with no host port published.
- `compose.xmpp-traefik-certs.yaml`: optional reuse of Traefik's resolver and
  certificate store for Prosody.

Compose does not create an external network. It must exist before startup, as
described in [Docker's network documentation](https://docs.docker.com/reference/compose-file/networks/#external).
For a newly provisioned proxy network, create it deliberately and attach your
proxy to it before starting Archipel Server.

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
To move it into PostgreSQL instead, see [PostgreSQL](#postgresql).

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
sure applicants can select disclosure for the Archipel Server OIDC client in FedIdP.
They can sign in with no socials and wait for a decision. Administrators named in
`ADMIN_SUBJECTS` are automatically approved; if needed, let your administrator
sign in pending, identify their subject with the identities command above, add
it to configuration, and restart. Their existing session then gains admin access.

Custom emoji images, admission decisions, and message edits are part of the
database and use its persistent volume and backup procedure.

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
to Archipel Server and preserve the public Host, Date, Digest, and Signature headers and
request body. Production peers require public HTTPS endpoints. Outbound requests
to private/reserved addresses are rejected; loopback HTTP is restricted to local
development. See [federation.md](federation.md) for policy and transport details.

Personal uploads, adopted copies, and received emoji images also use the
existing database volume. Their setup requires no separate image service.
