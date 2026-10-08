import { randomUUID } from "node:crypto";
import { Problem, hash, text, type Message as ChannelMessage, type User } from "./store.js";
import type { Xmpp } from "./xmpp.js";

type Input = Record<string, unknown>;
type Room = {
  id: string; user_id: string; room: string; nick: string; session: string;
  desired: number; state: string; role: string; subject: string;
  error: string | null; updated_at: number; bridged: number;
  attempts: number; retry_at: number | null;
};
// Why a room session ended, when that is likely to pass: the other server or the path to it is down or restarting.
const passing = ["remote-server-not-found", "remote-server-timeout", "service-unavailable", "internal-server-error",
  "recipient-unavailable", "resource-constraint", "undefined-condition", "dropped"];
// Removed on purpose by the room: kicked, banned, or no longer a member of a members-only room.
const removed = ["301", "307", "321", "322"];
type Bridge = { channel_id: string; room: string; created_by: string; created_at: string };
type Message = {
  seq: number; id: string; subscription_id: string; sender: string; body: string;
  created_at: string; source_key: string | null; status: string; error: string | null;
  sender_jid: string | null;
};

/** Browser occupants live in Prosody; each account keeps its own room archive. */
export class RemoteRooms {
  constructor(readonly xmpp: Xmpp) {}
  get store() { return this.xmpp.store; }
  address(value: unknown) {
    const room = this.xmpp.remoteJid(value);
    if (String(value).includes("/") || room.endsWith(`@${this.xmpp.config.xmppDomain}`) || room.endsWith(`@${this.xmpp.rooms}`))
      throw new Problem(400, "Use the bare address of a room hosted on another server.");
    return room;
  }
  check(user: User, room: string, posting = false) {
    this.xmpp.enabled();
    const me = this.store.requirePermission(user, "xmpp_rooms"), access = this.xmpp.remoteAccess(me, `xmpp:${room}`);
    if (access.blocked || !access.incoming || !me.federation_subscribe)
      throw new Problem(403, access.blocked || "Receiving and subscribing to federated rooms must be enabled for this account.");
    if (posting && (!access.outgoing || !me.federation_post))
      throw new Problem(403, "Sending and posting in federated rooms must be enabled for this account.");
  }
  private owned(user: User, id: string) {
    this.store.active(user.id);
    const room = this.store.db.prepare("SELECT * FROM xmpp_remote_rooms WHERE id=? AND user_id=?").get(id, user.id) as Room | undefined;
    if (!room) throw new Problem(404, "XMPP room subscription not found.");
    return room;
  }
  private view(row: Room) {
    let blocked: string | null = null, postBlocked: string | null = null;
    try { this.check(this.store.user(row.user_id), row.room); } catch (e) { blocked = (e as Error).message; }
    try { this.check(this.store.user(row.user_id), row.room, true); } catch (e) { postBlocked = (e as Error).message; }
    return { id: row.id, room: row.room, nick: row.nick, desired: !!row.desired,
      state: row.state === "joined" && Date.now() - row.updated_at > 15000 ? "disconnected" : row.state,
      role: row.role, subject: row.subject, error: row.error, blocked,
      reconnecting: !blocked && row.desired === 1 && row.retry_at !== null && ["error", "left"].includes(row.state),
      can_post: !blocked && !postBlocked && row.desired === 1 && row.state === "joined" &&
        Date.now() - row.updated_at <= 15000 && ["participant", "moderator"].includes(row.role), post_blocked: postBlocked };
  }
  list(user: User) {
    this.store.active(user.id);
    return (this.store.db.prepare("SELECT * FROM xmpp_remote_rooms WHERE user_id=? AND bridged=0 ORDER BY room").all(user.id) as Room[]).map(r => this.view(r));
  }
  join(user: User, input: Input, bridged = false) {
    const room = this.address(input.room);
    this.check(user, room);
    const nick = text(input.nick || this.xmpp.account(user).node, "Nickname", 100);
    if (/[\x00-\x1f\x7f/]/.test(nick)) throw new Problem(400, "Use a nickname without slashes or control characters.");
    const old = this.store.db.prepare("SELECT * FROM xmpp_remote_rooms WHERE user_id=? AND room=?").get(user.id, room) as Room | undefined;
    if (!input.reconnect && old?.desired && old.nick === nick && ["joining", "joined"].includes(old.state) && Date.now() - old.updated_at < 15000)
      return this.view(old);
    const count = this.store.db.prepare("SELECT COUNT(*) AS n FROM xmpp_remote_rooms WHERE user_id=? AND desired=1").get(user.id) as { n: number };
    if ((!old || !old.desired) && count.n >= 50) throw new Problem(400, "Leave a room before joining another (maximum 50).");
    const id = old?.id || randomUUID(), session = randomUUID();
    this.store.transaction(() => {
      this.store.db.prepare(`INSERT INTO xmpp_remote_rooms(id,user_id,room,nick,session,updated_at,bridged) VALUES(?,?,?,?,?,?,?)
        ON CONFLICT(user_id,room) DO UPDATE SET nick=excluded.nick,session=excluded.session,desired=1,state='joining',role='none',error=NULL,updated_at=excluded.updated_at,bridged=excluded.bridged,attempts=0,retry_at=NULL`)
        .run(id, user.id, room, nick, session, Date.now(), Number(bridged));
      this.failPending(id, "The room session changed. Send the message again.");
    });
    return this.view(this.owned(user, id));
  }
  private failPending(id: string, reason: string) {
    this.store.db.prepare("UPDATE xmpp_remote_messages SET status='failed',error=? WHERE subscription_id=? AND status IN ('queued','sent')").run(reason, id);
  }
  leave(user: User, id: string) {
    this.owned(user, id);
    this.store.transaction(() => {
      this.store.db.prepare("UPDATE xmpp_remote_rooms SET desired=0,state='left',role='none',error=NULL,retry_at=NULL,updated_at=? WHERE id=?").run(Date.now(), id);
      this.failPending(id, "You left this room.");
    });
    return { ok: true };
  }
  history(user: User, id: string, before?: unknown) {
    const room = this.owned(user, id);
    this.check(user, room.room);
    const cursor = before === undefined ? Number.MAX_SAFE_INTEGER : Number(before);
    if (!Number.isSafeInteger(cursor) || cursor < 1) throw new Problem(400, "Invalid history cursor.");
    const rows = this.store.db.prepare("SELECT * FROM xmpp_remote_messages WHERE subscription_id=? AND seq<? ORDER BY seq DESC LIMIT 101").all(id, cursor) as Message[];
    const more = rows.length > 100;
    // Blocks name the occupant's own address where the room shows it, and otherwise the nickname in this room.
    const blocked = (m: Message) => this.store.isUserBlocked(user.id, `xmpp:${m.sender}`) ||
      (!!m.sender_jid && this.store.isUserBlocked(user.id, `xmpp:${m.sender_jid}`));
    return { room: this.view(room), more, messages: rows.slice(0, 100).reverse().map(m => blocked(m)
      ? { ...m, blocked: true, body: "This message is hidden because you blocked this user." } : { ...m, blocked: false }) };
  }
  post(user: User, id: string, value: unknown) {
    const room = this.owned(user, id);
    this.check(user, room.room, true);
    if (!this.view(room).can_post) throw new Problem(403, "Join the room with a speaking role before posting.");
    const body = text(value, "Message", 8000), messageId = randomUUID();
    this.store.db.prepare("INSERT INTO xmpp_remote_messages(id,subscription_id,sender,body,created_at,status) VALUES(?,?,?,?,?,'queued')")
      .run(messageId, id, `${room.room}/${room.nick}`, body, new Date().toISOString());
    return { id: messageId };
  }
  /** Only the private adapter calls this; token binds callbacks to a room session. */
  receive(input: Input) {
    const room = this.store.db.prepare("SELECT * FROM xmpp_remote_rooms WHERE session=? AND desired=1").get(text(input.session, "Room session", 100)) as Room | undefined;
    if (!room) throw new Problem(404, "Room session has ended.");
    this.check(this.store.user(room.user_id), room.room);
    const sender = text(input.from, "Room sender", 1024);
    if (sender.split("/")[0] !== room.room) throw new Problem(403, "The stanza does not come from the subscribed room.");
    if (input.kind === "state") {
      const state = text(input.state, "Room state", 20);
      if (!["joining", "joined", "error", "left"].includes(state)) throw new Problem(400, "Unknown room state.");
      const role = ["participant", "moderator", "visitor"].includes(String(input.role)) ? String(input.role) : "none";
      const nick = sender.includes("/") ? sender.slice(sender.indexOf("/") + 1) : room.nick;
      // A session that ended for a passing reason is joined again, a little later each time it fails.
      const codes = Array.isArray(input.codes) ? input.codes.map(String) : [];
      const again = state === "error" ? passing.includes(String(input.condition))
        : state === "left" && !codes.some(code => removed.includes(code));
      const attempts = state === "joined" ? 0 : again ? room.attempts + 1 : room.attempts;
      const retryAt = again && attempts <= 200 ? Date.now() + Math.min(600, 5 * 2 ** Math.min(attempts - 1, 10)) * 1000 : null;
      this.store.transaction(() => {
        this.store.db.prepare("UPDATE xmpp_remote_rooms SET state=?,role=?,nick=?,error=?,updated_at=?,attempts=?,retry_at=? WHERE id=?")
          .run(state, role, nick, input.error ? text(input.error, "Room error", 500) : null, Date.now(), attempts, retryAt, room.id);
        if (state === "error" || state === "left") this.failPending(room.id, "The room session ended.");
        else if (state === "joined" && !["participant", "moderator"].includes(role)) this.failPending(room.id, "The room changed your speaking role.");
      });
    } else if (input.kind === "subject") {
      if (typeof input.subject !== "string" || input.subject.length > 2000) throw new Problem(400, "Invalid room subject.");
      this.store.db.prepare("UPDATE xmpp_remote_rooms SET subject=? WHERE id=?").run(input.subject, room.id);
    } else if (input.kind === "message-error") {
      this.store.db.prepare("UPDATE xmpp_remote_messages SET status='failed',error=? WHERE id=? AND subscription_id=? AND status IN ('queued','sent')")
        .run(text(input.error || "The room rejected this message.", "Message error", 500), String(input.id), room.id);
    } else if (input.kind === "message") {
      if (!sender.includes("/")) throw new Problem(400, "Room messages require an occupant nickname.");
      const body = text(input.body, "Message", 8000);
      const stamp = typeof input.stamp === "string" && Number.isFinite(Date.parse(input.stamp)) ? new Date(input.stamp).toISOString() : new Date().toISOString();
      // Trust stanza-id only when the adapter checked its 'by' against this room.
      const key = input.stable_id ? `room:${text(input.stable_id, "Room message ID", 200)}` :
        input.id ? hash(JSON.stringify([sender, text(input.id, "Message ID", 200)])) :
        input.stamp ? hash(JSON.stringify([sender, stamp, body])) : null;
      let real: string | null = null;
      try { if (input.real_jid) real = this.xmpp.remoteJid(String(input.real_jid).toLowerCase()); }
      catch { /* An address the room reports in another form is simply not shown. */ }
      this.store.transaction(() => {
        const ownId = input.origin_id || input.id;
        const own = sender === `${room.room}/${room.nick}` && typeof ownId === "string" && this.store.db.prepare("SELECT id FROM xmpp_remote_messages WHERE id=? AND subscription_id=? AND status IN ('queued','sent','confirmed')").get(ownId, room.id);
        if (own) this.store.db.prepare("UPDATE xmpp_remote_messages SET status='confirmed',source_key=?,body=?,created_at=?,error=NULL WHERE id=?").run(key, body, stamp, ownId as string);
        // An occupant that only speaks for a bridged channel keeps no private archive of the room.
        else if (!room.bridged) this.store.db.prepare("INSERT OR IGNORE INTO xmpp_remote_messages(id,subscription_id,sender,body,created_at,source_key,sender_jid) VALUES(?,?,?,?,?,?,?)").run(randomUUID(), room.id, sender, body, stamp, key, real);
        this.bridgeIn(room, sender, body, stamp, key, real, ownId);
      });
      this.store.mirrorHooks?.pull();
    } else throw new Problem(400, "Unknown remote room event.");
    return { ok: true };
  }
  // ---- bridges: a local timeline channel and one external room carry the same conversation ----
  private bridgeOf(channelId: string) {
    return this.store.db.prepare("SELECT * FROM channel_bridges WHERE channel_id=?").get(channelId) as Bridge | undefined;
  }
  bridge(user: User, channelId: string) {
    this.store.requireManage(user, this.store.channel(channelId));
    const bridge = this.bridgeOf(channelId);
    if (!bridge) return { room: null };
    const listener = this.store.db.prepare("SELECT * FROM xmpp_remote_rooms WHERE user_id=? AND room=?").get(bridge.created_by, bridge.room) as Room | undefined;
    const view = listener && this.view(listener);
    return { room: bridge.room, state: view?.desired ? view.state : "left", error: view?.blocked || view?.error || null };
  }
  setBridge(user: User, channelId: string, value: unknown) {
    this.xmpp.enabled();
    const channel = this.store.channel(channelId);
    this.store.requireOwner(user, channel);
    if (channel.mode !== "timeline") throw new Problem(400, "Only timeline channels can be bridged with an XMPP room.");
    if (this.store.mirrorState(channelId)) throw new Problem(400, "A mirror takes rooms as sources instead of a bridge.");
    const room = this.address(value);
    this.check(user, room, true);
    return this.store.transaction(() => {
      if (this.store.db.prepare("SELECT 1 FROM channel_bridges WHERE room=? AND channel_id!=?").get(room, channelId))
        throw new Problem(409, "Another channel is already bridged with that room.");
      if (this.bridgeOf(channelId)?.room !== room) {
        this.unbridge(channelId);
        this.store.db.prepare("INSERT INTO channel_bridges VALUES(?,?,?,?)").run(channelId, room, user.id, new Date().toISOString());
        this.store.audit(user.id, "channel.bridge", JSON.stringify({ channel: channelId, room }));
      }
      this.occupy(user, room);
      return this.bridge(user, channelId);
    });
  }
  removeBridge(user: User, channelId: string) {
    this.store.requireOwner(user, this.store.channel(channelId));
    this.store.transaction(() => {
      if (!this.bridgeOf(channelId)) return;
      this.unbridge(channelId);
      this.store.audit(user.id, "channel.bridge", JSON.stringify({ channel: channelId, room: null }));
    });
    return { room: null };
  }
  private unbridge(channelId: string) {
    const bridge = this.bridgeOf(channelId);
    if (!bridge) return;
    for (const row of this.store.db.prepare("SELECT id FROM xmpp_remote_rooms WHERE room=? AND bridged=1").all(bridge.room) as { id: string }[]) {
      this.store.db.prepare("UPDATE xmpp_remote_rooms SET desired=0,state='left',role='none',error=NULL,updated_at=? WHERE id=?").run(Date.now(), row.id);
      this.failPending(row.id, "The channel is no longer bridged with this room.");
    }
    this.store.db.prepare("DELETE FROM channel_bridge_seen WHERE channel_id=?").run(channelId);
    this.store.db.prepare("DELETE FROM channel_bridges WHERE channel_id=?").run(channelId);
  }
  /** Each author speaks in the room as themselves; a room they joined on their own account is reused. */
  private occupy(user: User, room: string) {
    const find = () => this.store.db.prepare("SELECT * FROM xmpp_remote_rooms WHERE user_id=? AND room=?").get(user.id, room) as Room | undefined;
    const old = find();
    if (old?.desired && ["joining", "joined"].includes(old.state)) return old;
    this.join(user, { room, nick: old?.nick, reconnect: true }, true);
    return find()!;
  }
  /** A local member's new channel message is repeated in the bridged room when their own grants allow it. */
  relay(message: ChannelMessage) {
    const bridge = this.bridgeOf(message.channel_id), author = this.store.user(message.author_id);
    if (!bridge || author.remote_actor || message.remote_object) return;
    try {
      this.check(author, bridge.room, true);
      const occupant = this.occupy(author, bridge.room);
      this.store.db.prepare("INSERT INTO xmpp_remote_messages(id,subscription_id,sender,body,created_at,status,relay_of) VALUES(?,?,?,?,?,'queued',?)")
        .run(randomUUID(), occupant.id, `${occupant.room}/${occupant.nick}`, message.body, message.created_at, message.id);
    } catch (error) {
      // Without the grants, or room, to speak there the message simply stays local.
      if (!(error instanceof Problem)) throw error;
    }
  }
  /** What the room says enters the channel once, whichever bridged occupants hear it. */
  private bridgeIn(room: Room, sender: string, body: string, stamp: string, key: string | null, real: string | null, id: unknown) {
    const bridge = this.store.db.prepare("SELECT * FROM channel_bridges WHERE room=?").get(room.room) as Bridge | undefined;
    // A member's private subscription to the same room never feeds a channel someone else bridged.
    if (!bridge || (!room.bridged && room.user_id !== bridge.created_by) || sender.length > 400) return;
    if (!key && room.user_id !== bridge.created_by) return;
    const known = typeof id === "string" ? this.store.db.prepare("SELECT m.relay_of,r.user_id FROM xmpp_remote_messages m JOIN xmpp_remote_rooms r ON r.id=m.subscription_id WHERE m.id=? AND r.room=?")
      .get(id, room.room) as { relay_of: string | null; user_id: string } | undefined : undefined;
    if (known?.relay_of) return;
    if (key && !this.store.db.prepare("INSERT OR IGNORE INTO channel_bridge_seen VALUES(?,?)").run(bridge.channel_id, key).changes) return;
    let author: User | null;
    try {
      author = known ? this.store.active(known.user_id)
        : real?.endsWith(`@${this.xmpp.config.xmppDomain}`) ? this.xmpp.local(real)
        : this.xmpp.identity(real || sender, real || sender.slice(sender.indexOf("/") + 1));
    } catch { author = null; }
    if (!author) return;
    // Written directly, as for occupants of other servers: nothing here is relayed onward.
    const messageId = randomUUID();
    this.store.db.prepare("INSERT INTO messages(id,channel_id,author_id,body,created_at) VALUES(?,?,?,?,?)").run(messageId, bridge.channel_id, author.id, body, stamp);
    this.store.db.prepare("INSERT INTO xmpp_events(kind,object_id) VALUES('Create',?)").run(messageId);
  }
  sync(input: Input) {
    const active = Array.isArray(input.active) ? input.active : [];
    if (active.length > 10000) throw new Problem(400, "Invalid remote room inventory.");
    const desired: { session: string; from: string; room: string; nick: string }[] = [];
    const messages: { session: string; id: string; body: string }[] = [];
    for (const row of this.store.db.prepare("SELECT * FROM xmpp_remote_rooms WHERE desired=1").all() as Room[]) {
      try { this.check(this.store.user(row.user_id), row.room); }
      catch {
        this.failPending(row.id, "Room federation access was revoked.");
        this.store.db.prepare("UPDATE xmpp_remote_rooms SET state='error',role='none',error='Room federation access was revoked.',retry_at=NULL WHERE id=?").run(row.id);
        continue;
      }
      if (["error", "left"].includes(row.state)) {
        if (row.retry_at === null || row.retry_at > Date.now()) continue;
        this.store.db.prepare("UPDATE xmpp_remote_rooms SET state='joining',role='none',retry_at=NULL,updated_at=? WHERE id=?").run(Date.now(), row.id);
        row.state = "joining";
      }
      desired.push({ session: row.session, from: `${this.xmpp.jid(this.store.user(row.user_id))}/archipel-room-${row.session}`, room: row.room, nick: row.nick });
      if (active.includes(row.session)) this.store.db.prepare("UPDATE xmpp_remote_rooms SET updated_at=? WHERE id=?").run(Date.now(), row.id);
      if (row.state !== "joined" || !active.includes(row.session) || !["participant", "moderator"].includes(row.role)) continue;
      try { this.check(this.store.user(row.user_id), row.room, true); }
      catch { this.failPending(row.id, "Posting permission was revoked."); continue; }
      for (const message of this.store.db.prepare("SELECT id,body FROM xmpp_remote_messages WHERE subscription_id=? AND status='queued' ORDER BY seq LIMIT 50").all(row.id) as Message[])
        messages.push({ session: row.session, id: message.id, body: message.body });
    }
    return { desired, messages };
  }
  dispatched(input: Input) {
    const room = this.store.db.prepare("SELECT * FROM xmpp_remote_rooms WHERE session=? AND desired=1").get(String(input.session)) as Room | undefined;
    if (!room) throw new Problem(404, "Room session has ended.");
    this.check(this.store.user(room.user_id), room.room, true);
    if (!this.view(room).can_post) throw new Problem(403, "The room no longer permits posting.");
    const update = this.store.db.prepare("UPDATE xmpp_remote_messages SET status='sent' WHERE subscription_id=? AND id=? AND status='queued'").run(room.id, String(input.id));
    if (update.changes !== 1) throw new Problem(409, "The message was already dispatched or cancelled.");
    return { ok: true };
  }
}
