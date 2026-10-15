// One durable channel log, consumed once per peer. Transport is deliberately
// separate from individual follower admission and the existing activity codec.
import type { Request, Response } from "express";
import type { Federation } from "./federation.js";
import { Problem } from "./store.js";
import { peerJson, peerRequest, signedHeaders } from "./federation-net.js";
import { StringDecoder } from "node:string_decoder";
import { InstanceFeed } from "./instance-feed.js";

export type Checkpoint = { channel: string; follow: string; after: number; cursor: number };
export type ChannelPage = { type: "ChannelEvents"; channel: string; follow: string; after: number; cursor: number;
  events: { seq: number; activity: string | null }[] };
const MAX_BYTES = 262144, PAGE_BYTES = 240000, PAGE_COUNT = 32;
const RETENTION_MS = 7 * 86400000, RETENTION_COUNT = 100000;

export class ChannelFeed {
  private consumers = new Map<string, { controller: AbortController; job: Promise<void>; follow: string }>();
  private responses = new Set<Response>();
  private leases = new Map<Response, { id: string; actor: string; origin: string }>();
  private leaseSnapshot = new Map<string, { tail: number; allowed: boolean }>();
  private leaseSnapshotAt = 0;
  private closed = false;
  private prunedAt = 0;
  private startedAt = new Map<string, number>();
  private syncedAt = 0;
  readonly stats = { connections: 0, batches: 0, events: 0, skipped: 0, retries: 0, gaps: 0 };
  readonly instance: InstanceFeed;
  private routingStamp = "";
  private routingRows: Record<string, any>[] = [];
  constructor(private fed: Federation) { this.instance = new InstanceFeed(fed, this.stats); }

  private leaseState(id: string, actor: string) {
    if (Date.now() - this.leaseSnapshotAt >= 250) {
      this.leaseSnapshotAt = Date.now(); this.leaseSnapshot.clear();
      const candidates = [...this.leases.values()];
      for (let offset = 0; offset < candidates.length; offset += 64) {
        const chunk = candidates.slice(offset, offset + 64);
        const rows = this.fed.store.db.prepare(`WITH candidates(channel_id,actor,origin) AS (VALUES ${chunk.map(() => "(?,?,?)").join(",")})
          SELECT c.channel_id,c.actor,COALESCE(p.tail,0) AS tail,
            CASE WHEN ch.federation_enabled=1 AND ch.remote_actor IS NULL AND f.status='accepted' AND f.stream_capable=1 AND f.stream_start IS NOT NULL
              AND u.banned=0 AND u.admission_status='approved'
              AND EXISTS(SELECT 1 FROM instance_settings WHERE key='federation_enabled' AND value='true')
              AND NOT EXISTS(SELECT 1 FROM federation_blocks b WHERE b.target=c.actor OR b.target=c.origin)
              AND NOT EXISTS(SELECT 1 FROM channel_rules r WHERE r.channel_id=c.channel_id AND r.user_id=u.id AND r.rule='block')
              THEN 1 ELSE 0 END AS allowed
          FROM candidates c LEFT JOIN channels ch ON ch.id=c.channel_id
          LEFT JOIN federation_follows f ON f.channel_id=c.channel_id AND f.actor=c.actor
          LEFT JOIN users u ON u.remote_actor=c.actor LEFT JOIN federation_channel_state p ON p.channel_id=c.channel_id`)
          .all(...chunk.flatMap(c => [c.id, c.actor, c.origin]));
        for (const row of rows) this.leaseSnapshot.set(`${row.channel_id}|${row.actor}`, { tail: Number(row.tail), allowed: !!row.allowed });
      }
    }
    return this.leaseSnapshot.get(`${id}|${actor}`);
  }

  tail(id: string) { return Number(this.fed.store.db.prepare("SELECT tail FROM federation_channel_state WHERE channel_id=?").get(id)?.tail || 0); }

