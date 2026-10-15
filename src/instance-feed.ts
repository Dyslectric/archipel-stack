// A commit-ordered origin log. Intake commits bytes before any key, actor,
// avatar or activity resolution. Materializers have their own bounded budget.
import { createCipheriv, createDecipheriv, createPublicKey, randomBytes } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import type { Request, Response } from "express";
import type { Federation, PublicationLookups } from "./federation.js";
import { Problem } from "./store.js";
import { peerJson, peerRequest, signedHeaders } from "./federation-net.js";

export type FeedSubscription = Record<string, any>;
type Payload = { activity: string | null; actors: Record<string, any>[] };
export type InstanceEvent = { seq: number; channel: string; channelSeq: number; epoch: number;
  payload?: Payload; encrypted?: { iv: string; tag: string; data: string } };
type Page = { type: "InstanceEvents"; origin: string; after: number; cursor: number; events: InstanceEvent[] };
const COUNT = 32, BYTES = 240000, FRAME = 262144, POLICY_AGE = 1000;
const aad = (origin: string, event: InstanceEvent) => Buffer.from(JSON.stringify([1, origin, event.seq, event.channel, event.channelSeq, event.epoch]));
export function sealEvent(origin: string, event: InstanceEvent, payload: Payload, secret: string): InstanceEvent {
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", Buffer.from(secret, "base64"), iv);
  cipher.setAAD(aad(origin, event));
  const data = Buffer.concat([cipher.update(JSON.stringify(payload)), cipher.final()]);
  return { ...event, encrypted: { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") } };
}
export function openEvent(origin: string, event: InstanceEvent, secret: string): Payload {
  const encrypted = event.encrypted!;
  if (Buffer.from(encrypted.iv, "base64").length !== 12 || Buffer.from(encrypted.tag, "base64").length !== 16 || Buffer.from(secret, "base64").length !== 32)
    throw new Problem(400, "Invalid encrypted instance event.");
  const decipher = createDecipheriv("aes-256-gcm", Buffer.from(secret, "base64"), Buffer.from(encrypted.iv, "base64"));
  decipher.setAAD(aad(origin, event)); decipher.setAuthTag(Buffer.from(encrypted.tag, "base64"));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(encrypted.data, "base64")), decipher.final()]).toString("utf8"));
}

