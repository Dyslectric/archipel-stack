import { createServer } from "node:http";
import { readFileSync, writeFileSync, appendFileSync, existsSync, copyFileSync, createWriteStream } from "node:fs";
import { dirname, join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import { loadConfig } from "../src/config.js";
import { Store } from "../src/store.js";
import { createApp } from "../src/app.js";
import { PostgresDatabase } from "../src/db.js";

interface Options { instance: number; instances: number; members: number; rooms: number; roomHost?: number; history: number; profile?: number;
  port: number; database: string; output: string; peerRate: number; inboxRate: number; batch: number; interval: number; concurrency: number;
  channelTransport?: string; postgresUrl?: string; schema?: string; nativeUrl?: string; nativeSecret?: string; nativeHistory?: number }

async function serve(o: Options) {
  const roomHost = (room: number) => o.roomHost ?? room % o.instances;
  if (existsSync(o.database)) throw new Error("Use a fresh fixture database.");
  const origin = `http://127.0.0.1:${o.port}`, issuer = "urn:archipel:development";
  const env = { DEV_AUTH: "true", BASE_URL: origin, HOST: "127.0.0.1", PORT: String(o.port),
    FEDERATION_CHANNEL_TRANSPORT: o.channelTransport || "stream",
    ADMIN_SUBJECTS: "load-0", REGISTRATION_MODE: "open", FEDERATION_SEND_CONCURRENCY: String(o.concurrency),
    ...(o.postgresUrl ? {DATABASE_URL:o.postgresUrl} : {}) };
  const store = new Store(o.postgresUrl ? new PostgresDatabase(o.postgresUrl,o.schema) : o.database, origin);
  store.initializeRegistration("open");
  const members: ReturnType<Store["loginIdentity"]>[] = [], sessions: ReturnType<Store["createSession"]>[] = [];
  store.transaction(() => {
    for (let i = 0; i < o.members; i++) {
      members.push(store.loginIdentity(issuer, i === 0 ? "alice" : `load-${i}`, `load-${i}`, [], i === 0));
      sessions.push(store.createSession(members[i].id));
    }
  });
  let app = createApp(loadConfig({ ...env, FEDERATION_SEND_RATE: "1000", FEDERATION_SEND_INTERVAL: "100",
    FEDERATION_PEER_SEND_RATE: "0", RATE_LIMIT_FEDERATION: "100000",
    ...(o.nativeUrl ? { NATIVE_CHAT_URL: o.nativeUrl, NATIVE_BRIDGE_SECRET: o.nativeSecret! } : {}) }), store);
  let fed = app.locals.federation;
  const admin = store.user(members[0].id), role = store.roles(admin).find(r => r.is_default)!;
  store.updateRole(admin, role.id, { federation_send: true, federation_receive: true,
    federation_subscribe: true, federation_post: true, federate_channels: true });
  fed.setEnabled(admin, true);
  fed.keys();
  const channels = new Map<number, string>(), actors: Record<number, string> = {};
  store.transaction(() => {
    for (let r = 0; r < o.rooms; r++) if (roomHost(r) === o.instance) {
      const c = store.createChannel(store.user(members[r].id), { name: `shared-${String(r).padStart(3, "0")}`,
        mode: "timeline", visibility: "members", admission: "open" });
      fed.setChannel(admin, c.id, true);
      channels.set(r, c.id); actors[r] = fed.channelActor(c);
      if(!o.nativeHistory) for (let n = 0; n < o.history; n++) store.post(store.user(members[r].id), c.id, { body: `Shared seed ${n}` });
    }
    for (let i = 0; i < o.members; i++) if (roomHost(i % o.rooms) === o.instance)
      store.join(store.user(members[i].id), channels.get(i % o.rooms)!);
  });
  const wire: Record<string, { requests: number; errors: number; maxMs: number; statuses: Record<string, number> }> = {};
  const server = createServer((req, res) => {
    const path = req.url?.split("?")[0] || "";
    if (path.startsWith("/federation") || path.startsWith("/actors")) {
      const key = path.startsWith("/actors") ? "/actors/*" : path, begin = performance.now();
      res.on("finish", () => {
        const m = wire[key] ??= { requests: 0, errors: 0, maxMs: 0, statuses: {} };
        m.requests++; m.errors += Number(res.statusCode >= 400); m.maxMs = Math.max(m.maxMs, performance.now() - begin);
        m.statuses[res.statusCode] = (m.statuses[res.statusCode] || 0) + 1;
      });
    }
    app(req, res);
  });
  await new Promise<void>(done => server.listen(o.port, "127.0.0.1", done));
  let timer: NodeJS.Timeout, ticking: Promise<void> | undefined, paused = false, stopping = false;
  const schedule = () => {
    if (paused || stopping) return;
    timer = setTimeout(() => {
      if (o.nativeUrl && !existsSync(join(o.output, "setup.json"))) { schedule(); return; }
      const job: Promise<void> = fed.tick({wait:false}).catch((e: unknown) => console.error(e));
      ticking = job;
      void job.finally(() => { ticking = undefined; schedule(); });
    }, fed.sending().interval);
  };
  fed.paceChanged = () => { clearTimeout(timer); schedule(); };
  schedule();
  let nativeSample: Promise<void> | undefined;
  const stageTimer = setInterval(() => {
    if (!fed.config.nativeChatUrl || nativeSample || stopping || paused || !existsSync(join(o.output, "setup.json"))) return;
    nativeSample = (async () => {
      const response = await fetch(`${fed.config.nativeChatUrl}/health`, {
        headers:{Authorization:`Bearer ${fed.config.nativeBridgeSecret}`},signal:AbortSignal.timeout(10000),
      });
      if(!response.ok) throw new Error(`Native stage snapshot failed: ${response.status}`);
      const value = await response.json();
      appendFileSync(join(o.output, `native-stages-${o.instance}.ndjson`), JSON.stringify({time:Date.now(),phase,...value})+"\n");
      writeFileSync(join(o.output, `native-stages-${o.instance}.json`), JSON.stringify({time:Date.now(),phase,...value}));
    })().catch(e=>console.error(e)).finally(()=>{nativeSample=undefined;});
  }, 10000);
  stageTimer.unref();
  const readyFile = join(o.output, `ready-${o.instance}.json`);
  const users = () => members.map((m, index) => ({ ...sessions[index], index, instance: o.instance,
    id: m.id, room: index % o.rooms, channel: channels.get(index % o.rooms) }));
  writeFileSync(readyFile, JSON.stringify({ type: "ready", origin, actors, node: process.version }));
  let configuring = false, configured = false, phase = "bootstrap", profiling = false;
  let historyChecked = false;
  const delay = monitorEventLoopDelay({ resolution: 20 }); delay.enable();
  const telemetry = createWriteStream(join(o.output, `server-${o.instance}.ndjson`));
  let cpu = process.cpuUsage(), wall = performance.now();
  const sampleTimer = setInterval(() => {
    const now = performance.now(), used = process.cpuUsage(cpu); cpu = process.cpuUsage();
    const deliveries = store.db.prepare("SELECT status,COUNT(*) AS count,SUM(attempts) AS attempts FROM federation_deliveries GROUP BY status").all();
    const pending = store.db.prepare("SELECT COUNT(*) AS count,MIN(o.created_at) AS oldest FROM federation_deliveries d JOIN federation_outgoing o ON o.id=d.activity_id WHERE d.status='pending'").get()!;
    const subscriptions = store.db.prepare("SELECT status,COUNT(*) AS count FROM federation_subscriptions GROUP BY status").all();
    telemetry.write(JSON.stringify({ type: "telemetry", time: Date.now(), instance: o.instance, phase,
      rssMB: process.memoryUsage().rss / 1048576, cpuPercent: (used.user + used.system) / ((now - wall) * 10),
      eventLoopP95Ms: delay.percentile(95) / 1e6, streams: app.locals.events.listeners,
      channelFeed: fed.channelFeed.stats, instanceFeed: fed.channelFeed.instance.stats, instanceCursors: store.db.prepare("SELECT * FROM federation_instance_cursors").all(), channelCursors: store.db.prepare("SELECT * FROM federation_channel_cursors").all(),
      seedCopies: Number(store.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE body LIKE 'Shared seed %'").get()!.n),
      subscriptions, deliveries, pending: pending.count, oldestPendingMs: pending.oldest ? Date.now() - Number(pending.oldest) : 0,
      wire, deliveryStats: fed.deliveryStats, nativeFederation: fed.nativeStats, nativeChat: app.locals.nativeChat.statistics }) + "\n");
    wall = now; delay.reset();
  }, 1000);
  const controlTimer = setInterval(() => {
    if (!profiling && o.profile && existsSync(join(o.output, "profile-start"))) {
      profiling = true;
      void (async () => {
        const { Session } = await import("node:inspector/promises");
        const session = new Session(); session.connect();
        try {
          await session.post("Profiler.enable"); await session.post("Profiler.start");
          await new Promise(done => setTimeout(done, o.profile! * 1000));
          const { profile } = await session.post("Profiler.stop");
          writeFileSync(join(o.output, `cpu-${o.instance}.cpuprofile`), JSON.stringify(profile));
        } finally { session.disconnect(); }
      })().catch(e => console.error(e));
    }
    if (!paused && existsSync(join(o.output, "pause-deliveries"))) {
      paused = true; clearTimeout(timer);
      void (async () => {
        await ticking;
        let drained=true;
        if(fed.config.nativeChatUrl) try { await fed.tick({drainOnly:true}); }
        catch(e) { drained=false;console.error(e); }
        writeFileSync(join(o.output, `paused-${o.instance}.json`), JSON.stringify({ time: Date.now(),drained }));
      })();
    }
    const setupFile = join(o.output, "setup.json");
    if (!configuring && existsSync(setupFile)) {
      configuring = true;
      void (async () => {
        const setup = JSON.parse(readFileSync(setupFile, "utf8")) as { actors: Record<number, string> };
        // Use the real actor discovery / signed Follow / Accept path, not fabricated admission rows.
        for (let i = 0; i < o.members; i++) if (roomHost(i % o.rooms) !== o.instance) {
          const sub = await fed.subscribe(store.user(members[i].id), setup.actors[i % o.rooms]);
          channels.set(i % o.rooms, sub.channel.id);
        }
        configured = true;
        writeFileSync(readyFile, JSON.stringify({ type: "configured", origin, actors, users: users(), node: process.version }));
      })().catch(e => { console.error(e); process.exitCode = 1; void stop(); });
    }
    if(configured && o.nativeHistory && phase==="bootstrap" && existsSync(join(o.output,"start-native-history"))) {
      phase="native-history-start";
      void(async()=>{
        paused=true;clearTimeout(timer);await ticking;
        if(fed.config.nativeChatUrl) await fed.tick({drainOnly:true});
        await fed.channelFeed.close();
        app.locals.events.close();
        app=createApp(loadConfig({...env,FEDERATION_SEND_RATE:"1000",FEDERATION_SEND_INTERVAL:"100",FEDERATION_PEER_SEND_RATE:"0",RATE_LIMIT_FEDERATION:"100000",
          NATIVE_CHAT_URL:o.nativeUrl!,NATIVE_BRIDGE_SECRET:o.nativeSecret!}),store);
        fed=app.locals.federation;phase="native-history";paused=false;schedule();
        let committed=0;
        // Keep production bounded: each fixture offers two native posts at once.
        const jobs=[...channels.entries()].filter(([room])=>roomHost(room)===o.instance).flatMap(([room,channel])=>Array.from({length:o.history},(_,index)=>({room,channel,index})));
        let next=0;
        await Promise.all(Array.from({length:2},async()=>{
          while(next<jobs.length){const job=jobs[next++],session=sessions[job.room];
            const response=await fetch(`${o.nativeUrl}/v1/chat`,{method:"POST",signal:AbortSignal.timeout(20000),headers:{Authorization:`Bearer ${o.nativeSecret}`,"Content-Type":"application/json"},
              body:JSON.stringify({op:"post",channel:job.channel,token:session.token,csrf:session.csrf,message_id:randomUUID(),body:`Shared seed ${job.index}`})});
            if(!response.ok)throw new Error(`Native history post failed: ${response.status} ${await response.text()}`);
            await response.arrayBuffer();committed++;
          }
        }));
        writeFileSync(join(o.output,`history-${o.instance}.json`),JSON.stringify({committed}));
      })().catch(e=>{console.error(e);process.exitCode=1;void stop();});
    }
    if(o.nativeHistory && phase==="native-history" && !historyChecked && existsSync(join(o.output,"check-native-history"))){
      historyChecked=true;
      const rows=store.db.prepare("SELECT channel_id,COUNT(*) AS n FROM messages WHERE body LIKE 'Shared seed %' GROUP BY channel_id").all();
      writeFileSync(join(o.output,`history-check-${o.instance}.json`),JSON.stringify({rooms:rows.length,minimum:Math.min(...rows.map(row=>Number(row.n))),maximum:Math.max(...rows.map(row=>Number(row.n)))}));
    }
    if (configured && ["bootstrap","native-history"].includes(phase) && existsSync(join(o.output, "start-measured-settings"))) {
      phase = "resetting";
      void (async () => {
        paused = true; clearTimeout(timer); await ticking;
        if(fed.config.nativeChatUrl) await fed.tick({drainOnly:true});
        app.locals.events.close();
        app = createApp(loadConfig({ ...env, FEDERATION_SEND_RATE: String(o.batch), FEDERATION_SEND_INTERVAL: String(o.interval),
          FEDERATION_PEER_SEND_RATE: String(o.peerRate), RATE_LIMIT_FEDERATION: String(o.inboxRate),
          ...(o.nativeUrl ? {NATIVE_CHAT_URL:o.nativeUrl,NATIVE_BRIDGE_SECRET:o.nativeSecret!} : {}) }), store);
        fed = app.locals.federation; phase = "chat"; paused = false; schedule();
        writeFileSync(join(o.output, `settings-${o.instance}.json`), JSON.stringify({ sending: fed.sending(),
          peerRate: o.peerRate, inboxRate: o.inboxRate, concurrency: o.concurrency, signedTransport: true, loopbackDevelopmentTransport: true }));
      })().catch(e => { console.error(e); process.exitCode = 1; void stop(); });
    }
  }, 250);
  async function stop() {
    if (stopping) return; stopping = true; clearInterval(stageTimer); paused = true; clearTimeout(timer);
    clearInterval(controlTimer); clearInterval(sampleTimer); delay.disable(); await ticking;
    if(fed.config.nativeChatUrl) {
      try { await fed.tick({drainOnly:true}); }
      catch(e) { writeFileSync(join(o.output,`drain-error-${o.instance}.txt`),String(e)); }
    }
    await fed.channelFeed.close();
    await nativeSample;
    app.locals.events.close(); server.closeAllConnections();
    await new Promise<void>(done => server.close(() => done()));
    writeFileSync(join(o.output, `final-${o.instance}.json`), JSON.stringify({ wire, deliveryStats: fed.deliveryStats,
      nativeFederation: fed.nativeStats, channelFeed: fed.channelFeed.stats, instanceFeed: fed.channelFeed.instance.stats, instanceCursors: store.db.prepare("SELECT * FROM federation_instance_cursors").all(),
      channelCursors: store.db.prepare("SELECT * FROM federation_channel_cursors").all(),
      channelLogs: store.db.prepare("SELECT * FROM federation_channel_state").all(),
      nativeChat: app.locals.nativeChat.statistics,
      distinctIncomingActivities: store.db.prepare("SELECT COUNT(*) AS count FROM federation_incoming").get()!.count }));
    if(o.postgresUrl) writeFileSync(join(o.output,`snapshot-${o.instance}.json`),JSON.stringify({
      channelCursors:store.db.prepare("SELECT * FROM federation_channel_cursors").all(),
      channelLogs:store.db.prepare("SELECT * FROM federation_channel_state").all(),
      activitySizes:store.db.prepare("SELECT purpose,COUNT(*) AS activities,MIN(octet_length(activity)) AS minimum_bytes,MAX(octet_length(activity)) AS maximum_bytes FROM federation_outgoing GROUP BY purpose").all(),
      messages:store.db.prepare("SELECT body,channel_id FROM messages WHERE body LIKE 'BENCH|%'").all(),
      queues:store.db.prepare("SELECT d.status,o.purpose,COUNT(*) AS count,SUM(d.attempts) AS attempts FROM federation_deliveries d JOIN federation_outgoing o ON o.id=d.activity_id GROUP BY d.status,o.purpose").all(),
      errors:store.db.prepare("SELECT error,COUNT(*) AS count FROM federation_deliveries WHERE error IS NOT NULL GROUP BY error").all(),
      statuses:store.db.prepare("SELECT status,COUNT(*) AS count,SUM(attempts) AS attempts FROM federation_deliveries GROUP BY status").all(),
      relay:store.db.prepare("SELECT d.activity_id,d.recipient,d.status FROM federation_deliveries d JOIN federation_outgoing o ON o.id=d.activity_id WHERE o.purpose='relay'").all(),
    }));
    telemetry.end(); store.close(); if(!o.postgresUrl) copyFileSync(o.database, join(dirname(readyFile), `instance-${o.instance}.sqlite`));
    process.exit(process.exitCode || 0);
  }
  process.once("SIGTERM", () => void stop()); process.once("SIGINT", () => void stop());
}
void serve(JSON.parse(readFileSync(process.argv[2], "utf8"))).catch(e => { console.error(e); process.exit(1); });
