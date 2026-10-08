import { randomUUID } from "node:crypto";
import { Problem, hash, text, type User } from "./store.js";
import type { Xmpp } from "./xmpp.js";

type Input = Record<string, unknown>;
type Room = {
  id: string; user_id: string; room: string; nick: string; session: string;
  desired: number; state: string; role: string; subject: string;
  error: string | null; updated_at: number;
};
type Message = {
  seq: number; id: string; subscription_id: string; sender: string; body: string;
  created_at: string; source_key: string | null; status: string; error: string | null;
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
    const me = this.store.active(user.id), access = this.xmpp.remoteAccess(me, `xmpp:${room}`);
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
      can_post: !blocked && !postBlocked && row.desired === 1 && row.state === "joined" &&
        Date.now() - row.updated_at <= 15000 && ["participant", "moderator"].includes(row.role), post_blocked: postBlocked };
  }
  list(user: User) {
    this.store.active(user.id);
    return (this.store.db.prepare("SELECT * FROM xmpp_remote_rooms WHERE user_id=? ORDER BY room").all(user.id) as Room[]).map(r => this.view(r));
  }
  join(user: User, input: Input) {
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
      this.store.db.prepare(`INSERT INTO xmpp_remote_rooms(id,user_id,room,nick,session,updated_at) VALUES(?,?,?,?,?,?)
        ON CONFLICT(user_id,room) DO UPDATE SET nick=excluded.nick,session=excluded.session,desired=1,state='joining',role='none',error=NULL,updated_at=excluded.updated_at`)
        .run(id, user.id, room, nick, session, Date.now());
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
      this.store.db.prepare("UPDATE xmpp_remote_rooms SET desired=0,state='left',role='none',error=NULL,updated_at=? WHERE id=?").run(Date.now(), id);
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
    return { room: this.view(room), messages: rows.slice(0, 100).reverse(), more };
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
      this.store.transaction(() => {
        this.store.db.prepare("UPDATE xmpp_remote_rooms SET state=?,role=?,nick=?,error=?,updated_at=? WHERE id=?")
          .run(state, role, nick, input.error ? text(input.error, "Room error", 500) : null, Date.now(), room.id);
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
      this.store.transaction(() => {
        const ownId = input.origin_id || input.id;
        const own = sender === `${room.room}/${room.nick}` && typeof ownId === "string" && this.store.db.prepare("SELECT id FROM xmpp_remote_messages WHERE id=? AND subscription_id=? AND status IN ('queued','sent','confirmed')").get(ownId, room.id);
        if (own) this.store.db.prepare("UPDATE xmpp_remote_messages SET status='confirmed',source_key=?,body=?,created_at=?,error=NULL WHERE id=?").run(key, body, stamp, ownId as string);
        else this.store.db.prepare("INSERT OR IGNORE INTO xmpp_remote_messages(id,subscription_id,sender,body,created_at,source_key) VALUES(?,?,?,?,?,?)").run(randomUUID(), room.id, sender, body, stamp, key);
      });
    } else throw new Problem(400, "Unknown remote room event.");
    return { ok: true };
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
        this.store.db.prepare("UPDATE xmpp_remote_rooms SET state='error',role='none',error='Room federation access was revoked.' WHERE id=?").run(row.id);
        continue;
      }
      if (["error", "left"].includes(row.state)) continue;
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
