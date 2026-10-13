import { createServer } from "node:http";
import { existsSync, readFileSync, writeFileSync, createWriteStream, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { loadConfig } from "../src/config.js";
import { Store } from "../src/store.js";
import { createApp } from "../src/app.js";

interface Options { instance: number; members: number; native: number; rooms: number; history: number;
  database: string; domains: string[]; secret: string; port?: number; origin?: string; readyPath?: string; telemetryPath?: string; bridgesStartPath?: string }
async function serve(o: Options) {
  try {
    if (existsSync(o.database)) throw new Error("The fixture database must be new.");
    const server = createServer();
    // Docker reaches the host adapter, as in the real XMPP integration test.
    await new Promise<void>(done => server.listen(o.port || 0, "0.0.0.0", done));
    const port = (server.address() as { port: number }).port, origin = o.origin || `http://127.0.0.1:${port}`;
    const issuer = "https://benchmark.invalid";
    const config = loadConfig({ BASE_URL: origin, OIDC_ISSUER: issuer, OIDC_CLIENT_ID: "benchmark",
      ADMIN_SUBJECTS: "load-0", XMPP_DOMAIN: o.domains[o.instance], XMPP_BRIDGE_SECRET: o.secret });
    const store = new Store(o.database, origin);
    store.initializeRegistration("open");
    const members: ReturnType<Store["loginIdentity"]>[] = [];
    const sessions: ReturnType<Store["createSession"]>[] = [];
    store.transaction(() => {
      for (let i = 0; i < o.members; i++) {
        members.push(store.loginIdentity(issuer, `load-${i}`, `load-${i}`, [], i === 0));
        sessions.push(store.createSession(members[i].id));
      }
    });
    const app = createApp(config, store), xmpp = app.locals.xmpp;
    let projectionCursor = 0;
    const sync = xmpp.sync.bind(xmpp);
    xmpp.sync = (input: Parameters<typeof sync>[0]) => {
      const result = sync(input); projectionCursor = result.after; return result;
    };
    const adapter: Record<string, { requests: number; errors: number; maxMs: number; statuses: Record<string, number> }> = {};
    server.on("request", (req, res) => {
      const path = req.url?.split("?")[0] || "";
      if (path.startsWith("/internal/xmpp/")) {
        const started = performance.now();
        res.on("finish", () => {
          const metric = adapter[path] ??= { requests: 0, errors: 0, maxMs: 0, statuses: {} };
          metric.requests++; metric.errors += Number(res.statusCode >= 400);
          metric.maxMs = Math.max(metric.maxMs, performance.now() - started);
          metric.statuses[res.statusCode] = (metric.statuses[res.statusCode] || 0) + 1;
        });
      }
      app(req, res);
    });
    const admin = store.user(members[0].id), role = store.roles(admin).find(r => r.is_default)!;
    store.updateRole(admin, role.id, { federation_send: true, federation_receive: true, federation_subscribe: true, federation_post: true });
    app.locals.federation.setEnabled(admin, true);
    const channels: ReturnType<Store["createChannel"]>[] = [];
    const roomName = (r: number) => `shared-${String(r).padStart(3, "0")}`;
    // This is pre-existing archive history, not a burst of newly committed live messages.
    const projection = store.xmppHooks;
    store.xmppHooks = undefined;
    store.transaction(() => {
      for (let r = 0; r < o.rooms; r++) {
        const owner = members[r];
        channels.push(store.createChannel(owner, { name: roomName(r), mode: "timeline", visibility: "members", admission: "open" }));
        if (r % o.domains.length === o.instance) {
          store.db.prepare("UPDATE channels SET federation_enabled=1 WHERE id=?").run(channels[r].id);
          for (let n = 0; n < o.history; n++) store.post(owner, channels[r].id, { body: `Shared seed ${n}` });
        }
      }
      for (let i = 0; i < o.members; i++) {
        const room = i % o.rooms;
        if (i < o.members - o.native || room % o.domains.length === o.instance) store.join(members[i], channels[room].id);
      }
    });
    store.xmppHooks = projection;
    let bridgesStarted = false;
    const startBridges = () => {
      if (bridgesStarted || (o.bridgesStartPath && !existsSync(o.bridgesStartPath))) return;
      bridgesStarted = true;
      for (let r = 0; r < o.rooms; r++) if (r % o.domains.length !== o.instance)
        xmpp.remoteRooms.setBridge(members[r], channels[r].id, `${roomName(r)}@channels.${o.domains[r % o.domains.length]}`);
    };
    startBridges();
    const bridgeTimer = setInterval(startBridges, 500);
    const users = members.map((member, index) => ({ index, instance: o.instance, id: member.id,
      ...sessions[index], room: index % o.rooms, channel: channels[index % o.rooms].id,
      roomJid: `${roomName(index % o.rooms)}@channels.${o.domains[index % o.rooms % o.domains.length]}`,
      ...(index >= o.members - o.native ? { credential: xmpp.issue(member, "Benchmark native client") } : {}) }));
    const delay = monitorEventLoopDelay({ resolution: 20 }); delay.enable();
    const telemetry = o.telemetryPath ? createWriteStream(o.telemetryPath) : undefined;
    let cpu = process.cpuUsage(), wall = performance.now();
    const timer = setInterval(() => {
      const now = performance.now(), used = process.cpuUsage(cpu); cpu = process.cpuUsage();
      const queued = store.db.prepare("SELECT COUNT(*) AS n FROM xmpp_remote_messages WHERE status='queued'").get()!.n;
      const rooms = store.db.prepare("SELECT COUNT(*) AS total,SUM(CASE WHEN state='joined' THEN 1 ELSE 0 END) AS joined FROM xmpp_remote_rooms WHERE desired=1").get()!;
      const roomStates = store.db.prepare("SELECT state,COUNT(*) AS count FROM xmpp_remote_rooms WHERE desired=1 GROUP BY state").all();
      const sample = { type: "telemetry", time: Date.now(), instance: o.instance,
        rssMB: process.memoryUsage().rss / 1048576, cpuPercent: (used.user + used.system) / ((now - wall) * 10),
        eventLoopP95Ms: delay.percentile(95) / 1e6, streams: app.locals.events.listeners,
        virtualRooms: rooms.total, joinedVirtualRooms: rooms.joined || 0, queuedBridgePosts: queued,
        projectionIssued: store.db.sequence("xmpp_events"), projectionCursor,
        projectionBacklog: store.db.sequence("xmpp_events") - projectionCursor, roomStates, adapter };
      if (telemetry) telemetry.write(`${JSON.stringify(sample)}\n`);
      else process.send?.(sample);
      wall = now; delay.reset();
    }, 1000);
    let stopping = false;
    const stop = () => {
      if (stopping) return; stopping = true; clearInterval(timer); clearInterval(bridgeTimer); delay.disable();
      telemetry?.end();
      app.locals.events.close(); server.closeAllConnections(); server.close(() => {
        store.close();
        // Docker Desktop cannot export this container's nested read-only bind mounts.
        if (o.readyPath) copyFileSync(o.database, join(dirname(o.readyPath), `instance-${o.instance}.sqlite`));
        process.exit(0);
      });
    };
    process.on("message", message => { if ((message as { type?: string }).type === "stop") stop(); });
    process.on("disconnect", stop);
    process.once("SIGTERM", stop); process.once("SIGINT", stop);
    const ready = { type: "ready", instance: o.instance, origin, port, users, secret: o.secret, node: process.version };
    if (o.readyPath) writeFileSync(o.readyPath, JSON.stringify(ready), { mode: 0o600 });
    else process.send?.(ready);
  } catch (error) { console.error(error); process.exit(1); }
}
if (process.argv[2]) void serve(JSON.parse(readFileSync(process.argv[2], "utf8")) as Options);
else process.once("message", (o: Options) => { void serve(o); });