  page(actor: Record<string, any>, id: string, after: number): ChannelPage {
    const { store } = this.fed;
    this.fed.ensureEnabled();
    const channel = store.channel(id);
    if (!channel.federation_enabled || channel.remote_actor || !this.fed.acceptedFollower(id, actor.id))
      throw new Problem(403, "Channel stream access denied.");
    const follow = store.db.prepare("SELECT follow_id,stream_start,stream_capable FROM federation_follows WHERE channel_id=? AND actor=?").get(id, actor.id)!;
    if (!follow.stream_capable || follow.stream_start == null) throw new Problem(403, "Channel stream was not negotiated.");
    if (!Number.isSafeInteger(after) || after < 0) throw new Problem(400, "Invalid channel event cursor.");
    this.prune();
    const state = store.db.prepare("SELECT tail,floor FROM federation_channel_state WHERE channel_id=?").get(id) || { tail: 0, floor: 0 };
    after = Math.max(after, Number(follow.stream_start));
    if (after < Number(state.floor)) throw new Problem(410, "Channel event cursor expired; leave and rejoin to import bounded current history.");
    if (after > Number(state.tail)) throw new Problem(400, "Channel event cursor is ahead of its home.");
    const page: ChannelPage = { type: "ChannelEvents", channel: this.fed.channelActor(channel), follow: follow.follow_id, after, cursor: after, events: [] };
    let bytes = 0;
    const rows = store.db.prepare("SELECT e.seq,o.* FROM federation_channel_events e JOIN federation_outgoing o ON o.id=e.activity_id WHERE e.channel_id=? AND e.seq>? ORDER BY e.seq LIMIT ?").all(id, after, PAGE_COUNT);
    for (const row of rows) {
      let activity: string | null = row.activity;
      try { this.fed.channelDeliveryAllowed(row as any, actor.id); } catch { activity = null; }
      const event = { seq: Number(row.seq), activity };
      const size = Buffer.byteLength(JSON.stringify(event));
      if (size > PAGE_BYTES) throw new Problem(413, "Channel event exceeds the frame limit.");
      if (bytes + size > PAGE_BYTES) break;
      page.events.push(event); page.cursor = event.seq; bytes += size;
    }
    if (page.events.length && !this.fed.channelPageAllowance(actor.id)) { page.events = []; page.cursor = page.after; }
    store.db.prepare("INSERT INTO federation_channel_peers(channel_id,origin,cursor,updated_at) VALUES(?,?,?,?) ON CONFLICT(channel_id,origin) DO UPDATE SET cursor=excluded.cursor,updated_at=excluded.updated_at", { notify: false })
      .run(id, new URL(actor.id).origin, after, Date.now());
    return page;
  }

  private prune() {
    if (Date.now() - this.prunedAt < 60000) return;
    this.prunedAt = Date.now();
    const db = this.fed.store.db;
    this.fed.store.transaction(() => {
      db.prepare("UPDATE federation_channel_state SET floor=MAX(floor,tail-?,COALESCE((SELECT MAX(seq) FROM federation_channel_events WHERE channel_id=federation_channel_state.channel_id AND created_at<?),0))", { notify: false }).run(RETENTION_COUNT, Date.now() - RETENTION_MS);
      db.prepare("DELETE FROM federation_channel_events WHERE seq<=(SELECT floor FROM federation_channel_state WHERE channel_id=federation_channel_events.channel_id)", { notify: false }).run();
      // Keep legacy audit rows and one activity per author: actor export uses
      // that durable publication evidence to serve keys for older note proofs.
      db.prepare("DELETE FROM federation_outgoing WHERE purpose IN ('relay','moderation') AND channel_id IS NOT NULL AND id NOT IN(SELECT MAX(id) FROM federation_outgoing WHERE user_id IS NOT NULL GROUP BY user_id) AND NOT EXISTS(SELECT 1 FROM federation_channel_events e WHERE e.activity_id=federation_outgoing.id) AND NOT EXISTS(SELECT 1 FROM federation_instance_events e WHERE e.activity_id=federation_outgoing.id) AND NOT EXISTS(SELECT 1 FROM federation_deliveries d WHERE d.activity_id=federation_outgoing.id)", { notify: false }).run();
    });
  }

  async open(req: Request, res: Response, actor: Record<string, any>, id: string, after: number) {
    if (this.closed) throw new Problem(503, "The server is stopping.");
    if (this.responses.size >= 128) throw new Problem(503, "Channel stream capacity is busy.");
    let page = this.page(actor, id, after);
    res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
    res.flushHeaders(); this.responses.add(res);
    this.leases.set(res, { id, actor: actor.id, origin: new URL(actor.id).origin }); this.leaseSnapshotAt = 0;
    let stopped = false;
    const stop = () => { stopped = true; this.responses.delete(res); this.leases.delete(res); };
    res.on("close", stop);
    const end = Date.now() + 30000; // Fresh signed authorization on each lease.
    try {
      while (!stopped && !this.closed && Date.now() < end) {
        if (page.events.length) {
          const writable = res.write(`id: ${page.cursor}\ndata: ${JSON.stringify(page)}\n\n`);
          if (!writable) await new Promise<void>(resolve => {
            const done = () => { res.off("drain", done); res.off("close", done); resolve(); };
            res.once("drain", done); res.once("close", done);
            // A slow peer gets disconnected and resumes durably, never an unbounded buffer.
            const timeout = setTimeout(() => { res.destroy(); done(); }, 5000); timeout.unref();
            res.once("drain", () => clearTimeout(timeout)); res.once("close", () => clearTimeout(timeout));
          });
          after = page.cursor;
        } else {
          res.write(": heartbeat\n\n");
          await new Promise<void>(resolve => { const timer = setTimeout(resolve, 250); timer.unref(); });
        }
        if (!stopped) {
          const state = this.leaseState(id, actor.id);
          if (!state?.allowed) throw new Problem(403, "Channel stream admission revoked.");
          page = state.tail > after ? this.page(actor, id, after) : { ...page, after, cursor: after, events: [] };
        }
      }
    } catch { /* A revoked lease ends immediately; reconnect exposes the rejection. */ }
    finally { stop(); res.end(); }
  }

