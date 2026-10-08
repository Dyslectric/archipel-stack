-- Prosody 13.0. The integration secret is supplied through the private env file.
local domain = Lua.assert(ENV_XMPP_DOMAIN, "XMPP_DOMAIN is required")
Lua.assert(domain ~= "", "XMPP_DOMAIN is required")
plugin_paths = { "/etc/prosody/archipel-modules" }
data_path = "/var/lib/prosody"
pidfile = "/var/run/prosody/prosody.pid"
daemonize = false
log = { { levels = { min = ENV_PROSODY_LOGLEVEL or "info" }, to = "console" } }
admins = {}
modules_enabled = {
  "disco"; "roster"; "saslauth"; "tls"; "limits";
  "smacks"; "private"; "ping"; "version";
}
-- Independent histories/offline queues would bypass current Archipel policy.
modules_disabled = { "register"; "mam"; "offline"; "carbons"; "blocklist" }
allow_registration = false
c2s_require_encryption = true
s2s_require_encryption = true
s2s_secure_auth = true
c2s_stanza_size_limit = 3145728
s2s_stanza_size_limit = 3145728
-- Bound stream traffic while allowing a 2 MiB photo to finish within IQ timeouts.
limits = { c2s = { rate = "256kb/s"; burst = 13 }; s2s = { rate = "256kb/s"; burst = 13 } }
certificates = ENV_XMPP_CERTS_PATH or "/etc/prosody/certs"
-- Optional private PKI trust anchor; normal deployments use system trust roots.
ssl = { cafile = ENV_XMPP_CA_FILE }
local client_port = Lua.tonumber(ENV_XMPP_CLIENT_PORT or "5222")
local server_port = Lua.tonumber(ENV_XMPP_SERVER_PORT or "5269")
Lua.assert(client_port and client_port >= 1 and client_port <= 65535 and client_port % 1 == 0, "Invalid XMPP_CLIENT_PORT")
Lua.assert(server_port and server_port >= 1 and server_port <= 65535 and server_port % 1 == 0, "Invalid XMPP_SERVER_PORT")
Lua.assert(client_port ~= server_port, "XMPP client and server ports must differ")
c2s_ports = { client_port }
s2s_ports = { server_port }
http_ports = {}
https_ports = {}
authentication = "archipel"
archipel_api_url = ENV_ARCHIPEL_API_URL or "http://archipel:8788/internal/xmpp"
archipel_api_secret = Lua.assert(ENV_XMPP_BRIDGE_SECRET, "XMPP_BRIDGE_SECRET is required")
archipel_domain = domain
VirtualHost (domain)
  modules_enabled = { "archipel" }
Component ("channels." .. domain) "muc"
  modules_enabled = { "archipel_muc" }
  modules_disabled = { "muc_mam" }
  restrict_room_creation = true
  muc_room_default_public = false
  muc_room_default_persistent = false
  muc_room_default_history_length = 0
  muc_room_default_public_jids = false
