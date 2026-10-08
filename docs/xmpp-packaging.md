# XMPP and standalone packaging

Status: Prosody XMPP integration is implemented for the profile described in
[xmpp.md](xmpp.md). A standalone executable is not implemented. Packaging details
below are proposed and must be validated through prototypes.

## Product requirements

Archipel should host XMPP accounts and conversations using Prosody and provide
the browser frontend. Ordinary XMPP clients should be able to connect, and users
on other XMPP servers should be able to participate in supported conversations.
ActivityPub support remains part of the application.

The eventual complete distribution should be one executable per supported
operating system and architecture, including the required Archipel and Prosody
runtimes and browser assets. It must not require a separately installed Node,
Lua, Prosody, Docker, package manager, or runtime dependency download at startup.
Configuration, databases, credentials, and certificates remain external persistent
state. Public federation still requires suitable domains, DNS, certificates,
network access, and configured authentication.

## Proposed runtime and distribution

Use the Archipel executable as the entry point and supervisor. It serves the
browser interface and application API and starts bundled Prosody in the foreground.
Prosody handles XMPP client sessions, authentication negotiation, routing, and
server-to-server federation. Archipel modules integrate accounts, policy, and
conversation data. This is one distributed executable with multiple internal
processes; a single process is not an established requirement.

Node's [single-executable application support](https://nodejs.org/download/release/latest-v24.x/docs/api/single-executable-applications.html)
is a candidate for bundling the existing TypeScript server after compilation,
its JavaScript dependencies, migrations, browser assets, and Prosody payload.
SEA supports embedded assets; it does not automatically package or make Prosody
and its native dependencies portable. The current filesystem-relative migration
and browser asset loading must gain a packaged-resource path.

Proposed first approach: extract the bundled Prosody runtime into a private,
versioned runtime directory and launch it by absolute path. Include Lua, Prosody
code, selected modules, and the native libraries needed for the advertised features.
Keep extracted runtime files separate from persistent instance data. Use atomic
extraction and verify the payload before launching it; do not execute an arbitrary
Prosody found on PATH. No runtime installer or dependency fetching should be needed.
Whether extraction is acceptable remains open; running without extraction would
require a different embedding/build approach and its own feasibility prototype.

Prosody's [dependency documentation](https://prosody.im/doc/depends) and
[source build guide](https://prosody.im/doc/installing_from_source) describe the
Lua runtime and native dependencies. Its [packaging guide](https://prosody.im/doc/packagers)
documents foreground operation. Packaging must account for TLS trust roots and
build-platform dependencies as well as the Lua scripts.

The supervisor needs explicit readiness checks, useful combined diagnostics,
bounded restart behavior, and coordinated shutdown without orphan processes.
Unavailable policy integration must reject affected XMPP operations rather than
bypassing Archipel's permissions. Child-process management must be implemented
and tested for each advertised operating system.

Standalone platform targets have not been selected. A Linux packaging prototype
is a proposed first step, not a restriction on the product. Native Windows support
needs an early build and runtime investigation; do not describe WSL or Docker as
a native Windows executable, or promise Windows support before testing it.

## Identity, policy, and storage boundaries

Retain Archipel's immutable user IDs and exact OIDC `(issuer, subject)` bindings.
Bind each local XMPP bare JID explicitly to a local user; matching usernames,
email addresses, or social handles must not link accounts automatically. Remote
XMPP identities must retain their protocol and authenticated domain provenance.
An XMPP JID and an ActivityPub actor with similar names are distinct identities
unless a separate verified linking flow establishes otherwise.

Keep the browser's OIDC login. External XMPP clients need a supported authentication
mechanism: evaluate a Prosody authentication provider and revocable application
credentials or supported token flows. Do not treat an OIDC ID token as a generic
XMPP credential. Pending admission, suspension, and credential revocation must
apply to existing XMPP sessions as well as new logins.

Archipel must remain authoritative for its instance admission, channel policy,
delegated permissions, and federation grants. Before choosing a storage strategy,
prove how Prosody enforces those decisions for client writes, incoming remote
messages, room changes, and archive reads. Room administration through an ordinary
XMPP client must not bypass Archipel's owner protections or blocks.

Evaluate Prosody modules with its built-in MUC service first; an external component
is another integration option. Prosody [components](https://prosody.im/doc/components)
provide services such as rooms and gateways, but do not themselves host user
accounts or accept client logins. A channel component alone is therefore not a
complete account-hosting integration.

Choose one authoritative write path per entity before exposing it over both
interfaces. If Prosody owns a room's message archive, the Archipel view should be
a defined projection with recovery behavior. If Archipel owns its messages,
Prosody integration must enforce that write path and expose authorized history.
Do not create independently writable message histories or membership lists and
rely on eventual synchronization to repair permission violations. Prosody may
need its own durable state; colocating it in the instance data directory does not
mean both applications should mutate the same SQLite tables.

## Interoperability scope

Start with direct messages and timeline channels exposed as
[MUC rooms](https://xmpp.org/extensions/xep-0045.html), including discovery,
membership, moderation, and authorized
[archive retrieval](https://xmpp.org/extensions/xep-0313.html).
Preserve stable message identifiers for replay, editing, and duplicate detection.
Test ordinary client access and real federation with a separate XMPP server.

Use [reply references](https://xmpp.org/extensions/xep-0461.html) where supported
for Archipel's nested display. Topics, titled roots, custom emoji, edits, and
removals need explicit supported mappings and fallbacks; basic XMPP compatibility
does not guarantee that every client displays Archipel's full interface.

Keep XMPP support and cross-protocol forwarding separately configurable. Any
ActivityPub/XMPP bridge must preserve gateway attribution, stable ID mappings,
loop prevention, audience permissions, and moderation authority. An XMPP message
must not be presented as an original ActivityPub author's signed object.
Do not forward restricted history simply because both protocols are enabled.
Mirroring and rehoming remain separate work; adding Prosody does not provide
distributed writable room authority.

## Sequence and acceptance criteria

1. Prove a relocatable Prosody runtime with bundled dependencies before investing
   in the full adapter. Run on a clean target without development tools or separately
   installed runtimes. Establish target platforms and extraction requirements.
2. Prototype local account binding and one timeline room. Establish the policy,
   message, membership, and archive authority boundaries with an ordinary client.
3. Add federation, direct messages, reconnect/history behavior, and enforcement
   for admission, suspension, blocking, and revocation. Test against another server.
4. Package the frontend, server, migrations, Prosody runtime, and integration
   modules in one launchable executable. Test first run, restart, child failure,
   shutdown, executable replacement, and backup/restore of all persistent state.
5. Extend conversation metadata and any explicitly enabled cross-protocol bridge
   after documenting and testing the basic interoperability profile.

Release acceptance requires one downloaded executable to serve the browser and
XMPP clients on each advertised clean target; no separate runtime installation
or startup dependency download. Restart and update must preserve identities,
history, policy, and signing keys. Unauthorized archive reads and writes must be
rejected through both interfaces, and shutdown must leave no managed child running.
