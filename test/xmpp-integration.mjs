import { grant } from "./roles.ts";
// Real TLS streams against the pinned Prosody image. Requires Docker and Node 24+.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import tls from "node:tls";
import { setTimeout as delay } from "node:timers/promises";
import { client, xml } from "@xmpp/client";
import { Store, randomToken } from "../src/store.ts";
import { loadConfig } from "../src/config.ts";
import { createApp } from "../src/app.ts";

const image = "prosodyim/prosody:13.0@sha256:0d4efc7c11018dfd863c9a25495efe706027de357a58a18ef02f8c484fb264ed";
const name = `archipel-xmpp-test-${randomUUID()}`;
const remoteName = `${name}-remote`, network = `${name}-network`;
const temporary = mkdtempSync(join(tmpdir(), "archipel-xmpp-test-"));
const store = new Store(":memory:");
const secret = randomToken();
const clientPort = 55222;
const config = loadConfig({ DEV_AUTH: "true", XMPP_DOMAIN: "chat.test", XMPP_BRIDGE_SECRET: secret, XMPP_CLIENT_PORT: String(clientPort) });
const app = createApp(config, store), xmpp = app.locals.xmpp;
const server = app.listen(0, "0.0.0.0");
await new Promise(resolve => server.once("listening", resolve));
const port = server.address().port;
const alice = store.loginIdentity("urn:archipel:development", "alice", "alice", [], true);
const bob = store.loginIdentity("urn:archipel:development", "bob", "bob", []);
const a = xmpp.issue(alice, "Native desktop"), b = xmpp.issue(bob, "Native phone");
const avatarImage = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=";
store.setAvatar(alice, avatarImage);
const room = store.createChannel(alice, { name: "general", mode: "timeline", visibility: "members", admission: "open" });
const roomJid = "general@channels.chat.test";
const clients = [];
const execute = promisify(execFile);
const docker = async (...args) => {
  const result = await execute("docker", args, { encoding: "utf8", timeout: 60000 });
  return (result.stdout + (args[0] === "logs" ? result.stderr : "")).trim();
};
async function until(fn, label, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = fn(); if (value) return value; await delay(50); }
  throw new Error(`Timed out: ${label}`);
}
function account(credential, resource, domain = "chat.test", connectPort = xmppPort) {
  const native = client({ service: `xmpp://127.0.0.1:${connectPort}`, domain, resource,
    username: credential.jid.split("@")[0], password: credential.password });
  const received = [], errors = [];
  native.on("stanza", stanza => received.push(stanza));
  native.on("error", error => errors.push(error));
  native.reconnect.stop();
  clients.push(native);
  return { native, received, errors };
}
let xmppPort;
try {
  await docker("network", "create", network);
  // libunbound otherwise bypasses Docker DNS and queries public root servers.
  writeFileSync(join(temporary, "local.cfg.lua"), 'unbound = { resolvconf = true; hoststxt = true; options = { ["domain-insecure"] = "test" } }\n' + readFileSync(resolve("prosody/prosody.cfg.lua"), "utf8"));
  await docker("run", "--detach", "--rm", "--name", name, "--network", network,
    "--network-alias", "chat.test", "--network-alias", "channels.chat.test", "--add-host", "host.docker.internal:host-gateway",
    "--env", "XMPP_DOMAIN=chat.test", "--env", `XMPP_BRIDGE_SECRET=${secret}`,
    "--env", `ARCHIPEL_API_URL=http://host.docker.internal:${port}/internal/xmpp`,
    "--env", "XMPP_CERTS_PATH=/tmp/test-certs", "--env", `XMPP_CLIENT_PORT=${clientPort}`, "--publish", `127.0.0.1::${clientPort}`,
    "--env", "XMPP_CA_FILE=/tmp/test-certs/chat.test.crt",
    "--mount", `type=bind,src=${join(temporary, "local.cfg.lua")},dst=/etc/prosody/prosody.cfg.lua,readonly`,
    "--mount", `type=bind,src=${resolve("prosody/modules")},dst=/etc/prosody/archipel-modules,readonly`,
    "--entrypoint", "sh", image, "-c",
    'mkdir -p /tmp/test-certs; test -f /tmp/test-certs/chat.test.crt || openssl req -x509 -newkey rsa:2048 -nodes -keyout /tmp/test-certs/chat.test.key -out /tmp/test-certs/chat.test.crt -days 1 -subj /CN=chat.test -addext subjectAltName=DNS:chat.test,DNS:channels.chat.test,DNS:remote.test,DNS:muc.remote.test >/dev/null 2>&1 && chown -R prosody:prosody /tmp/test-certs && exec /entrypoint.sh prosody');
  xmppPort = Number(JSON.parse(await docker("inspect", name))[0].NetworkSettings.Ports[`${clientPort}/tcp`][0].HostPort);
  assert.equal(xmpp.status(alice).port, clientPort);
  await delay(1500);
  await docker("cp", `${name}:/tmp/test-certs/chat.test.crt`, join(temporary, "ca.crt"));
  tls.setDefaultCACertificates([...tls.getCACertificates(), readFileSync(join(temporary, "ca.crt"), "utf8")]);
  const desktop = account(a, "desktop"), phone = account(b, "phone");
  await Promise.all([desktop.native.start(), phone.native.start()]);
  assert.equal(desktop.native.status, "online");
  await delay(2500);
  assert.equal(desktop.native.status, "online", "A DM-only client must stay connected without room occupants");
  assert.equal(phone.native.status, "online");
  console.log(`PASS TLS, SASL app-password authentication and resource binding on custom client port ${clientPort}`);
  await desktop.native.send(xml("presence")); await phone.native.send(xml("presence"));
  const ownCard = await desktop.native.iqCaller.request(xml("iq", { type: "get" }, xml("vCard", { xmlns: "vcard-temp" })));
  assert.equal(ownCard.getChild("vCard").getChild("PHOTO").getChildText("BINVAL"), avatarImage);
  const largeAvatar = Buffer.concat([Buffer.from(avatarImage, "base64"), Buffer.alloc(300000)]).toString("base64");
  await phone.native.iqCaller.request(xml("iq", { type: "set" }, xml("vCard", { xmlns: "vcard-temp" }, xml("PHOTO", {}, xml("TYPE", {}, "image/png"), xml("BINVAL", {}, largeAvatar)))));
  assert.deepEqual(Buffer.from(store.avatarImage(bob.id).image), Buffer.from(largeAvatar, "base64"));
  const largeCard = await desktop.native.iqCaller.request(xml("iq", { type: "get", to: b.jid }, xml("vCard", { xmlns: "vcard-temp" })));
  assert.equal(largeCard.getChild("vCard").getChild("PHOTO").getChildText("BINVAL"), largeAvatar);
  await assert.rejects(phone.native.iqCaller.request(xml("iq", { type: "set", to: a.jid }, xml("vCard", { xmlns: "vcard-temp" }))));
  await phone.native.iqCaller.request(xml("iq", { type: "set" }, xml("vCard", { xmlns: "vcard-temp" })));
  assert.equal(store.avatarUrl(bob.id), null);
  await until(() => desktop.received.find(s => s.is("presence") && s.getChild("x", "vcard-temp:x:update")?.getChildText("photo")), "authoritative local avatar presence");
  console.log("PASS native vCard reads, shared avatar writes/removals and presence hashes");
  // A client asks what an address is before joining it: a room nobody is in yet answers as a room.
  const unjoined = await desktop.native.iqCaller.request(xml("iq", { type: "get", to: roomJid }, xml("query", { xmlns: "http://jabber.org/protocol/disco#info" })));
  assert.equal(unjoined.getChild("query").getChild("identity").attrs.category, "conference");
  assert.ok(unjoined.getChild("query").getChildren("feature").some(f => f.attrs.var === "http://jabber.org/protocol/muc"));
  console.log("PASS a room nobody has joined yet is discoverable as a room");
  await desktop.native.send(xml("presence", { to: `${roomJid}/Alice's phone`, id: "join-alice" }, xml("x", { xmlns: "http://jabber.org/protocol/muc" })));
  await phone.native.send(xml("presence", { to: `${roomJid}/bob`, id: "join-bob" }, xml("x", { xmlns: "http://jabber.org/protocol/muc" })));
  await until(() => phone.received.find(s => s.is("presence") && s.attrs.from === `${roomJid}/bob` && !s.attrs.type), "Bob room join");
  assert.equal(store.role(room.id, bob.id), "member");
  const selfPresence = await until(() => desktop.received.find(s => s.is("presence") && s.attrs.from === `${roomJid}/alice`), "assigned nick presence");
  assert.ok(selfPresence.getChild("x", "http://jabber.org/protocol/muc#user").getChildren("status").some(status => status.attrs.code === "210"), selfPresence.toString());
  console.log("PASS MUC join creates authorized Archipel Server membership");
  const discovery = await phone.native.iqCaller.request(xml("iq", { type: "get", to: "channels.chat.test" }, xml("query", { xmlns: "http://jabber.org/protocol/disco#items" })));
  assert.equal(discovery.getChild("query").getChild("item").attrs.jid, roomJid);
  await desktop.native.send(xml("message", { to: roomJid, type: "groupchat", id: "native-message" }, xml("body", {}, "Hello from native XMPP")));
  const delivered = await until(() => phone.received.find(s => s.is("message") && s.getChildText("body") === "Hello from native XMPP"), "native room delivery");
  assert.equal(store.messages(bob, room.id)[0].body, "Hello from native XMPP");
  const saved = store.messages(bob, room.id)[0];
  assert.equal(delivered.getChild("stanza-id", "urn:xmpp:sid:0").attrs.id, saved.id);
  store.post(alice, room.id, { body: "Hello from browser REST" });
  await until(() => phone.received.find(s => s.getChildText("body") === "Hello from browser REST"), "browser room delivery");
  console.log("PASS native/browser shared messages, discovery and stable stanza IDs");
  // Clients find the rooms an account belongs to in its bookmarks, beside whatever they saved themselves.
  await phone.native.iqCaller.request(xml("iq", { type: "set" }, xml("query", { xmlns: "jabber:iq:private" }, xml("storage", { xmlns: "storage:bookmarks" }, xml("conference", { jid: "elsewhere@muc.example", autojoin: "false" })))));
  const bookmarks = (await phone.native.iqCaller.request(xml("iq", { type: "get" }, xml("query", { xmlns: "jabber:iq:private" }, xml("storage", { xmlns: "storage:bookmarks" }))))).getChild("query").getChild("storage", "storage:bookmarks").getChildren("conference");
  assert.deepEqual(bookmarks.map(c => [c.attrs.jid, c.attrs.autojoin, c.getChildText("nick") ?? null]), [["elsewhere@muc.example", "false", null], [roomJid, "true", "bob"]]);
  console.log("PASS room bookmarks list joined channels beside the client's own");
  assert.equal(delivered.attrs.id, "native-message");
  await desktop.native.send(xml("message", { to: roomJid, type: "groupchat", id: "native-edit" }, xml("body", {}, "Edited from native"), xml("replace", { xmlns: "urn:xmpp:message-correct:0", id: "native-message" })));
  await until(() => phone.received.find(s => s.getChildText("body") === "Edited from native"), "native correction");
  await desktop.native.send(xml("message", { to: b.jid, type: "chat", id: "native-dm" }, xml("body", {}, "A native direct message")));
  const directMessage = await until(() => phone.received.find(s => s.getChildText("body") === "A native direct message"), "native DM delivery");
  assert.equal(directMessage.attrs.id, "native-dm");
  assert.equal(store.directHistory(bob, `${store.baseUrl}/actors/users/${alice.id}`).messages[0].body, "A native direct message");
  console.log("PASS corrections and direct messages use Archipel Server archive");
  const archive = await phone.native.iqCaller.request(xml("iq", { type: "set", to: roomJid }, xml("query", { xmlns: "urn:xmpp:mam:2", queryid: "history" }, xml("set", { xmlns: "http://jabber.org/protocol/rsm" }, xml("max", {}, "1"), xml("before")))));
  assert.equal(archive.getChild("fin", "urn:xmpp:mam:2").getChild("set").getChildText("count"), "2");
  const archived = phone.received.find(s => s.getChild("result", "urn:xmpp:mam:2")?.attrs.queryid === "history");
  assert.ok(archived);
  const forwarded = archived.getChild("result").getChild("forwarded", "urn:xmpp:forward:0");
  assert.ok(forwarded.getChild("message", "jabber:client"));
  assert.ok(forwarded.getChild("delay", "urn:xmpp:delay").attrs.stamp);
  console.log("PASS XEP-0313 room history with result-set paging");
  const directArchive = await desktop.native.iqCaller.request(xml("iq", { type: "set" }, xml("query", { xmlns: "urn:xmpp:mam:2", queryid: "direct-history" })));
  assert.ok(directArchive.getChild("fin", "urn:xmpp:mam:2"));
  const recipientArchive = await phone.native.iqCaller.request(xml("iq", { type: "set" }, xml("query", { xmlns: "urn:xmpp:mam:2", queryid: "incoming-direct" })));
  assert.ok(recipientArchive.getChild("fin", "urn:xmpp:mam:2"));
  const archivedDirect = phone.received.find(s => s.getChild("result", "urn:xmpp:mam:2")?.attrs.queryid === "incoming-direct").getChild("result");
  assert.equal(archivedDirect.attrs.id, directMessage.getChild("stanza-id", "urn:xmpp:sid:0").attrs.id);
  console.log("PASS personal XEP-0313 archive");

  // Ordinary Prosody peer: no Archipel Server modules, shared API or application archive.
  const localIp = Object.values(JSON.parse(await docker("inspect", name))[0].NetworkSettings.Networks)[0].IPAddress;
  await docker("cp", `${name}:/tmp/test-certs/chat.test.key`, join(temporary, "remote.test.key"));
  writeFileSync(join(temporary, "remote.test.crt"), readFileSync(join(temporary, "ca.crt")));
  writeFileSync(join(temporary, "remote.cfg.lua"), `
data_path = "/var/lib/prosody"
pidfile = "/var/run/prosody/prosody.pid"
daemonize = false
log = {{ levels = { min = "info" }, to = "console" }}
modules_enabled = { "disco"; "roster"; "saslauth"; "tls"; "ping"; "offline"; "vcard" }
authentication = "internal_hashed"
c2s_require_encryption = true
s2s_require_encryption = true
s2s_secure_auth = true
certificates = "/tmp/peer-certs"
ssl = { cafile = "/tmp/peer-certs/remote.test.crt" }
unbound = { resolvconf = true; hoststxt = true; options = { ["domain-insecure"] = "test"; ["local-zone"] = "chat.test. redirect"; ["local-data"] = "chat.test. IN A ${localIp}" } }
http_ports = {}
https_ports = {}
VirtualHost "remote.test"
Component "muc.remote.test" "muc"
  restrict_room_creation = false
`);
  const remotePassword = randomToken();
  await docker("run", "--detach", "--rm", "--name", remoteName, "--network", network, "--network-alias", "remote.test", "--network-alias", "muc.remote.test",
    "--publish", "127.0.0.1::5222", "--env", `TEST_REMOTE_PASSWORD=${remotePassword}`,
    "--mount", `type=bind,src=${temporary},dst=/test,readonly`, "--entrypoint", "sh", image, "-c",
    'cp /test/remote.cfg.lua /etc/prosody/prosody.cfg.lua && mkdir /tmp/peer-certs && cp /test/remote.test.crt /test/remote.test.key /tmp/peer-certs/ && chown -R prosody:prosody /tmp/peer-certs && prosodyctl register other remote.test "$TEST_REMOTE_PASSWORD" && exec /entrypoint.sh prosody');
  await delay(1500);
  const remotePort = Number(JSON.parse(await docker("inspect", remoteName))[0].NetworkSettings.Ports["5222/tcp"][0].HostPort);
  const remoteIp = Object.values(JSON.parse(await docker("inspect", remoteName))[0].NetworkSettings.Networks)[0].IPAddress;
  writeFileSync(join(temporary, "local.cfg.lua"), `unbound = { resolvconf = true; hoststxt = true; options = { ["domain-insecure"] = "test"; ["local-zone"] = "remote.test. redirect"; ["local-data"] = "remote.test. IN A ${remoteIp}" } }\n` + readFileSync(resolve("prosody/prosody.cfg.lua"), "utf8"));
  await docker("exec", name, "sh", "-c", 'kill -HUP "$(cat /var/run/prosody/prosody.pid)"');
  await delay(500);
  const peer = account({ jid: "other@remote.test", password: remotePassword }, "ordinary-client", "remote.test", remotePort);
  await peer.native.start(); await peer.native.send(xml("presence"));
  await desktop.native.send(xml("message", { type: "chat", to: "other@remote.test", id: "fed-denied" }, xml("body", {}, "Federation starts disabled")));
  await until(() => desktop.received.find(s => s.attrs.id === "fed-denied" && s.attrs.type === "error"), "default federation rejection");
  app.locals.federation.setEnabled(alice, true);
  grant(app.locals.federation.store, alice, alice.id, { federation_send: true, federation_receive: true, federation_subscribe: false, federation_post: false });
  await peer.native.iqCaller.request(xml("iq", { type: "set" }, xml("vCard", { xmlns: "vcard-temp" }, xml("PHOTO", {}, xml("TYPE", {}, "image/png"), xml("BINVAL", {}, avatarImage)))));
  await desktop.native.send(xml("message", { type: "chat", to: "other@remote.test", id: "fed-native" }, xml("body", {}, "Hello to ordinary Prosody")));
  await until(() => {
    const rejected = desktop.received.find(s => s.attrs.type === "error" && s.getChildText("body") === "Hello to ordinary Prosody");
    if (rejected) throw new Error(`s2s rejected: ${rejected.getChild("error")?.getChildText("text")}`);
    return peer.received.find(s => s.getChildText("body") === "Hello to ordinary Prosody");
  }, "outgoing s2s delivery", 15000);
  await peer.native.send(xml("message", { type: "chat", to: a.jid, id: "fed-reply" }, xml("body", {}, "Reply from ordinary Prosody")));
  await until(() => desktop.received.find(s => s.getChildText("body") === "Reply from ordinary Prosody"), "incoming s2s delivery", 15000);
  assert.equal(store.directHistory(alice, "xmpp:other@remote.test").messages.at(-1).body, "Reply from ordinary Prosody");
  await until(() => store.peerInfo("xmpp:other@remote.test").avatar_url, "remote native avatar cached for browser", 15000);
  const remoteCard = await peer.native.iqCaller.request(xml("iq", { type: "get", to: a.jid }, xml("vCard", { xmlns: "vcard-temp" })));
  assert.equal(remoteCard.getChild("vCard").getChild("PHOTO").getChildText("BINVAL"), avatarImage);
  await peer.native.iqCaller.request(xml("iq", { type: "set" }, xml("vCard", { xmlns: "vcard-temp" })));
  await peer.native.send(xml("presence", { to: a.jid }, xml("x", { xmlns: "vcard-temp:x:update" }, xml("photo"))));
  await until(() => !store.peerInfo("xmpp:other@remote.test").avatar_url, "remote avatar removal presence", 10000);
  store.removeAvatar(alice);
  const emptyCard = await peer.native.iqCaller.request(xml("iq", { type: "get", to: a.jid }, xml("vCard", { xmlns: "vcard-temp" })));
  assert.equal(emptyCard.getChild("vCard").getChild("PHOTO"), undefined);
  console.log("PASS bidirectional federated vCard pictures and avatar removal");
  console.log("PASS certificate-authenticated TLS federation with an ordinary Prosody peer");
  // Foreign MUCs use an ordinary peer, including browser resources without c2s sessions.
  grant(app.locals.federation.store, alice, alice.id, { federation_send: true, federation_receive: true, federation_subscribe: true, federation_post: true });
  const foreignRoom = "lounge@muc.remote.test";
  await peer.native.send(xml("presence", { to: `${foreignRoom}/host` }, xml("x", { xmlns: "http://jabber.org/protocol/muc" })));
  await until(() => peer.received.find(s => s.is("presence") && s.attrs.from === `${foreignRoom}/host`), "foreign room creation");
  await peer.native.iqCaller.request(xml("iq", { type: "set", to: foreignRoom }, xml("query", { xmlns: "http://jabber.org/protocol/muc#owner" }, xml("x", { xmlns: "jabber:x:data", type: "submit" },
    xml("field", { var: "FORM_TYPE" }, xml("value", {}, "http://jabber.org/protocol/muc#roomconfig")),
    xml("field", { var: "muc#roomconfig_whois" }, xml("value", {}, "anyone"))))));
  await peer.native.send(xml("message", { to: foreignRoom, type: "groupchat", id: "before-join" }, xml("body", {}, "History from the foreign room")));
  const subscription = xmpp.remoteRooms.join(alice, { room: foreignRoom, nick: "alice-browser" });
  await until(() => xmpp.remoteRooms.list(alice).find(r => r.id === subscription.id)?.state === "joined", "browser external room join", 15000);
  await until(() => xmpp.remoteRooms.history(alice, subscription.id).messages.some(m => m.body === "History from the foreign room"), "foreign room join history");
  await peer.native.send(xml("message", { to: foreignRoom, type: "groupchat", id: "foreign-live" }, xml("body", {}, "Live foreign room message")));
  await until(() => xmpp.remoteRooms.history(alice, subscription.id).messages.some(m => m.body === "Live foreign room message"), "foreign live archive");
  // The room discloses addresses, so a live message names its sender; replayed history does not.
  const attributed = body => xmpp.remoteRooms.history(alice, subscription.id).messages.find(m => m.body === body).sender_jid;
  assert.equal(attributed("Live foreign room message"), "other@remote.test");
  assert.equal(attributed("History from the foreign room"), null);
  store.setUserBlock(alice, "xmpp:other@remote.test", true);
  assert.equal(xmpp.remoteRooms.history(alice, subscription.id).messages.filter(m => m.blocked).length, 1);
  store.setUserBlock(alice, "xmpp:other@remote.test", false);
  const outgoing = xmpp.remoteRooms.post(alice, subscription.id, "Browser posting to the foreign room");
  await until(() => peer.received.find(s => s.getChildText("body") === "Browser posting to the foreign room"), "browser foreign post");
  await until(() => xmpp.remoteRooms.history(alice, subscription.id).messages.find(m => m.id === outgoing.id)?.status === "confirmed", "room echo confirmation");
  assert.equal(xmpp.remoteRooms.history(alice, subscription.id).messages.filter(m => m.body === "Browser posting to the foreign room").length, 1);
  await desktop.native.send(xml("presence", { to: `${foreignRoom}/alice-native`, id: "native-foreign-join" }, xml("x", { xmlns: "http://jabber.org/protocol/muc" })));
  await until(() => desktop.received.find(s => s.is("presence") && s.attrs.from === `${foreignRoom}/alice-native` && !s.attrs.type), "native foreign join");
  await desktop.native.send(xml("message", { to: foreignRoom, type: "groupchat", id: "native-foreign-post" }, xml("body", {}, "Native foreign room message")));
  await until(() => peer.received.find(s => s.getChildText("body") === "Native foreign room message"), "native foreign post");
  await until(() => desktop.received.find(s => s.getChildText("body") === "Native foreign room message" && s.attrs.type === "groupchat"), "native foreign echo");
  await peer.native.send(xml("message", { to: foreignRoom, type: "groupchat" }, xml("subject", {}, "Foreign room subject")));
  await until(() => xmpp.remoteRooms.list(alice).find(r => r.id === subscription.id)?.subject === "Foreign room subject", "foreign room subject");
  await peer.native.iqCaller.request(xml("iq", { type: "set", to: foreignRoom }, xml("query", { xmlns: "http://jabber.org/protocol/muc#admin" }, xml("item", { nick: "alice-browser", role: "visitor" }))));
  await until(() => xmpp.remoteRooms.list(alice).find(r => r.id === subscription.id)?.role === "visitor", "foreign room speaking role change");
  assert.throws(() => xmpp.remoteRooms.post(alice, subscription.id, "Visitor cannot post"));
  await peer.native.iqCaller.request(xml("iq", { type: "set", to: foreignRoom }, xml("query", { xmlns: "http://jabber.org/protocol/muc#admin" }, xml("item", { nick: "alice-browser", role: "participant" }))));
  await until(() => xmpp.remoteRooms.list(alice).find(r => r.id === subscription.id)?.can_post, "foreign speaking role restored");
  xmpp.remoteRooms.leave(alice, subscription.id);
  await until(() => peer.received.find(s => s.is("presence") && s.attrs.from === `${foreignRoom}/alice-browser` && s.attrs.type === "unavailable"), "browser foreign leave");
  await desktop.native.send(xml("presence", { to: `${foreignRoom}/alice-native`, type: "unavailable" }));
  xmpp.remoteRooms.join(alice, { room: foreignRoom, nick: "host" });
  await until(() => xmpp.remoteRooms.list(alice).find(r => r.id === subscription.id)?.state === "error", "foreign nickname conflict");
  assert.match(xmpp.remoteRooms.list(alice).find(r => r.id === subscription.id).error, /conflict/);
  xmpp.remoteRooms.join(alice, { room: foreignRoom, nick: "alice-browser" });
  await until(() => xmpp.remoteRooms.list(alice).find(r => r.id === subscription.id)?.state === "joined", "rejoin after conflict");
  grant(app.locals.federation.store, alice, alice.id, { federation_send: true, federation_receive: false, federation_subscribe: true, federation_post: true });
  const unavailableCount = peer.received.filter(s => s.is("presence") && s.attrs.from === `${foreignRoom}/alice-browser` && s.attrs.type === "unavailable").length;
  await until(() => peer.received.filter(s => s.is("presence") && s.attrs.from === `${foreignRoom}/alice-browser` && s.attrs.type === "unavailable").length > unavailableCount, "foreign policy revocation evicts browser");
  grant(app.locals.federation.store, alice, alice.id, { federation_send: true, federation_receive: true, federation_subscribe: true, federation_post: true });
  xmpp.remoteRooms.leave(alice, subscription.id);
  console.log("PASS foreign MUC joins, history, live messages, confirmed posts, subjects, roles, conflicts, leave and policy revocation");
  // The opposite direction: the ordinary peer's user occupies a federated local room.
  const mucNs = "http://jabber.org/protocol/muc";
  const plaza = store.createChannel(alice, { name: "plaza", mode: "timeline", visibility: "public", admission: "open" });
  const plazaJid = "plaza@channels.chat.test", guest = `${plazaJid}/other@remote.test`;
  await peer.native.send(xml("presence", { to: `${plazaJid}/guest`, id: "unfederated-join" }, xml("x", { xmlns: mucNs })));
  await until(() => peer.received.find(s => s.is("presence") && s.attrs.id === "unfederated-join" && s.attrs.type === "error"), "local-only room refuses a foreign join", 15000);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM users WHERE remote_actor='xmpp:other@remote.test'").get().n, 0);
  app.locals.federation.setChannel(alice, plaza.id, true);
  store.post(alice, plaza.id, { body: "Posted before the foreign join" });
  await peer.native.send(xml("presence", { to: `${plazaJid}/guest`, id: "foreign-join" }, xml("x", { xmlns: mucNs }, xml("history", { maxstanzas: "10" }))));
  const statusCodes = s => (s.getChild("x", `${mucNs}#user`)?.getChildren("status") || []).map(status => status.attrs.code);
  const guestPresence = await until(() => peer.received.find(s => s.is("presence") && s.attrs.from === guest && !s.attrs.type && statusCodes(s).includes("110")), "foreign occupant join", 15000);
  assert.ok(statusCodes(guestPresence).includes("210"), guestPresence.toString());
  const replayed = await until(() => peer.received.find(s => s.is("message") && s.getChildText("body") === "Posted before the foreign join"), "bounded join history for a foreign occupant");
  assert.equal(replayed.attrs.from, `${plazaJid}/alice`);
  assert.ok(replayed.getChild("delay", "urn:xmpp:delay").attrs.stamp);
  const foreigner = store.details(alice, plaza.id).members.find(member => member.actor_url === "xmpp:other@remote.test");
  assert.equal(foreigner.username, "other@remote.test");
  await peer.native.send(xml("message", { to: plazaJid, type: "groupchat", id: "foreign-occupant-post" }, xml("body", {}, "Hello from a foreign home server")));
  const reflected = await until(() => peer.received.find(s => s.is("message") && s.attrs.type === "groupchat" && s.attrs.id === "foreign-occupant-post"), "foreign post reflected after commit", 15000);
  const committed = store.messages(alice, plaza.id).at(-1);
  assert.equal(committed.body, "Hello from a foreign home server");
  assert.equal(committed.author_actor_url, "xmpp:other@remote.test");
  assert.equal(committed.username, "other@remote.test");
  assert.equal(reflected.attrs.from, guest);
  assert.equal(reflected.getChild("stanza-id", "urn:xmpp:sid:0").attrs.id, committed.id);
  store.post(alice, plaza.id, { body: "Live to the foreign occupant" });
  await until(() => peer.received.find(s => s.getChildText("body") === "Live to the foreign occupant" && s.attrs.from === `${plazaJid}/alice`), "live delivery to a foreign occupant");
  const foreignArchive = await peer.native.iqCaller.request(xml("iq", { type: "set", to: plazaJid }, xml("query", { xmlns: "urn:xmpp:mam:2", queryid: "foreign-history" })));
  assert.equal(foreignArchive.getChild("fin", "urn:xmpp:mam:2").getChild("set").getChildText("count"), "3");
  assert.equal(peer.received.filter(s => s.getChild("result", "urn:xmpp:mam:2")?.attrs.queryid === "foreign-history").length, 3);
  await assert.rejects(peer.native.iqCaller.request(xml("iq", { type: "set", to: roomJid }, xml("query", { xmlns: "urn:xmpp:mam:2" }))));
  store.deleteMessage(alice, committed.id);
  await until(() => peer.received.find(s => s.getChild("replace", "urn:xmpp:message-correct:0")?.attrs.id === "foreign-occupant-post" && s.getChildText("body") === "This message was removed."), "moderator removal reaches the foreign occupant");
  store.setMember(alice, plaza.id, foreigner.id, { rule: "block" });
  await until(() => peer.received.find(s => s.is("presence") && s.attrs.from === guest && s.attrs.type === "unavailable"), "moderator block evicts the foreign occupant");
  await peer.native.send(xml("presence", { to: `${plazaJid}/guest`, id: "foreign-rejoin" }, xml("x", { xmlns: mucNs })));
  await until(() => peer.received.find(s => s.is("presence") && s.attrs.id === "foreign-rejoin" && s.attrs.type === "error"), "blocked foreign occupant cannot rejoin");
  console.log("PASS foreign home-server occupants: admission, join history, committed posts, live delivery, room MAM, removal and eviction");
  // A bridged channel shares one conversation with a room on the ordinary peer, each author as themselves.
  const everything = { federation_send: true, federation_receive: true, federation_subscribe: true, federation_post: true };
  grant(app.locals.federation.store, alice, bob.id, everything);
  const annexRoom = "annex@muc.remote.test";
  await peer.native.send(xml("presence", { to: `${annexRoom}/host` }, xml("x", { xmlns: "http://jabber.org/protocol/muc" })));
  await until(() => peer.received.find(s => s.is("presence") && s.attrs.from === `${annexRoom}/host`), "bridged room creation");
  await peer.native.iqCaller.request(xml("iq", { type: "set", to: annexRoom }, xml("query", { xmlns: "http://jabber.org/protocol/muc#owner" }, xml("x", { xmlns: "jabber:x:data", type: "submit" },
    xml("field", { var: "FORM_TYPE" }, xml("value", {}, "http://jabber.org/protocol/muc#roomconfig")),
    xml("field", { var: "muc#roomconfig_whois" }, xml("value", {}, "anyone"))))));
  const annex = store.createChannel(alice, { name: "annex", mode: "timeline", visibility: "public", admission: "open" });
  store.join(bob, annex.id);
  xmpp.remoteRooms.setBridge(alice, annex.id, annexRoom);
  await until(() => xmpp.remoteRooms.bridge(alice, annex.id).state === "joined", "bridge listener join", 15000);
  await peer.native.send(xml("message", { to: annexRoom, type: "groupchat", id: "annex-in" }, xml("body", {}, "Room to channel")));
  await until(() => store.messages(alice, annex.id).some(m => m.body === "Room to channel"), "room message bridged into the channel");
  assert.equal(store.messages(alice, annex.id).find(m => m.body === "Room to channel").author_actor_url, "xmpp:other@remote.test");
  store.post(bob, annex.id, { body: "Channel to room" });
  await until(() => peer.received.find(s => s.getChildText("body") === "Channel to room" && s.attrs.from === `${annexRoom}/bob`), "channel message bridged into the room as its author", 20000);
  await until(() => store.db.prepare("SELECT status FROM xmpp_remote_messages WHERE relay_of IS NOT NULL").get()?.status === "confirmed", "bridged echo confirmation");
  await delay(1500);
  assert.deepEqual(store.messages(alice, annex.id).map(m => m.body), ["Room to channel", "Channel to room"]);
  assert.deepEqual(xmpp.remoteRooms.list(bob), []);
  xmpp.remoteRooms.removeBridge(alice, annex.id);
  await until(() => peer.received.find(s => s.is("presence") && s.attrs.from === `${annexRoom}/bob` && s.attrs.type === "unavailable"), "bridge removal retires its occupants");
  grant(app.locals.federation.store, alice, bob.id, { federation_send: false, federation_receive: false, federation_subscribe: false, federation_post: false });
  console.log("PASS bridged channel: room messages enter once with their author, members speak in the room as themselves");
  store.setUserBlock(bob, `${store.baseUrl}/actors/users/${alice.id}`, true);
  await desktop.native.send(xml("message", { to: b.jid, type: "chat", id: "blocked-dm" }, xml("body", {}, "Must not arrive")));
  await until(() => desktop.received.find(s => s.attrs.id === "blocked-dm" && s.attrs.type === "error"), "blocked DM rejection");
  store.post(alice, room.id, { body: "Must be hidden" });
  await until(() => phone.received.find(s => /hidden because/.test(s.getChildText("body") || "")), "personal block projection");
  const adminIq = xml("iq", { type: "set", to: roomJid }, xml("query", { xmlns: "http://jabber.org/protocol/muc#admin" }, xml("item", { jid: a.jid, affiliation: "outcast" })));
  await assert.rejects(phone.native.iqCaller.request(adminIq));
  store.setMember(alice, room.id, bob.id, { remove: true });
  await until(() => phone.received.find(s => s.is("presence") && s.attrs.from === `${roomJid}/bob` && s.attrs.type === "unavailable"), "membership eviction");
  await assert.rejects(phone.native.iqCaller.request(xml("iq", { type: "set", to: roomJid }, xml("query", { xmlns: "urn:xmpp:mam:2" }))));
  xmpp.revoke(bob, b.id);
  await until(() => phone.native.status !== "online", "credential disconnect");
  console.log("PASS personal blocks, owner protection, membership removal, archive denial and credential disconnect");
  xmpp.remoteRooms.join(alice, { room: foreignRoom, nick: "alice-browser" });
  await until(() => xmpp.remoteRooms.list(alice).find(r => r.id === subscription.id)?.state === "joined", "join before adapter restart");
  const historyCount = xmpp.remoteRooms.history(alice, subscription.id).messages.length;
  const presenceCount = peer.received.filter(s => s.is("presence") && s.attrs.from === `${foreignRoom}/alice-browser` && !s.attrs.type).length;
  await docker("restart", "--time", "1", name);
  await until(() => peer.received.filter(s => s.is("presence") && s.attrs.from === `${foreignRoom}/alice-browser` && !s.attrs.type).length > presenceCount && xmpp.remoteRooms.list(alice).find(r => r.id === subscription.id)?.state === "joined", "persistent browser room rejoins after Prosody restart", 20000);
  await peer.native.send(xml("message", { to: foreignRoom, type: "groupchat", id: "after-restart" }, xml("body", {}, "Live after adapter restart")));
  await until(() => xmpp.remoteRooms.history(alice, subscription.id).messages.some(m => m.body === "Live after adapter restart"), "room live delivery after restart", 15000);
  assert.equal(xmpp.remoteRooms.history(alice, subscription.id).messages.filter(m => m.body === "History from the foreign room").length, 1);
  assert.ok(xmpp.remoteRooms.history(alice, subscription.id).messages.length >= historyCount);
  xmpp.remoteRooms.leave(alice, subscription.id);
  console.log("PASS persistent browser subscription reconnects after adapter restart without replaying duplicate history");
} catch (error) {
  try { console.error(await docker("logs", "--tail", "100", name)); } catch (logsError) { console.error("Local logs unavailable", logsError.message); }
  try { console.error(await docker("logs", remoteName)); } catch { /* Peer may not be started. */ }
  throw error;
} finally {
  await Promise.allSettled(clients.map(native => native.stop()));
  try { await docker("stop", "--time", "3", name); } catch { /* Failed startup. */ }
  try { await docker("stop", "--time", "3", remoteName); } catch { /* Peer may not be started. */ }
  try { await docker("network", "rm", network); } catch { /* Failed network creation. */ }
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  store.close(); rmSync(temporary, { recursive: true, force: true });
}
