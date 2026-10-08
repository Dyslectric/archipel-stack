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
const room = store.createChannel(alice, { name: "general", mode: "timeline", visibility: "members", admission: "open" });
const roomJid = "general@channels.chat.test";
const clients = [];
const execute = promisify(execFile);
const docker = async (...args) => (await execute("docker", args, { encoding: "utf8", timeout: 60000 })).stdout.trim();
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
    'mkdir -p /tmp/test-certs; openssl req -x509 -newkey rsa:2048 -nodes -keyout /tmp/test-certs/chat.test.key -out /tmp/test-certs/chat.test.crt -days 1 -subj /CN=chat.test -addext subjectAltName=DNS:chat.test,DNS:channels.chat.test,DNS:remote.test >/dev/null 2>&1 && chown -R prosody:prosody /tmp/test-certs && exec /entrypoint.sh prosody');
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
  await desktop.native.send(xml("presence", { to: `${roomJid}/Alice's phone`, id: "join-alice" }, xml("x", { xmlns: "http://jabber.org/protocol/muc" })));
  await phone.native.send(xml("presence", { to: `${roomJid}/bob`, id: "join-bob" }, xml("x", { xmlns: "http://jabber.org/protocol/muc" })));
  await until(() => phone.received.find(s => s.is("presence") && s.attrs.from === `${roomJid}/bob` && !s.attrs.type), "Bob room join");
  assert.equal(store.role(room.id, bob.id), "member");
  const selfPresence = await until(() => desktop.received.find(s => s.is("presence") && s.attrs.from === `${roomJid}/alice`), "assigned nick presence");
  assert.ok(selfPresence.getChild("x", "http://jabber.org/protocol/muc#user").getChildren("status").some(status => status.attrs.code === "210"), selfPresence.toString());
  console.log("PASS MUC join creates authorized Archipel membership");
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
  assert.equal(delivered.attrs.id, "native-message");
  await desktop.native.send(xml("message", { to: roomJid, type: "groupchat", id: "native-edit" }, xml("body", {}, "Edited from native"), xml("replace", { xmlns: "urn:xmpp:message-correct:0", id: "native-message" })));
  await until(() => phone.received.find(s => s.getChildText("body") === "Edited from native"), "native correction");
  await desktop.native.send(xml("message", { to: b.jid, type: "chat", id: "native-dm" }, xml("body", {}, "A native direct message")));
  const directMessage = await until(() => phone.received.find(s => s.getChildText("body") === "A native direct message"), "native DM delivery");
  assert.equal(directMessage.attrs.id, "native-dm");
  assert.equal(store.directHistory(bob, `${store.baseUrl}/actors/users/${alice.id}`).messages[0].body, "A native direct message");
  console.log("PASS corrections and direct messages use Archipel archive");
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

  // Ordinary Prosody peer: no Archipel modules, shared API or application archive.
  const localIp = Object.values(JSON.parse(await docker("inspect", name))[0].NetworkSettings.Networks)[0].IPAddress;
  await docker("cp", `${name}:/tmp/test-certs/chat.test.key`, join(temporary, "remote.test.key"));
  writeFileSync(join(temporary, "remote.test.crt"), readFileSync(join(temporary, "ca.crt")));
  writeFileSync(join(temporary, "remote.cfg.lua"), `
data_path = "/var/lib/prosody"
pidfile = "/var/run/prosody/prosody.pid"
daemonize = false
log = {{ levels = { min = "info" }, to = "console" }}
modules_enabled = { "disco"; "roster"; "saslauth"; "tls"; "ping"; "offline" }
authentication = "internal_hashed"
c2s_require_encryption = true
s2s_require_encryption = true
s2s_secure_auth = true
certificates = "/tmp/peer-certs"
ssl = { cafile = "/tmp/peer-certs/remote.test.crt" }
unbound = { resolvconf = true; hoststxt = true; options = { ["domain-insecure"] = "test"; ["local-data"] = "chat.test. IN A ${localIp}" } }
http_ports = {}
https_ports = {}
VirtualHost "remote.test"
`);
  const remotePassword = randomToken();
  await docker("run", "--detach", "--rm", "--name", remoteName, "--network", network, "--network-alias", "remote.test",
    "--publish", "127.0.0.1::5222", "--env", `TEST_REMOTE_PASSWORD=${remotePassword}`,
    "--mount", `type=bind,src=${temporary},dst=/test,readonly`, "--entrypoint", "sh", image, "-c",
    'cp /test/remote.cfg.lua /etc/prosody/prosody.cfg.lua && mkdir /tmp/peer-certs && cp /test/remote.test.crt /test/remote.test.key /tmp/peer-certs/ && chown -R prosody:prosody /tmp/peer-certs && prosodyctl register other remote.test "$TEST_REMOTE_PASSWORD" && exec /entrypoint.sh prosody');
  await delay(1500);
  const remotePort = Number(JSON.parse(await docker("inspect", remoteName))[0].NetworkSettings.Ports["5222/tcp"][0].HostPort);
  const remoteIp = Object.values(JSON.parse(await docker("inspect", remoteName))[0].NetworkSettings.Networks)[0].IPAddress;
  writeFileSync(join(temporary, "local.cfg.lua"), `unbound = { resolvconf = true; hoststxt = true; options = { ["domain-insecure"] = "test"; ["local-data"] = "remote.test. IN A ${remoteIp}" } }\n` + readFileSync(resolve("prosody/prosody.cfg.lua"), "utf8"));
  await docker("exec", name, "sh", "-c", 'kill -HUP "$(cat /var/run/prosody/prosody.pid)"');
  await delay(500);
  const peer = account({ jid: "other@remote.test", password: remotePassword }, "ordinary-client", "remote.test", remotePort);
  await peer.native.start(); await peer.native.send(xml("presence"));
  await desktop.native.send(xml("message", { type: "chat", to: "other@remote.test", id: "fed-denied" }, xml("body", {}, "Federation starts disabled")));
  await until(() => desktop.received.find(s => s.attrs.id === "fed-denied" && s.attrs.type === "error"), "default federation rejection");
  app.locals.federation.setEnabled(alice, true);
  app.locals.federation.setPermissions(alice, alice.id, { federation_send: true, federation_receive: true, federation_subscribe: false, federation_post: false });
  await desktop.native.send(xml("message", { type: "chat", to: "other@remote.test", id: "fed-native" }, xml("body", {}, "Hello to ordinary Prosody")));
  await until(() => {
    const rejected = desktop.received.find(s => s.attrs.type === "error" && s.getChildText("body") === "Hello to ordinary Prosody");
    if (rejected) throw new Error(`s2s rejected: ${rejected.getChild("error")?.getChildText("text")}`);
    return peer.received.find(s => s.getChildText("body") === "Hello to ordinary Prosody");
  }, "outgoing s2s delivery", 15000);
  await peer.native.send(xml("message", { type: "chat", to: a.jid, id: "fed-reply" }, xml("body", {}, "Reply from ordinary Prosody")));
  await until(() => desktop.received.find(s => s.getChildText("body") === "Reply from ordinary Prosody"), "incoming s2s delivery", 15000);
  assert.equal(store.directHistory(alice, "xmpp:other@remote.test").messages.at(-1).body, "Reply from ordinary Prosody");
  console.log("PASS certificate-authenticated TLS federation with an ordinary Prosody peer");
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
} catch (error) {
  try { console.error((await docker("logs", name)).split("\n").filter(line => /^s2s|remote\.test|\serror\s|Client disconnected|stream:error/.test(line)).join("\n")); } catch { /* Container may already be gone. */ }
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
