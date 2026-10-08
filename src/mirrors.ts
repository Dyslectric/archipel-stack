import { randomUUID } from "node:crypto";
import { Problem, type Message, type Store, type User } from "./store.js";
import type { Xmpp } from "./xmpp.js";

type Input = Record<string, unknown>;
type Source = {
  id: string; channel_id: string; kind: "channel" | "xmpp"; source: string;
  active: number; cursor: number; created_at: string;
};
type RoomRow = { id: string; room: string; nick: string };
type RoomMessage = {
  seq: number; id: string; sender: string; sender_jid: string | null;
  body: string; created_at: string; status: string;
};

/**
 * A mirror is a local channel its owner fills from channels and rooms hosted elsewhere.
 * It copies what the owner's own subscriptions receive, tells the sources nothing, and keeps
 * its copies whatever the sources later edit or remove: the mirror's owner moderates it.
 */
export class Mirrors {
  constructor(readonly store: Store, readonly xmpp: Xmpp) {
    store.mirrorHooks = {
      pull: () => {
        // A mirror that cannot be filled must never reject the message that arrived.
        try { this.pull(); } catch (error) { console.error("Mirror update failed", error); }
      },
    };
  }
  create(user: User, input: Input) {
    return this.store.transaction(() => {
      // A mirror has the format of what it copies, so topics and threads keep their shape.
      const channel = this.store.createChannel(user, { ...input, mode: input.mode ?? "timeline" });
      this.store.db.prepare("INSERT INTO channel_mirrors VALUES(?,0)").run(channel.id);
      this.store.audit(user.id, "mirror.create", channel.id);
      return this.store.channelInfo(user, this.store.channel(channel.id));
    });
  }
  private mirror(user: User, id: string, owning = false) {
    const channel = this.store.channel(id);
    if (owning) this.store.requireOwner(user, channel);
    else this.store.requireManage(user, channel);
    if (!this.store.mirrorState(id)) throw new Problem(404, "This channel is not a mirror.");
    return channel;
  }
  private rows(id: string) {
    return this.store.db.prepare("SELECT * FROM mirror_sources WHERE channel_id=? ORDER BY created_at,id").all(id) as unknown as Source[];
  }
  private room(owner: User, id: string) {
    return this.store.db.prepare("SELECT id,room,nick FROM xmpp_remote_rooms WHERE id=? AND user_id=? AND bridged=0").get(id, owner.id) as RoomRow | undefined;
  }
  /** Sources are read through the owner's own subscriptions, so their state is the owner's. */
  sources(user: User, id: string) {
    const channel = this.mirror(user, id), owner = this.store.user(channel.owner_id);
    return {
      writable: this.store.mirrorState(id) === "writable",
      sources: this.rows(id).map((source) => {
        let name = source.source, state = "unavailable";
        if (source.kind === "channel") {
          const replica = this.store.channel(source.source);
          name = `#${replica.name}`;
          const status = (this.store.db.prepare("SELECT status FROM federation_subscriptions WHERE channel_id=? AND user_id=?")
            .get(replica.id, owner.id) as { status: string } | undefined)?.status;
          state = status === "accepted" ? "following" : status || "not following";
        } else {
          const room = this.room(owner, source.source);
          if (room) {
            name = room.room;
            state = this.xmpp.remoteRooms.list(owner).find((r) => r.id === room.id)?.state || state;
          }
        }
        return { id: source.id, kind: source.kind, name, state, active: !!source.active };
      }),
    };
  }
  addSource(user: User, id: string, input: Input) {
    const channel = this.mirror(user, id, true);
    if (channel.owner_id !== user.id)
      throw new Problem(403, "Only the mirror's owner can add sources: they are read through the owner's own subscriptions.");
    const key = String(input.source || "");
    if (input.kind === "channel") {
      // A channel hosted here is never a source; only one followed from another instance.
      const replica = this.store.channel(key);
      if (!replica.remote_actor)
        throw new Problem(400, "Only channels hosted on other instances can be mirrored.");
      if (replica.mode !== channel.mode)
        throw new Problem(400, `This mirror is a ${channel.mode} channel and only takes sources in the same format.`);
      const followed = this.store.db.prepare("SELECT 1 FROM federation_subscriptions WHERE channel_id=? AND user_id=? AND status='accepted'").get(key, user.id);
      if (!followed) throw new Problem(403, "Follow this channel before mirroring it.");
    } else if (input.kind === "xmpp") {
      if (!this.room(user, key)) throw new Problem(404, "Join this XMPP room before mirroring it.");
      if (channel.mode !== "timeline")
        throw new Problem(400, `This mirror is a ${channel.mode} channel and only takes sources in the same format.`);
    } else throw new Problem(400, "Choose a followed channel or a joined XMPP room.");
    if (this.store.db.prepare("SELECT 1 FROM mirror_sources WHERE channel_id=? AND kind=? AND source=?").get(id, input.kind, key))
      throw new Problem(409, "The mirror already has this source.");
    this.store.transaction(() => {
      this.store.db.prepare("INSERT INTO mirror_sources(id,channel_id,kind,source,created_at) VALUES(?,?,?,?,?)")
        .run(randomUUID(), id, input.kind as string, key, new Date().toISOString());
      this.store.audit(user.id, "mirror.source", JSON.stringify({ channel: id, kind: input.kind, source: key }));
    });
    this.pull();
    return this.sources(user, id);
  }
  /** Pausing keeps the place reached, so resuming brings in what the owner's subscription received meanwhile. */
  setSource(user: User, id: string, sourceId: string, input: Input) {
    this.mirror(user, id, true);
    if (typeof input.active !== "boolean") throw new Problem(400, "Choose whether the source is consumed.");
    if (!this.store.db.prepare("UPDATE mirror_sources SET active=? WHERE id=? AND channel_id=?").run(Number(input.active), sourceId, id).changes)
      throw new Problem(404, "Mirror source not found.");
    this.pull();
    return this.sources(user, id);
  }
  removeSource(user: User, id: string, sourceId: string) {
    this.mirror(user, id, true);
    if (!this.store.db.prepare("DELETE FROM mirror_sources WHERE id=? AND channel_id=?").run(sourceId, id).changes)
      throw new Problem(404, "Mirror source not found.");
    return this.sources(user, id);
  }
  /** Opening a mirror makes it a fork: members write here, and its sources keep arriving. */
  setWritable(user: User, id: string, value: unknown) {
    this.mirror(user, id, true);
    if (typeof value !== "boolean") throw new Problem(400, "Choose whether members can write in the mirror.");
    this.store.transaction(() => {
      this.store.db.prepare("UPDATE channel_mirrors SET writable=? WHERE channel_id=?").run(Number(value), id);
      this.store.audit(user.id, "mirror.writable", JSON.stringify({ channel: id, writable: value }));
    });
    return this.sources(user, id);
  }
  pull() {
    const active = this.store.db.prepare("SELECT * FROM mirror_sources WHERE active=1").all() as unknown as Source[];
    for (const source of active) {
      try {
        this.store.transaction(() => this.pullSource(source));
      } catch (error) {
        // The owner's access to a source can lapse; the mirror waits where it stopped.
        if (!(error instanceof Problem)) throw error;
      }
    }
  }
  private pullSource(source: Source) {
    const mirror = this.store.channel(source.channel_id), owner = this.store.active(mirror.owner_id);
    let cursor = source.cursor;
    // Marked as remote content: readers need the receive grant, and nothing relays it onward.
    const marker = (original: string) => `mirror:${source.id}:${original}`;
    const copied = (id: string | null) => id
      ? (this.store.db.prepare("SELECT id FROM messages WHERE remote_object=?").get(marker(id)) as { id: string } | undefined)?.id ?? null
      : null;
    const copy = (original: string, author: string, body: string, stamp: string, emojis = "[]", parent: string | null = null) =>
      this.store.db.prepare("INSERT OR IGNORE INTO messages(id,channel_id,author_id,body,parent_id,created_at,remote_object,emoji_tags) VALUES(?,?,?,?,?,?,?,?)")
        .run(randomUUID(), mirror.id, author, body, parent, stamp, marker(original), emojis);
    // Topics are matched by title, so sources that share one meet in it.
    const topic = (id: string | null) => {
      if (!id) return null;
      const title = (this.store.db.prepare("SELECT title FROM topics WHERE id=?").get(id) as { title: string }).title;
      const mine = this.store.db.prepare("SELECT id FROM topics WHERE channel_id=? AND title=?").get(mirror.id, title) as { id: string } | undefined;
      if (mine) return mine.id;
      const created = randomUUID();
      this.store.db.prepare("INSERT INTO topics(id,channel_id,title,created_at) VALUES(?,?,?,?)").run(created, mirror.id, title, new Date().toISOString());
      return created;
    };
    for (;;) {
      let count = 0;
      if (source.kind === "channel") {
        const replica = this.store.channel(source.source);
        this.store.requireRead(owner, replica);
        if (!this.store.role(replica.id, owner.id)) throw new Problem(403, "The owner no longer follows this channel.");
        const rows = this.store.db.prepare("SELECT * FROM messages WHERE channel_id=? AND seq>? ORDER BY seq LIMIT 500").all(replica.id, cursor) as unknown as Message[];
        for (const row of rows) {
          cursor = row.seq;
          if (mirror.mode === "timeline") {
            // A reply keeps its link when what it answers was copied too.
            if (!row.history_placeholder && !row.deleted_at) copy(row.id, row.author_id, row.body, row.created_at, row.emoji_tags, copied(row.parent_id));
            continue;
          }
          // Topics and threads keep their shape, so what was already removed or never received
          // is kept as the same empty place the owner sees at the source: replies hang from it.
          this.store.db.prepare("INSERT OR IGNORE INTO messages(id,channel_id,author_id,body,title,topic_id,parent_id,created_at,deleted_at,remote_object,emoji_tags,history_placeholder) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
            .run(randomUUID(), mirror.id, row.author_id, row.body, row.title, topic(row.topic_id), copied(row.parent_id), row.created_at, row.deleted_at, marker(row.id), row.emoji_tags, row.history_placeholder);
        }
        count = rows.length;
      } else {
        const room = this.room(owner, source.source);
        if (!room) throw new Problem(404, "The owner no longer has this room.");
        this.xmpp.remoteRooms.check(owner, room.room);
        const rows = this.store.db.prepare("SELECT * FROM xmpp_remote_messages WHERE subscription_id=? AND seq>? ORDER BY seq LIMIT 500").all(room.id, cursor) as unknown as RoomMessage[];
        for (const row of rows) {
          // The owner's own message is only known to have reached the room once it is confirmed.
          if (["queued", "sent"].includes(row.status)) { count = 0; break; }
          cursor = row.seq; count++;
          if (row.status === "failed") continue;
          let author: User | null;
          try {
            author = row.status === "confirmed" ? owner
              : row.sender_jid?.endsWith(`@${this.xmpp.config.xmppDomain}`) ? this.xmpp.local(row.sender_jid)
              : this.xmpp.identity(row.sender_jid || row.sender, row.sender_jid || row.sender.slice(row.sender.indexOf("/") + 1));
          } catch { author = null; }
          if (author) copy(row.id, author.id, row.body, row.created_at);
        }
      }
      if (count < 500) break;
    }
    if (cursor !== source.cursor)
      this.store.db.prepare("UPDATE mirror_sources SET cursor=? WHERE id=?").run(cursor, source.id);
  }
}
