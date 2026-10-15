// Maintained delivery routes keep ordinary messages off the audience-query path.
// Opted-in browsers receive shared, policy-filtered deltas; control changes and
// older clients retain API invalidations and their fresh authorization checks.
import type { Request, Response } from "express";
import type { Change } from "./db.js";
import type { Store,User,Channel } from "./store.js";
import type { NativeChat } from "./native-chat.js";
import { createHash } from "node:crypto";
import { fork, type ChildProcess } from "node:child_process";

interface Stream {
  res: Response;
  token: string;
  user: string;
  approved: boolean;
  admin: boolean;
  profile: User;
  deltas: boolean;
  watch: string;
  channels: Set<string>;
  handles: Set<string>;
  blocks: Set<string>;
  contacts: Map<string,string>;
  slow: boolean;
  /** Set once the socket belongs to a writing process. */
  remote?: { worker: Writer; id: number };
}
// What an event may carry. `all` asks for everything to be looked at again.
export interface Notice {
  all?: true;
  me?: true;
  admin?: true;
  channels?: string[];
  read?: true;
  rooms?: true;
  content?: true;
  sending?: true;
  delta?: {channel:string;messages:unknown[];cursor:number};
}
// Written to constantly as the instance works, with nothing of it on anyone's screen.
const quiet = new Set([
  "auth_flows",
  "attachments",
  "channel_bridge_seen",
  "device_flows",
  "federation_actors",
  "federation_incoming",
  "federation_keys",
  "federation_objects",
  "mirror_sources",
  "native_changes",
  // Written along with the reaction it is the picture of.
  "reaction_emojis",
  "remote_emoji_cache",
  "xmpp_avatar_requests",
  "xmpp_accounts",
  "xmpp_direct_ids",
  "xmpp_events",
  "xmpp_incoming",
  "xmpp_message_ids",
  "federation_channel_state","federation_channel_events","federation_channel_peers","federation_channel_cursors",
  "federation_instance_state","federation_instance_events","federation_instance_cursors","federation_instance_incoming",
  "federation_channel_epochs","federation_channel_keys","federation_received_keys",
]);
// A member's own things: only their browsers show them.
const personal = new Set([
  "direct_messages",
  "conversation_prefs",
  "sidebar_layouts",
  "closed_conversations",
  "contact_names",
  "user_blocks",
  "personal_emojis",
  "push_subscriptions",
  "xmpp_credentials",
]);
const inChannel = new Set(["messages", "topics", "channel_roster"]);
// Writes that never change who a stream is routed to, or what it filters.
const unrouted = new Set(["messages","topics","read_marks","message_reactions","federation_outgoing","federation_deliveries","audit","sessions",
  "direct_messages","sidebar_layouts","closed_conversations","personal_emojis","push_subscriptions","xmpp_credentials","xmpp_remote_rooms","xmpp_remote_messages"]);
// A reader's own filters: reloaded only for the members they belong to.
const viewerTables = new Set(["users","user_roles","user_blocks","contact_names","conversation_prefs"]);
// An event frame ready for the socket. HTTP/1.1 chunk framing is added once and
// the same bytes are shared by every stream it goes to.
class Frame {
  private framed?: Buffer;
  constructor(readonly data: Buffer) {}
  get chunk() { return this.framed ??= Buffer.concat([Buffer.from(`${this.data.length.toString(16)}\r\n`), this.data, Buffer.from("\r\n")]); }
}
// What a handed-over stream keeps in place of its response.
const released = Object.freeze({}) as Response;
// A process that writes handed-over event streams. Frames for it are batched
// until the current flush ends, then sent as one message with their readers.
interface Writer { child: ChildProcess; streams: Map<number, Stream>; batch: Map<Frame, number[]>; ends: number[] }
interface Viewer { profile: User; blocks: Set<string>; contacts: Map<string,string>; slow: boolean }
const WAIT = 10, // changes this close together are told of once
  // Socket writes per second across every stream. A flush that wrote more spaces
  // the next one out, so under heavy fan-out each frame carries several messages:
  // CPU stays bounded and delivery latency grows instead.
  FRAME_BUDGET = 60000,
  BEAT = 25000, // a line this often keeps proxies from closing a silent stream
  OPEN_BATCH = 10, // streams opened this close together are routed together
  PER_USER = 8;