  async sync(drainOnly = false, throttle = false) {
    if (drainOnly) { await this.close(false); return; }
    if (this.closed || this.fed.config.federationChannelTransport === "off") return;
    if (throttle && Date.now() - this.syncedAt < 250) return;
    this.syncedAt = Date.now();
    const stamp = ["federation_subscriptions","users","roles","user_roles","channels","federation_blocks","instance_settings"].map(t => this.fed.store.db.revision(t)).join("|");
    if (stamp !== this.routingStamp) {
      this.routingStamp = stamp;
      this.routingRows = this.fed.store.db.prepare("SELECT channel_id,follow_id,stream_start,instance_start,remote_actor,user_id,document FROM (SELECT s.channel_id,s.follow_id,s.stream_start,s.instance_start,c.remote_actor,u.id AS user_id,a.document,ROW_NUMBER() OVER(PARTITION BY s.channel_id ORDER BY s.stream_start,s.follow_id) AS priority FROM federation_subscriptions s JOIN users u ON u.id=s.user_id JOIN channels c ON c.id=s.channel_id LEFT JOIN federation_actors a ON a.id=c.remote_actor WHERE s.status='accepted' AND s.stream_start IS NOT NULL AND u.banned=0 AND u.admission_status='approved' AND u.federation_receive=1 AND u.federation_subscribe=1) candidates WHERE priority=1").all();
    }
    const rows = this.routingRows;
    const multiplexed = await this.instance.sync(this.fed.enabled() ? rows : []);
    const wanted = new Map<string, typeof rows[number]>();
    if (this.fed.enabled()) for (const row of rows) {
      try { this.fed.channelPeerUrl(row.remote_actor); } catch { continue; }
      if (!multiplexed.has(row.channel_id) && !wanted.has(row.channel_id)) wanted.set(row.channel_id, row);
    }
    for (const [id, consumer] of this.consumers) if (!wanted.has(id) || wanted.get(id)!.follow_id !== consumer.follow) consumer.controller.abort();
    for (const id of this.startedAt.keys()) if (!wanted.has(id)) this.startedAt.delete(id);
    const candidates = [...wanted].sort(([a], [b]) => (this.startedAt.get(a) || 0) - (this.startedAt.get(b) || 0));
    for (const [id, row] of candidates) {
      if (this.consumers.size >= 128) break;
      if (this.consumers.has(id)) continue;
      const saved = this.fed.store.db.prepare("SELECT retry_at FROM federation_channel_cursors WHERE channel_id=?").get(id);
      if (Number(saved?.retry_at || 0) > Date.now()) continue;
      this.fed.store.db.prepare("INSERT OR IGNORE INTO federation_channel_cursors(channel_id,cursor) VALUES(?,?)", { notify: false }).run(id, Number(row.stream_start));
      const controller = new AbortController();
      this.startedAt.set(id, Date.now());
      const job = this.consume(row, controller.signal).catch(error => {
        if (controller.signal.aborted || this.closed) return;
        this.stats.retries++;
        if (error instanceof Problem && error.status === 410) this.stats.gaps++;
        this.fed.store.db.prepare("UPDATE federation_channel_cursors SET error=?,retry_at=? WHERE channel_id=?", { notify: false })
          .run(error instanceof Problem && error.status === 410 ? "Channel event cursor expired; leave and rejoin to import bounded current history." : String(error.message).slice(0, 200), Date.now() + (error instanceof Problem && error.status === 410 ? 60000 : 5000), id);
      }).finally(() => { if (this.consumers.get(id)?.controller === controller) this.consumers.delete(id); });
      this.consumers.set(id, { controller, job, follow: row.follow_id });
    }
    // Batch mode has bounded jobs; streaming leases run independently of inbox rounds.
    if (this.fed.config.federationChannelTransport === "batch") await Promise.all([...this.consumers.values()].map(c => c.job));
  }

