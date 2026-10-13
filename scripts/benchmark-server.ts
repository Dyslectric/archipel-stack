// Dedicated loopback fixture: never imports .env or opens the instance's data directory.
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { loadConfig } from "../src/config.js";
import { Store } from "../src/store.js";
import { createApp } from "../src/app.js";

interface Options { users: number; channels: number; history: number; visibility: string; database: string }
process.once("message", async (options: Options) => {
  try {
    if (existsSync(options.database)) throw new Error("Benchmark database must be a new file.");
    const server = createServer();
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const issuer = "https://benchmark.invalid";
    const config = loadConfig({ BASE_URL: origin, OIDC_ISSUER: issuer, OIDC_CLIENT_ID: "benchmark", NODE_ENV: "production" });
    const store = new Store(options.database, origin);
    store.initializeRegistration("open");
    const members: ReturnType<Store["loginIdentity"]>[] = [];
    const users: { index: number; id: string; token: string; csrf: string; channel: string }[] = [];
    console.log(`Seeding ${options.users} users in an isolated SQLite database.`);
    store.transaction(() => {
      for (let i = 0; i < options.users; i++) {
        const member = store.loginIdentity(issuer, `load-${i}`, `load-${i}`, []);
        members.push(member);
        users.push({ index: i, id: member.id, ...store.createSession(member.id), channel: "" });
      }
      const channels = Array.from({ length: options.channels }, (_, i) => store.createChannel(members[i], {
        name: `load-${i}`, mode: "timeline", visibility: options.visibility, admission: "open",
      }));
      for (let i = 0; i < users.length; i++) {
        users[i].channel = channels[i % channels.length].id;
        store.join(members[i], users[i].channel);
      }
      for (let i = 0; i < channels.length; i++)
        for (let n = 0; n < options.history; n++)
          store.post(members[i], channels[i].id, { body: `Seed history ${n}: ${"text ".repeat(30)}` });
    });
    const app = createApp(config, store);
    server.on("request", app);
    const delay = monitorEventLoopDelay({ resolution: 20 }); delay.enable();
    let cpu = process.cpuUsage(), wall = performance.now();
    const stats = setInterval(() => {
      const now = performance.now(), used = process.cpuUsage(cpu);
      cpu = process.cpuUsage();
      process.send?.({ type: "telemetry", time: Date.now(), rssMB: process.memoryUsage().rss / 1048576,
        cpuPercent: (used.user + used.system) / ((now - wall) * 10),
        eventLoopP95Ms: delay.percentile(95) / 1e6, eventLoopMaxMs: delay.max / 1e6,
        connections: app.locals.events.listeners });
      wall = now; delay.reset();
    }, 1000);
    const stop = () => {
      clearInterval(stats); delay.disable(); app.locals.events.close(); server.closeAllConnections();
      server.close(() => { store.close(); process.exit(0); });
    };
    process.on("message", message => { if ((message as { type?: string }).type === "stop") stop(); });
    process.on("disconnect", stop);
    process.send?.({ type: "ready", origin, users, rateLimitApi: config.rateLimitApi });
  } catch (error) {
    console.error(error); process.exit(1);
  }
});
