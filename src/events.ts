// Maintained delivery routes keep ordinary messages off the audience-query path.
// Opted-in browsers receive shared, policy-filtered deltas; control changes and
// older clients retain API invalidations and their fresh authorization checks.
import type { Request, Response } from "express";
import type { Change } from "./db.js";
import type { Store,User,Channel } from "./store.js";
import type { NativeChat } from "./native-chat.js";
import { createHash } from "node:crypto";

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
const WAIT = 40, // changes this close together are told of once
  BEAT = 25000, // a line this often keeps proxies from closing a silent stream
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
  private routingDirty=true;
  private cursors=new Map<string,number>();
  constructor(private store: Store, private native?: NativeChat) {
    store.db.onChange = (changes) => {
      if (!this.streams.size) return;
      if(changes.some(c=>!quiet.has(c.table) && !["messages","read_marks","federation_outgoing","federation_deliveries","audit"].includes(c.table)))this.routingDirty=true;
      this.queue.push(...changes);
      this.timer ??= setTimeout(() => {
        this.timer = null;
        void this.flush().catch(() => {
          // Whatever could not be worked out, everyone looks again rather than miss it.
          this.queue = [];
          for (const stream of this.streams) this.send(stream, { all: true });
        });
      }, WAIT);
    };
  }
  get listeners() {
    return this.streams.size;
  }
  /** Holds the response open as a stream of events for the session behind it. */
  async open(req: Request, res: Response, token: string) {
    if(this.closed)return res.status(503).json({error:"The server is stopping."});
    const nativeSession=await this.native?.eventSession(token);
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
    if(this.routingDirty)this.rebuildRouting();else this.routeStream(stream);
    res.on("close", () => this.drop(stream));
    if (!this.beat) {
      this.beat = setInterval(() => {
        void this.review().then(()=>{for (const s of this.streams) s.res.write(": \n\n");});
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
  }
  private drop(stream: Stream) {
    if (!this.streams.delete(stream)) return;
    const own=this.byUser.get(stream.user);own?.delete(stream);if(!own?.size)this.byUser.delete(stream.user);
    this.adminStreams.delete(stream);
    for(const channel of stream.channels)this.byChannel.get(channel)?.delete(stream);
    stream.res.end();
    if (!this.streams.size && this.beat) {
      clearInterval(this.beat);
      this.beat = null;
    }
  }
  private send(stream: Stream, notice: Notice) {
    this.sendFrame(stream,`data: ${JSON.stringify(notice)}\n\n`);
  }
  private sendFrame(stream:Stream,frame:string|Buffer) {
    if(stream.res.writableLength>1024*1024){this.drop(stream);return;}
    stream.res.write(frame);
  }
  private routeStream(stream:Stream) {
    if(stream.admin)this.adminStreams.add(stream);else this.adminStreams.delete(stream);
    stream.channels.clear();stream.handles.clear();
    stream.blocks=new Set(this.store.db.prepare("SELECT peer FROM user_blocks WHERE user_id=?").all(stream.user).map(r=>r.peer));
    stream.contacts=new Map(this.store.db.prepare("SELECT peer,display_name FROM contact_names WHERE user_id=?").all(stream.user).map(r=>[r.peer,r.display_name]));
    stream.slow=!!this.store.db.prepare("SELECT 1 FROM conversation_prefs WHERE user_id=? AND hidden=1 AND (target LIKE 'thread:%' OR target LIKE 'topic:%') LIMIT 1").get(stream.user);
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
  private rebuildRouting() {
    this.routingDirty=false;this.byChannel.clear();this.routes=new Map(this.store.db.prepare("SELECT * FROM channels").all().map(c=>[c.id,c as Channel]));
    this.memberships.clear();for(const m of this.store.db.prepare("SELECT channel_id,user_id FROM memberships").all()){
      const channels=this.memberships.get(m.user_id)||new Set<string>();channels.add(m.channel_id);this.memberships.set(m.user_id,channels);
    }
    this.blocked=new Set(this.store.db.prepare("SELECT channel_id,user_id FROM channel_rules WHERE rule='block'").all().map(r=>`${r.channel_id}|${r.user_id}`));
    this.federationBlocks=new Set(this.store.db.prepare("SELECT target FROM federation_blocks").all().map(r=>r.target));
    this.federationEnabled=this.store.db.prepare("SELECT value FROM instance_settings WHERE key='federation_enabled'").get()?.value==="true";
    for(const c of this.routes.values())if(!this.cursors.has(c.id))this.cursors.set(c.id,Number(this.store.db.prepare("SELECT COALESCE(MAX(seq),0) AS seq FROM messages WHERE channel_id=?").get(c.id)!.seq));
    for(const stream of this.streams){try{stream.profile=this.store.active(stream.user);}catch{this.drop(stream);continue;}stream.approved=stream.profile.admission_status==="approved";stream.admin=!!stream.profile.admin;this.routeStream(stream);}
  }
  private broadcastDelta(channel:string,changed:string[]) {
    const group=this.byChannel.get(channel);if(!group?.size)return;
    const after=this.cursors.get(channel)||0,page=this.store.liveMessageBatch(channel,after,changed),cursor=Math.max(after,...page.map(m=>m.seq));
    this.cursors.set(channel,cursor);
    const variants=new Map<string,Buffer>(),hasRemote=page.some(m=>m.live_remote),localOnly=hasRemote?page.filter(m=>!m.live_remote):page;
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
      });frame=Buffer.from(`data: ${JSON.stringify({delta:{channel,messages,cursor,added:eligible.filter(m=>m.seq>after && !m.deleted_at && !m.history_placeholder && !stream.blocks.has(m.author_actor_url)).map(m=>m.id)}})}\n\n`);variants.set(key,frame);}
      this.sendFrame(stream,frame);
    }
    if(page.length===100){this.queue.push({table:"messages",rows:[{channel_id:channel}]});this.timer??=setTimeout(()=>{this.timer=null;void this.flush().catch(()=>{});},WAIT);}
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
      } else {
        all = true;
        if (["users", "user_roles", "roles"].includes(table)) accounts = true;
      }
    }
    if (accounts) await this.review();
    if(this.routingDirty)this.rebuildRouting();
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