export class Events {
  private streams = new Set<Stream>();
  private queue: Change[] = [];
  private timer: NodeJS.Timeout | null = null;
  private beat: NodeJS.Timeout | null = null;
  private reviewPending?: Promise<void>;
  private reviewQueued = false;
  private closed = false;
  private byUser=new Map<string,Set<Stream>>();
  private byChannel=new Map<string,Set<Stream>>();
  private adminStreams=new Set<Stream>();
  private routes=new Map<string,Channel>();
  private memberships=new Map<string,Set<string>>();
  private blocked=new Set<string>();
  private federationBlocks=new Set<string>();
  private federationEnabled=false;
  // Routing state is kept current incrementally. Channel-wide policy reloads
  // the shared tables; a member's own changes reload only that member.
  private globalDirty=true;
  private viewers=new Map<string,Viewer>();
  private viewersDirty=new Set<string>();
  private allViewersDirty=false;
  private membersDirty=new Set<string>();
  private cursors=new Map<string,number>();
  private opening=new Set<Stream>();
  private openTimer:NodeJS.Timeout|null=null;
  private writers: Writer[] = [];
  private nextWriter = 0;
  private nextRemote = 0;
  private dispatching = false;
  constructor(private store: Store, private native?: NativeChat, private fanout = { workers: 0, threshold: 512 }) {
    store.db.onChange = (changes) => {
      if (!this.streams.size) { this.globalDirty=true;return; }
      for(const {table,rows} of changes) {
        if(quiet.has(table) || unrouted.has(table))continue;
        if(viewerTables.has(table)) {
          const ids=rows.map(r=>table==="users"?r.id:r.user_id);
          if(!ids.length || ids.some(id=>typeof id!=="string"))this.allViewersDirty=true;
          else for(const id of ids)this.viewersDirty.add(id as string);
        } else if(table==="memberships" && rows.length && rows.every(r=>typeof r.user_id==="string"))for(const r of rows)this.membersDirty.add(r.user_id as string);
        else if(table==="instance_settings" && rows.length && rows.every(r=>r.key!=="federation_enabled"))continue;
        else if(table==="roles")this.allViewersDirty=true;
        else this.globalDirty=true;
      }
      this.queue.push(...changes);
      this.schedule();
    };
  }
  // An idle hub tells of a change at once; under load, changes within WAIT of
  // the previous flush are coalesced into the next one.
  private lastFlush = 0;
  private frames = 0;
  private spacing = WAIT;
  private schedule() {
    this.timer ??= setTimeout(() => {
      this.timer = null;
      this.lastFlush = Date.now();
      this.frames = 0;
      void this.flush().finally(() => { this.spacing = Math.max(WAIT, this.frames * 1000 / FRAME_BUDGET); }).catch(() => {
        // Whatever could not be worked out, everyone looks again rather than miss it.
        this.queue = [];
        for (const stream of this.streams) this.send(stream, { all: true });
      });
    }, Math.max(0, this.lastFlush + this.spacing - Date.now()));
  }
  get listeners() {
    return this.streams.size;
  }
  /** Holds the response open as a stream of events for the session behind it. */
  async open(req: Request, res: Response, token: string, current?: { user: User }) {
    if(this.closed)return res.status(503).json({error:"The server is stopping."});
    const nativeSession=current ?? await this.native?.eventSession(token);
    const session=nativeSession===undefined?this.store.session(token):nativeSession;
    if(this.closed)return res.status(503).json({error:"The server is stopping."});
    if(res.destroyed)return;
    if (!session) return res.status(401).json({ error: "Sign in to continue." });
    const stream: Stream = {
      res,
      token,
      user: session.user.id,
      approved: session.user.admission_status === "approved",
      admin: !!session.user.admin,
      profile:session.user,deltas:req.query.deltas==="1",watch:typeof req.query.watch==="string"?req.query.watch:"",
      channels:new Set(),handles:new Set(),blocks:new Set(),contacts:new Map(),slow:false,
    };
    // A browser with many tabs keeps its newest streams.
    const mine = [...(this.byUser.get(stream.user)||[])];
    for (const old of mine.slice(0, Math.max(0, mine.length - PER_USER + 1)))
      this.drop(old);
    req.socket.setTimeout(0);
    req.socket.setNoDelay(true);
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no",
    });
    res.write("retry: 2000\n\n");
    this.streams.add(stream);
    const own=this.byUser.get(stream.user)||new Set<Stream>();own.add(stream);this.byUser.set(stream.user,own);
    // Streams opened within a few milliseconds are routed together, sharing one
    // bulk viewer read: a reconnecting crowd costs a few queries per batch.
    this.opening.add(stream);
    this.openTimer??=setTimeout(()=>{this.openTimer=null;this.routeOpened();},OPEN_BATCH);
    res.on("close", () => { if (!stream.remote) this.drop(stream); });
    if (!this.beat) {
      this.beat = setInterval(() => {
        void this.review().then(()=>{const beat=new Frame(Buffer.from(": \n\n"));for (const s of this.streams) this.sendFrame(s,beat);});
      }, BEAT);
      this.beat.unref();
    }
  }
  /** Ends every stream, so the server can stop. */
  close() {
    this.closed=true;
    for (const stream of [...this.streams]) this.drop(stream);
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.openTimer) clearTimeout(this.openTimer);
    this.openTimer = null;
    this.dispatch();
    for (const writer of this.writers) writer.child.disconnect();
    this.writers = [];
  }
  private drop(stream: Stream) {
    if (!this.streams.delete(stream)) return;
    const own=this.byUser.get(stream.user);own?.delete(stream);if(!own?.size)this.byUser.delete(stream.user);
    this.adminStreams.delete(stream);
    for(const channel of stream.channels)this.byChannel.get(channel)?.delete(stream);
    this.opening.delete(stream);
    if(!this.byUser.has(stream.user))this.viewers.delete(stream.user);
    if (stream.remote) {
      const { worker, id } = stream.remote;
      if (worker.streams.delete(id)) { worker.ends.push(id); this.queueDispatch(); }
    } else stream.res.end();
    if (!this.streams.size && this.beat) {
      clearInterval(this.beat);
      this.beat = null;
    }
  }
  private send(stream: Stream, notice: Notice) {
    this.sendFrame(stream,`data: ${JSON.stringify(notice)}\n\n`);
  }
  private sendFrame(stream:Stream,frame:string|Frame) {
    if (stream.remote) {
      const shared = typeof frame === "string" ? new Frame(Buffer.from(frame)) : frame, batch = stream.remote.worker.batch;
      const ids = batch.get(shared); if (ids) ids.push(stream.remote.id); else batch.set(shared, [stream.remote.id]);
      this.frames++; this.queueDispatch(); return;
    }
    if(stream.res.writableLength>1024*1024){this.drop(stream);return;}
    this.frames++;
    // Once the headers are out, frames go straight to the socket, skipping the
    // response's per-write chunk encoding and deferred cork for every stream.
    // Only open() writes through the response, and it has flushed by then.
    const res=stream.res as Response & {chunkedEncoding?:boolean},socket=res.socket;
    if(typeof frame!=="string" && socket && res.headersSent && res.chunkedEncoding && !res.writableEnded)socket.write(frame.chunk);
    else res.write(typeof frame==="string"?frame:frame.data);
  }
  private queueDispatch() {
    if (this.dispatching) return;
    this.dispatching = true;
    queueMicrotask(() => this.dispatch());
  }
  // Each writing process receives this flush's frames once, with the readers of each.
  private dispatch() {
    this.dispatching = false;
    for (const writer of this.writers) {
      if (writer.batch.size) {
        const chunks: Uint8Array[] = [], targets: Int32Array[] = [];
        for (const [frame, ids] of writer.batch) { chunks.push(frame.chunk); targets.push(Int32Array.from(ids)); }
        writer.batch.clear();
        if (writer.child.connected) writer.child.send({ type: "write", chunks, targets });
      }
      if (writer.ends.length) { if (writer.child.connected) writer.child.send({ type: "end", ids: writer.ends }); writer.ends = []; }
    }
  }
  private startWriters() {
    const source = import.meta.url.endsWith(".ts");
    for (let i = 0; i < this.fanout.workers; i++) {
      const child = fork(new URL(source ? "./fanout-worker.ts" : "./fanout-worker.js", import.meta.url), [],
        { serialization: "advanced", execArgv: source ? ["--import", "tsx"] : [], stdio: ["ignore", "inherit", "inherit", "ipc"] });
      const writer: Writer = { child, streams: new Map(), batch: new Map(), ends: [] };
      child.on("message", (message: { type: string; id: number }) => {
        const stream = message.type === "closed" ? writer.streams.get(message.id) : undefined;
        if (stream) { writer.streams.delete(message.id); this.drop(stream); }
      });
      // A writer that stops takes its sockets with it; their readers reconnect.
      child.on("exit", () => {
        this.writers = this.writers.filter(w => w !== writer);
        for (const stream of [...writer.streams.values()]) { writer.streams.delete(stream.remote!.id); this.drop(stream); }
      });
      this.writers.push(writer);
    }
  }
  // Moves a routed stream's socket to a writing process once its headers are out.
  private handOff(stream: Stream) {
    if (this.closed || stream.remote || this.streams.size < this.fanout.threshold || !this.fanout.workers) return;
    if (!this.writers.length) this.startWriters();
    const res = stream.res as Response & { chunkedEncoding?: boolean }, socket = res.socket;
    const writer = this.writers[this.nextWriter++ % this.writers.length];
    if (!writer?.child.connected || !socket || !res.headersSent || !res.chunkedEncoding || socket.writableLength) return;
    const id = ++this.nextRemote;
    stream.remote = { worker: writer, id };
    writer.streams.set(id, stream);
    // Node detaches a sent socket from its server, which then waits for the
    // writer's copies on close: stop this hub before closing the HTTP server.
    writer.child.send({ type: "adopt", id }, socket, { keepOpen: false }, error => {
      if (error) { if (writer.streams.delete(id)) this.drop(stream); return; }
      // Only the writer serves this stream now. Letting go of the request and
      // response lets them be collected; remote streams never use them again.
      stream.res = released;
    });
  }
  /** Routes one stream from the in-memory tables and its member's viewer data. */
  private routeStream(stream:Stream) {
    const viewer=this.viewers.get(stream.user);
    if(!viewer){this.drop(stream);return;}
    stream.profile=viewer.profile;stream.blocks=viewer.blocks;stream.contacts=viewer.contacts;stream.slow=viewer.slow;
    if(stream.admin)this.adminStreams.add(stream);else this.adminStreams.delete(stream);
    for(const channel of stream.channels)this.byChannel.get(channel)?.delete(stream);
    stream.channels.clear();stream.handles.clear();
    const wanted=new Set(this.memberships.get(stream.user)||[]);
    if(stream.watch)wanted.add(stream.watch);
    if(!stream.deltas || stream.admin)for(const [id,c]of this.routes)if(!stream.deltas || id===stream.watch)wanted.add(id);
    for(const id of wanted) {
      const c=this.routes.get(id);if(!c || !stream.approved)continue;
      if(c.remote_actor && (!this.federationEnabled || !stream.profile.federation_receive || !stream.profile.federation_subscribe || this.federationBlocks.has(c.remote_actor) || this.federationBlocks.has(new URL(c.remote_actor).origin)))continue;
      if(!stream.admin && (this.blocked.has(`${id}|${stream.user}`) || c.visibility!=="public" && !this.memberships.get(stream.user)?.has(id)))continue;
      stream.channels.add(id);if(this.store.sees(stream.profile,c,"handles"))stream.handles.add(id);
      const group=this.byChannel.get(id)||new Set<Stream>();group.add(stream);this.byChannel.set(id,group);
    }
  }
  private reloadGlobal() {
    this.globalDirty=false;this.routes=new Map(this.store.db.prepare("SELECT * FROM channels").all().map(c=>[c.id,c as Channel]));
    this.memberships.clear();for(const m of this.store.db.prepare("SELECT channel_id,user_id FROM memberships").all()){
      const channels=this.memberships.get(m.user_id)||new Set<string>();channels.add(m.channel_id);this.memberships.set(m.user_id,channels);
    }
    this.membersDirty.clear();
    this.blocked=new Set(this.store.db.prepare("SELECT channel_id,user_id FROM channel_rules WHERE rule='block'").all().map(r=>`${r.channel_id}|${r.user_id}`));
    this.federationBlocks=new Set(this.store.db.prepare("SELECT target FROM federation_blocks").all().map(r=>r.target));
    this.federationEnabled=this.store.db.prepare("SELECT value FROM instance_settings WHERE key='federation_enabled'").get()?.value==="true";
    for(const c of this.routes.values())if(!this.cursors.has(c.id))this.cursors.set(c.id,Number(this.store.db.prepare("SELECT COALESCE(MAX(seq),0) AS seq FROM messages WHERE channel_id=?").get(c.id)!.seq));
  }
  // Each member's account and own filters, read together for up to 500 members per query.
  private loadViewers(ids:string[]) {
    for(let at=0;at<ids.length;at+=500) {
      const chunk=ids.slice(at,at+500),marks=chunk.map(()=>"?").join(","),loaded=new Map<string,Viewer>();
      for(const user of this.store.db.prepare(`SELECT * FROM users WHERE id IN (${marks})`).all(...chunk) as unknown as User[])
        if(!user.banned)loaded.set(user.id,{profile:user,blocks:new Set(),contacts:new Map(),slow:false});
      for(const r of this.store.db.prepare(`SELECT user_id,peer FROM user_blocks WHERE user_id IN (${marks})`).all(...chunk))loaded.get(r.user_id as string)?.blocks.add(r.peer as string);
      for(const r of this.store.db.prepare(`SELECT user_id,peer,display_name FROM contact_names WHERE user_id IN (${marks})`).all(...chunk))loaded.get(r.user_id as string)?.contacts.set(r.peer as string,r.display_name as string);
      for(const r of this.store.db.prepare(`SELECT DISTINCT user_id FROM conversation_prefs WHERE user_id IN (${marks}) AND hidden=1 AND (target LIKE 'thread:%' OR target LIKE 'topic:%')`).all(...chunk)){const v=loaded.get(r.user_id as string);if(v)v.slow=true;}
      for(const id of chunk) {
        const viewer=loaded.get(id);
        if(viewer)this.viewers.set(id,viewer);else this.viewers.delete(id);
        for(const stream of this.byUser.get(id)||[])if(viewer){stream.approved=viewer.profile.admission_status==="approved";stream.admin=!!viewer.profile.admin;}
      }
    }
  }
  private routeOpened() {
    const streams=[...this.opening].filter(s=>this.streams.has(s));this.opening.clear();
    try {
      const missing=[...new Set(streams.map(s=>s.user))].filter(id=>!this.viewers.has(id) || this.viewersDirty.has(id));
      if(missing.length)this.loadViewers(missing);
      this.applyRouting();
      for(const stream of streams)if(this.streams.has(stream)){this.routeStream(stream);if(this.streams.has(stream))this.handOff(stream);}
    } catch {for(const stream of streams)this.drop(stream);}
  }
  /** Brings routing up to date with the changes seen since it was last applied. */
  private applyRouting() {
    const reroute=new Set<string>(),global=this.globalDirty;
    if(global)this.reloadGlobal();
    else if(this.membersDirty.size) {
      const ids=[...this.membersDirty];this.membersDirty.clear();
      for(let at=0;at<ids.length;at+=500) {
        const chunk=ids.slice(at,at+500);for(const id of chunk)this.memberships.delete(id);
        for(const m of this.store.db.prepare(`SELECT channel_id,user_id FROM memberships WHERE user_id IN (${chunk.map(()=>"?").join(",")})`).all(...chunk)) {
          const channels=this.memberships.get(m.user_id as string)||new Set<string>();channels.add(m.channel_id as string);this.memberships.set(m.user_id as string,channels);
        }
      }
      for(const id of ids)reroute.add(id);
    }
    const stale=this.allViewersDirty?[...this.byUser.keys()]:[...this.byUser.keys()].filter(id=>this.viewersDirty.has(id));
    this.allViewersDirty=false;this.viewersDirty.clear();
    if(stale.length)this.loadViewers(stale);
    for(const id of stale)reroute.add(id);
    const streams=global?[...this.streams]:[...reroute].flatMap(id=>[...this.byUser.get(id)||[]]);
    for(const stream of streams)if(this.streams.has(stream) && !this.opening.has(stream))this.routeStream(stream);
  }
  private broadcastDelta(channel:string,changed:string[]) {
    const group=this.byChannel.get(channel);if(!group?.size)return;
    const after=this.cursors.get(channel)||0,page=this.store.liveMessageBatch(channel,after,changed),cursor=Math.max(after,...page.map(m=>m.seq));
    this.cursors.set(channel,cursor);
    const variants=new Map<string,Frame>(),hasRemote=page.some(m=>m.live_remote),localOnly=hasRemote?page.filter(m=>!m.live_remote):page;
    for(const stream of group) {
      if(!stream.deltas || stream.slow)continue;
      const handles=stream.handles.has(channel),eligible=stream.profile.federation_receive?page:localOnly;
      const common=handles && !stream.blocks.size && (!hasRemote || !stream.contacts.size);
      const key=common?`public:${hasRemote && !!stream.profile.federation_receive}`:JSON.stringify([handles,!!stream.profile.federation_receive,eligible.map(m=>[stream.blocks.has(m.author_actor_url),stream.contacts.get(m.author_actor_url)||null,!handles && m.author_id===stream.user])]);
      let frame=variants.get(key);
      if(!frame){const messages=eligible.map(m=>{
        const {live_remote,...original}=m;let value={...original};
        const alias=stream.contacts.get(m.author_actor_url);if(m.live_remote && alias)value.display_name=alias;
        if(stream.blocks.has(m.author_actor_url))value={...value,body:"This message is hidden because you blocked this user.",title:value.title===null?null:"Hidden thread",emoji_tags:"[]",emojis:[],edited_at:null};
        return this.store.veiled(stream.profile,value,handles);
      });frame=new Frame(Buffer.from(`data: ${JSON.stringify({delta:{channel,messages,cursor,added:eligible.filter(m=>m.seq>after && !m.deleted_at && !m.history_placeholder && !stream.blocks.has(m.author_actor_url)).map(m=>m.id)}})}\n\n`));variants.set(key,frame);}
      this.sendFrame(stream,frame);
    }
    if(page.length===100){this.queue.push({table:"messages",rows:[{channel_id:channel}]});this.schedule();}
  }
  // A stream lasts as long as its session: signing out, expiry or suspension ends it.
  private review(): Promise<void> {
    this.reviewQueued=true;
    if(this.reviewPending) return this.reviewPending;
    const pending=(async()=>{
      while(this.reviewQueued) {
        this.reviewQueued=false;
        const streams=[...this.streams];
        try {
          const reviewed=await this.native?.reviewSessions(streams.map(s=>s.token));
          for(const stream of streams) {
            const current=reviewed?.get(createHash("sha256").update(stream.token).digest("hex"));
            if(reviewed) {
              if(!current || current.user!==stream.user){this.drop(stream);continue;}
              stream.approved=current.approved;stream.admin=current.admin;
            } else {
              const session=this.store.session(stream.token);
              if(!session){this.drop(stream);continue;}
              stream.approved=session.user.admission_status==="approved";stream.admin=!!session.user.admin;
            }
          }
        } catch {for(const stream of streams)this.drop(stream);}
      }
    })();
    this.reviewPending=pending;
    void pending.finally(()=>{if(this.reviewPending===pending)this.reviewPending=undefined;});
    return pending;
  }
  private async flush() {
    const changes = this.queue;
    this.queue = [];
    const db = this.store.db,
      users = new Set<string>(),
      readers = new Set<string>(),
      roomUsers = new Set<string>(),
      senders = new Set<string>(),
      channels = new Set<string>(),
      metadata = new Set<string>(),
      reacted = new Set<string>(),
      rooms = new Set<string>(),
      activities = new Set<string>();
    const changedUsers = new Set<string>();
    let all = false,
      admins = false,
      accounts = false;
    for (const { table, rows } of changes) {
      if (quiet.has(table)) continue;
      if (table === "sessions") accounts = true;
      else if (inChannel.has(table)) for (const row of rows) {
        channels.add(row.channel_id);
        if (table !== "messages") metadata.add(row.channel_id);
      }
      else if (personal.has(table)) for (const row of rows) users.add(row.user_id);
      else if (table === "read_marks") for (const row of rows) readers.add(row.user_id);
      else if (table === "xmpp_remote_rooms") for (const row of rows) roomUsers.add(row.user_id);
      else if (table === "message_reactions")
        for (const row of rows) reacted.add(row.message_id);
      else if (table === "xmpp_remote_messages")
        for (const row of rows) rooms.add(row.subscription_id);
      else if (table === "federation_outgoing") {
        admins = true;
        for (const row of rows) if (row.user_id) senders.add(row.user_id);
      } else if (table === "federation_deliveries") {
        admins = true;
        for (const row of rows) activities.add(row.activity_id);
      } else if (table === "audit") admins = true;
      else if (table === "instance_settings") {
        // The notification worker keeps its place here; nobody is shown it.
        if (rows.some((row) => !String(row.key).startsWith("push_"))) all = true;
      }
      // A member joining, leaving or being ruled on concerns that member and
      // the channel's own viewers, not every connected browser.
      else if ((table === "memberships" || table === "channel_rules") && rows.length && rows.every(r => typeof r.user_id === "string" && typeof r.channel_id === "string"))
        for (const row of rows) { users.add(row.user_id as string); channels.add(row.channel_id as string); metadata.add(row.channel_id as string); }
      else if (table === "federation_follows" && rows.length && rows.every(r => typeof r.channel_id === "string"))
        for (const row of rows) { channels.add(row.channel_id as string); metadata.add(row.channel_id as string); }
      // An account change is news to its own browsers and to the channels it is seen in.
      else if ((table === "users" || table === "user_roles") && rows.length && rows.every(r => typeof (table === "users" ? r.id : r.user_id) === "string")) {
        accounts = true; admins = true;
        for (const row of rows) changedUsers.add((table === "users" ? row.id : row.user_id) as string);
      } else {
        all = true;
        if (["users", "user_roles", "roles"].includes(table)) accounts = true;
      }
    }
    if (accounts) await this.review();
    if(this.opening.size)this.routeOpened();else this.applyRouting();
    for (const id of changedUsers) {
      // Remote authors appear in channels without a local membership: look everywhere again.
      if (!this.memberships.has(id)) { all = true; break; }
      users.add(id);
      for (const channel of this.memberships.get(id) || []) { channels.add(channel); metadata.add(channel); }
    }
    if (all) {
      for (const stream of this.streams) this.send(stream, { all: true });
      return;
    }
    for (const id of reacted) {
      const message = db.prepare("SELECT channel_id FROM messages WHERE id=?").get(id);
      if (message) { channels.add(message.channel_id); metadata.add(message.channel_id); }
    }
    for (const id of rooms) {
      const room = db.prepare("SELECT user_id FROM xmpp_remote_rooms WHERE id=?").get(id);
      if (room) roomUsers.add(room.user_id);
    }
    for (const id of activities) {
      const sent = db.prepare("SELECT user_id FROM federation_outgoing WHERE id=?").get(id);
      if (sent?.user_id) senders.add(sent.user_id);
    }
    // A channel kept to its members is only news to them, and to the administrators who can read it.
    for(const id of channels)if(!metadata.has(id))this.broadcastDelta(id,changes.filter(c=>c.table==="messages").flatMap(c=>c.rows).filter(r=>r.channel_id===id).map(r=>r.id||r.object).filter(Boolean));
    const audience = new Map<string, Set<string> | null>();
    const timelines = new Set<string>();
    const nativeAudience=[...channels].flatMap(id=>{const c=this.routes.get(id);return c?[{id,visibility:c.visibility,mode:c.mode,members:[] as string[]}]:[];});
    if(nativeAudience!==undefined) {
      const current=new Map(nativeAudience.map(c=>[c.id,c]));
      for(const id of channels) {const channel=current.get(id);if(!channel)continue;
        if(channel.mode==="timeline")timelines.add(id);
        audience.set(id,channel.visibility==="public"?null:new Set(channel.members));
      }
    }
    else for (const id of channels) {
      const channel = db.prepare("SELECT visibility,mode FROM channels WHERE id=?").get(id);
      if (!channel) continue;
      if (channel.mode === "timeline") timelines.add(id);
      audience.set(
        id,
        channel.visibility === "public"
          ? null
          : new Set(
              db
                .prepare("SELECT user_id FROM memberships WHERE channel_id=?")
                .all(id)
                .map((row) => row.user_id as string),
            ),
      );
    }
    const candidates=new Set<Stream>();
    for(const id of channels)for(const stream of this.byChannel.get(id)||[])if(!stream.deltas || stream.slow || metadata.has(id))candidates.add(stream);
    for(const id of new Set([...users,...readers,...roomUsers,...senders]))for(const stream of this.byUser.get(id)||[])candidates.add(stream);
    if(admins)for(const stream of this.adminStreams)candidates.add(stream);
    for (const stream of candidates) {
      const notice: Notice = {};
      if (users.has(stream.user)) notice.me = true;
      if (senders.has(stream.user)) notice.sending = true;
      if (readers.has(stream.user)) notice.read = true;
      if (roomUsers.has(stream.user)) notice.rooms = true;
      if (stream.approved) {
        if (admins && stream.admin) notice.admin = true;
        const seen = [...audience]
          .filter(([id]) => stream.channels.has(id) && (!stream.deltas || stream.slow || metadata.has(id)))
          .map(([id]) => id);
        if (seen.length) {
          notice.channels = seen;
          if (seen.every(id => timelines.has(id) && !metadata.has(id))) notice.content = true;
        }
      }
      if (notice.me || notice.admin || notice.channels || notice.read || notice.rooms || notice.sending) this.send(stream, notice);
    }
  }
}
