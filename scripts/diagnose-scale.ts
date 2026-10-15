// Targeted route/policy probes, not native-client or distributed load simulation.
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "../src/config.js";
import { Store, randomToken } from "../src/store.js";
import { createApp } from "../src/app.js";
import type { Statement } from "../src/db.js";

const output = resolve("test-results", "scale-diagnostics", new Date().toISOString().replace(/[:.]/g, "-"));
mkdirSync(output, { recursive: true });
const results: Record<string, unknown>[] = [];
for (let instance = 0; instance < 5; instance++) {
  const server = createServer();
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const issuer = "https://benchmark.invalid", domain = `load-${instance}.bench.test`, secret = randomToken();
  const config = loadConfig({ BASE_URL: origin, OIDC_ISSUER: issuer, OIDC_CLIENT_ID: "benchmark",
    XMPP_DOMAIN: domain, XMPP_BRIDGE_SECRET: secret });
  const store = new Store(resolve(output, `instance-${instance}.sqlite`), origin);
  try {
    store.initializeRegistration("open");
    const users: ReturnType<Store["loginIdentity"]>[] = [];
    const sessions: ReturnType<Store["createSession"]>[] = [];
    const channels: ReturnType<Store["createChannel"]>[] = [];
    store.transaction(() => {
      for (let i = 0; i < 2000; i++) {
        users.push(store.loginIdentity(issuer, `load-${i}`, `load-${i}`, []));
        sessions.push(store.createSession(users[i].id));
      }
      for (let i = 0; i < 20; i++) channels.push(store.createChannel(users[i], {
        name: `load-${i}`, mode: "timeline", visibility: "members", admission: "open",
      }));
      users.forEach((user, i) => store.join(user, channels[i % 20].id));
      for (let c = 0; c < 20; c++) for (let n = 0; n < 100; n++)
        store.post(users[c], channels[c].id, { body: `Seed message ${n}: ${"text ".repeat(30)}` });
    });
    const app = createApp(config, store), xmpp = app.locals.xmpp;
    server.on("request", app);
    const credentials = users.slice(1500).map(user => xmpp.issue(user, "diagnostic native client"));
    const inventory = {
      after: store.db.sequence("xmpp_events"),
      sessions: credentials.map((credential: { jid: string; id: string }) => ({ jid: `${credential.jid}/benchmark`, credential: credential.id })),
      occupants: credentials.map((credential: { jid: string }, i: number) => ({ jid: `${credential.jid}/benchmark`, room: `load-${i % 20}@channels.${domain}` })),
    };
    let operations = 0;
    const original = store.db.prepare.bind(store.db);
    store.db.prepare = (sql, options) => {
      const statement = original(sql, options);
      return Object.fromEntries(["get", "all", "run", "iterate"].map(method => [method,
        (...args: Parameters<Statement["get"]>) => {
          operations++;
          return (statement[method as keyof Statement] as (...values: Parameters<Statement["get"]>) => unknown)(...args);
        },
      ])) as unknown as Statement;
    };
    const probe = async (path: string, body?: unknown, adapter = false) => {
      operations = 0; const started = performance.now();
      const response = await fetch(`${origin}${path}`, { method: body ? "POST" : "GET", headers: {
        ...(adapter ? { Authorization: `Bearer ${secret}` } : { Cookie: `archipel=${sessions[0].token}`, Origin: origin, "X-CSRF-Token": sessions[0].csrf }),
        ...(body ? { "Content-Type": "application/json" } : {}),
      }, ...(body ? { body: JSON.stringify(body) } : {}) });
      const bytes = await response.arrayBuffer();
      return { status: response.status, milliseconds: performance.now() - started, preparedStatementOperations: operations,
        requestBytes: body ? Buffer.byteLength(JSON.stringify(body)) : 0, responseBytes: bytes.byteLength };
    };
    const small = { ...inventory, sessions: inventory.sessions.slice(0, 100), occupants: inventory.occupants.slice(0, 100) };
    const routes: Record<string, unknown> = {};
    for (const path of ["/api/session", "/api/channels", "/api/overview", `/api/channels/${channels[0].id}`, `/api/channels/${channels[0].id}/messages`]) {
      const runs = [];
      for (let i = 0; i < 5; i++) runs.push(await probe(path));
      routes[path.replace(channels[0].id, ":id")] = runs;
    }
    const smallSync = await probe("/internal/xmpp/sync", small, true);
    const fullSync = await probe("/internal/xmpp/sync", inventory, true);
    // Direct calls deliberately bypass HTTP to inspect the work hidden behind the body limit.
    operations = 0; let begin = performance.now();
    const idle = xmpp.sync(inventory);
    const idleSync = { milliseconds: performance.now() - begin, preparedStatementOperations: operations,
      messages: idle.messages.length, disconnect: idle.disconnect.length, kick: idle.kick.length };
    store.transaction(() => {
      for (let n = 0; n < 33; n++) store.post(users[n % 20], channels[n % 20].id, { body: `Diagnostic event ${n}` });
    });
    operations = 0; begin = performance.now();
    const busy = xmpp.sync(inventory);
    const busySync = { milliseconds: performance.now() - begin, preparedStatementOperations: operations,
      events: 33, deliveries: busy.messages.length, responseBytes: Buffer.byteLength(JSON.stringify(busy)),
      disconnect: busy.disconnect.length, kick: busy.kick.length };
    const queryPlans = {
      membershipsByUser: original("EXPLAIN QUERY PLAN SELECT channel_id FROM memberships WHERE user_id=?").all(users[0].id),
      joinedChannels: original("EXPLAIN QUERY PLAN SELECT c.* FROM channels c JOIN memberships m ON m.channel_id=c.id WHERE m.user_id=? ORDER BY c.name").all(users[0].id),
    };
    const from = busy.after;
    store.transaction(() => {
      for (let n = 0; n < 167; n++) store.post(users[0], channels[0].id, { body: `Backlog event ${n}` });
    });
    operations = 0; begin = performance.now();
    const burst = xmpp.sync({ ...inventory, after: from });
    const backlogSync = { milliseconds: performance.now() - begin, preparedStatementOperations: operations,
      offeredEvents: 167, cursorAdvanced: burst.after - from, eventsRemaining: store.db.sequence("xmpp_events") - burst.after,
      deliveries: burst.messages.length };
    // Queue-only probe: no outbound network traffic or fabricated delivery success.
    original("UPDATE instance_settings SET value='true' WHERE key='federation_enabled'").run();
    original("UPDATE channels SET federation_enabled=1 WHERE id=?").run(channels[0].id);
    original("UPDATE users SET federation_send=1,federation_post=1 WHERE id=?").run(users[0].id);
    let federationFanout: Record<string, unknown> = {};
    store.transaction(() => {
      for (let n = 0; n < 1000; n++) original("INSERT INTO federation_follows(channel_id,actor,follow_id,status) VALUES(?,?,?,'accepted')")
        .run(channels[0].id, `https://peer.example/actors/users/${randomUUID()}`, `diagnostic-follow-${n}`);
      store.post(store.user(users[0].id), channels[0].id, { body: "Federation fan-out diagnostic only" });
      const outgoing = original("SELECT id,activity FROM federation_outgoing WHERE channel_id=? ORDER BY created_at DESC LIMIT 1").get(channels[0].id)!;
      const deliveries = original("SELECT recipient FROM federation_deliveries WHERE activity_id=?").all(outgoing.id);
      federationFanout = { remoteFollowers: 1000, peerHosts: new Set(deliveries.map(row => new URL(row.recipient as string).host)).size,
        queuedDeliveriesForOnePost: deliveries.length, activityBytes: Buffer.byteLength(outgoing.activity as string),
        inboxBodyLimitBytes: 65536, networkDeliveryAttempted: false };
    });
    const item = { instance, users: 2000, nativeCredentials: 500, rooms: 20, membersPerRoom: 100,
      smallSync, fullSync, idleSync, busySync, backlogSync, federationFanout, queryPlans, routes };
    results.push(item);
    console.log(JSON.stringify({ instance, fullSync, idleSync, busySync, backlogSync }));
  } finally {
    server.closeAllConnections();
    await new Promise<void>(done => server.close(() => done()));
    store.close();
  }
}
writeFileSync(resolve(output, "probes.json"), JSON.stringify({ date: new Date().toISOString(),
  kind: "Five independent fixtures, sequential targeted probes; no real Prosody/client/federation load", results }, null, 2));
console.log(`Saved ${resolve(output, "probes.json")}`);
