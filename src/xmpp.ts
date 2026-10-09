import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { Router, type RequestHandler } from "express";
import type { Config } from "./config.js";
import { Store, Problem, hash, randomToken, text, type User, type Channel, type Message } from "./store.js";
import { RemoteRooms } from "./xmpp-remote-rooms.js";

type Input = Record<string, unknown>;
type Account = { user_id: string; node: string };
type Credential = { id: string; user_id: string; digest: string; revoked_at: string | null };
type Direct = { id: string; user_id: string; peer: string; direction: string; body: string; created_at: string; seq: number; xmpp_source_id: string | null };
type Delivery = { id: string; from: string; to: string; body: string; type: string; stamp: string; replace?: string; stanza_id?: string; origin_id?: string; by?: string };
function equal(a: string, b: string) {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Prosody owns streams/routing/MUC presence; all content and policy live in Store. */
export class Xmpp {
  readonly rooms: string;
  readonly remoteRooms: RemoteRooms;
  constructor(readonly store: Store, readonly config: Config) {
    this.rooms = `channels.${config.xmppDomain}`;
    this.remoteRooms = new RemoteRooms(this);
    if (!config.xmppDomain) return;
    const savedDomain = store.db.prepare("SELECT value FROM instance_settings WHERE key='xmpp_domain'").get()?.value;
    if (savedDomain && savedDomain !== config.xmppDomain)
      throw new Error("XMPP_DOMAIN cannot change after account provisioning; restore the saved domain.");
    store.db.prepare("INSERT OR IGNORE INTO instance_settings VALUES('xmpp_domain',?)").run(config.xmppDomain);
    store.xmppHooks = {
      profile: (user) => {
        if (!user.remote_actor) store.db.prepare("INSERT INTO xmpp_events(kind,object_id,sender_id) VALUES('Profile',?,?)").run(user.id, user.id);
      },
      message: (message, kind) => {
        const channel = store.channel(message.channel_id);
        // Cross-protocol forwarding is deliberately not implicit.
        if (!channel.remote_actor && channel.mode === "timeline" && !message.remote_object)
          store.db.prepare("INSERT INTO xmpp_events(kind,object_id) VALUES(?,?)").run(kind, message.id);
        if (kind === "Create") this.remoteRooms.relay(message);
      },
      direct: (id, sender, recipient) => {
        store.db.prepare("INSERT INTO xmpp_events(kind,object_id,sender_id,recipient) VALUES('Direct',?,?,?)")
          .run(id, sender.id, this.jid(recipient));
      },
      access: (user, peer) => this.remoteAccess(user, peer),
    };
  }
  enabled() {
    if (!this.config.xmppDomain) throw new Problem(503, "XMPP is not configured.");
  }
  account(user: User): Account {
    this.enabled();
    if (user.remote_actor) throw new Problem(400, "Only local accounts have local XMPP identities.");
    let account = this.store.db.prepare("SELECT * FROM xmpp_accounts WHERE user_id=?").get(user.id) as Account | undefined;
    if (!account) {
      const candidate = /^[a-z0-9][a-z0-9._-]{0,39}$/.test(user.username) ? user.username : `u-${user.id}`;
      const occupied = this.store.db.prepare("SELECT 1 FROM xmpp_accounts WHERE node=?").get(candidate);
      account = { user_id: user.id, node: occupied ? `u-${user.id}` : candidate };
      this.store.db.prepare("INSERT INTO xmpp_accounts VALUES(?,?)").run(account.user_id, account.node);
    }
    return account;
  }
  jid(user: User) { return `${this.account(user).node}@${this.config.xmppDomain}`; }
  local(address: string) {
    const bare = address.split("/")[0], at = bare.lastIndexOf("@");
    if (at < 1 || bare.slice(at + 1) !== this.config.xmppDomain)
      throw new Problem(403, "This operation requires a local XMPP account.");
    const account = this.store.db.prepare("SELECT * FROM xmpp_accounts WHERE node=?").get(bare.slice(0, at)) as Account | undefined;
    if (!account) throw new Problem(404, "XMPP account not found.");
    return this.store.active(account.user_id);
  }
  foreign(address: string) {
    const bare = address.split("/")[0];
    return bare.slice(bare.lastIndexOf("@") + 1) !== this.config.xmppDomain;
  }
  /** Foreign occupants are xmpp: remote users; a JID never links to a local or ActivityPub account. */
  private remoteUser(address: string) {
    const row = this.store.db.prepare("SELECT id FROM users WHERE remote_actor=?").get(`xmpp:${address}`) as { id: string } | undefined;
    return row ? this.store.user(row.id) : null;
  }
  /** The xmpp: identity for an address, created on first sight; null when administrators blocked or suspended it. */
  identity(address: string, name = address) {
    if (this.blockedXmppDomains().includes(address.split("/")[0].split("@")[1]) ||
      this.store.db.prepare("SELECT 1 FROM federation_blocks WHERE target=?").get(`xmpp:${address}`)) return null;
    let user = this.remoteUser(address);
    if (!user) {
      const id = randomUUID(), taken = this.store.db.prepare("SELECT 1 FROM users WHERE username=?").get(address);
      this.store.db.prepare("INSERT INTO users(id,username,display_name,created_at,remote_actor) VALUES(?,?,?,?,?)")
        .run(id, taken ? `${address}-${id.slice(0, 6)}` : address, name.slice(0, 80), new Date().toISOString(), `xmpp:${address}`);
      user = this.store.user(id);
    }
    return user.banned || user.admission_status !== "approved" ? null : user;
  }
  /** Content only crosses the server boundary for channels whose moderators opted into federation. */
  private foreignPolicy(address: string, channel: Channel) {
    if (!this.federationEnabled()) throw new Problem(403, "Federation is disabled on this instance.");
    if (this.blockedXmppDomains().includes(address.slice(address.lastIndexOf("@") + 1)) ||
      this.store.db.prepare("SELECT 1 FROM federation_blocks WHERE target=?").get(`xmpp:${address}`))
      throw new Problem(403, "This XMPP identity or domain is blocked.");
    if (!channel.federation_enabled || channel.visibility !== "public")
      throw new Problem(403, "This room does not admit members of other servers.");
  }
  /** Returns the known identity, or null for a newcomer who may still join. */
  private admissible(address: string, channel: Channel) {
    this.foreignPolicy(address, channel);
    const known = this.remoteUser(address), user = known && this.store.active(known.id);
    const rule = user && this.store.rule(channel.id, user.id);
    if (rule === "block") throw new Problem(403, "You are blocked from this channel.");
    if (!(user && this.store.role(channel.id, user.id)) && channel.admission !== "open" && rule !== "allow")
      throw new Problem(403, "This channel requires an invitation.");
    return user;
  }
  /** Receive grants gate foreign authors; send and post grants gate what foreign occupants are shown. */
  private visibleAuthors(viewer: User) {
    if (viewer.remote_actor)
      return "author_id IN (SELECT id FROM users WHERE remote_actor IS NOT NULL OR (federation_send=1 AND federation_post=1 AND banned=0 AND admission_status='approved'))";
    return this.federationEnabled() && viewer.federation_receive ? "1=1" : "author_id NOT IN (SELECT id FROM users WHERE remote_actor LIKE 'xmpp:%')";
  }
  private nick(user: User) {
    return user.remote_actor?.startsWith("xmpp:") ? user.remote_actor.slice(5) : this.account(user).node;
  }
  credential(user: User, id: unknown) {
    if (typeof id !== "string") throw new Problem(401, "XMPP authentication is required.");
    const credential = this.store.db.prepare("SELECT * FROM xmpp_credentials WHERE id=? AND user_id=? AND revoked_at IS NULL")
      .get(id, user.id) as Credential | undefined;
    if (!credential) throw new Problem(401, "XMPP credential has been revoked.");
    return credential;
  }
  authorize(input: Input) {
    const user = this.local(text(input.from, "Sender", 1024));
    this.credential(user, input.credential);
    return user;
  }
  status(user: User) {
    this.store.active(user.id);
    if (!this.config.xmppDomain) return { enabled: false };
    return {
      enabled: true, jid: this.jid(user), domain: this.config.xmppDomain,
      rooms: this.rooms, port: this.config.xmppClientPort,
      credentials: this.store.db.prepare("SELECT id,label,created_at FROM xmpp_credentials WHERE user_id=? AND revoked_at IS NULL ORDER BY created_at")
        .all(user.id),
      channels: this.store.listChannels(user).filter(c => !c.remote_actor && c.mode === "timeline")
        .map(c => ({ id: c.id, name: c.name, jid: `${c.name}@${this.rooms}` })),
    };
  }
  issue(user: User, label: unknown) {
    this.store.active(user.id);
    this.enabled();
    const name = text(label, "Credential name", 80);
    const count = this.store.db.prepare("SELECT COUNT(*) AS n FROM xmpp_credentials WHERE user_id=? AND revoked_at IS NULL").get(user.id) as { n: number };
    if (count.n >= 20) throw new Problem(400, "Revoke an old XMPP credential before adding another.");
    const id = randomUUID(), secret = randomToken(), password = `${id}.${secret}`;
    this.store.db.prepare("INSERT INTO xmpp_credentials(id,user_id,label,digest,created_at) VALUES(?,?,?,?,?)")
      .run(id, user.id, name, hash(password), new Date().toISOString());
    this.store.audit(user.id, "xmpp.credential.create", id);
    return { id, jid: this.jid(user), password };
  }
  revoke(user: User, id: string) {
    this.store.active(user.id);
    this.store.db.prepare("UPDATE xmpp_credentials SET revoked_at=? WHERE id=? AND user_id=?")
      .run(new Date().toISOString(), id, user.id);
    this.store.audit(user.id, "xmpp.credential.revoke", id);
  }
  verify(input: Input) {
    try {
      const node = text(input.username, "Username", 128), password = text(input.password, "Password", 200);
      const user = this.local(`${node}@${this.config.xmppDomain}`);
      const credential = this.credential(user, password.split(".")[0]);
      if (!equal(hash(password), credential.digest)) return { valid: false };
      return { valid: true, credential: credential.id };
    } catch { return { valid: false }; }
  }
  remoteAccess(user: User, peer: string) {
    const me = this.store.active(user.id), address = peer.slice(5);
    const on = this.federationEnabled();
    const domain = address.split("@")[1];
    const instanceBlocked = this.blockedXmppDomains().includes(domain);
    const blocked = this.store.isUserBlocked(me.id, peer) || instanceBlocked || !!this.store.db.prepare("SELECT 1 FROM federation_blocks WHERE target=?")
      .get(peer);
    return { incoming: on && !blocked && !!me.federation_receive, outgoing: on && !blocked && !!me.federation_send,
      blocked: blocked ? "This XMPP identity or domain is blocked." : !on ? "Federation is disabled on this instance." : null };
  }
  private blockedXmppDomains() {
    return (this.store.db.prepare("SELECT target FROM federation_blocks WHERE kind='instance'").all() as { target: string }[])
      .map(({ target }) => {
        try { return new URL(target).hostname; }
        catch { return target; }
      });
  }
  private federationEnabled() {
    return this.store.db.prepare("SELECT value FROM instance_settings WHERE key='federation_enabled'").get()?.value === "true";
  }
  remoteJid(value: unknown) {
    const address = text(value, "XMPP recipient", 1024).replace(/^xmpp:/, "").split("/")[0];
    if (!/^[a-z0-9._=-]+@[a-z0-9]+(?:[a-z0-9.-]*[a-z0-9])?$/.test(address))
      throw new Problem(400, "Use a lowercase bare XMPP JID.");
    return address;
  }
  sendDirect(user: User, to: unknown, bodyValue: unknown) {
    this.store.requirePermission(user, "direct_messages");
    const target = this.remoteJid(to);
    if (target.endsWith(`@${this.config.xmppDomain}`)) {
      const recipient = this.local(target);
      return this.store.sendDirect(user, recipient.id, bodyValue);
    }
    const access = this.remoteAccess(user, `xmpp:${target}`);
    if (!access.outgoing || access.blocked) throw new Problem(403, access.blocked || "Sending XMPP federation is disabled for this account.");
    const body = text(bodyValue, "Message", 8000), id = randomUUID(), stamp = new Date().toISOString();
    this.store.transaction(() => {
      this.store.db.prepare("INSERT INTO direct_messages(id,user_id,peer,direction,body,created_at) VALUES(?,?,?,'outgoing',?,?)")
        .run(id, user.id, `xmpp:${target}`, body, stamp);
      this.store.db.prepare("INSERT INTO xmpp_events(kind,object_id,sender_id,recipient) VALUES('Direct',?,?,?)")
        .run(id, user.id, target);
      this.requestAvatar(user, `xmpp:${target}`);
    });
    return { peer: `xmpp:${target}`, id };
  }
  room(value: unknown) {
    const address = text(value, "Room", 512).split("/")[0];
    if (!address.endsWith(`@${this.rooms}`)) throw new Problem(404, "Unknown XMPP room.");
    const row = this.store.db.prepare("SELECT id FROM channels WHERE name=? AND mode='timeline' AND remote_actor IS NULL")
      .get(address.slice(0, -(this.rooms.length + 1))) as { id: string } | undefined;
    if (!row) throw new Problem(404, "Only local timeline channels are exposed as XMPP rooms.");
    return this.store.channel(row.id);
  }
  roomAccess(user: User, room: string) {
    const channel = this.room(room);
    if (user.remote_actor) {
      this.foreignPolicy(user.remote_actor.slice(5), channel);
      this.store.active(user.id);
    } else this.store.requireRead(user, channel);
    if (!this.store.role(channel.id, user.id) || this.store.rule(channel.id, user.id) === "block")
      throw new Problem(403, "Channel membership is required.");
    return channel;
  }
  private stanzaScope(input: Input) {
    const sender = text(input.from, "Sender", 1024);
    const stream = input.stream === undefined ? "" : text(input.stream, "Stream ID", 200);
    return hash(JSON.stringify([sender, stream]));
  }
  deduplicate(input: Input, fn: () => unknown) {
    const sender = this.stanzaScope(input);
    const id = text(input.id, "Stanza ID", 200);
    const digest = hash(JSON.stringify([input.operation, input.to, input.body, input.replace, input.origin_id]));
    return this.store.transaction(() => {
      const prior = this.store.db.prepare("SELECT digest,result FROM xmpp_incoming WHERE sender=? AND stanza_id=?")
        .get(sender, id) as { digest: string; result: string } | undefined;
      if (prior) {
        if (prior.digest !== digest) throw new Problem(409, "This stanza ID was already used for different content.");
        return JSON.parse(prior.result);
      }
      const result = fn();
      this.store.db.prepare("INSERT INTO xmpp_incoming VALUES(?,?,?,?)").run(sender, id, digest, JSON.stringify(result));
      return result;
    });
  }
  operation(input: Input) {
    if (input.operation === "exists") {
      try { this.local(`${text(input.username, "Username", 128)}@${this.config.xmppDomain}`); return { exists: true }; }
      catch { return { exists: false }; }
    }
    if (input.operation === "vcard") return this.vcard(input);
    if (input.operation === "avatar-hash") return { hash: this.avatar(this.authorize(input))?.hash || "" };
    if (input.operation === "vcard-access") {
      const user = this.authorize(input), peer = `xmpp:${this.remoteJid(input.to)}`;
      const access = this.remoteAccess(user, peer);
      if (access.blocked || (!access.incoming && !access.outgoing)) throw new Problem(403, "Remote profile access is disabled.");
      return { valid: true };
    }
    if (input.operation === "avatar-refresh") {
      const sender = this.remoteJid(input.from), user = this.local(text(input.to, "Recipient", 1024));
      const peer = `xmpp:${sender}`, access = this.remoteAccess(user, peer);
      if (access.blocked || (!access.incoming && !access.outgoing)) throw new Problem(403, "Remote profile access is disabled.");
      if (input.photo === "") {
        this.store.cacheRemoteAvatar(peer, null, "");
        this.store.db.prepare("DELETE FROM xmpp_avatar_requests WHERE peer=?").run(peer);
      }
      else {
        const current = this.store.db.prepare("SELECT image FROM remote_avatars WHERE peer=?").get(peer) as { image: Uint8Array } | undefined;
        const currentHash = current ? createHash("sha1").update(current.image).digest("hex") : "";
        if (typeof input.photo === "string" && /^[a-f0-9]{40}$/i.test(input.photo) && currentHash !== input.photo.toLowerCase()) this.requestAvatar(user, peer, true);
      }
      return { valid: true };
    }
    if (input.operation === "direct" && !String(input.from).split("/")[0].endsWith(`@${this.config.xmppDomain}`)) {
      // Only authenticated s2s origins may call this branch (the private adapter enforces that).
      const sender = this.remoteJid(input.from), recipient = this.local(text(input.to, "Recipient", 1024));
      const access = this.remoteAccess(recipient, `xmpp:${sender}`);
      if (!access.incoming || access.blocked) throw new Problem(403, access.blocked || "Receiving XMPP federation is disabled.");
      return this.deduplicate(input, () => {
        const id = randomUUID(), body = text(input.body, "Message", 8000), stamp = new Date().toISOString();
        this.store.db.prepare("INSERT INTO direct_messages(id,user_id,peer,direction,body,created_at) VALUES(?,?,?,'incoming',?,?)")
          .run(id, recipient.id, `xmpp:${sender}`, body, stamp);
        this.store.db.prepare("INSERT INTO xmpp_events(kind,object_id,recipient) VALUES('Direct',?,?)").run(id, this.jid(recipient));
        this.recordDirectId(id, input);
        this.requestAvatar(recipient, `xmpp:${sender}`);
        return { id };
      });
    }
    if (typeof input.from === "string" && this.foreign(input.from)) return this.foreignOperation(input);
    const user = this.authorize(input);
    switch (input.operation) {
      case "check": return { valid: true };
      case "remote-room-check": {
        if (input.mode !== "leave") this.remoteRooms.check(user, this.remoteRooms.address(input.to), input.mode === "post");
        return { valid: true };
      }
      case "rooms": return { rooms: this.status(user).channels };
      // The rooms a client should open by itself: the local timeline channels this account is in.
      case "bookmarks": return { nick: this.account(user).node,
        rooms: this.store.listChannels(user).filter(c => !c.remote_actor && c.mode === "timeline" && c.role)
          .map(c => ({ name: c.name, jid: `${c.name}@${this.rooms}` })) };
      case "join": {
        const channel = this.room(input.to);
        this.store.join(user, channel.id);
        this.store.requireRead(user, channel);
        return { name: channel.name, description: channel.description };
      }
      // What a room is can be asked by whoever may read the channel, so a client learns its features before joining.
      case "read": { this.store.requireRead(user, this.room(input.to)); return { valid: true }; }
      case "post": {
        const channel = this.roomAccess(user, text(input.to, "Room", 512));
        this.store.requirePost(user, channel);
        return this.deduplicate(input, () => {
          if (input.replace) {
            const reference = text(input.replace, "Message ID", 200);
            const aliases = this.store.db.prepare("SELECT i.message_id,i.scope FROM xmpp_message_ids i JOIN messages m ON m.id=i.message_id WHERE i.sender=? AND m.channel_id=? AND (i.stanza_id=? OR i.origin_id=?)")
              .all(this.jid(user), channel.id, reference, reference) as { message_id: string; scope: string }[];
            const scoped = aliases.filter(a => a.scope === this.stanzaScope(input));
            const candidates = scoped.length ? scoped : aliases;
            if (candidates.length > 1) throw new Problem(409, "Correction reference is ambiguous; use the archive message ID.");
            const alias = candidates[0];
            const message = this.store.message(alias?.message_id || reference);
            if (message.channel_id !== channel.id) throw new Problem(400, "Correction must target this room.");
            return { id: this.store.editMessage(user, message.id, { body: input.body, expected_edited_at: message.edited_at }).id };
          }
          const message = this.store.post(user, channel.id, { body: input.body });
          const origin = input.origin_id === undefined ? null : text(input.origin_id, "Origin ID", 200);
          this.store.db.prepare("INSERT INTO xmpp_message_ids VALUES(?,?,?,?,?)")
            .run(message.id, this.jid(user), String(input.id), origin, this.stanzaScope(input));
          return { id: message.id };
        });
      }
      case "direct": return this.deduplicate(input, () => {
        const result = this.sendDirect(user, input.to, input.body);
        this.recordDirectId(result.id, input);
        return result;
      });
      case "archive": return this.archive(user, input);
      default: throw new Problem(400, "Unknown XMPP operation.");
    }
  }
  /** Room traffic from another home server; the adapter marks authenticated s2s origins. */
  private foreignOperation(input: Input) {
    if (input.s2s !== true) throw new Problem(403, "This operation requires a local XMPP account.");
    const sender = text(input.from, "Sender", 1024), address = this.remoteJid(sender);
    if (address.length > 320) throw new Problem(400, "Use a shorter XMPP address.");
    const member = () => {
      const user = this.remoteUser(address);
      if (!user) throw new Problem(403, "Channel membership is required.");
      return user;
    };
    switch (input.operation) {
      case "join": {
        const channel = this.room(input.to);
        return this.store.transaction(() => {
          let user = this.admissible(address, channel);
          if (!user) {
            const id = randomUUID(), taken = this.store.db.prepare("SELECT 1 FROM users WHERE username=?").get(address);
            this.store.db.prepare("INSERT INTO users(id,username,display_name,created_at,remote_actor) VALUES(?,?,?,?,?)")
              .run(id, taken ? `${address}-${id.slice(0, 6)}` : address, address.slice(0, 80), new Date().toISOString(), `xmpp:${address}`);
            user = this.store.user(id);
          }
          const occupant = user;
          if (!this.store.role(channel.id, occupant.id))
            this.store.db.prepare("INSERT INTO memberships VALUES(?,?,'member')").run(channel.id, occupant.id);
          const wanted = Math.floor(Number(input.history)), limit = Math.min(100, wanted >= 0 ? wanted : 0);
          const rows = this.store.db.prepare(`SELECT id FROM messages WHERE channel_id=? AND remote_object IS NULL AND ${this.visibleAuthors(occupant)} ORDER BY seq DESC LIMIT ?`)
            .all(channel.id, limit) as { id: string }[];
          return { name: channel.name, description: channel.description,
            history: rows.reverse().map(row => this.channelDelivery(occupant, this.store.message(row.id), sender)) };
        });
      }
      case "read": { this.admissible(address, this.room(input.to)); return { valid: true }; }
      case "post": {
        const user = member(), channel = this.roomAccess(user, text(input.to, "Room", 512));
        if (input.replace) throw new Problem(400, "Corrections from other servers are not supported.");
        return this.deduplicate(input, () => {
          // Written directly: ActivityPub grants and relays apply to local authors only.
          const id = randomUUID(), body = text(input.body, "Message", 8000);
          const origin = input.origin_id === undefined ? null : text(input.origin_id, "Origin ID", 200);
          this.store.db.prepare("INSERT INTO messages(id,channel_id,author_id,body,created_at) VALUES(?,?,?,?,?)")
            .run(id, channel.id, user.id, body, new Date().toISOString());
          this.store.db.prepare("INSERT INTO xmpp_events(kind,object_id) VALUES('Create',?)").run(id);
          this.store.db.prepare("INSERT INTO xmpp_message_ids VALUES(?,?,?,?,?)").run(id, address, String(input.id), origin, this.stanzaScope(input));
          return { id };
        });
      }
      case "archive": {
        if (!input.room) throw new Problem(403, "This operation requires a local XMPP account.");
        return this.archive(member(), input, sender);
      }
      default: throw new Problem(403, "This operation requires a local XMPP account.");
    }
  }
  private avatar(user: User) {
    const picture = this.store.db.prepare("SELECT mime,image FROM user_avatars WHERE user_id=?").get(user.id) as { mime: string; image: Uint8Array } | undefined;
    return picture ? { mime: picture.mime, image: Buffer.from(picture.image).toString("base64"), hash: createHash("sha1").update(picture.image).digest("hex") } : null;
  }
  vcard(input: Input) {
    const from = text(input.from, "Sender", 1024), user = this.local(text(input.to || from, "Profile account", 1024));
    if (from.split("/")[0].endsWith(`@${this.config.xmppDomain}`)) this.authorize(input);
    else {
      const access = this.remoteAccess(user, `xmpp:${this.remoteJid(from)}`);
      if (access.blocked || !access.outgoing) throw new Problem(403, "Profile federation is disabled.");
    }
    return { name: user.display_name, jid: this.jid(user), avatar: this.avatar(user) };
  }
  requestAvatar(user: User, peer: string, force = false) {
    const access = this.remoteAccess(user, peer);
    if (access.blocked || (!access.incoming && !access.outgoing)) return;
    const previous = this.store.db.prepare("SELECT requested_at FROM xmpp_avatar_requests WHERE peer=?").get(peer) as { requested_at: number } | undefined;
    if (!force && previous && previous.requested_at > Date.now() - 60000) return;
    this.store.db.prepare("INSERT INTO xmpp_avatar_requests(peer,requester_id,requested_at) VALUES(?,?,?) ON CONFLICT(peer) DO UPDATE SET requester_id=excluded.requester_id,requested_at=excluded.requested_at")
      .run(peer, user.id, Date.now());
  }
  cacheAvatar(input: Input) {
    if (input.operation === "set") {
      const user = this.authorize(input);
      if (input.to && String(input.to).split("/")[0] !== this.jid(user)) throw new Problem(403, "Only your own profile may be changed.");
      if (input.image === null) this.store.removeAvatar(user);
      else this.store.setAvatar(user, typeof input.image === "string" ? input.image.replace(/\s/g, "") : input.image);
      return { valid: true };
    }
    const peer = `xmpp:${this.remoteJid(input.peer)}`, requester = this.local(text(input.requester, "Requester", 1024));
    const access = this.remoteAccess(requester, peer);
    if (access.blocked || (!access.incoming && !access.outgoing)) throw new Problem(403, "Remote profile access is disabled.");
    const request = this.store.db.prepare("SELECT requester_id,last_attempt FROM xmpp_avatar_requests WHERE peer=?").get(peer) as { requester_id: string; last_attempt: number } | undefined;
    if (!request || request.requester_id !== requester.id || request.last_attempt !== input.attempt)
      throw new Problem(403, "No matching profile request.");
    const image = typeof input.image === "string" ? input.image.replace(/\s/g, "") : input.image;
    this.store.cacheRemoteAvatar(peer, image, peer);
    return { valid: true };
  }
  private recordDirectId(id: string, input: Input) {
    const origin = input.origin_id === undefined ? null : text(input.origin_id, "Origin ID", 200);
    this.store.db.prepare("INSERT INTO xmpp_direct_ids VALUES(?,?,?)").run(id, String(input.id), origin);
  }
  channelDelivery(user: User, message: Message, to: string, kind = "Create"): Delivery {
    const channel = this.store.channel(message.channel_id), view = this.store.messageFor(user, message);
    const native = this.store.db.prepare("SELECT stanza_id,origin_id FROM xmpp_message_ids WHERE message_id=?")
      .get(message.id) as { stanza_id: string; origin_id: string | null } | undefined;
    // Use a stable nick shared with the presence adapter, even across reconnects.
    return { id: kind === "Create" ? message.id : `${message.id}-${kind}-${kind === "Delete" ? message.deleted_at : message.edited_at}`,
      from: `${channel.name}@${this.rooms}/${this.nick(this.store.user(message.author_id))}`,
      to, type: "groupchat", body: message.deleted_at ? "This message was removed." : view.body,
      stamp: message.created_at,
      ...(kind === "Create" && native ? { stanza_id: native.stanza_id, ...(native.origin_id ? { origin_id: native.origin_id } : {}) } : {}),
      ...(kind !== "Create" ? { replace: native?.stanza_id || message.id } : {}) };
  }
  directDelivery(row: Direct, to: string): Delivery {
    const owner = this.store.user(row.user_id), me = this.jid(owner);
    const peer = row.peer.startsWith("xmpp:") ? row.peer.slice(5) : this.jid(this.store.user(row.peer.slice(row.peer.lastIndexOf("/") + 1)));
    const id = row.xmpp_source_id || row.id;
    const native = this.store.db.prepare("SELECT stanza_id,origin_id FROM xmpp_direct_ids WHERE source_id=?").get(id) as
      { stanza_id: string; origin_id: string | null } | undefined;
    return { id, from: row.direction === "outgoing" ? me : peer, to,
      by: to.split("/")[0].endsWith(`@${this.config.xmppDomain}`) ? to.split("/")[0] : me,
      body: row.body, stamp: row.created_at, type: "chat",
      ...(native ? { stanza_id: native.stanza_id, ...(native.origin_id ? { origin_id: native.origin_id } : {}) } : {}) };
  }
  archive(user: User, input: Input, to = this.jid(user)) {
    const room = input.room ? text(input.room, "Room", 512) : null;
    const clauses: string[] = [], parameters: (string | number)[] = [];
    const table = room ? "messages" : "direct_messages";
    if (room) {
      const channel = this.roomAccess(user, room);
      clauses.push("channel_id=?", "remote_object IS NULL", this.visibleAuthors(user)); parameters.push(channel.id);
    } else {
      const me = this.store.active(user.id), prefix = `${this.store.baseUrl}/actors/users/`;
      const on = this.federationEnabled();
      clauses.push("user_id=?", "(substr(peer,1,?)=? OR (peer LIKE 'xmpp:%' AND ((direction='incoming' AND ?=1) OR (direction='outgoing' AND ?=1))))");
      parameters.push(me.id, prefix.length, prefix, Number(on && !!me.federation_receive), Number(on && !!me.federation_send));
      clauses.push("peer NOT IN (SELECT peer FROM user_blocks WHERE user_id=?)", "peer NOT IN (SELECT target FROM federation_blocks WHERE kind='actor')");
      parameters.push(me.id);
      const domains = this.blockedXmppDomains();
      if (domains.length) {
        clauses.push(`(peer NOT LIKE 'xmpp:%' OR substr(peer,instr(peer,'@')+1) NOT IN (${domains.map(() => "?").join(",")}))`);
        parameters.push(...domains);
      }
    }
    const withJid = input.with ? text(input.with, "Archive peer", 1024).split("/")[0] : null;
    if (withJid && room) throw new Problem(400, "Room archive author filtering is unsupported.");
    if (withJid) {
      const address = this.remoteJid(withJid);
      let peer = `xmpp:${address}`;
      if (address.endsWith(`@${this.config.xmppDomain}`)) {
        // Historical local conversations remain readable after peer suspension.
        const node = address.slice(0, -(this.config.xmppDomain.length + 1));
        const binding = this.store.db.prepare("SELECT user_id FROM xmpp_accounts WHERE node=?").get(node) as { user_id: string } | undefined;
        peer = `${this.store.baseUrl}/actors/users/${binding?.user_id || "unknown"}`;
      }
      clauses.push("peer=?"); parameters.push(peer);
    }
    for (const key of ["start", "end"] as const) if (input[key] !== undefined) {
      const stamp = typeof input[key] === "string" ? Date.parse(input[key]) : NaN;
      if (!Number.isFinite(stamp)) throw new Problem(400, "Invalid archive timestamp.");
      clauses.push(`created_at${key === "start" ? ">=" : "<="}?`); parameters.push(new Date(stamp).toISOString());
    }
    const max = input.max === undefined ? 50 : Number(input.max);
    if (!Number.isInteger(max) || max < 0 || max > 100) throw new Problem(400, "Archive page size must be 0–100.");
    if (input.after !== undefined && input.before !== undefined) throw new Problem(400, "Use one archive cursor.");
    const base = clauses.join(" AND "), baseParams = [...parameters];
    const count = Number(this.store.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${base}`).get(...baseParams)!.n);
    const reverse = input.before !== undefined;
    if (input.after !== undefined || (input.before !== undefined && input.before !== "")) {
      const cursor = this.store.db.prepare(`SELECT seq FROM ${table} WHERE ${base} AND ${room ? "id" : "COALESCE(xmpp_source_id,id)"}=?`)
        .get(...baseParams, String(input.after ?? input.before));
      if (!cursor) throw new Problem(404, "Archive cursor not found.");
      clauses.push(`seq${reverse ? "<" : ">"}?`); parameters.push(Number(cursor.seq));
    }
    let page = this.store.db.prepare(`SELECT * FROM ${table} WHERE ${clauses.join(" AND ")} ORDER BY seq ${reverse ? "DESC" : "ASC"} LIMIT ?`)
      .all(...parameters, max) as unknown as (Message | Direct)[];
    if (reverse) page = page.reverse();
    const offset = page[0] ? Number(this.store.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${base} AND seq<?`).get(...baseParams, page[0].seq)!.n) : 0;
    const messages = page.map(row => {
      if (room) return this.channelDelivery(user, this.store.message(row.id), to);
      const direct = row as Direct, delivery = this.directDelivery(direct, this.jid(user));
      if (direct.direction === "outgoing") delivery.to = direct.peer.startsWith("xmpp:") ? direct.peer.slice(5) : this.jid(this.store.user(direct.peer.slice(direct.peer.lastIndexOf("/") + 1)));
      return delivery;
    });
    return { messages, first: messages[0]?.id, last: messages.at(-1)?.id, index: offset, count,
      complete: reverse ? offset === 0 : offset + page.length >= count };
  }
  sync(input: Input) {
    const after = Number(input.after);
    if (!Number.isSafeInteger(after) || after < 0) throw new Problem(400, "Invalid event cursor.");
    if (!Array.isArray(input.sessions) || input.sessions.length > 2000 || !Array.isArray(input.occupants) || input.occupants.length > 4000)
      throw new Problem(400, "Invalid XMPP session inventory.");
    const disconnect: string[] = [], kick: { room: string; jid: string }[] = [];
    const sessions: { jid: string; user: User }[] = [];
    for (const entry of input.sessions as Input[]) {
      const address = text(entry.jid, "Session JID", 1024);
      try { sessions.push({ jid: address, user: this.authorize({ from: address, credential: entry.credential }) }); }
      catch { disconnect.push(address); }
    }
    const occupants: { room: string; jid: string; user: User }[] = [];
    for (const entry of input.occupants as Input[]) {
      const address = text(entry.jid, "Occupant JID", 1024), room = text(entry.room, "Room", 512);
      const session = sessions.find(s => s.jid === address);
      try {
        // Foreign occupants have no local stream; current room policy alone keeps them.
        const user = this.foreign(address) ? this.remoteUser(this.remoteJid(address)) : session?.user;
        if (!user) throw new Problem(403, "No authorized session.");
        this.roomAccess(user, room);
        occupants.push({ room, jid: address, user });
      } catch { kick.push({ room, jid: address }); }
    }
    // A cursor past every event issued here was kept for another database (Prosody's volume
    // outlived this one, or a backup was restored): nothing new would ever reach it, so it starts
    // again from what exists now.
    const issued = Number(this.store.db.prepare("SELECT seq FROM sqlite_sequence WHERE name='xmpp_events'").get()?.seq ?? 0);
    const from = Math.min(after, issued);
    const events = this.store.db.prepare("SELECT * FROM xmpp_events WHERE seq>? ORDER BY seq LIMIT 100")
      .all(from) as { seq: number; kind: string; object_id: string; sender_id: string | null; recipient: string | null }[];
    const messages: Delivery[] = [], profiles: { jid: string; hash: string }[] = [];
    for (const event of events) {
      if (event.kind === "Profile") {
        try {
          const user = this.store.active(event.object_id);
          profiles.push({ jid: this.jid(user), hash: this.avatar(user)?.hash || "" });
        } catch { /* Suspended accounts do not publish profiles. */ }
      } else if (event.kind === "Direct") {
        const row = this.store.db.prepare("SELECT * FROM direct_messages WHERE id=?").get(event.object_id) as Direct;
        if (!row) continue;
        if (row.peer.startsWith("xmpp:")) {
          try {
            const user = this.store.active(row.user_id), access = this.remoteAccess(user, row.peer);
            if (access.blocked || !(row.direction === "outgoing" ? access.outgoing : access.incoming)) continue;
            if (row.direction === "outgoing") messages.push(this.directDelivery(row, row.peer.slice(5)));
            else for (const session of sessions.filter(s => s.user.id === row.user_id)) messages.push(this.directDelivery(row, session.jid));
          } catch { /* Current admission/federation policy cancels delivery. */ }
        } else {
          try {
            const sender = this.store.active(row.user_id), recipient = this.local(event.recipient!);
            if (this.store.isUserBlocked(sender.id, row.peer) || this.store.isUserBlocked(recipient.id, `${this.store.baseUrl}/actors/users/${sender.id}`)) continue;
            for (const session of sessions.filter(s => s.user.id === recipient.id)) messages.push(this.directDelivery(row, session.jid));
          } catch { /* Suspension cancels pending delivery. */ }
        }
      } else {
        const message = this.store.message(event.object_id), channel = this.store.channel(message.channel_id);
        for (const occupant of occupants.filter(o => o.room === `${channel.name}@${this.rooms}`))
          if (this.store.db.prepare(`SELECT 1 FROM messages WHERE id=? AND ${this.visibleAuthors(occupant.user)}`).get(message.id))
            messages.push(this.channelDelivery(occupant.user, message, occupant.jid, event.kind));
      }
    }
    const avatarRequests: { peer: string; requester: string; attempt: number }[] = [];
    const pending = this.store.db.prepare("SELECT * FROM xmpp_avatar_requests WHERE requested_at>last_attempt ORDER BY requested_at LIMIT 10").all() as { peer: string; requester_id: string }[];
    for (const request of pending) {
      const attempt = Date.now();
      this.store.db.prepare("UPDATE xmpp_avatar_requests SET last_attempt=? WHERE peer=?").run(attempt, request.peer);
      try {
        const user = this.store.active(request.requester_id), access = this.remoteAccess(user, request.peer);
        if (!access.blocked && (access.incoming || access.outgoing)) avatarRequests.push({ peer: request.peer.slice(5), requester: this.jid(user), attempt });
      } catch { /* Current policy cancels queued remote profile reads. */ }
    }
    return { after: events.at(-1)?.seq ?? from, messages, disconnect, kick, profiles, avatar_requests: avatarRequests };
  }
  internalRouter() {
    const router = Router();
    router.use(((req, _res, next) => {
      if (!this.config.xmppDomain || !equal(req.headers.authorization || "", `Bearer ${this.config.xmppBridgeSecret}`))
        return next(new Problem(401, "XMPP adapter authentication required."));
      next();
    }) as RequestHandler);
    router.post("/auth", (req, res) => res.json(this.verify(req.body || {})));
    router.post("/operation", (req, res) => res.json(this.operation(req.body || {})));
    router.post("/sync", (req, res) => res.json(this.sync(req.body || {})));
    router.post("/avatars", (req, res) => res.json(this.cacheAvatar(req.body || {})));
    router.post("/remote-rooms/sync", (req, res) => res.json(this.remoteRooms.sync(req.body || {})));
    router.post("/remote-rooms/receive", (req, res) => res.json(this.remoteRooms.receive(req.body || {})));
    router.post("/remote-rooms/dispatched", (req, res) => res.json(this.remoteRooms.dispatched(req.body || {})));
    return router;
  }
}
