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
certificates = ENV_XMPP_CERTS_PATH or "/etc/prosody/certs"
-- Optional private PKI trust anchor; normal deployments use system trust roots.
ssl = { cafile = ENV_XMPP_CA_FILE }
c2s_ports = { 5222 }
s2s_ports = { 5269 }
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
