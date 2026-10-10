local bridge = module:require "archipel";
local st = require "prosody.util.stanza";
local jid = require "prosody.util.jid";
local async = require "prosody.util.async";
local array = require "prosody.util.array";
local uuid = require "prosody.util.uuid";
local json = require "prosody.util.json";
local cursor_store = module:open_store("archipel_cursor");
local cursor = (cursor_store:get(nil) or {}).after or 0;
local assigned_nicks = module:shared("/" .. bridge.domain .. "/archipel/assigned_nicks");
module:add_feature("urn:xmpp:mam:2");
module:add_feature("vcard-temp");
module:hook("account-disco-info", function(event)
  event.reply:tag("feature", { var = "urn:xmpp:mam:2" }):up()
    :tag("feature", { var = "urn:xmpp:sid:0" }):up()
    :tag("feature", { var = "vcard-temp" }):up();
end);
local function get_vcard(event)
  if event.origin.type ~= "c2s" and event.origin.type ~= "s2sin" then return true; end
  local result = bridge.operation(event, "vcard");
  if not result then return true; end
  local reply = st.reply(event.stanza):tag("vCard", { xmlns = "vcard-temp" })
    :tag("FN"):text(result.name):up():tag("JABBERID"):text(result.jid):up();
  if result.avatar and result.avatar ~= json.null then
    reply:tag("PHOTO"):tag("TYPE"):text(result.avatar.mime):up()
      :tag("BINVAL"):text(result.avatar.image):up():up();
  end
  event.origin.send(reply); return true;
end
local function set_vcard(event)
  if event.origin.type ~= "c2s" then event.origin.send(st.error_reply(event.stanza, "auth", "forbidden")); return true; end
  local photo = event.stanza:get_child("vCard", "vcard-temp"):get_child("PHOTO");
  local image = photo and photo:get_child_text("BINVAL");
  local result = bridge.request("/avatars", { operation = "set"; from = event.stanza.attr.from;
    to = event.stanza.attr.to; credential = event.origin.archipel_credential; image = image and image ~= "" and image or json.null });
  event.origin.send(result and st.reply(event.stanza) or st.error_reply(event.stanza, "cancel", "not-allowed"));
  return true;
end
for _, address in ipairs({ "self", "bare" }) do
  module:hook("iq-get/" .. address .. "/vcard-temp:vCard", get_vcard, 100);
  module:hook("iq-set/" .. address .. "/vcard-temp:vCard", set_vcard, 100);
end
local function remote_vcard_access(event)
  if event.origin.type ~= "c2s" or not event.stanza:get_child("vCard", "vcard-temp") or
    jid.host(event.stanza.attr.to or "") == module.host or not event.stanza.attr.to then return; end
  if event.stanza.attr.type == "set" then event.origin.send(st.error_reply(event.stanza, "auth", "forbidden")); return true; end
  if event.stanza.attr.type == "get" and not bridge.operation(event, "vcard-access") then return true; end
end
module:hook("pre-iq/bare", remote_vcard_access, 100);
module:hook("pre-iq/full", remote_vcard_access, 100);
-- Replace client-supplied hashes with the authoritative shared profile hash.
local function local_avatar_presence(event)
  if event.origin.type ~= "c2s" or event.stanza.attr.type then return; end
  local result = bridge.operation(event, "avatar-hash");
  if not result then return true; end
  event.stanza:remove_children("x", "vcard-temp:x:update");
  event.stanza:tag("x", { xmlns = "vcard-temp:x:update" }):tag("photo"):text(result.hash):up():up();
end
module:hook("pre-presence/bare", local_avatar_presence, 100);
module:hook("pre-presence/full", local_avatar_presence, 110);
module:hook("pre-presence/host", local_avatar_presence, 100);
local function remote_avatar_presence(event)
  if event.origin.type ~= "s2sin" or event.stanza.attr.type then return; end
  if event.stanza:get_child("x", "http://jabber.org/protocol/muc#user") then return; end
  local update = event.stanza:get_child("x", "vcard-temp:x:update");
  local photo = update and update:get_child_text("photo");
  if photo ~= nil then bridge.operation(event, "avatar-refresh", { photo = photo }); end
