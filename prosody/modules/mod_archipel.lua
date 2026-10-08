local bridge = module:require "archipel";
local st = require "prosody.util.stanza";
local jid = require "prosody.util.jid";
local async = require "prosody.util.async";
local array = require "prosody.util.array";
local cursor_store = module:open_store("archipel_cursor");
local cursor = (cursor_store:get(nil) or {}).after or 0;
local assigned_nicks = module:shared("/" .. bridge.domain .. "/archipel/assigned_nicks");
module:add_feature("urn:xmpp:mam:2");
module:hook("account-disco-info", function(event)
  event.reply:tag("feature", { var = "urn:xmpp:mam:2" }):up()
    :tag("feature", { var = "urn:xmpp:sid:0" }):up();
end);
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
      origin:close({ condition = "not-authorized"; text = "Archipel access was revoked or is unavailable." }); return true;
    end
  end
end, 1000);
module:hook("pre-presence/full", function(event)
  local target_host = jid.host(event.stanza.attr.to or "");
  if target_host ~= module.host and target_host ~= "channels." .. module.host then
    event.origin.send(st.error_reply(event.stanza, "cancel", "feature-not-implemented", "Foreign rooms are not supported.")); return true;
  end
end, 100);

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
    for _, session in pairs(active) do session:close({ condition = "internal-server-error"; text = "Archipel policy service is unavailable." }); end
    busy = false; return;
  end
  for _, address in ipairs(result.disconnect) do if active[address] then active[address]:close({ condition = "not-authorized" }); end end
  for _, entry in ipairs(result.kick) do
    local room = muc.get_room_from_jid(entry.room);
    local occupant = room and room:get_occupant_by_real_jid(entry.jid);
    if occupant then room:set_role(true, occupant.nick, nil, "Archipel channel access revoked"); end
  end
  for _, item in ipairs(result.messages) do
    if jid.host(item.to) == module.host then
      local session = active[item.to];
      if session and not session.destroyed then session.send(bridge.message(item)); end
    else module:send(bridge.message(item)); end
  end
  cursor = result.after;
  assert(cursor_store:set(nil, { after = cursor }));
  busy = false;
end, { error = function(_, err) busy = false; module:log("error", "Archipel synchronization failed: %s", err); end });
module:add_timer(1, function() if not busy then busy = true; runner:run(true); end return 1; end);