export class InstanceFeed {
  private consumers = new Map<string, { controller: AbortController; job: Promise<void> }>();
  private responses = new Set<Response>();
  private admissions = new Map<string, FeedSubscription>();
  private queued = new Set<string>();
  private jobs = new Map<string, Promise<void>>();
  private retries = new Map<string, number>();
  private retryTimers = new Map<string,NodeJS.Timeout>();
  private routingRows?: FeedSubscription[];
  private groups = new Map<string,FeedSubscription[]>();
  private handled = new Set<string>();
  private pages = new Map<number, { stamp: string; at: number; page: Page }>();
  // Each event as every peer is sent it, with its encoded size. Publication policy
  // depends only on the tables in stamp(), so one evaluation serves every peer's
  // page until one of them changes. Policy written by another front end does not
  // move the stamp, so a decision is also kept for at most POLICY_AGE.
  private events = new Map<number, { stamp: string; at: number; event: InstanceEvent; size: number }>();
  private closed = false;
  private prunedAt = 0;
  private assetQueue = new Map<string, Record<string, any>>();
  private assetVersions = new Map<string,string>();
  private assetJobs = new Set<Promise<void>>();
  readonly stats = { connections: 0, staged: 0, materialized: 0, retries: 0 };
  constructor(private fed: Federation, private channelStats: { connections: number; batches: number; events: number; skipped: number; retries: number; gaps: number }) {}
  private stamp() {
    const db = this.fed.store.db;
    return ["channels", "users", "roles", "user_roles", "channel_rules", "federation_blocks", "instance_settings"].map(t => db.revision(t)).join("|");
  }
  key(actor: Record<string, any>, id: string, epoch: number) {
    this.fed.ensureEnabled();
    if (!Number.isSafeInteger(epoch) || epoch < 1 || !this.fed.acceptedFollower(id, actor.id)) throw new Problem(403, "Channel key access denied.");
    const db = this.fed.store.db, channel = this.fed.store.channel(id);
    const follow = db.prepare("SELECT key_epoch FROM federation_follows WHERE channel_id=? AND actor=? AND status='accepted'").get(id, actor.id);
    const current = Number(db.prepare("SELECT epoch FROM federation_channel_epochs WHERE channel_id=?").get(id)?.epoch || 1);
    if (!channel.federation_enabled || channel.remote_actor || !follow || epoch < Number(follow.key_epoch || 1) || epoch > current)
      throw new Problem(403, "Channel key epoch is outside this admission.");
    return { channel: this.fed.channelActor(channel), epoch, secret: this.secret(id, epoch) };
  }
  private secret(id: string, epoch: number) {
    const db = this.fed.store.db;
    db.prepare("INSERT OR IGNORE INTO federation_channel_keys(channel_id,epoch,secret) VALUES(?,?,?)", { notify: false }).run(id, epoch, randomBytes(32).toString("base64"));
    return String(db.prepare("SELECT secret FROM federation_channel_keys WHERE channel_id=? AND epoch=?").get(id, epoch)!.secret);
  }
  page(after: number): Page {
    this.fed.ensureEnabled();
    if (!Number.isSafeInteger(after) || after < 0) throw new Problem(400, "Invalid instance event cursor.");
    const db = this.fed.store.db, state = db.prepare("SELECT tail,floor FROM federation_instance_state WHERE id=1").get()!;
    if (after < Number(state.floor)) throw new Problem(410, "Instance event cursor expired; resubscribe for bounded current history.");
    if (after > Number(state.tail)) throw new Problem(400, "Instance cursor is ahead of its home.");
    const stamp = this.stamp(), cached = this.pages.get(after);
    if (cached?.stamp === stamp && Date.now() - cached.at < POLICY_AGE && (cached.page.events.length === COUNT || cached.page.cursor === Number(state.tail))) return cached.page;
    const page: Page = { type: "InstanceEvents", origin: this.fed.config.baseUrl, after, cursor: after, events: [] };
    const rows = db.prepare("SELECT e.*,o.activity,o.purpose,o.user_id FROM federation_instance_events e JOIN federation_outgoing o ON o.id=e.activity_id WHERE e.seq>? ORDER BY e.seq LIMIT ?").all(after, COUNT);
    let bytes = 0, lookups: PublicationLookups | undefined;
    const now = Date.now();
    let oldest = now;
    for (const row of rows) {
      let built = this.events.get(Number(row.seq));
      if (built?.stamp !== stamp || now - built.at >= POLICY_AGE) {
        const event = this.build(row, lookups ??= this.fed.publicationLookups());
        built = { stamp, at: now, event, size: Buffer.byteLength(JSON.stringify(event)) };
        this.events.delete(Number(row.seq));
        if (this.events.size >= 4096) this.events.delete(this.events.keys().next().value!);
        this.events.set(Number(row.seq), built);
      }
      if (built.size > BYTES) throw new Problem(413, "Instance event exceeds its frame limit.");
      if (bytes + built.size > BYTES) break;
      bytes += built.size; page.events.push(built.event); page.cursor = built.event.seq; oldest = Math.min(oldest, built.at);
    }
    if (this.pages.size >= 256) this.pages.delete(this.pages.keys().next().value!);
    this.pages.set(after, { stamp, at: oldest, page }); return page;
  }
  // One event as peers receive it: its stored frame when policy allows it, otherwise
  // a placeholder that advances cursors without the content.
  private build(row: Record<string, any>, lookups: PublicationLookups): InstanceEvent {
    const db = this.fed.store.db;
    let allowed = true;
    try { this.fed.channelPublicationAllowed(row as any, lookups); } catch { allowed = false; }
    if (row.frame && allowed) return JSON.parse(row.frame);
    const base: InstanceEvent = { seq: Number(row.seq), channel: `${this.fed.config.baseUrl}/actors/channels/${row.channel_id}`, channelSeq: Number(row.channel_seq), epoch: Number(row.epoch) };
    const actors: Record<string, any>[] = [];
    if (allowed) {
      actors.push(this.fed.publicActor("channels", row.channel_id));
      if (row.user_id) {
        const user = this.fed.store.user(row.user_id);
        // Only an actor's own origin can supply its signing identity.
        if (!user.remote_actor) actors.push(this.fed.publicActor("users", user.id));
      }
    }
    const payload: Payload = { activity: allowed ? row.activity : null, actors };
    const event = row.public ? { ...base, payload } : sealEvent(this.fed.config.baseUrl, base, payload, this.secret(row.channel_id, base.epoch));
    if (!allowed) return event;
    db.prepare("UPDATE federation_instance_events SET frame=? WHERE seq=? AND frame IS NULL", { notify: false }).run(JSON.stringify(event), row.seq);
    // Another front end may have won the cache fill. Every reader uses
    // the durable winner, including its nonce and authentication tag.
    return JSON.parse(db.prepare("SELECT frame FROM federation_instance_events WHERE seq=?").get(row.seq)!.frame);
  }
  async open(_req: Request, res: Response, after: number) {
    if (this.closed || this.responses.size >= 128) throw new Problem(503, "Instance stream capacity is busy.");
    let page = this.page(after);
    res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-store", "X-Accel-Buffering": "no" }); res.flushHeaders();
    this.responses.add(res); let stopped = false; res.once("close", () => { stopped = true; this.responses.delete(res); });
    try {
      const end = Date.now() + 30000;
      while (!stopped && !this.closed && Date.now() < end) {
        if (page.events.length) {
          if (res.writableLength > FRAME) break;
          if (!res.write(`id: ${page.cursor}\ndata: ${JSON.stringify(page)}\n\n`)) {
            await new Promise<void>(resolve => {
              const timer = setTimeout(() => { res.destroy(); done(); }, 5000); timer.unref();
              const done = () => { clearTimeout(timer); res.off("drain", done); res.off("close", done); resolve(); };
              res.once("drain", done); res.once("close", done);
            });
          }
          after = page.cursor;
          // A peer catching up is served a page at a time between other work,
          // never in one run that keeps the server from accepting connections.
          await new Promise<void>(resolve => setImmediate(resolve));
        } else {
          res.write(": heartbeat\n\n"); await new Promise<void>(resolve => { const timer = setTimeout(resolve, 250); timer.unref(); });
        }
        if (!stopped) page = this.page(after);
      }
    } catch { /* Reconnect reports revoked federation or an expired cursor. */ }
    finally { this.responses.delete(res); res.end(); }
  }
  async sync(rows: FeedSubscription[]) {
    if (this.closed) return new Set<string>();
    if (rows !== this.routingRows) {
      this.routingRows = rows;
      this.admissions.clear(); this.groups.clear(); this.handled.clear();
      for (const row of rows) {
      let doc; try { doc = JSON.parse(row.document); } catch { continue; }
      if (!doc.channelEvents?.instanceStream || !doc.channelEvents?.instanceBatches || row.instance_start == null) continue;
      const origin = new URL(row.remote_actor).origin;
      for (const [field, path] of [["instanceStream", "/federation/stream"], ["instanceBatches", "/federation/events"]]) {
        const url = this.fed.channelPeerUrl(doc.channelEvents[field]);
        if (url.origin !== origin || url.pathname !== path || url.search) throw new Problem(400, "Invalid instance feed endpoint.");
      }
      this.handled.add(row.channel_id); this.admissions.set(row.remote_actor, row);
      const group = this.groups.get(origin) || []; group.push(row); this.groups.set(origin, group);
      this.fed.store.db.prepare("INSERT OR IGNORE INTO federation_channel_cursors(channel_id,cursor) VALUES(?,?)", { notify: false }).run(row.channel_id, Number(row.stream_start));
      this.schedule(row.remote_actor);
      }
      for (const [origin,group] of this.groups) {
        const start = group.reduce((minimum,row) => Math.min(minimum,Number(row.instance_start)),Infinity);
        // A fresh admission's bounded history covers everything before this
        // boundary. Rejoining can therefore recover an expired origin cursor.
        const moved = this.fed.store.db.prepare("INSERT INTO federation_instance_cursors(origin,cursor) VALUES(?,?) ON CONFLICT(origin) DO UPDATE SET cursor=excluded.cursor,error=NULL,retry_at=0 WHERE federation_instance_cursors.cursor<excluded.cursor", { notify: false }).run(origin,start);
        if (moved.changes) this.consumers.get(origin)?.controller.abort();
      }
    }
    for (const [origin, consumer] of this.consumers) if (!this.groups.has(origin)) consumer.controller.abort();
    for (const [origin, group] of this.groups) {
      if (this.consumers.has(origin) || this.consumers.size >= 128) continue;
      const db = this.fed.store.db;
      if (Number(db.prepare("SELECT retry_at FROM federation_instance_cursors WHERE origin=?").get(origin)!.retry_at) > Date.now()) continue;
      const controller = new AbortController();
      const job = this.consume(origin, group[0], controller.signal).catch(error => {
        if (controller.signal.aborted || this.closed) return;
        this.stats.retries++; this.channelStats.retries++;
        if (error instanceof Problem && error.status === 410) this.channelStats.gaps++;
        db.prepare("UPDATE federation_instance_cursors SET error=?,retry_at=? WHERE origin=?", { notify: false }).run(error instanceof Problem && error.status === 410 ? "Instance event cursor expired; resubscribe for bounded current history." : String(error.message).slice(0, 200), Date.now() + 5000, origin);
      }).finally(() => { if (this.consumers.get(origin)?.controller === controller) this.consumers.delete(origin); });
      this.consumers.set(origin, { controller, job });
    }
    if (this.fed.config.federationChannelTransport === "batch") { await Promise.all([...this.consumers.values()].map(c => c.job)); await this.settle(); }
    this.prune(); return this.handled;
  }
  private async consume(origin: string, row: FeedSubscription, signal: AbortSignal) {
    const db = this.fed.store.db, stream = this.fed.config.federationChannelTransport === "stream";
    const url = this.fed.channelPeerUrl(`${origin}/federation/${stream ? "stream" : "events"}`);
    url.searchParams.set("after", String(db.prepare("SELECT cursor FROM federation_instance_cursors WHERE origin=?").get(origin)!.cursor));
    const headers = signedHeaders(url, "GET", this.fed.userActor(this.fed.store.user(row.user_id)), this.fed.keys().private_key);
    const apply = (value: unknown) => this.stage(origin, value as Page);
    if (!stream) { apply(await peerJson(url, this.fed.config, headers)); return; }
    headers.accept = "text/event-stream"; this.stats.connections++; this.channelStats.connections++;
    await peerRequest(url, this.fed.config, headers, undefined, FRAME, 40000, "GET", async response => {
      if (!/^text\/event-stream(;|$)/i.test(String(response.headers["content-type"] || ""))) throw new Problem(415, "Expected an instance event stream.");
      const decoder = new StringDecoder("utf8"); let pending = "";
      for await (const chunk of response) {
        if (signal.aborted) throw new Error("Instance consumer stopped.");
        pending = (pending + decoder.write(chunk)).replaceAll("\r\n", "\n"); let at: number;
        while ((at = pending.indexOf("\n\n")) >= 0) {
          const frame = pending.slice(0, at); pending = pending.slice(at + 2);
          if (Buffer.byteLength(frame) > FRAME) throw new Problem(413, "Instance stream frame exceeds its limit.");
          const data = frame.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).replace(/^ /, "")).join("\n");
          if (data) apply(JSON.parse(data));
        }
        if (Buffer.byteLength(pending) > FRAME) throw new Problem(413, "Instance stream frame exceeds its limit.");
      }
      if (pending.trim()) throw new Problem(400, "Truncated instance stream frame.");
    }, signal);
  }
  stage(origin: string, page: Page) {
    const db = this.fed.store.db;
    let previous = Number(db.prepare("SELECT cursor FROM federation_instance_cursors WHERE origin=?").get(origin)?.cursor);
    if (page?.type !== "InstanceEvents" || page.origin !== origin || page.after !== previous || !Array.isArray(page.events) || page.events.length > COUNT)
      throw new Problem(400, "Invalid instance event page.");
    // Validate the complete page before committing any of it.
    for (const event of page.events) {
      const url = this.fed.channelPeerUrl(event.channel);
      if (event.seq !== ++previous || !Number.isSafeInteger(event.seq) || !Number.isSafeInteger(event.channelSeq) || event.channelSeq < 1 || !Number.isSafeInteger(event.epoch) || event.epoch < 1 || url.origin !== origin || !/^\/actors\/channels\/[a-f0-9-]+$/.test(url.pathname) || url.search || (!!event.payload === !!event.encrypted) || Buffer.byteLength(JSON.stringify(event)) > BYTES)
        throw new Problem(400, "Invalid instance event sequence or authority.");
    }
    if (page.cursor !== previous) throw new Problem(400, "Invalid instance checkpoint.");
    this.fed.store.transaction(() => {
      for (const event of page.events) db.prepare("INSERT INTO federation_instance_incoming(origin,seq,channel_actor,channel_seq,frame) VALUES(?,?,?,?,?)", { notify: false }).run(origin, event.seq, event.channel, event.channelSeq, JSON.stringify(event));
      db.prepare("UPDATE federation_instance_cursors SET cursor=?,error=NULL,retry_at=0 WHERE origin=?", { notify: false }).run(page.cursor, origin);
    });
    this.stats.staged += page.events.length; this.channelStats.batches++;
    for (const event of page.events) if (this.admissions.has(event.channel)) this.schedule(event.channel);
  }
  private schedule(channel: string) {
    if (this.closed || !this.admissions.has(channel) || (this.retries.get(channel) || 0) > Date.now()) return;
    this.queued.add(channel); this.pump();
  }
  private pump() {
    for (const channel of this.queued) {
      if (this.jobs.size >= 8 || this.closed) break;
      if (this.jobs.has(channel)) continue;
      if ((this.retries.get(channel) || 0) > Date.now()) { this.queued.delete(channel); continue; }
      this.queued.delete(channel);
      const job = this.materialize(channel).catch(error => {
        if (this.closed) return;
        this.stats.retries++; this.retries.set(channel, Date.now() + 5000);
        clearTimeout(this.retryTimers.get(channel));
        const timer = setTimeout(() => { this.retryTimers.delete(channel); this.schedule(channel); }, 5000);
        timer.unref(); this.retryTimers.set(channel, timer);
        const row = this.admissions.get(channel);
        if (row) this.fed.store.db.prepare("UPDATE federation_channel_cursors SET error=?,retry_at=? WHERE channel_id=?", { notify: false }).run(String(error.message).slice(0, 200), Date.now() + 5000, row.channel_id);
      }).finally(() => { this.jobs.delete(channel); this.pump(); });
      this.jobs.set(channel, job);
    }
  }
  private async materialize(channel: string) {
    const row = this.admissions.get(channel); if (!row || this.closed) return;
    const db = this.fed.store.db;
    const pending = db.prepare("SELECT seq,frame FROM federation_instance_incoming WHERE channel_actor=? AND state='pending' ORDER BY channel_seq LIMIT ?").all(channel, COUNT);
    for (const saved of pending) {
      if (this.closed || this.admissions.get(channel)?.follow_id !== row.follow_id) return;
      const event: InstanceEvent = JSON.parse(saved.frame), origin = new URL(channel).origin;
      const cursor = db.prepare("SELECT cursor FROM federation_channel_cursors WHERE channel_id=?").get(row.channel_id);
      if (!cursor) return;
      const previous = Math.max(Number(cursor.cursor), Number(row.stream_start));
      if (event.channelSeq > previous) {
        if (event.channelSeq !== previous + 1) throw new Problem(410, "Channel materialization gap; resubscribe for bounded current history.");
        let payload = event.payload;
        if (!payload) {
          let secret = db.prepare("SELECT secret FROM federation_received_keys WHERE channel_actor=? AND epoch=?").get(channel, event.epoch)?.secret;
          if (!secret) {
            const url = this.fed.channelPeerUrl(`${channel}/keys/${event.epoch}`);
            const key = await peerJson(url, this.fed.config, signedHeaders(url, "GET", this.fed.userActor(this.fed.store.user(row.user_id)), this.fed.keys().private_key));
            if (key.channel !== channel || key.epoch !== event.epoch || typeof key.secret !== "string" || Buffer.from(key.secret, "base64").length !== 32) throw new Problem(400, "Invalid channel stream key.");
            secret = key.secret; db.prepare("INSERT OR IGNORE INTO federation_received_keys(channel_actor,epoch,secret) VALUES(?,?,?)", { notify: false }).run(channel, event.epoch, secret);
          }
          payload = openEvent(origin, event, secret);
        }
        if (!payload || !Array.isArray(payload.actors) || payload.actors.length > 2 || (payload.activity !== null && (typeof payload.activity !== "string" || Buffer.byteLength(payload.activity) > 65536))) throw new Problem(400, "Invalid instance event payload.");
        for (const actor of payload.actors) this.cacheActor(origin, actor);
        const sender = await this.fed.actor(channel);
        if (this.closed || this.admissions.get(channel)?.follow_id !== row.follow_id) return;
        const applied = await this.fed.receiveChannelEvent(sender, payload.activity, { channel, follow: row.follow_id, after: previous, cursor: event.channelSeq });
        if (!applied) this.channelStats.skipped++;
        this.channelStats.events++; this.stats.materialized++;
      }
      db.prepare("UPDATE federation_instance_incoming SET state='done',error=NULL WHERE origin=? AND seq=?", { notify: false }).run(origin, event.seq);
    }
    if (pending.length === COUNT) this.queued.add(channel);
  }
  private cacheActor(origin: string, actor: Record<string, any>) {
    if (!actor || typeof actor.id !== "string" || new URL(actor.id).origin !== origin || !["Person", "Group"].includes(actor.type) || actor.publicKey?.owner !== actor.id || actor.publicKey?.id !== `${actor.id}#main-key` || typeof actor.publicKey?.publicKeyPem !== "string" || actor.publicKey.publicKeyPem.length > 10000 || (actor.fwdxpVersion ?? actor.archipelVersion) !== 1 || this.fed.channelPeerUrl(actor.inbox).origin !== origin)
      throw new Problem(400, "Invalid same-origin stream actor.");
    const key = createPublicKey(actor.publicKey.publicKeyPem);
    if (key.asymmetricKeyType !== "rsa" || (key.asymmetricKeyDetails?.modulusLength || 0) < 2048) throw new Problem(400, "Invalid stream actor signing key.");
    this.fed.store.db.prepare("INSERT INTO federation_actors(id,document,fetched_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET document=excluded.document,fetched_at=excluded.fetched_at", { notify: false }).run(actor.id, JSON.stringify(actor), Date.now());
    const icon = JSON.stringify(actor.icon || null);
    if (this.assetVersions.get(actor.id) !== icon) {
      if (this.assetVersions.size >= 1024) this.assetVersions.delete(this.assetVersions.keys().next().value!);
      this.assetVersions.set(actor.id, icon);
      if (this.assetQueue.size < 128) this.assetQueue.set(actor.id, actor);
      this.pumpAssets();
    }
  }
  private pumpAssets() {
    while (!this.closed && this.assetJobs.size < 2 && this.assetQueue.size) {
      const [id,actor] = this.assetQueue.entries().next().value!; this.assetQueue.delete(id);
      const job = this.fed.syncAvatar(actor).catch(() => {}).finally(() => { this.assetJobs.delete(job); this.pumpAssets(); });
      this.assetJobs.add(job);
    }
  }
  private async settle() { while (this.jobs.size) await Promise.all([...this.jobs.values()]); }
  private prune() {
    if (Date.now() - this.prunedAt < 1000) return;
    this.prunedAt = Date.now(); const db = this.fed.store.db;
    this.fed.store.transaction(() => {
      // Delete a bounded prefix, never scan/delete the entire log in a read.
      const rows = db.prepare("SELECT seq,created_at,channel_id,channel_seq FROM federation_instance_events ORDER BY seq LIMIT 1000").all();
      const tail = Number(db.prepare("SELECT tail FROM federation_instance_state WHERE id=1").get()!.tail);
      let floor = 0;
      const channels = new Map<string,number>();
      for (const row of rows) {
        if (row.seq > tail - 100000 && row.created_at > Date.now() - 7 * 86400000) break;
        floor = Number(row.seq); channels.set(row.channel_id, Number(row.channel_seq));
      }
      if (floor) {
        db.prepare("DELETE FROM federation_instance_events WHERE seq<=?", { notify: false }).run(floor);
        db.prepare("UPDATE federation_instance_state SET floor=? WHERE id=1", { notify: false }).run(floor);
        for (const [channel,sequence] of channels) {
          db.prepare("DELETE FROM federation_channel_events WHERE channel_id=? AND seq<=?", { notify: false }).run(channel,sequence);
          db.prepare("UPDATE federation_channel_state SET floor=MAX(floor,?) WHERE channel_id=?", { notify: false }).run(sequence,channel);
        }
      }
      db.prepare("DELETE FROM federation_instance_incoming WHERE (origin,seq) IN(SELECT origin,seq FROM federation_instance_incoming WHERE state='done' ORDER BY origin,seq LIMIT 1000)", { notify: false }).run();
      // Unknown channels are retained for admission races, but not forever.
      // Any admitted channel falling outside this horizon reports a sequence
      // gap instead of advancing its materialization checkpoint over lost data.
      db.prepare("DELETE FROM federation_instance_incoming WHERE (origin,seq) IN(SELECT i.origin,i.seq FROM federation_instance_incoming i JOIN federation_instance_cursors c ON c.origin=i.origin WHERE i.seq<=c.cursor-100000 ORDER BY i.origin,i.seq LIMIT 1000)", { notify: false }).run();
    });
  }
  async close(permanent = true) {
    if (permanent) this.closed = true;
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
    for (const response of this.responses) response.end();
    for (const consumer of this.consumers.values()) consumer.controller.abort();
    await Promise.all([...this.consumers.values()].map(c => c.job)); await this.settle();
    await Promise.all([...this.assetJobs]);
  }
}
