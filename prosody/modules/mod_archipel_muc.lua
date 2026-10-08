local bridge = module:require "archipel";
local st = require "prosody.util.stanza";
local jid = require "prosody.util.jid";
local muc = module:depends "muc";
local assigned_nicks = module:shared("/" .. bridge.domain .. "/archipel/assigned_nicks");
module:add_feature("urn:xmpp:mam:2");
local muc_ns = "http://jabber.org/protocol/muc";
-- Join history for occupants of other servers, held between admission and room entry.
local pending_history = {};

-- Gate room creation, presence and discovery before built-in MUC sees them.
module:hook("presence/full", function(event)
  if event.stanza.attr.type == "unavailable" or event.stanza.attr.type == "error" then return; end
  local from = event.stanza.attr.from;
  local room_jid = jid.bare(event.stanza.attr.to);
  local foreign = jid.host(from) ~= bridge.domain;
  local extras;
  if foreign then
    local x = event.stanza:get_child("x", muc_ns);
    local history = x and x:get_child("history");
    extras = { history = x and (tonumber(history and history.attr.maxstanzas) or 25) or 0 };
  end
  local result = bridge.operation(event, "join", extras);
  if not result then return true; end
  local room = muc.get_room_from_jid(room_jid) or muc.create_room(room_jid);
  if not room then event.origin.send(st.error_reply(event.stanza, "wait", "internal-server-error")); return true; end
  room:set_members_only(true);
  room:set_hidden(true);
  room:set_name(result.name);
  room:set_description(result.description);
  room:set_changesubject(false);
  room:set_historylength(0);
  room:set_affiliation(true, jid.bare(event.stanza.attr.from), "member");
  -- Stable account nicks keep history and live messages aligned.
  -- Foreign occupants keep their whole address, which no local account nick can equal.
  local assigned = room_jid .. "/" .. (foreign and jid.bare(from) or jid.node(from));
  if foreign then pending_history[from .. " " .. room_jid] = result.history; end
  if event.stanza.attr.to ~= assigned then
    assigned_nicks[event.stanza.attr.from] = assigned;
  end
  event.stanza.attr.to = assigned;
end, 100);
-- Self-presence for another server leaves through s2s, not through a local user's host.
module:hook("route/remote", function(event)
  local stanza = event.stanza;
  if stanza.name ~= "presence" or stanza.attr.type or assigned_nicks[stanza.attr.to] ~= stanza.attr.from then return; end
  local x = stanza:get_child("x", muc_ns .. "#user");
  if not x then return; end
  for status in x:childtags("status") do
    if status.attr.code == "110" then
      x:tag("status", { code = "210" }):up();
      assigned_nicks[stanza.attr.to] = nil;
      break;
    end
  end
end, 100);

module:hook("muc-occupant-groupchat", function(event)
  if event.stanza:get_child("encrypted", "eu.siacs.conversations.axolotl") or event.stanza:get_child("encrypted", "urn:xmpp:omemo:2") then
    event.origin.send(st.error_reply(event.stanza, "cancel", "feature-not-implemented", "Encrypted rooms are not supported.")); return true;
  end
  local body = event.stanza:get_child_text("body");
  if not body then
    -- No unvalidated subjects, invitations, encrypted payloads or arbitrary extensions.
    if event.stanza:get_child("subject") then event.origin.send(st.error_reply(event.stanza, "auth", "forbidden")); end
    return true;
  end
  if not event.occupant then event.origin.send(st.error_reply(event.stanza, "auth", "forbidden")); return true; end
  local replace = event.stanza:get_child("replace", "urn:xmpp:message-correct:0");
  if replace and jid.host(event.stanza.attr.from) ~= bridge.domain then
    event.origin.send(st.error_reply(event.stanza, "cancel", "feature-not-implemented", "Corrections from other servers are not supported.")); return true;
  end
  local origin_id = event.stanza:get_child("origin-id", "urn:xmpp:sid:0");
  bridge.operation(event, "post", { body = body; replace = replace and replace.attr.id; origin_id = origin_id and origin_id.attr.id });
  return true; -- Delivery happens from the committed, policy-filtered event stream.
end, 100);

local function deny(event)
  if event.stanza.attr.type ~= "error" and event.stanza.attr.type ~= "result" then
    event.origin.send(st.error_reply(event.stanza, "auth", "forbidden", "Manage rooms and membership in Archipel."));
  end
  return true;
end
for _, name in ipairs({
  "iq-set/bare/http://jabber.org/protocol/muc#admin:query";
  "iq-set/bare/http://jabber.org/protocol/muc#owner:query";
  "iq-get/bare/http://jabber.org/protocol/muc#admin:query";
  "iq-get/bare/http://jabber.org/protocol/muc#owner:query";
  "iq/bare/jabber:iq:register:query"; "message/full"; "iq/full";
}) do module:hook(name, deny, 100); end
module:hook("message/bare", function(event)
  if event.stanza.attr.type ~= "groupchat" then return deny(event); end
end, 100);
module:hook("muc-room-pre-create", deny, 100);
-- Built-in history stays disabled; foreign occupants get a bounded, policy-filtered page.
module:hook("muc-get-history", function(event)
  local key = event.to .. " " .. event.room.jid;
  local items, index = pending_history[key] or {}, 0;
  pending_history[key] = nil;
  function event.next_stanza()
    index = index + 1;
    local item = items[index];
    if not item then return; end
    local stanza = bridge.message(item);
    stanza:tag("delay", { xmlns = "urn:xmpp:delay"; from = event.room.jid; stamp = item.stamp }):up();
    return stanza;
  end
  return true;
end, 100);
module:hook("iq-get/bare/http://jabber.org/protocol/disco#info:query", function(event)
  if not bridge.operation(event, "read") then return true; end
end, 100);
module:hook("iq-get/bare/http://jabber.org/protocol/disco#items:query", function(event)
  if not bridge.operation(event, "read") then return true; end
end, 100);
module:hook("iq-get/host/http://jabber.org/protocol/disco#items:query", function(event)
  local result = bridge.operation(event, "rooms");
  if result then
    local reply = st.reply(event.stanza):tag("query", { xmlns = "http://jabber.org/protocol/disco#items" });
    for _, room in ipairs(result.rooms) do reply:tag("item", { jid = room.jid; name = room.name }):up(); end
    event.origin.send(reply);
  end
  return true;
end, 100);
module:hook("muc-disco#info", function(event)
  event.reply:tag("feature", { var = "urn:xmpp:mam:2" }):up()
    :tag("feature", { var = "urn:xmpp:sid:0" }):up()
    :tag("feature", { var = "urn:xmpp:message-correct:0" }):up();
end);
module:hook("iq-set/bare/urn:xmpp:mam:2:query", function(event) return bridge.archive(event, jid.bare(event.stanza.attr.to)); end, 100);
module:hook("iq-get/bare/urn:xmpp:mam:2:query", function(event)
  if bridge.operation(event, "read") then return bridge.archive_form(event, true); end
  return true;
end, 100);
