local http = require "prosody.net.http";
local json = require "prosody.util.json";
local async = require "prosody.util.async";
local st = require "prosody.util.stanza";
local jid = require "prosody.util.jid";
local uuid = require "prosody.util.uuid";

local api_url = module:get_option_string("archipel_api_url");
local secret = module:get_option_string("archipel_api_secret");
assert(api_url and secret and #secret >= 43, "Archipel Server adapter configuration required");
local domain = module:get_option_string("archipel_domain");
-- The pinned Prosody HTTP client has unsafe pool cleanup on cancellation.
-- Retain its verified default transport until that dependency is corrected.
local adapter_http = http.default;
local last_warning = {};

local function request(path, input)
  local wait, done = async.waiter();
  local result, status, completed, reason, watchdog;
  local pending = adapter_http:request(api_url .. path, {
    method = "POST";
    headers = { ["Content-Type"] = "application/json"; ["Authorization"] = "Bearer " .. secret };
    body = json.encode(input); timeout = 5;
  }, function(body, code)
    if completed then return; end
    completed = true;
    if watchdog then watchdog:stop(); end
    status = code;
    if code == 200 then
      local ok, decoded = pcall(json.decode, body);
      if ok and type(decoded) == "table" then result = decoded;
      else reason = "Invalid adapter JSON response"; end
    elseif code == 0 then reason = tostring(body):sub(1, 120);
    elseif body then
      -- Archipel Server says why it refused, in words meant for the member.
      local ok, refusal = pcall(json.decode, body);
      if ok and type(refusal) == "table" and type(refusal.error) == "string" and #refusal.error <= 300 then reason = refusal.error; end
    end
    done();
  end);
  if not completed then watchdog = module:add_timer(5, function()
    if not completed then
      completed = true; status = 0;
      reason = pending and pending.conn and "Adapter response timed out" or "Adapter connection timed out";
      if pending and pending.cancel then pending:cancel("Archipel Server request timed out");
      elseif pending then http.destroy_request(pending, true); end
      done();
    end
  end); end
  wait();
  if not result then
    local key = path .. ":" .. tostring(status);
    if not last_warning[key] or os.time() - last_warning[key] >= 10 then
      last_warning[key] = os.time();
      module:log("warn", "Adapter %s failed (status %s): %s", path, tostring(status), reason or "transport failure");
    end
  end
  return result, status, reason;
end
local function operation(event, op, extras)
  local stanza, origin = event.stanza, event.origin;
  local input = extras or {};
  input.operation = op;
  input.from = stanza.attr.from or (origin.username and origin.username .. "@" .. domain);
  input.to = jid.bare(stanza.attr.to or "");
  input.credential = origin.archipel_credential;
  -- Foreign senders are only trusted on authenticated server-to-server streams.
  input.s2s = origin.type == "s2sin" or nil;
  -- Stanza IDs are unique within a stream, not across an account's clients.
  origin.archipel_stream_id = origin.archipel_stream_id or uuid.generate();
  input.stream = origin.archipel_stream_id;
  input.id = stanza.attr.id or uuid.generate();
  local result, status, reason = request("/operation", input);
  if not result and stanza.attr.type ~= "error" and stanza.attr.type ~= "result" then
    local condition = status == 404 and "item-not-found" or
      status == 400 and "bad-request" or status == 409 and "conflict" or
      (status == 401 or status == 403) and "forbidden" or "service-unavailable";
    origin.send(st.error_reply(stanza, "cancel", condition, reason or "Archipel Server could not authorize this operation."));
  end
  return result;
end
local function message(item)
  local stanza = st.message({ from = item.from; to = item.to; type = item.type; id = item.stanza_id or item.id })
    :tag("body"):text(item.body):up()
    :tag("stanza-id", { xmlns = "urn:xmpp:sid:0"; by = item.type == "groupchat" and jid.bare(item.from) or item.by or domain; id = item.id }):up();
  if item.replace then stanza:tag("replace", { xmlns = "urn:xmpp:message-correct:0"; id = item.replace }):up(); end
  if item.origin_id then stanza:tag("origin-id", { xmlns = "urn:xmpp:sid:0"; id = item.origin_id }):up(); end
  -- Object property only; cannot be forged by sending XML.
  stanza._archipel = true;
  return stanza;
end

local function archive(event, room)
  local query = event.stanza:get_child("query", "urn:xmpp:mam:2");
  local input = { room = room };
  local form = query:get_child("x", "jabber:x:data");
  if form then
    if form.attr.type ~= "submit" then
      event.origin.send(st.error_reply(event.stanza, "modify", "bad-request")); return true;
    end
    for field in form:childtags("field") do
      local key = field.attr.var;
      if key == "with" or key == "start" or key == "end" then input[key] = field:get_child_text("value");
      elseif key ~= "FORM_TYPE" then
        event.origin.send(st.error_reply(event.stanza, "modify", "feature-not-implemented")); return true;
      end
    end
  end
  local rsm = query:get_child("set", "http://jabber.org/protocol/rsm");
  if rsm then
    if rsm:get_child("index") then event.origin.send(st.error_reply(event.stanza, "modify", "feature-not-implemented")); return true; end
    input.max = rsm:get_child_text("max"); input.after = rsm:get_child_text("after");
    if rsm:get_child("before") then input.before = rsm:get_child_text("before") or ""; end
  end
  local result = operation(event, "archive", input);
  if not result then return true; end
  for _, item in ipairs(result.messages) do
    local forwarded = message(item);
    forwarded.attr.xmlns = "jabber:client";
    -- Original direct recipient belongs inside the forwarded stanza.
    event.origin.send(st.message({ from = event.stanza.attr.to; to = event.stanza.attr.from })
      :tag("result", { xmlns = "urn:xmpp:mam:2"; id = item.id; queryid = query.attr.queryid })
      :tag("forwarded", { xmlns = "urn:xmpp:forward:0" })
      :tag("delay", { xmlns = "urn:xmpp:delay"; stamp = item.stamp }):up():add_child(forwarded));
  end
  local reply = st.reply(event.stanza):tag("fin", { xmlns = "urn:xmpp:mam:2"; complete = result.complete and "true" or "false"; stable = "true" })
    :tag("set", { xmlns = "http://jabber.org/protocol/rsm" });
  if result.first then reply:tag("first", { index = tostring(result.index) }):text(result.first):up(); end
  if result.last then reply:tag("last"):text(result.last):up(); end
  reply:tag("count"):text(tostring(result.count));
  event.origin.send(reply);
  return true;
end
local function archive_form(event, room_only)
  local form = st.reply(event.stanza):tag("query", { xmlns = "urn:xmpp:mam:2" })
    :tag("x", { xmlns = "jabber:x:data"; type = "form" })
    :tag("field", { var = "FORM_TYPE"; type = "hidden" }):tag("value"):text("urn:xmpp:mam:2"):up():up();
  for _, key in ipairs(room_only and { "start", "end" } or { "with", "start", "end" }) do form:tag("field", { var = key; type = "text-single" }):up(); end
  event.origin.send(form); return true;
end
return { request = request; operation = operation; message = message; archive = archive; archive_form = archive_form; domain = domain };
