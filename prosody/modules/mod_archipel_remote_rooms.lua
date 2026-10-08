-- External MUC routing, plus one durable browser occupant per subscription.
local bridge = module:require "archipel";
local st = require "prosody.util.stanza";
local jid = require "prosody.util.jid";
local async = require "prosody.util.async";
local uuid = require "prosody.util.uuid";
local array = require "prosody.util.array";
local occupants, native_rooms = {}, {};
local muc_ns, user_ns = "http://jabber.org/protocol/muc", "http://jabber.org/protocol/muc#user";

local function foreign(address)
  local host = jid.host(address or "");
  return host and host ~= module.host and host ~= "channels." .. module.host;
end
local function check(session, room, mode)
  return bridge.request("/operation", { operation = "remote-room-check"; from = session.full_jid;
    credential = session.archipel_credential; to = room; mode = mode });
end
local function fail(event)
  event.origin.send(st.error_reply(event.stanza, "auth", "forbidden", "External room access is unavailable."));
  return true;
end
local function self_presence(stanza)
  local x = stanza:get_child("x", user_ns);
  if not x then return false; end
  for status in x:childtags("status") do if status.attr.code == "110" then return true; end end
  return false;
end
local function error_text(stanza)
  local _, condition, description = stanza:get_error();
  if condition then return condition .. (description and #description < 300 and (": " .. description) or ""); end
  return "The room session ended.";
end
local function receive(entry, stanza, payload)
  payload.session, payload.from = entry.session, stanza.attr.from;
  return bridge.request("/remote-rooms/receive", payload);
end
local function unavailable(entry)
  module:send(st.presence({ from = entry.from; to = entry.room .. "/" .. entry.nick; type = "unavailable" }));
end

-- Native clients use their own resource, nickname and MUC protocol/history.
module:hook("pre-presence/full", function(event)
  local stanza, session = event.stanza, event.origin;
  if session.type ~= "c2s" or not foreign(stanza.attr.to) then return; end
  local room = jid.bare(stanza.attr.to);
  local rooms = native_rooms[session.full_jid] or {};
  if not stanza:get_child("x", muc_ns) and not rooms[room] then return; end
  local leaving = stanza.attr.type == "unavailable";
  if not check(session, room, leaving and "leave" or "read") then return fail(event); end
  if leaving then rooms[room] = nil;
  else rooms[room] = { nick = jid.resource(stanza.attr.to) }; end
  native_rooms[session.full_jid] = rooms;
end, 200);
local function outgoing_message(event)
  local stanza, session = event.stanza, event.origin;
  if session.type ~= "c2s" or not foreign(stanza.attr.to) then return; end
  local room = jid.bare(stanza.attr.to);
  if stanza.attr.type ~= "groupchat" and not ((native_rooms[session.full_jid] or {})[room] and jid.resource(stanza.attr.to)) then return; end
  if not (native_rooms[session.full_jid] or {})[room] or not check(session, room, "post") then return fail(event); end
  stanza._archipel = true; -- route the original stanza; do not treat it as a DM
end
module:hook("pre-message/bare", outgoing_message, 200);
module:hook("pre-message/full", outgoing_message, 200);
local function outgoing_iq(event)
  local stanza, session = event.stanza, event.origin;
  if session.type ~= "c2s" or not foreign(stanza.attr.to) then return; end
  local query = stanza:get_child("query");
  if not query then return; end
  local ns = query.attr.xmlns;
  if ns ~= "http://jabber.org/protocol/muc#admin" and ns ~= "http://jabber.org/protocol/muc#owner" and ns ~= "urn:xmpp:mam:2" then return; end
  local room = jid.bare(stanza.attr.to);
  local posting = stanza.attr.type == "set" and ns ~= "urn:xmpp:mam:2";
  if not check(session, room, posting and "post" or "read") then return fail(event); end
end
module:hook("pre-iq/bare", outgoing_iq, 200);
module:hook("pre-iq/full", outgoing_iq, 200);

-- Authenticated s2s only. Full recipient resource and exact room bind each stanza.
local function incoming(event)
  local stanza = event.stanza;
  if event.origin.type ~= "s2sin" or not foreign(stanza.attr.from) then return; end
  local entry;
  for _, candidate in pairs(occupants) do if candidate.from == stanza.attr.to then entry = candidate; break; end end
  if entry then
    if jid.bare(stanza.attr.from) ~= entry.room then return true; end
    if stanza.name == "presence" then
      -- Rooms that disclose real addresses name them in presence; remember who holds each nickname.
      local nick, x = jid.resource(stanza.attr.from), stanza:get_child("x", user_ns);
      local item = x and x:get_child("item");
      if nick and stanza.attr.type ~= "error" then
        entry.jids = entry.jids or {};
        entry.jids[nick] = stanza.attr.type ~= "unavailable" and item and item.attr.jid and jid.bare(item.attr.jid) or nil;
      end
      if stanza.attr.type == "error" then
        receive(entry, stanza, { kind = "state"; state = "error"; error = error_text(stanza) });
        occupants[entry.session] = nil;
      elseif self_presence(stanza) then
        local x = stanza:get_child("x", user_ns);
        local item = x:get_child("item");
        if stanza.attr.type == "unavailable" then
          -- A 303 self-presence announces a nick change, followed by available presence.
          local changing = false;
          for status in x:childtags("status") do if status.attr.code == "303" then changing = true; end end
          if changing and item and item.attr.nick then entry.nick = item.attr.nick;
          else
            receive(entry, stanza, { kind = "state"; state = "left"; error = error_text(stanza) });
            occupants[entry.session] = nil;
          end
        else
          entry.nick, entry.joined = jid.resource(stanza.attr.from), true;
          if not receive(entry, stanza, { kind = "state"; state = "joined"; role = item and item.attr.role }) then unavailable(entry); occupants[entry.session] = nil; end
        end
      end
    elseif stanza.name == "message" then
      if stanza.attr.type == "error" then
        receive(entry, stanza, { kind = "message-error"; id = stanza.attr.id; error = error_text(stanza) });
      elseif stanza.attr.type == "groupchat" then
        local subject = stanza:get_child_text("subject");
        if subject ~= nil then receive(entry, stanza, { kind = "subject"; subject = subject }); end
        local body = stanza:get_child_text("body");
        if body then
          local stable;
          for child in stanza:childtags("stanza-id", "urn:xmpp:sid:0") do
            if child.attr.by == entry.room then stable = child.attr.id; break; end
          end
          local delay = stanza:get_child("delay", "urn:xmpp:delay");
          local origin = stanza:get_child("origin-id", "urn:xmpp:sid:0");
          -- History may predate whoever holds the nickname now, so only live messages are attributed.
          local real = not delay and entry.jids and entry.jids[jid.resource(stanza.attr.from) or ""] or nil;
          receive(entry, stanza, { kind = "message"; body = body; id = stanza.attr.id; stable_id = stable;
            origin_id = origin and origin.attr.id; stamp = delay and delay.attr.stamp; real_jid = real });
        end
      end
    end
    return true; -- consume browser resource traffic instead of bouncing it
  end
  local session = prosody.full_sessions[stanza.attr.to];
  local room = jid.bare(stanza.attr.from);
  local membership = session and (native_rooms[session.full_jid] or {})[room];
  if membership then
    if not check(session, room, "read") then return true; end
    if stanza.name == "presence" and self_presence(stanza) then
      if stanza.attr.type == "unavailable" then native_rooms[session.full_jid][room] = nil;
      else membership.nick = jid.resource(stanza.attr.from); end
    end
    if stanza.name == "message" then stanza._archipel = true; end
    return; -- native client consumes the original room stanza
  end
  if stanza.name == "message" and stanza.attr.type == "groupchat" then return true; end
end
module:hook("presence/full", incoming, 300);
module:hook("message/full", incoming, 300);
module:hook("iq/full", incoming, 300);

local busy = false;
local runner = async.runner(function()
  local active = array();
  for token in pairs(occupants) do table.insert(active, token); end
  local result = bridge.request("/remote-rooms/sync", { active = active });
  if not result then
    for token, entry in pairs(occupants) do unavailable(entry); occupants[token] = nil; end
    busy = false; return;
  end
  local desired = {};
  for _, entry in ipairs(result.desired) do desired[entry.session] = entry; end
  for token, entry in pairs(occupants) do
    if not desired[token] then unavailable(entry); occupants[token] = nil;
    elseif not entry.joined and os.time() - entry.started > 30 then
      receive(entry, st.presence({ from = entry.room .. "/" .. entry.nick }), { kind = "state"; state = "error"; error = "The room did not answer the join request. Check the address (Archipel channels are name@channels.<domain>), then try joining again." });
      unavailable(entry); occupants[token] = nil;
      desired[token] = nil;
    end
  end
  for token, entry in pairs(desired) do
    if not occupants[token] then
      entry.started = os.time(); occupants[token] = entry;
      if receive(entry, st.presence({ from = entry.room .. "/" .. entry.nick }), { kind = "state"; state = "joining" }) then
        module:send(st.presence({ from = entry.from; to = entry.room .. "/" .. entry.nick; id = uuid.generate() })
          :tag("x", { xmlns = muc_ns }):tag("history", { maxstanzas = "100"; maxchars = "100000" }));
      else occupants[token] = nil; end
    end
  end
  for _, message in ipairs(result.messages) do
    local entry = occupants[message.session];
    if entry and entry.joined and bridge.request("/remote-rooms/dispatched", { session = entry.session; id = message.id }) then
      module:send(st.message({ from = entry.from; to = entry.room; type = "groupchat"; id = message.id })
        :tag("body"):text(message.body):up():tag("origin-id", { xmlns = "urn:xmpp:sid:0"; id = message.id }));
    end
  end
  -- Native occupants are evicted as soon as stream credentials or room policy change.
  for address, rooms in pairs(native_rooms) do
    local session = prosody.full_sessions[address];
    for room, entry in pairs(rooms) do
      if not session or not check(session, room, "read") then
        unavailable({ from = address; room = room; nick = entry.nick }); rooms[room] = nil;
      end
    end
    if not next(rooms) then native_rooms[address] = nil; end
  end
  busy = false;
end, { error = function(_, err) busy = false; module:log("error", "External room synchronization failed: %s", err); end });
module:add_timer(1, function() if not busy then busy = true; runner:run(true); end return 1; end);
module:hook_global("s2s-destroyed", function(event)
  local session = event.session;
  for token, entry in pairs(occupants) do
    if session and session.to_host == module.host and jid.host(entry.room) == session.from_host then occupants[token] = nil; end
  end
end);
function module.unload()
  for _, entry in pairs(occupants) do unavailable(entry); end
end