end
module:hook("presence/bare", remote_avatar_presence, 100);
module:hook("presence/full", remote_avatar_presence, 100);
local avatar_cache_runner = async.runner(function(payload) bridge.request("/avatars", payload); end,
  { error = function(_, err) module:log("warn", "Remote avatar cache failed: %s", err); end });
local function request_avatar(item)
  module:send_iq(st.iq({ type = "get"; from = item.requester; to = item.peer; id = uuid.generate() })
    :tag("vCard", { xmlns = "vcard-temp" }), nil, 15):next(function(event)
      if jid.bare(event.stanza.attr.from) ~= item.peer then return; end
      local card = event.stanza:get_child("vCard", "vcard-temp");
      if not card then return; end
      local photo = card:get_child("PHOTO");
      local image = photo and photo:get_child_text("BINVAL");
      if image and #image > 2800000 then return; end
      avatar_cache_runner:run({ peer = item.peer; requester = item.requester; attempt = item.attempt;
        image = image and image ~= "" and image or json.null });
    end, function() end);
end
-- MUC self-presence is routed through the user's host before final delivery.
module:hook("presence/full", function(event)
  local stanza = event.stanza;
  if stanza.attr.type or assigned_nicks[stanza.attr.to] ~= stanza.attr.from then return; end
  local x = stanza:get_child("x", "http://jabber.org/protocol/muc#user");
  if x then
    for status in x:childtags("status") do
      if status.attr.code == "110" then
        x:tag("status", { code = "210" }):up();
        assigned_nicks[stanza.attr.to] = nil;
        break;
      end
    end
  end
end, 100);

-- Clients keep their room list as bookmarks in private storage. The local channels an account
-- belongs to are added to what the client saved, so they open by themselves after signing in.
local private_storage = module:open_store("private", "map");
module:hook("iq/self/jabber:iq:private:query", function(event)
  local origin, stanza = event.origin, event.stanza;
  if stanza.attr.type ~= "get" or origin.type ~= "c2s" then return; end
  local wanted = stanza.tags[1].tags[1];
  if not wanted or wanted.name ~= "storage" or wanted.attr.xmlns ~= "storage:bookmarks" then return; end
  local result = bridge.operation(event, "bookmarks");
  if not result then return true; end
  local saved = private_storage:get(origin.username, "storage:storage:bookmarks");
  local storage = saved and st.deserialize(saved) or st.stanza("storage", { xmlns = "storage:bookmarks" });
  local ours = {};
  for _, room in ipairs(result.rooms) do ours[room.jid] = true; end
  storage:maptags(function(child)
    if child.name == "conference" and ours[child.attr.jid] then return nil; end
    return child;
  end);
  for _, room in ipairs(result.rooms) do
    storage:tag("conference", { jid = room.jid; name = "#" .. room.name; autojoin = "true" })
      :tag("nick"):text(result.nick):up():up();
  end
  origin.send(st.reply(stanza):tag("query", { xmlns = "jabber:iq:private" }):add_child(storage));
  return true;
end, 100);

local function direct(event)
  local stanza, origin = event.stanza, event.origin;
  if stanza._archipel or stanza.attr.type == "error" then return; end
  local target_host = jid.host(stanza.attr.to or "");
  if target_host == "channels." .. module.host and stanza.attr.type == "groupchat" then return; end
  if target_host == "channels." .. module.host or stanza.attr.type == "groupchat" then
    origin.send(st.error_reply(stanza, "cancel", "feature-not-implemented", "Only local timeline rooms are supported.")); return true;
  end
  -- Only authenticated clients/s2s are allowed to assert a sender.
  if origin.type ~= "c2s" and origin.type ~= "s2sin" then return true; end
  if stanza:get_child("replace", "urn:xmpp:message-correct:0") or stanza:get_child("encrypted", "eu.siacs.conversations.axolotl") or stanza:get_child("encrypted", "urn:xmpp:omemo:2") then
    origin.send(st.error_reply(stanza, "cancel", "feature-not-implemented", "This direct-message format is not supported.")); return true;
  end
  if not stanza:get_child("body") then return true; end
  local origin_id = stanza:get_child("origin-id", "urn:xmpp:sid:0");
  bridge.operation(event, "direct", { body = stanza:get_child_text("body"); origin_id = origin_id and origin_id.attr.id });
  return true;
