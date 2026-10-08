local bridge = module:require "archipel";
local st = require "prosody.util.stanza";
local jid = require "prosody.util.jid";
local muc = module:depends "muc";
local assigned_nicks = module:shared("/" .. bridge.domain .. "/archipel/assigned_nicks");
module:add_feature("urn:xmpp:mam:2");

-- Gate room creation, presence and discovery before built-in MUC sees them.
module:hook("presence/full", function(event)
  if event.stanza.attr.type == "unavailable" or event.stanza.attr.type == "error" then return; end
  local result = bridge.operation(event, "join");
  if not result then return true; end
  local room_jid = jid.bare(event.stanza.attr.to);
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
  local assigned = room_jid .. "/" .. jid.node(event.stanza.attr.from);
  if event.stanza.attr.to ~= assigned then
    assigned_nicks[event.stanza.attr.from] = assigned;
  end
  event.stanza.attr.to = assigned;
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
module:hook("muc-get-history", function() return true; end, 100);
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