  private async consume(row: Record<string, any>, signal: AbortSignal) {
    const actor = await this.fed.actor(row.remote_actor);
    if (actor.channelEvents?.version !== 1) throw new Problem(409, "Channel event capability withdrawn.");
    const stream = this.fed.config.federationChannelTransport === "stream" && actor.channelEvents.stream;
    const url = this.fed.channelPeerUrl(stream ? actor.channelEvents.stream : actor.channelEvents.batches);
    const expected = `${new URL(row.remote_actor).pathname}/${stream ? "stream" : "events"}`;
    if (url.origin !== new URL(row.remote_actor).origin || url.pathname !== expected || url.search)
      throw new Problem(400, "Invalid channel event endpoint.");
    const saved = this.fed.store.db.prepare("SELECT cursor,error FROM federation_channel_cursors WHERE channel_id=?").get(row.channel_id)!;
    const cursor = Number(saved.cursor);
    let recovering = !!saved.error;
    url.searchParams.set("after", String(Math.max(cursor, Number(row.stream_start))));
    const headers = signedHeaders(url, "GET", this.fed.userActor(this.fed.store.user(row.user_id)), this.fed.keys().private_key);
    const apply = async (value: unknown) => {
      if (signal.aborted) throw new Error("Channel consumer stopped.");
      const page = value as ChannelPage;
      let previous = Number(this.fed.store.db.prepare("SELECT cursor FROM federation_channel_cursors WHERE channel_id=?").get(row.channel_id)!.cursor);
      if (page?.type !== "ChannelEvents" || page.channel !== row.remote_actor || page.follow !== row.follow_id || !Array.isArray(page.events) || page.events.length > PAGE_COUNT || page.after !== Math.max(previous, Number(row.stream_start)))
        throw new Problem(400, "Invalid channel event page.");
      previous = page.after;
      for (const event of page.events) {
        if (signal.aborted || !Number.isSafeInteger(event.seq) || event.seq !== previous + 1 || (event.activity !== null && typeof event.activity !== "string"))
          throw new Problem(400, "Invalid channel event sequence.");
        const checkpoint = { channel: row.remote_actor, follow: row.follow_id, after: previous, cursor: event.seq };
        const applied = await this.fed.receiveChannelEvent(actor, event.activity, checkpoint);
        if (!applied) this.stats.skipped++;
        previous = event.seq; this.stats.events++;
      }
      if (page.cursor !== previous) throw new Problem(400, "Invalid channel event checkpoint.");
      if (recovering) {
        // A valid empty page also proves recovery; quiet channels must not keep
        // displaying an old network error until somebody posts again.
        this.fed.store.db.prepare("UPDATE federation_channel_cursors SET error=NULL,retry_at=0 WHERE channel_id=?", { notify: false }).run(row.channel_id);
        recovering = false;
      }
      this.stats.batches++;
    };
    if (!stream) { await apply(await peerJson(url, this.fed.config, headers)); return; }
    headers.accept = "text/event-stream"; this.stats.connections++;
    await peerRequest(url, this.fed.config, headers, undefined, MAX_BYTES, 40000, "GET", async response => {
      if (!/^text\/event-stream(;|$)/i.test(String(response.headers["content-type"] || ""))) throw new Problem(415, "Expected a channel event stream.");
      const decoder = new StringDecoder("utf8"); let pending = "";
      for await (const chunk of response) {
        pending = (pending + decoder.write(chunk)).replaceAll("\r\n", "\n");
        let at: number;
        while ((at = pending.indexOf("\n\n")) >= 0) {
          const frame = pending.slice(0, at); pending = pending.slice(at + 2);
          if (Buffer.byteLength(frame) > MAX_BYTES) throw new Problem(413, "Channel stream frame exceeds its limit.");
          const data = frame.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).replace(/^ /, "")).join("\n");
          if (data) await apply(JSON.parse(data));
        }
        if (Buffer.byteLength(pending) > MAX_BYTES) throw new Problem(413, "Channel stream frame exceeds its limit.");
      }
      if (pending.trim()) throw new Problem(400, "Truncated channel event frame.");
    }, signal);
  }

  async close(permanent = true) {
    if (permanent) this.closed = true;
    for (const response of this.responses) response.end();
    for (const consumer of this.consumers.values()) consumer.controller.abort();
    await Promise.all([...this.consumers.values()].map(c => c.job));
    await this.instance.close(permanent);
  }
}
