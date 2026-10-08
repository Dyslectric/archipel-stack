-- Writes the certificates Traefik holds for the XMPP names as Prosody .crt/.key pairs.
-- Usage: lua traefik-certs.lua <acme.json> <output directory> <XMPP domain>
local json = require "prosody.util.json";
local base64 = require "prosody.util.encodings".base64;
local source, target, domain = ...;

local file = assert(io.open(source, "rb"));
local store = json.decode(file:read("a"));
file:close();
assert(type(store) == "table", "Unreadable Traefik certificate store");

local function covers(name, host)
  return name == host or (name:sub(1, 2) == "*." and host:match("^[^.]+%.(.+)$") == name:sub(3));
end
local function write(path, data)
  local out = assert(io.open(path, "wb"));
  out:write(data);
  out:close();
end

local written = 0;
for _, resolver in pairs(store) do
  local entries = type(resolver) == "table" and resolver.Certificates;
  for _, entry in ipairs(type(entries) == "table" and entries or {}) do
    local names = {};
    if type(entry.domain) == "table" then
      if type(entry.domain.main) == "string" then table.insert(names, entry.domain.main); end
      for _, san in ipairs(type(entry.domain.sans) == "table" and entry.domain.sans or {}) do table.insert(names, san); end
    end
    local wanted = false;
    for _, name in ipairs(names) do
      if covers(name, domain) or covers(name, "channels." .. domain) then wanted = true; end
    end
    if wanted and type(entry.certificate) == "string" and type(entry.key) == "string" then
      -- Named after what the certificate covers, so an unchanged store rewrites identical files.
      table.sort(names);
      local path = target .. "/" .. table.concat(names, "_"):gsub("[^%w._-]", "-"):sub(1, 200);
      write(path .. ".crt", base64.decode(entry.certificate));
      write(path .. ".key", base64.decode(entry.key));
      written = written + 1;
    end
  end
end
os.exit(written > 0 and 0 or 1);