end
module:hook("pre-message/bare", direct, 100);
module:hook("pre-message/full", direct, 100);
module:hook("message/bare", direct, 100);
module:hook("message/full", direct, 100);
module:hook("iq-set/self/urn:xmpp:mam:2:query", function(event) return bridge.archive(event); end, 100);
module:hook("iq-set/bare/urn:xmpp:mam:2:query", function(event)
  if event.stanza.attr.to and jid.bare(event.stanza.attr.to) ~= jid.bare(event.stanza.attr.from) then
    event.origin.send(st.error_reply(event.stanza, "auth", "forbidden")); return true;
  end
  return bridge.archive(event);
end, 100);
module:hook("iq-get/self/urn:xmpp:mam:2:query", bridge.archive_form, 100);

-- Check every stanza, so a revoked/suspended account cannot keep using its stream.
module:hook("pre-stanza", function(event)
  local origin = event.origin;
  if origin.type == "c2s" and origin.username and not event.stanza._archipel then
    if not bridge.operation(event, "check") then
      origin:close({ condition = "not-authorized"; text = "Archipel Server access was revoked or is unavailable." }); return true;
    end
  end
end, 1000);

local busy = false;
local runner = async.runner(function()
  local sessions, occupants, active = array(), array(), {};
  for address in pairs(assigned_nicks) do if not prosody.full_sessions[address] then assigned_nicks[address] = nil; end end
  for _, session in pairs(prosody.full_sessions) do
    if session.host == module.host then
      table.insert(sessions, { jid = session.full_jid; credential = session.archipel_credential });
      active[session.full_jid] = session;
    end
  end
  local muc = prosody.hosts["channels." .. module.host].modules.muc;
  for room in muc.each_room(true) do
    for _, occupant in room:each_occupant() do
      for address in occupant:each_session() do table.insert(occupants, { jid = address; room = room.jid }); end
    end
  end
  local result = bridge.request("/sync", { after = cursor; sessions = sessions; occupants = occupants });
  if not result then
    -- No cached policy is accepted during an adapter outage.
    for _, session in pairs(active) do session:close({ condition = "internal-server-error"; text = "Archipel Server policy service is unavailable." }); end
    for _, entry in ipairs(occupants) do
      local room = jid.host(entry.jid) ~= module.host and muc.get_room_from_jid(entry.room);
      local occupant = room and room:get_occupant_by_real_jid(entry.jid);
      if occupant then room:set_role(true, occupant.nick, nil, "Archipel Server policy service is unavailable"); end
    end
    busy = false; return;
  end
  for _, address in ipairs(result.disconnect) do if active[address] then active[address]:close({ condition = "not-authorized" }); end end
  for _, entry in ipairs(result.kick) do
    local room = muc.get_room_from_jid(entry.room);
    local occupant = room and room:get_occupant_by_real_jid(entry.jid);
    if occupant then room:set_role(true, occupant.nick, nil, "Archipel Server channel access revoked"); end
  end
  for _, item in ipairs(result.messages) do
    if jid.host(item.to) == module.host then
      local session = active[item.to];
      if session and not session.destroyed then session.send(bridge.message(item)); end
    else module:send(bridge.message(item)); end
  end
  for _, item in ipairs(result.avatar_requests or {}) do request_avatar(item); end
  for _, profile in ipairs(result.profiles or {}) do
    local bare_session = prosody.bare_sessions[profile.jid];
    for _, session in pairs(bare_session and bare_session.sessions or {}) do
      if session.presence and not session.destroyed then
        local presence = st.clone(session.presence);
        presence.attr.from = session.full_jid; presence.attr.to = nil;
        presence:remove_children("x", "vcard-temp:x:update");
        presence:tag("x", { xmlns = "vcard-temp:x:update" }):tag("photo"):text(profile.hash):up():up();
        module:send(presence, session);
      end
    end
  end
  cursor = result.after;
  assert(cursor_store:set(nil, { after = cursor }));
  busy = false;
end, { error = function(_, err) busy = false; module:log("error", "Archipel Server synchronization failed: %s", err); end });
module:add_timer(1, function() if not busy then busy = true; runner:run(true); end return 1; end);
