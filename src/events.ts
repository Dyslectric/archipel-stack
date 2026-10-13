// Open browsers are told when something they show has changed, instead of asking every few
// seconds. An event says only where to look again: what is there is still fetched through the
// API, which decides what the reader may see.
import type { Request, Response } from "express";
import type { Change } from "./db.js";
import type { Store } from "./store.js";
import type { NativeChat } from "./native-chat.js";
import { createHash } from "node:crypto";

interface Stream {
  res: Response;
  token: string;
  user: string;
  approved: boolean;
  admin: boolean;
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
  constructor(private store: Store, private native?: NativeChat) {
    store.db.onChange = (changes) => {
      if (!this.streams.size) return;
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
    };
    // A browser with many tabs keeps its newest streams.
    const mine = [...this.streams].filter((s) => s.user === stream.user);
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
    stream.res.end();
    if (!this.streams.size && this.beat) {
      clearInterval(this.beat);
      this.beat = null;
    }
  }
  private send(stream: Stream, notice: Notice) {
    stream.res.write(`data: ${JSON.stringify(notice)}\n\n`);
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
    const audience = new Map<string, Set<string> | null>();
    const timelines = new Set<string>();
    const nativeAudience=await this.native?.audience([...channels]);
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
    for (const stream of this.streams) {
      const notice: Notice = {};
      if (users.has(stream.user)) notice.me = true;
      if (senders.has(stream.user)) notice.sending = true;
      if (readers.has(stream.user)) notice.read = true;
      if (roomUsers.has(stream.user)) notice.rooms = true;
      if (stream.approved) {
        if (admins && stream.admin) notice.admin = true;
        const seen = [...audience]
          .filter(([, members]) => !members || stream.admin || members.has(stream.user))
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
