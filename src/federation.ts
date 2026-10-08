import {
  generateKeyPairSync,
  randomUUID,
  sign,
  verify,
  createPublicKey,
} from "node:crypto";
import type { Request } from "express";
import type { Config } from "./config.js";
import {
  Store,
  Problem,
  hash,
  text,
  type User,
  type Channel,
  type Message,
} from "./store.js";
import {
  peerUrl,
  peerJson,
  peerRequest,
  signedHeaders,
  signatureKey,
  verifyRequest,
} from "./federation-net.js";

const context = [
  "https://www.w3.org/ns/activitystreams",
  "https://w3id.org/security/v1",
  {
    archipel: "https://archipel.invalid/ns#",
    archipelVersion: "archipel:version",
    channel: "archipel:channel",
    mode: "archipel:mode",
    admission: "archipel:admission",
    visibility: "archipel:visibility",
    topic: "archipel:topic",
    topics: "archipel:topics",
    proof: "archipel:proof",
    emoji: "archipel:emoji",
  },
];
const flags = [
  "federation_send",
  "federation_receive",
  "federation_subscribe",
  "federation_post",
] as const;
type Doc = Record<string, any>;
type Outgoing = {
  id: string;
  activity: string;
  signer: string;
  user_id: string | null;
  channel_id: string | null;
  purpose: string;
};
const time = () => new Date().toISOString();

export class Federation {
  private importing = false;
  private busy = false;
  constructor(
    readonly store: Store,
    readonly config: Config,
  ) {
    store.db
      .prepare(
        "INSERT OR IGNORE INTO instance_settings VALUES('federation_enabled','false')",
      )
      .run();
    store.federationHooks = {
      profile: (user) => this.profileChanged(user),
      write: (user, channel) => {
        if (this.importing) return;
        if (channel.remote_actor)
          throw new Problem(400, "Remote writes must go through federation.");
        if (channel.federation_enabled) {
          this.require(user, "federation_send");
          this.require(user, "federation_post");
        }
      },
      read: (user, channel) => {
        if (channel.remote_actor) {
          this.require(user, "federation_receive");
          this.require(user, "federation_subscribe");
          this.allowed(channel.remote_actor);
        }
      },
      message: (message, type, user) => {
        // XMPP occupants of other servers are never attributed to ActivityPub.
        if (
          !this.importing &&
          store.channel(message.channel_id).federation_enabled &&
          !store.user(message.author_id).remote_actor?.startsWith("xmpp:")
        )
          this.relay(message, type, user);
      },
      direct: (user, peer) => {
        let reachable = true;
        try {
          this.allowed(peer);
        } catch {
          reachable = false;
        }
        const on = this.enabled();
        return {
          incoming: reachable && on && !!user.federation_receive,
          outgoing: reachable,
          blocked: !on
            ? "Federation is disabled on this instance."
            : !reachable
              ? "This remote instance or member is blocked."
              : !user.federation_send
                ? "Your administrator has not allowed your account to send federated messages."
                : null,
        };
      },
    };
  }
  enabled() {
    return (
      this.store.db
        .prepare(
          "SELECT value FROM instance_settings WHERE key='federation_enabled'",
        )
        .get()?.value === "true"
    );
  }
  ensureEnabled() {
    if (!this.enabled())
      throw new Problem(
        403,
        "Federation is disabled by this instance administrator.",
      );
  }
  require(user: User, flag: (typeof flags)[number]) {
    this.ensureEnabled();
    const current = this.store.active(user.id);
    if (current.remote_actor || !current[flag])
      throw new Problem(
        403,
        `Your administrator has disabled ${flag.replace("federation_", "federated ")} permission.`,
      );
    return current;
  }
  allowed(value: string) {
    const url = peerUrl(value, this.config);
    if (
      this.store.db
        .prepare("SELECT 1 FROM federation_blocks WHERE target=? OR target=?")
        .get(value, url.origin)
    )
      throw new Problem(403, "This remote instance or actor is blocked.");
    return url;
  }
  userActor(user: User) {
    return (
      user.remote_actor || `${this.config.baseUrl}/actors/users/${user.id}`
    );
  }
  channelActor(channel: Channel) {
    return (
      channel.remote_actor ||
      `${this.config.baseUrl}/actors/channels/${channel.id}`
    );
  }
  keys() {
    let keys = this.store.db
      .prepare("SELECT * FROM federation_keys WHERE id=1")
      .get() as { private_key: string; public_key: string } | undefined;
    if (!keys) {
      const generated = generateKeyPairSync("rsa", {
        modulusLength: 2048,
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
        publicKeyEncoding: { type: "spki", format: "pem" },
      });
      this.store.db
        .prepare("INSERT INTO federation_keys VALUES(1,?,?)")
        .run(generated.privateKey, generated.publicKey);
      keys = {
        private_key: generated.privateKey,
        public_key: generated.publicKey,
      };
    }
    return keys;
  }
  publicActor(kind: "users" | "channels", id: string): Doc {
    this.ensureEnabled();
    let data: Doc;
    if (kind === "users") {
      const user = this.store.user(id);
      const previouslyFederated = !!this.store.db
        .prepare("SELECT 1 FROM federation_outgoing WHERE user_id=? LIMIT 1")
        .get(id);
      if (
        user.remote_actor ||
        user.admission_status !== "approved" ||
        (!flags.some((f) => user[f]) && !previouslyFederated)
      )
        throw new Problem(404, "Actor is not federated.");
      data = {
        id: this.userActor(user),
        type: "Person",
        preferredUsername: user.username,
        name: user.display_name,
        icon: !user.banned && flags.some(f => user[f]) && this.store.avatarUrl(user.id) ? {
          type: "Image", mediaType: this.store.avatarImage(user.id).mime,
          url: `${this.config.baseUrl}/federation/avatars/${user.id}?v=${this.store.db.prepare("SELECT revision FROM user_avatars WHERE user_id=?").get(user.id)!.revision}`,
        } : null,
      };
    } else {
      const channel = this.store.channel(id);
      if (!channel.federation_enabled || channel.remote_actor)
        throw new Problem(404, "Channel is not federated.");
      data = {
        id: this.channelActor(channel),
        type: "Group",
        preferredUsername: channel.name,
        name: channel.name,
        summary: channel.description,
        mode: channel.mode,
        visibility: channel.visibility,
        admission: channel.admission,
      };
    }
    return {
      "@context": context,
      ...data,
      archipelVersion: 1,
      inbox: `${this.config.baseUrl}/federation/inbox`,
      outbox: `${data.id}/outbox`,
      publicKey: {
        id: `${data.id}#main-key`,
        owner: data.id,
        publicKeyPem: this.keys().public_key,
      },
    };
  }
  async actor(id: string, refresh = false): Promise<Doc> {
    this.ensureEnabled();
    const url = this.allowed(id);
    if (url.origin === this.config.baseUrl) {
      const match = /^\/actors\/(users|channels)\/([a-f0-9-]+)$/.exec(
        url.pathname,
      );
      if (!match || url.search)
        throw new Problem(404, "Local actor not found.");
      return this.publicActor(match[1] as "users" | "channels", match[2]);
    }
    const cache = this.store.db
      .prepare("SELECT * FROM federation_actors WHERE id=?")
      .get(id) as { document: string; fetched_at: number } | undefined;
    if (!refresh && cache && cache.fetched_at > Date.now() - 60000)
      return JSON.parse(cache.document) as Doc;
    const actor = await peerJson(url, this.config);
    if (
      actor.id !== id ||
      !["Person", "Group"].includes(actor.type) ||
      actor.archipelVersion !== 1 ||
      typeof actor.inbox !== "string" ||
      actor.publicKey?.owner !== id ||
      actor.publicKey?.id !== `${id}#main-key` ||
      typeof actor.publicKey?.publicKeyPem !== "string" ||
      actor.publicKey.publicKeyPem.length > 10000
    )
      throw new Problem(
        400,
        "This actor does not support the Archipel federation profile.",
      );
    if (this.allowed(actor.inbox).origin !== url.origin)
      throw new Problem(400, "An actor inbox must be on its home instance.");
    const key = createPublicKey(actor.publicKey.publicKeyPem);
    if (
      key.asymmetricKeyType !== "rsa" ||
      (key.asymmetricKeyDetails?.modulusLength || 0) < 2048
    )
      throw new Problem(
        400,
        "Actor must use an RSA signing key of at least 2048 bits.",
      );
    await this.syncAvatar(actor, refresh);
    this.store.db
      .prepare(
        "INSERT INTO federation_actors VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET document=excluded.document,fetched_at=excluded.fetched_at",
      )
      .run(id, JSON.stringify(actor), Date.now());
    return actor;
  }
  private async syncAvatar(actor: Doc, refresh = false) {
    if (actor.type !== "Person") return;
    if (!actor.icon) { this.store.cacheRemoteAvatar(actor.id, null, ""); return; }
    try {
      if (actor.icon.type !== "Image") return;
      const url = this.allowed(actor.icon.url);
      if (url.origin !== new URL(actor.id).origin) return;
      const cached = this.store.db.prepare("SELECT source FROM remote_avatars WHERE peer=?").get(actor.id);
      if (!refresh && cached?.source === url.href) return;
      const image = await peerRequest(url, this.config, { accept: "image/png,image/jpeg,image/gif,image/webp" }, undefined, 2097152, 3000);
      this.ensureEnabled(); this.allowed(actor.id);
      this.store.cacheRemoteAvatar(actor.id, image.body.toString("base64"), url.href);
    } catch { /* An unavailable or invalid optional image must not reject messages. */ }
  }
  private profileChanged(user: User) {
    if (!this.enabled() || user.remote_actor || !flags.some(f => user[f])) return;
    const recipients = (this.store.db.prepare(`
      SELECT peer AS actor FROM direct_messages WHERE user_id=? AND peer LIKE 'http%'
      UNION SELECT f.actor FROM federation_follows f JOIN messages m ON m.channel_id=f.channel_id WHERE m.author_id=? AND f.status='accepted'
      UNION SELECT c.remote_actor AS actor FROM memberships m JOIN channels c ON c.id=m.channel_id WHERE m.user_id=? AND c.remote_actor IS NOT NULL
    `).all(user.id, user.id, user.id) as { actor: string }[]).map(r => r.actor);
    if (recipients.length) this.queue("Update", this.userActor(user), this.publicActor("users", user.id), recipients, "profile", user.id, null);
  }
  async authenticate(req: Request, rawBody?: Buffer) {
    this.ensureEnabled();
    const values = signatureKey(req),
      id = values.keyId.slice(0, -"#main-key".length);
    const actor = await this.actor(id);
    verifyRequest(req, actor, rawBody);
    if (req.headers.host !== new URL(this.config.baseUrl).host)
      throw new Problem(401, "Signed host must match this instance.");
    this.allowed(id);
    return actor;
  }
  status() {
    return {
      enabled: this.enabled(),
      blocks: this.store.db
        .prepare("SELECT * FROM federation_blocks ORDER BY target")
        .all(),
      deliveries: this.store.db
        .prepare(
          "SELECT status,COUNT(*) AS count FROM federation_deliveries GROUP BY status",
        )
        .all(),
      recent: this.store.db
        .prepare(
          "SELECT d.id,d.recipient,d.status,d.attempts,d.error,o.purpose FROM federation_deliveries d JOIN federation_outgoing o ON o.id=d.activity_id ORDER BY d.id DESC LIMIT 30",
        )
        .all(),
    };
  }
  setEnabled(admin: User, value: unknown) {
    this.store.requireAdmin(admin);
    if (typeof value !== "boolean")
      throw new Problem(400, "Federation enabled must be a boolean.");
    this.store.transaction(() => {
      this.store.db
        .prepare(
          "UPDATE instance_settings SET value=? WHERE key='federation_enabled'",
        )
        .run(String(value));
      this.store.audit(admin.id, "federation.enabled", String(value));
    });
    if (value) this.keys();
    return this.status();
  }
  setPermissions(admin: User, id: string, input: Doc) {
    this.store.requireAdmin(admin);
    const target = this.store.user(id);
    if (
      target.remote_actor ||
      !flags.every((flag) => typeof input[flag] === "boolean") ||
      Object.keys(input).some((key) => !flags.includes(key as any))
    )
      throw new Problem(
        400,
        "Provide all four federation permissions for a local user.",
      );
    this.store.transaction(() => {
      this.store.db
        .prepare(
          "UPDATE users SET federation_send=?,federation_receive=?,federation_subscribe=?,federation_post=? WHERE id=?",
        )
        .run(...flags.map((flag) => Number(input[flag])), id);
      if (!input.federation_subscribe || !input.federation_receive) {
        const subscriptions = this.store.db
          .prepare(
            "SELECT * FROM federation_subscriptions WHERE user_id=? AND status IN ('pending','accepted')",
          )
          .all(id) as unknown as { channel_id: string; follow_id: string }[];
        for (const sub of subscriptions)
          this.unsubscribe(target, sub.channel_id, true);
      }
      this.store.audit(
        admin.id,
        "federation.permissions",
        JSON.stringify({ user: id, ...input }),
      );
    });
    return this.store.profile(this.store.user(id), true);
  }
  block(admin: User, input: Doc) {
    this.store.requireAdmin(admin);
    if (
      !["instance", "actor"].includes(input.kind) ||
      typeof input.blocked !== "boolean"
    )
      throw new Problem(
        400,
        "Choose an instance or actor and a boolean block status.",
      );
    const url = peerUrl(input.target, this.config);
    const target = input.kind === "instance" ? url.origin : url.href;
    if (url.origin === this.config.baseUrl)
      throw new Problem(400, "Cannot block the home instance.");
    this.store.transaction(() => {
      if (input.blocked)
        this.store.db
          .prepare("INSERT OR REPLACE INTO federation_blocks VALUES(?,?)")
          .run(target, input.kind);
      else
        this.store.db
          .prepare("DELETE FROM federation_blocks WHERE target=?")
          .run(target);
      this.store.audit(
        admin.id,
        input.blocked ? "federation.block" : "federation.unblock",
        target,
      );
    });
    return this.status();
  }
  setChannel(user: User, id: string, enabled: unknown) {
    const channel = this.store.channel(id);
    this.store.requireManage(user, channel);
    if (typeof enabled !== "boolean")
      throw new Problem(400, "Choose a boolean federation setting.");
    if (enabled) this.ensureEnabled();
    this.store.transaction(() => {
      this.store.db
        .prepare("UPDATE channels SET federation_enabled=? WHERE id=?")
        .run(Number(enabled), id);
      if (!enabled) {
        const follows = this.store.db
          .prepare(
            "SELECT * FROM federation_follows WHERE channel_id=? AND status!='blocked'",
          )
          .all(id) as unknown as { actor: string; follow_id: string }[];
        for (const follow of follows) {
          this.queue(
            "Reject",
            this.channelActor(channel),
            {
              id: follow.follow_id,
              type: "Follow",
              actor: follow.actor,
              object: this.channelActor(channel),
            },
            [follow.actor],
            "cleanup",
            null,
            id,
          );
        }
        this.store.db
          .prepare(
            "UPDATE federation_follows SET status='blocked' WHERE channel_id=?",
          )
          .run(id);
      }
      this.store.audit(
        user.id,
        "channel.federation",
        JSON.stringify({ channel: id, enabled }),
      );
    });
    return this.store.channelInfo(user, this.store.channel(id));
  }
  followers(user: User, id: string) {
    this.store.requireManage(user, this.store.channel(id));
    return this.store.db
      .prepare(
        "SELECT * FROM federation_follows WHERE channel_id=? ORDER BY actor",
      )
      .all(id);
  }
  decideFollow(user: User, id: string, actor: string, decision: unknown) {
    const channel = this.store.channel(id);
    this.store.requireManage(user, channel);
    this.ensureEnabled();
    if (
      !channel.federation_enabled ||
      !["accepted", "blocked"].includes(String(decision))
    )
      throw new Problem(400, "Choose accept or block on a federated channel.");
    this.allowed(actor);
    const follow = this.store.db
      .prepare(
        "SELECT * FROM federation_follows WHERE channel_id=? AND actor=?",
      )
      .get(id, actor) as { follow_id: string } | undefined;
    if (!follow) throw new Problem(404, "Remote follower not found.");
    this.store.transaction(() => {
      this.store.db
        .prepare(
          "UPDATE federation_follows SET status=? WHERE channel_id=? AND actor=?",
        )
        .run(String(decision), id, actor);
      this.followAnswer(
        channel,
        actor,
        follow.follow_id,
        decision === "accepted",
      );
      this.store.audit(
        user.id,
        "channel.remote-follower",
        JSON.stringify({ channel: id, actor, decision }),
      );
    });
  }
  private followAnswer(
    channel: Channel,
    actor: string,
    followId: string,
    accept: boolean,
  ) {
    this.queue(
      accept ? "Accept" : "Reject",
      this.channelActor(channel),
      {
        id: followId,
        type: "Follow",
        actor,
        object: this.channelActor(channel),
      },
      [actor],
      "membership",
      null,
      channel.id,
    );
  }
  private remoteUser(actor: Doc) {
    if (new URL(actor.id).origin === this.config.baseUrl) {
      const prefix = `${this.config.baseUrl}/actors/users/`;
      if (!actor.id.startsWith(prefix))
        throw new Problem(400, "Invalid local author.");
      return this.store.active(actor.id.slice(prefix.length));
    }
    const existing = this.store.db
      .prepare("SELECT id FROM users WHERE remote_actor=?")
      .get(actor.id) as { id: string } | undefined;
    if (existing) {
      if (actor.type === "Person") this.store.db.prepare("UPDATE users SET display_name=? WHERE id=?")
        .run(String(actor.name || actor.preferredUsername || "Remote member").slice(0, 80), existing.id);
      return this.store.user(existing.id);
    }
    const id = randomUUID(),
      stem = `${
        String(actor.preferredUsername || "remote")
          .replace(/[^a-zA-Z0-9._-]/g, "")
          .slice(0, 40) || "remote"
      }@${new URL(actor.id).host}`;
    this.store.db
      .prepare(
        "INSERT INTO users(id,username,display_name,created_at,remote_actor) VALUES(?,?,?,?,?)",
      )
      .run(
        id,
        this.store.db.prepare("SELECT 1 FROM users WHERE username=?").get(stem)
          ? `${stem}-${id.slice(0, 6)}`
          : stem,
        String(actor.name || actor.preferredUsername || "Remote member").slice(
          0,
          80,
        ),
        time(),
        actor.id,
      );
    return this.store.user(id);
  }
  async resolve(value: unknown): Promise<Doc> {
    this.ensureEnabled();
    const input = text(value, "Channel or actor address", 2048);
    if (input.startsWith("https://") || input.startsWith("http://")) {
      if (this.allowed(input).origin === this.config.baseUrl)
        throw new Problem(400, "Use local channels and accounts directly.");
      return this.actor(input);
    }
    const clean = input.replace(/^#/, ""),
      at = clean.lastIndexOf("@");
    if (at < 1)
      throw new Problem(400, "Use #channel@instance or an actor URL.");
    const name = clean.slice(0, at),
      domain = clean.slice(at + 1);
    if (!/^[a-zA-Z0-9._-]+$/.test(name) || !/^[a-zA-Z0-9.:[\]-]+$/.test(domain))
      throw new Problem(400, "Invalid channel address.");
    const protocol =
      this.config.devAuth &&
      /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(domain)
        ? "http"
        : "https";
    const url = this.allowed(
      `${protocol}://${domain}/.well-known/webfinger?resource=${encodeURIComponent(`acct:${input.startsWith("#") ? "#" : ""}${name}@${domain}`)}`,
    );
    if (url.origin === this.config.baseUrl)
      throw new Problem(400, "Use local channels and accounts directly.");
    const result = await peerJson(url, this.config);
    const link = Array.isArray(result.links)
      ? result.links.find(
          (link: Doc) =>
            link.rel === "self" && link.type === "application/activity+json",
        )
      : null;
    if (!link || this.allowed(link.href).origin !== url.origin)
      throw new Problem(400, "Peer did not return a home-instance actor.");
    return this.actor(link.href);
  }
  async subscribe(user: User, value: unknown) {
    this.require(user, "federation_subscribe");
    this.require(user, "federation_receive");
    const actor = await this.resolve(value);
    if (
      actor.type !== "Group" ||
      !["timeline", "topical", "threaded"].includes(actor.mode) ||
      !["open", "allowlist"].includes(actor.admission) ||
      !["public", "members"].includes(actor.visibility)
    )
      throw new Problem(400, "Choose an Archipel channel actor.");
    this.require(user, "federation_subscribe");
    this.allowed(actor.id);
    return this.store.transaction(() => {
      let channel = this.store.db
        .prepare("SELECT * FROM channels WHERE remote_actor=?")
        .get(actor.id) as unknown as Channel | undefined;
      if (!channel) {
        const id = randomUUID();
        this.store.db
          .prepare(
            "INSERT INTO channels(id,name,description,mode,visibility,admission,owner_id,created_at,remote_actor,federation_enabled) VALUES(?,?,?,?,'members','allowlist',?,?,?,1)",
          )
          .run(
            id,
            `${String(actor.preferredUsername).slice(0, 40)}@${new URL(actor.id).host}`,
            String(actor.summary || "").slice(0, 500),
            actor.mode,
            user.id,
            time(),
            actor.id,
          );
        channel = this.store.channel(id);
      }
      const previous = this.store.db
        .prepare(
          "SELECT status FROM federation_subscriptions WHERE channel_id=? AND user_id=?",
        )
        .get(channel.id, user.id) as { status: string } | undefined;
      if (previous && ["pending", "accepted"].includes(previous.status))
        return {
          channel: this.store.channelInfo(user, channel),
          status: previous.status,
        };
      const follow = this.queue(
        "Follow",
        this.userActor(user),
        actor.id,
        [actor.id],
        "subscribe",
        user.id,
        channel.id,
      );
      this.store.db
        .prepare(
          "INSERT INTO federation_subscriptions VALUES(?,?,?,'pending') ON CONFLICT(channel_id,user_id) DO UPDATE SET follow_id=excluded.follow_id,status='pending'",
        )
        .run(channel.id, user.id, follow);
      return {
        channel: this.store.channelInfo(user, channel),
        status: "pending",
      };
    });
  }
  subscriptions(user: User) {
    this.store.active(user.id);
    return this.store.db
      .prepare(
        "SELECT s.*,c.name,c.remote_actor FROM federation_subscriptions s JOIN channels c ON c.id=s.channel_id WHERE user_id=? ORDER BY c.name",
      )
      .all(user.id);
  }
  unsubscribe(user: User, id: string, adminAction = false) {
    if (adminAction) this.store.user(user.id);
    else this.store.active(user.id);
    const channel = this.store.channel(id);
    const sub = this.store.db
      .prepare(
        "SELECT * FROM federation_subscriptions WHERE channel_id=? AND user_id=? AND status IN ('pending','accepted')",
      )
      .get(id, user.id) as { follow_id: string } | undefined;
    if (!sub || !channel.remote_actor) return;
    this.store.transaction(() => {
      this.store.db
        .prepare(
          "UPDATE federation_subscriptions SET status='left' WHERE channel_id=? AND user_id=?",
        )
        .run(id, user.id);
      this.store.db
        .prepare("DELETE FROM memberships WHERE channel_id=? AND user_id=?")
        .run(id, user.id);
      this.queue(
        "Undo",
        this.userActor(user),
        {
          type: "Follow",
          id: sub.follow_id,
          actor: this.userActor(user),
          object: channel.remote_actor,
        },
        [channel.remote_actor!],
        "cleanup",
        user.id,
        id,
      );
    });
  }
  private activity(type: string, actor: string, object: unknown) {
    return {
      "@context": context,
      id: `${this.config.baseUrl}/federation/activities/${randomUUID()}`,
      type,
      actor,
      object,
    };
  }
  private queue(
    type: string,
    actor: string,
    object: unknown,
    recipients: string[],
    purpose: string,
    userId: string | null,
    channelId: string | null,
  ) {
    const activity: Doc = this.activity(type, actor, object);
    activity.to = recipients;
    this.store.db
      .prepare("INSERT INTO federation_outgoing VALUES(?,?,?,?,?,?,?)")
      .run(
        activity.id,
        JSON.stringify(activity),
        actor,
        userId,
        channelId,
        purpose,
        Date.now(),
      );
    for (const recipient of new Set(recipients))
      this.store.db
        .prepare(
          "INSERT INTO federation_deliveries(activity_id,recipient) VALUES(?,?)",
        )
        .run(activity.id, recipient);
    return activity.id;
  }
  private signNote(note: Doc, actor: string): Doc {
    return {
      ...note,
      proof: {
        actor,
        keyId: `${actor}#main-key`,
        signature: sign(
          "RSA-SHA256",
          Buffer.from(JSON.stringify(note)),
          this.keys().private_key,
        ).toString("base64"),
      },
    };
  }
  private async verifyNote(note: Doc) {
    if (
      !note ||
      note.type !== "Note" ||
      typeof note.attributedTo !== "string" ||
      note.proof?.actor !== note.attributedTo ||
      note.proof.keyId !== `${note.attributedTo}#main-key`
    )
      throw new Problem(400, "Message origin proof is required.");
    if (this.allowed(note.id).origin !== this.allowed(note.attributedTo).origin)
      throw new Problem(400, "Message ID must belong to its author instance.");
    const actor = await this.actor(note.attributedTo),
      { proof, ...document } = note;
    if (
      actor.type !== "Person" ||
      typeof proof.signature !== "string" ||
      proof.signature.length > 1000 ||
      !verify(
        "RSA-SHA256",
        Buffer.from(JSON.stringify(document)),
        actor.publicKey.publicKeyPem,
        Buffer.from(proof.signature, "base64"),
      )
    )
      throw new Problem(401, "Message origin signature failed.");
    return actor;
  }
  private note(message: Message): Doc {
    const channel = this.store.channel(message.channel_id),
      user = this.store.user(message.author_id);
    if (message.remote_object) {
      const object = this.store.db
        .prepare("SELECT document FROM federation_objects WHERE id=?")
        .get(message.remote_object) as { document: string } | undefined;
      if (!object)
        throw new Problem(409, "Remote origin proof is unavailable.");
      return JSON.parse(object.document);
    }
    const emojis = JSON.parse(message.emoji_tags) as {
      id: string;
      name: string;
    }[];
    const topic = message.topic_id
      ? (this.store.db
          .prepare("SELECT * FROM topics WHERE id=?")
          .get(message.topic_id) as { id: string; title: string })
      : null;
    const parent = message.parent_id
      ? this.store.message(message.parent_id)
      : null;
    return this.signNote(
      {
        id: `${this.config.baseUrl}/objects/messages/${message.id}`,
        type: "Note",
        attributedTo: this.userActor(user),
        to: [this.channelActor(channel)],
        channel: this.channelActor(channel),
        mediaType: "text/plain",
        content: message.body,
        name: message.title,
        inReplyTo: parent
          ? parent.remote_object ||
            `${this.config.baseUrl}/objects/messages/${parent.id}`
          : null,
        topic: topic
          ? {
              id: `${this.config.baseUrl}/objects/topics/${topic.id}`,
              name: topic.title,
            }
          : null,
        published: message.created_at,
        updated: message.edited_at,
        emoji: emojis.slice(0, 8).map((e) => ({
          name: e.name,
          id: e.id,
          url: `${this.config.baseUrl}/federation/emojis/${e.id}/image`,
        })),
      },
      this.userActor(user),
    );
  }
  private relay(
    message: Message,
    type: "Create" | "Update" | "Delete",
    actor: User,
  ) {
    const channel = this.store.channel(message.channel_id);
    const recipients = (
      this.store.db
        .prepare(
          "SELECT actor FROM federation_follows WHERE channel_id=? AND status='accepted'",
        )
        .all(channel.id) as unknown as { actor: string }[]
    ).map((f) => f.actor);
    if (!recipients.length) return;
    const object =
      type === "Delete"
        ? {
            type: "Tombstone",
            id:
              message.remote_object ||
              `${this.config.baseUrl}/objects/messages/${message.id}`,
            channel: this.channelActor(channel),
          }
        : this.note(message);
    const inner = this.activity(
      type,
      this.userActor(this.store.user(message.author_id)),
      object,
    );
    this.queue(
      "Announce",
      this.channelActor(channel),
      inner,
      recipients,
      type === "Delete" ? "moderation" : "relay",
      actor.id,
      channel.id,
    );
  }
  async sendDirect(user: User, value: unknown, bodyValue: unknown) {
    this.require(user, "federation_send");
    const peer = await this.resolve(value);
    if (peer.type !== "Person")
      throw new Problem(400, "Direct messages need a remote user actor.");
    this.require(user, "federation_send");
    this.allowed(peer.id);
    if (this.store.isUserBlocked(user.id, peer.id))
      throw new Problem(403, "You blocked this user.");
    const body = text(bodyValue, "Message", 8000),
      id = `${this.config.baseUrl}/federation/objects/${randomUUID()}`,
      emojis = this.store.messageEmojiTags(user, body);
    const note = this.signNote(
      {
        id,
        type: "Note",
        attributedTo: this.userActor(user),
        to: [peer.id],
        mediaType: "text/plain",
        content: body,
        published: time(),
        emoji: emojis.slice(0, 8).map((e) => ({
          ...e,
          url: `${this.config.baseUrl}/federation/emojis/${e.id}/image`,
        })),
      },
      this.userActor(user),
    );
    return this.store.transaction(() => {
      this.store.db
        .prepare("INSERT INTO federation_objects VALUES(?,?,NULL,?)")
        .run(id, user.id, JSON.stringify(note));
      this.store.db
        .prepare(
          "INSERT INTO direct_messages(id,user_id,peer,direction,body,emoji_tags,created_at) VALUES(?,?,?,'outgoing',?,?,?)",
        )
        .run(
          id,
          user.id,
          peer.id,
          body,
          JSON.stringify(emojis),
          note.published,
        );
      const activity = this.queue(
        "Create",
        this.userActor(user),
        note,
        [peer.id],
        "direct",
        user.id,
        null,
      );
      return { id, activity, body, peer: peer.id };
    });
  }
  // Finds the person behind an address, so a conversation with them can be opened.
  async resolveDirect(user: User, value: unknown) {
    this.require(user, "federation_send");
    const peer = await this.resolve(value);
    if (peer.type !== "Person")
      throw new Problem(400, "Direct messages need a remote user actor.");
    return this.store.peerInfo(peer.id);
  }
  directMessages(user: User): Doc[] {
    this.store.active(user.id);
    return this.store.db
      .prepare(
        "SELECT * FROM direct_messages WHERE user_id=? AND (direction='outgoing' OR ?=1) ORDER BY seq DESC LIMIT 100",
      )
      .all(
        user.id,
        Number(this.enabled() && !!this.store.user(user.id).federation_receive),
      )
      .reverse()
      .filter((message) => {
        try {
          this.allowed(String(message.peer));
          return true;
        } catch {
          return false;
        }
      })
      .map((message) => ({
        ...message,
        emojis: JSON.parse(String(message.emoji_tags)),
      }));
  }
  async remotePost(user: User, id: string, input: Doc) {
    this.require(user, "federation_send");
    this.require(user, "federation_post");
    this.require(user, "federation_subscribe");
    const channel = this.store.channel(id);
    this.store.requireRead(user, channel);
    if (!channel.remote_actor || !this.store.role(id, user.id))
      throw new Problem(
        403,
        "Subscribe and wait for channel admission before posting.",
      );
    const body = text(input.body, "Message", 8000),
      title =
        input.title == null ? null : text(input.title, "Thread title", 160);
    const parent = input.parent_id
      ? this.store.message(String(input.parent_id))
      : null;
    if (parent && (parent.channel_id !== id || parent.deleted_at))
      throw new Problem(400, "Choose an existing parent in this channel.");
    const topic = input.topic_id
      ? (this.store.db
          .prepare("SELECT * FROM topics WHERE id=? AND channel_id=?")
          .get(String(input.topic_id), id) as
          | { id: string; title: string; remote_id: string }
          | undefined)
      : null;
    if (
      (channel.mode === "timeline" && (title || parent || input.topic_id)) ||
      (channel.mode === "threaded" &&
        ((!parent && !title) || (parent && title) || input.topic_id)) ||
      (channel.mode === "topical" &&
        (!topic || title || (parent && parent.topic_id !== topic.id)))
    )
      throw new Problem(
        400,
        "Message structure does not match this channel mode.",
      );
    const objectId = `${this.config.baseUrl}/federation/objects/${randomUUID()}`,
      emojis = this.store.messageEmojiTags(user, body + (title || ""));
    const note = this.signNote(
      {
        id: objectId,
        type: "Note",
        attributedTo: this.userActor(user),
        to: [channel.remote_actor],
        channel: channel.remote_actor,
        mediaType: "text/plain",
        content: body,
        name: title,
        inReplyTo: parent
          ? parent.remote_object ||
            `${this.config.baseUrl}/objects/messages/${parent.id}`
          : null,
        topic: topic ? { id: topic.remote_id, name: topic.title } : null,
        published: time(),
        updated: null,
        emoji: emojis.slice(0, 8).map((e) => ({
          ...e,
          url: `${this.config.baseUrl}/federation/emojis/${e.id}/image`,
        })),
      },
      this.userActor(user),
    );
    return this.store.transaction(() => {
      this.store.db
        .prepare("INSERT INTO federation_objects VALUES(?,?,?,?)")
        .run(objectId, user.id, channel.remote_actor, JSON.stringify(note));
      this.queue(
        "Create",
        this.userActor(user),
        note,
        [channel.remote_actor!],
        "post",
        user.id,
        id,
      );
      return { queued: true, object_url: objectId };
    });
  }
  async editRemote(user: User, id: string, input: Doc) {
    this.require(user, "federation_send");
    this.require(user, "federation_post");
    const message = this.store.message(id),
      channel = this.store.channel(message.channel_id);
    this.store.requireRead(user, channel);
    if (
      !channel.remote_actor ||
      message.author_id !== user.id ||
      !this.store.role(channel.id, user.id)
    )
      throw new Problem(
        403,
        "Only a subscribed author can edit a remote message.",
      );
    if (message.deleted_at || input.expected_edited_at !== message.edited_at)
      throw new Problem(
        409,
        "Message changed or was removed. Reopen the editor.",
      );
    if (
      Object.keys(input).some(
        (key) => !["body", "title", "expected_edited_at"].includes(key),
      )
    )
      throw new Problem(400, "Editing cannot change message relationships.");
    const stored = this.store.db
      .prepare(
        "SELECT document FROM federation_objects WHERE id=? AND user_id=?",
      )
      .get(message.remote_object!, user.id) as { document: string } | undefined;
    if (!stored)
      throw new Problem(403, "This instance does not own the message.");
    const original = JSON.parse(stored.document),
      { proof: _proof, ...note } = original;
    note.content = text(input.body, "Message", 8000);
    if (input.title !== undefined) {
      if (channel.mode !== "threaded" || message.parent_id)
        throw new Problem(400, "Only thread roots have titles.");
      note.name = text(input.title, "Thread title", 160);
    }
    note.updated = new Date(
      Math.max(
        Date.now(),
        Date.parse(message.edited_at || message.created_at) + 1,
      ),
    ).toISOString();
    note.emoji = this.store
      .messageEmojiTags(user, note.content + (note.name || ""))
      .slice(0, 8)
      .map((e) => ({
        ...e,
        url: `${this.config.baseUrl}/federation/emojis/${e.id}/image`,
      }));
    const updated = this.signNote(note, this.userActor(user));
    this.store.transaction(() => {
      this.store.db
        .prepare("UPDATE federation_objects SET document=? WHERE id=?")
        .run(JSON.stringify(updated), message.remote_object!);
      this.queue(
        "Update",
        this.userActor(user),
        updated,
        [channel.remote_actor!],
        "post",
        user.id,
        channel.id,
      );
    });
    return { queued: true };
  }
  deleteRemote(user: User, id: string) {
    this.store.active(user.id);
    this.ensureEnabled();
    const message = this.store.message(id),
      channel = this.store.channel(message.channel_id);
    if (
      !channel.remote_actor ||
      message.author_id !== user.id ||
      !this.store.role(channel.id, user.id)
    )
      throw new Problem(
        403,
        "Only the subscribed author can delete a remote message.",
      );
    this.queue(
      "Delete",
      this.userActor(user),
      {
        type: "Tombstone",
        id: message.remote_object,
        channel: channel.remote_actor,
      },
      [channel.remote_actor!],
      "cleanup",
      user.id,
      channel.id,
    );
  }
  history(actor: Doc, id: string, before?: number) {
    this.ensureEnabled();
    const channel = this.store.channel(id);
    if (
      !channel.federation_enabled ||
      channel.remote_actor ||
      !this.acceptedFollower(id, actor.id)
    )
      throw new Problem(403, "An accepted channel subscription is required.");
    this.allowed(actor.id);
    const records = this.store.db
      .prepare(
        "SELECT m.*,u.username,u.display_name FROM messages m JOIN users u ON u.id=m.author_id WHERE m.channel_id=? AND m.seq<? ORDER BY m.seq DESC LIMIT 20",
      )
      .all(id, before || Number.MAX_SAFE_INTEGER) as unknown as Message[];
    const items = records
      .reverse()
      .filter((m) => {
        const author = this.store.user(m.author_id);
        try {
          this.store.active(author.id);
          if (author.remote_actor) this.allowed(author.remote_actor);
          else {
            this.require(author, "federation_send");
            this.require(author, "federation_post");
          }
          return true;
        } catch {
          return false;
        }
      })
      .map((m) =>
        m.deleted_at
          ? {
              type: "Tombstone",
              id:
                m.remote_object ||
                `${this.config.baseUrl}/objects/messages/${m.id}`,
              channel: this.channelActor(channel),
            }
          : this.note(m),
      );
    return {
      "@context": context,
      type: "OrderedCollectionPage",
      id: `${this.channelActor(channel)}/outbox${before ? `?before=${before}` : ""}`,
      partOf: `${this.channelActor(channel)}/outbox`,
      orderedItems: items,
      next:
        records.length === 20
          ? `${this.channelActor(channel)}/outbox?before=${records[0].seq}`
          : null,
      topics: (
        this.store.db
          .prepare("SELECT * FROM topics WHERE channel_id=?")
          .all(id) as unknown as { id: string; title: string }[]
      ).map((t) => ({
        id: `${this.config.baseUrl}/objects/topics/${t.id}`,
        name: t.title,
      })),
    };
  }
  private acceptedFollower(id: string, actor: string) {
    const row = this.store.db
      .prepare(
        "SELECT 1 FROM federation_follows f JOIN users u ON u.remote_actor=f.actor WHERE f.channel_id=? AND f.actor=? AND f.status='accepted' AND u.banned=0 AND u.admission_status='approved' AND NOT EXISTS (SELECT 1 FROM channel_rules r WHERE r.channel_id=f.channel_id AND r.user_id=u.id AND r.rule='block')",
      )
      .get(id, actor);
    try {
      this.allowed(actor);
      return !!row;
    } catch {
      return false;
    }
  }
  private async snapshot(channel: Channel, user: User) {
    const items: Doc[] = [],
      topics: Doc[] = [];
    let next: string | null = `${channel.remote_actor}/outbox`;
    for (let page = 0; next && page < 5; page++) {
      const url = this.allowed(next);
      if (
        url.origin !== new URL(channel.remote_actor!).origin ||
        url.pathname !== new URL(`${channel.remote_actor}/outbox`).pathname
      )
        throw new Problem(400, "Invalid channel history cursor.");
      const history = await peerJson(
        url,
        this.config,
        signedHeaders(
          url,
          "GET",
          this.userActor(user),
          this.keys().private_key,
        ),
      );
      if (
        history.type !== "OrderedCollectionPage" ||
        !Array.isArray(history.orderedItems) ||
        history.orderedItems.length > 20 ||
        !Array.isArray(history.topics) ||
        history.topics.length > 500
      )
        throw new Problem(400, "Invalid remote channel history.");
      items.unshift(...history.orderedItems);
      topics.push(...history.topics);
      next = history.next || null;
    }
    const prepared = [];
    for (const item of items) prepared.push(await this.prepareNote(item));
    return { items: prepared, topics };
  }
  private async prepareNote(note: Doc) {
    if (note?.type === "Tombstone") return { note, actor: null, emojis: [] };
    const actor = await this.verifyNote(note);
    text(note.content, "Message", 8000);
    if (
      note.mediaType !== "text/plain" ||
      !Number.isFinite(Date.parse(note.published)) ||
      (note.updated != null && !Number.isFinite(Date.parse(note.updated))) ||
      (note.name != null &&
        (typeof note.name !== "string" || note.name.length > 160))
    )
      throw new Problem(400, "Invalid remote message.");
    const emojis: { id: string; name: string; url: string }[] = [];
    if (
      note.emoji !== undefined &&
      (!Array.isArray(note.emoji) || note.emoji.length > 8)
    )
      throw new Problem(400, "A message can carry up to eight custom emoji.");
    for (const emoji of note.emoji || []) {
      if (
        !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(emoji.name) ||
        this.allowed(emoji.url).origin !== new URL(note.attributedTo).origin
      )
        throw new Problem(400, "Invalid message emoji origin.");
      let cached = this.store.db
        .prepare("SELECT id FROM remote_emoji_cache WHERE source_url=?")
        .get(emoji.url) as { id: string } | undefined;
      if (!cached) {
        const image = await peerRequest(this.allowed(emoji.url), this.config);
        const { decodeEmojiImage } = await import("./emoji-image.js");
        const decoded = decodeEmojiImage(image.body.toString("base64"));
        cached = { id: randomUUID() };
        this.store.db
          .prepare("INSERT INTO remote_emoji_cache VALUES(?,?,?,?)")
          .run(cached.id, emoji.url, decoded.mime, decoded.image);
      }
      emojis.push({
        id: cached.id,
        name: emoji.name,
        url: `/api/emojis/${cached.id}/image`,
      });
    }
    return { note, actor, emojis };
  }
  private importTopic(channel: Channel, topic: Doc) {
    if (
      !topic ||
      typeof topic.id !== "string" ||
      new URL(this.allowed(topic.id)).origin !==
        new URL(this.channelActor(channel)).origin
    )
      throw new Problem(400, "Invalid topic origin.");
    const title = text(topic.name, "Topic title", 100);
    let row = this.store.db
      .prepare("SELECT id,channel_id FROM topics WHERE remote_id=?")
      .get(topic.id) as { id: string; channel_id: string } | undefined;
    if (row && row.channel_id !== channel.id)
      throw new Problem(400, "Topic belongs to another channel.");
    if (!row) {
      row = { id: randomUUID(), channel_id: channel.id };
      this.store.db
        .prepare(
          "INSERT INTO topics(id,channel_id,title,created_at,remote_id) VALUES(?,?,?,?,?)",
        )
        .run(row.id, channel.id, title, time(), topic.id);
    }
    return row.id;
  }
  private historyPlaceholder(
    channel: Channel,
    object: string,
    topicId: string | null,
    removed = false,
  ) {
    if (!channel.remote_actor)
      throw new Problem(400, "A home channel requires an existing parent.");
    this.allowed(object);
    const source = this.remoteUser({
      id: channel.remote_actor,
      name: channel.name,
      preferredUsername: channel.name,
    });
    const id = randomUUID();
    this.store.db
      .prepare(
        "INSERT INTO messages(id,channel_id,author_id,body,title,topic_id,created_at,deleted_at,remote_object,history_placeholder) VALUES(?,?,?,?,?,?,?,?,?,1)",
      )
      .run(
        id,
        channel.id,
        source.id,
        removed ? "" : "Earlier message is outside the cached history.",
        !removed && channel.mode === "threaded" ? "Earlier thread" : null,
        topicId,
        time(),
        removed ? time() : null,
        object,
      );
    return this.store.message(id);
  }
  private importNote(
    channel: Channel,
    prepared: Awaited<ReturnType<Federation["prepareNote"]>>,
  ) {
    const { note, actor, emojis } = prepared;
    if (note.channel !== this.channelActor(channel))
      throw new Problem(400, "Message belongs to another channel.");
    const existing = this.store.db
      .prepare("SELECT id FROM messages WHERE remote_object=?")
      .get(note.id) as { id: string } | undefined;
    // Local messages can return through their home Group; resolve their stable URL too.
    const local = note.id?.startsWith(
      `${this.config.baseUrl}/objects/messages/`,
    )
      ? (this.store.db
          .prepare("SELECT id FROM messages WHERE id=?")
          .get(
            note.id.slice(`${this.config.baseUrl}/objects/messages/`.length),
          ) as { id: string } | undefined)
      : undefined;
    const found = existing || local;
    if (note.type === "Tombstone") {
      this.allowed(note.id);
      if (found && this.store.message(found.id).channel_id === channel.id)
        this.store.db
          .prepare(
            "UPDATE messages SET body='',title=NULL,deleted_at=? WHERE id=?",
          )
          .run(time(), found.id);
      else if (!found && channel.remote_actor)
        this.historyPlaceholder(channel, note.id, null, true);
      return;
    }
    const user = this.remoteUser(actor!);
    this.store.active(user.id);
    this.allowed(note.attributedTo);
    let parentId: string | null = null,
      topicId: string | null = null;
    if (note.inReplyTo) {
      if (note.inReplyTo === note.id)
        throw new Problem(400, "A message cannot reply to itself.");
      let parent = this.store.db
        .prepare(
          "SELECT id,channel_id FROM messages WHERE remote_object=? OR (? LIKE ? AND id=?)",
        )
        .get(
          note.inReplyTo,
          note.inReplyTo,
          `${this.config.baseUrl}/objects/messages/%`,
          String(note.inReplyTo).split("/").at(-1) || "",
        ) as { id: string; channel_id: string } | undefined;
      if (!parent && channel.remote_actor) {
        const parentTopic = note.topic
          ? this.importTopic(channel, note.topic)
          : null;
        parent = this.historyPlaceholder(channel, note.inReplyTo, parentTopic);
      }
      if (!parent || parent.channel_id !== channel.id)
        throw new Problem(
          400,
          "Remote reply parent is unavailable in this channel.",
        );
      parentId = parent.id;
      const visited = new Set<string>();
      let ancestor: string | null = parentId;
      while (ancestor) {
        if (
          ancestor === found?.id ||
          visited.has(ancestor) ||
          visited.size >= 1000
        )
          throw new Problem(400, "Invalid remote reply ancestry.");
        visited.add(ancestor);
        ancestor = this.store.message(ancestor).parent_id;
      }
    }
    if (note.topic) {
      if (channel.remote_actor) topicId = this.importTopic(channel, note.topic);
      else {
        if (
          typeof note.topic.id !== "string" ||
          !note.topic.id.startsWith(`${this.config.baseUrl}/objects/topics/`)
        )
          throw new Problem(400, "Topic is not hosted by this channel.");
        const topic = this.store.db
          .prepare("SELECT id FROM topics WHERE id=? AND channel_id=?")
          .get(
            note.topic.id.slice(
              `${this.config.baseUrl}/objects/topics/`.length,
            ),
            channel.id,
          ) as { id: string } | undefined;
        if (!topic) throw new Problem(400, "Topic not found in this channel.");
        topicId = topic.id;
      }
    }
    if (parentId && topicId) {
      const parent = this.store.message(parentId);
      if (parent.history_placeholder && parent.topic_id === null)
        this.store.db
          .prepare("UPDATE messages SET topic_id=? WHERE id=?")
          .run(topicId, parentId);
    }
    if (
      (channel.mode === "timeline" && (parentId || topicId || note.name)) ||
      (channel.mode === "threaded" &&
        ((!parentId && !note.name) || (parentId && note.name) || topicId)) ||
      (channel.mode === "topical" &&
        (!topicId ||
          note.name ||
          (parentId && this.store.message(parentId).topic_id !== topicId)))
    )
      throw new Problem(400, "Invalid remote conversation structure.");
    if (found) {
      const current = this.store.message(found.id);
      if (current.channel_id !== channel.id)
        throw new Problem(403, "Object belongs to another channel.");
      if (current.deleted_at) return;
      if (current.history_placeholder) {
        this.store.db
          .prepare(
            "UPDATE messages SET author_id=?,body=?,title=?,topic_id=?,parent_id=?,created_at=?,edited_at=?,emoji_tags=?,history_placeholder=0 WHERE id=?",
          )
          .run(
            user.id,
            note.content.trim(),
            note.name || null,
            topicId,
            parentId,
            note.published,
            note.updated || null,
            JSON.stringify(emojis),
            current.id,
          );
        this.store.db
          .prepare(
            "INSERT INTO federation_objects VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET document=excluded.document",
          )
          .run(
            note.id,
            user.id,
            this.channelActor(channel),
            JSON.stringify(note),
          );
        return;
      }
      if (
        current.channel_id !== channel.id ||
        current.author_id !== user.id ||
        current.parent_id !== parentId ||
        current.topic_id !== topicId
      )
        throw new Problem(
          403,
          "Remote update cannot change message authority or relationships.",
        );
      if (
        Date.parse(note.updated || note.published) <=
        Date.parse(current.edited_at || current.created_at)
      ) {
        if (
          Date.parse(note.updated || note.published) ===
            Date.parse(current.edited_at || current.created_at) &&
          (note.content.trim() !== current.body ||
            (note.name || null) !== current.title)
        )
          throw new Problem(
            409,
            "Conflicting message with an existing object ID.",
          );
        return;
      }
      this.store.db
        .prepare(
          "UPDATE messages SET body=?,title=?,edited_at=?,emoji_tags=? WHERE id=?",
        )
        .run(
          note.content.trim(),
          note.name || null,
          note.updated,
          JSON.stringify(emojis),
          found.id,
        );
    } else {
      const id = randomUUID();
      this.store.db
        .prepare(
          "INSERT INTO messages(id,channel_id,author_id,body,title,topic_id,parent_id,created_at,edited_at,remote_object,emoji_tags) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          id,
          channel.id,
          user.id,
          note.content.trim(),
          note.name || null,
          topicId,
          parentId,
          note.published,
          note.updated || null,
          note.id,
          JSON.stringify(emojis),
        );
    }
    this.store.db
      .prepare(
        "INSERT INTO federation_objects VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET document=excluded.document",
      )
      .run(note.id, user.id, this.channelActor(channel), JSON.stringify(note));
  }
  async receive(req: Request, raw: Buffer) {
    const sender = await this.authenticate(req, raw);
    let activity: Doc;
    try {
      activity = JSON.parse(raw.toString());
    } catch {
      throw new Problem(400, "Invalid activity JSON.");
    }
    if (
      activity.actor !== sender.id ||
      typeof activity.id !== "string" ||
      this.allowed(activity.id).origin !== new URL(sender.id).origin
    )
      throw new Problem(
        403,
        "Activity authority does not match its signing actor.",
      );
    const previous = this.store.db
      .prepare("SELECT digest FROM federation_incoming WHERE id=?")
      .get(activity.id) as { digest: string } | undefined;
    if (previous) {
      if (previous.digest !== hash(raw.toString()))
        throw new Problem(409, "Activity ID reused with different content.");
      return;
    }
    const object = activity.object;
    let prepared: Awaited<ReturnType<Federation["prepareNote"]>> | undefined;
    let snapshot: Awaited<ReturnType<Federation["snapshot"]>> | undefined;
    const profileUpdate = activity.type === "Update" && object?.type === "Person";
    const profileRelay = activity.type === "Announce" && sender.type === "Group" && object?.type === "Update" && object.object?.type === "Person";
    if (profileUpdate) {
      if (sender.type !== "Person" || object.id !== sender.id)
        throw new Problem(403, "Profile update must belong to its signing actor.");
      // Refresh from the actor's own endpoint; a profile activity cannot replace keys.
      await this.actor(sender.id, true);
    } else if (profileRelay) {
      if (object.actor !== object.object.id) throw new Problem(403, "Invalid profile author.");
      const channel = this.store.db.prepare("SELECT id FROM channels WHERE remote_actor=?").get(sender.id) as { id: string } | undefined;
      if (!channel) throw new Problem(403, "Unknown profile relay channel.");
      const recipients = this.store.db.prepare("SELECT 1 FROM federation_subscriptions s JOIN users u ON u.id=s.user_id WHERE s.channel_id=? AND s.status='accepted' AND u.banned=0 AND u.admission_status='approved' AND u.federation_receive=1 AND u.federation_subscribe=1").get(channel.id);
      if (!recipients) throw new Problem(403, "No permitted profile recipients.");
      await this.actor(object.actor, true);
    } else if (["Create", "Update"].includes(activity.type)) {
      if (object?.attributedTo !== sender.id || sender.type !== "Person")
        throw new Problem(
          403,
          "Only the message author may create or update it.",
        );
      prepared = await this.prepareNote(object);
    } else if (activity.type === "Announce") {
      if (
        sender.type !== "Group" ||
        !["Create", "Update", "Delete"].includes(object?.type)
      )
        throw new Problem(400, "Invalid channel distribution activity.");
      prepared = await this.prepareNote(object.object);
    } else if (activity.type === "Accept") {
      const sub = this.store.db
        .prepare("SELECT * FROM federation_subscriptions WHERE follow_id=?")
        .get(object?.id) as
        | { channel_id: string; user_id: string; status: string }
        | undefined;
      if (
        !sub ||
        sub.status === "left" ||
        this.store.channel(sub.channel_id).remote_actor !== sender.id ||
        object.actor !== this.userActor(this.store.user(sub.user_id)) ||
        object.object !== sender.id ||
        object.type !== "Follow"
      )
        throw new Problem(
          403,
          "Accept must match an outstanding subscription.",
        );
      const user = this.store.user(sub.user_id);
      this.require(user, "federation_receive");
      this.require(user, "federation_subscribe");
      snapshot = await this.snapshot(this.store.channel(sub.channel_id), user);
    }
    this.ensureEnabled();
    this.allowed(sender.id);
    this.store.transaction(() => {
      const duplicate = this.store.db
        .prepare("SELECT digest FROM federation_incoming WHERE id=?")
        .get(activity.id) as { digest: string } | undefined;
      if (duplicate) {
        if (duplicate.digest !== hash(raw.toString()))
          throw new Problem(409, "Conflicting activity.");
        return;
      }
      if (profileUpdate || profileRelay) {
        const author = profileUpdate ? sender.id : object.actor;
        const cached = this.store.db.prepare("SELECT document FROM federation_actors WHERE id=?").get(author) as { document: string };
        const remoteAuthor = this.remoteUser(JSON.parse(cached.document));
        if (profileUpdate) {
          // Notify other subscribers when a remote author changes their picture.
          const channels = this.store.db.prepare("SELECT channel_id FROM federation_follows WHERE actor=? AND status='accepted'").all(sender.id) as { channel_id: string }[];
          for (const entry of channels) {
            const channel = this.store.channel(entry.channel_id);
            const recipients = (this.store.db.prepare("SELECT actor FROM federation_follows WHERE channel_id=? AND status='accepted' AND actor<>?").all(channel.id, sender.id) as { actor: string }[]).map(r => r.actor);
            if (channel.federation_enabled && recipients.length) this.queue("Announce", this.channelActor(channel), { type: "Update", actor: sender.id, object: { type: "Person", id: sender.id } }, recipients, "relay", remoteAuthor.id, channel.id);
          }
        }
      } else if (activity.type === "Follow") {
        if (
          sender.type !== "Person" ||
          typeof object !== "string" ||
          !object.startsWith(`${this.config.baseUrl}/actors/channels/`)
        )
          throw new Problem(400, "Follow a home channel.");
        const channel = this.store.channel(
          object.slice(`${this.config.baseUrl}/actors/channels/`.length),
        );
        if (!channel.federation_enabled || channel.remote_actor)
          throw new Problem(403, "Channel federation is disabled.");
        const remote = this.remoteUser(sender);
        this.store.active(remote.id);
        const old = this.store.db
          .prepare(
            "SELECT status FROM federation_follows WHERE channel_id=? AND actor=?",
          )
          .get(channel.id, sender.id) as { status: string } | undefined;
        const blocked =
          old?.status === "blocked" ||
          this.store.rule(channel.id, remote.id) === "block";
        const accept =
          !blocked &&
          (channel.admission === "open" ||
            old?.status === "accepted" ||
            this.store.rule(channel.id, remote.id) === "allow");
        this.store.db
          .prepare(
            "INSERT INTO federation_follows VALUES(?,?,?,?) ON CONFLICT(channel_id,actor) DO UPDATE SET follow_id=excluded.follow_id,status=excluded.status",
          )
          .run(
            channel.id,
            sender.id,
            activity.id,
            blocked ? "blocked" : accept ? "accepted" : "pending",
          );
        if (accept || blocked)
          this.followAnswer(channel, sender.id, activity.id, accept);
      } else if (activity.type === "Undo") {
        if (
          sender.type !== "Person" ||
          object?.type !== "Follow" ||
          object.actor !== sender.id
        )
          throw new Problem(403, "Undo must belong to its sender.");
        this.store.db
          .prepare(
            "UPDATE federation_follows SET status='blocked' WHERE actor=? AND follow_id=?",
          )
          .run(sender.id, object.id);
        // Explicit unsubscribe permits a later fresh Follow; retain no implicit block.
        this.store.db
          .prepare(
            "DELETE FROM federation_follows WHERE actor=? AND follow_id=?",
          )
          .run(sender.id, object.id);
      } else if (["Accept", "Reject"].includes(activity.type)) {
        const sub = this.store.db
          .prepare("SELECT * FROM federation_subscriptions WHERE follow_id=?")
          .get(object?.id) as
          | { channel_id: string; user_id: string; status: string }
          | undefined;
        if (
          !sub ||
          sub.status === "left" ||
          sender.type !== "Group" ||
          this.store.channel(sub.channel_id).remote_actor !== sender.id ||
          object.actor !== this.userActor(this.store.user(sub.user_id)) ||
          object.object !== sender.id ||
          object.type !== "Follow"
        )
          throw new Problem(
            403,
            "Membership decision does not match this subscription.",
          );
        const accepted = activity.type === "Accept",
          channel = this.store.channel(sub.channel_id);
        if (accepted) {
          this.require(this.store.user(sub.user_id), "federation_subscribe");
          this.require(this.store.user(sub.user_id), "federation_receive");
          for (const topic of snapshot!.topics)
            this.importTopic(channel, topic);
          for (const item of snapshot!.items) this.importNote(channel, item);
          this.store.db
            .prepare("INSERT OR IGNORE INTO memberships VALUES(?,?,'member')")
            .run(channel.id, sub.user_id);
          this.store.startReading(sub.user_id, channel.id);
        } else
          this.store.db
            .prepare("DELETE FROM memberships WHERE channel_id=? AND user_id=?")
            .run(channel.id, sub.user_id);
        this.store.db
          .prepare(
            "UPDATE federation_subscriptions SET status=? WHERE follow_id=?",
          )
          .run(accepted ? "accepted" : "rejected", object.id);
      } else if (activity.type === "Announce") {
        const channel = this.store.db
          .prepare("SELECT * FROM channels WHERE remote_actor=?")
          .get(sender.id) as unknown as Channel | undefined;
        if (!channel) throw new Problem(403, "Unknown remote channel.");
        const subscribers = this.store.db
          .prepare(
            "SELECT u.id FROM federation_subscriptions s JOIN users u ON u.id=s.user_id WHERE s.channel_id=? AND s.status='accepted' AND u.banned=0 AND u.admission_status='approved' AND u.federation_receive=1 AND u.federation_subscribe=1",
          )
          .all(channel.id);
        if (!subscribers.length)
          throw new Problem(403, "No permitted recipients for this channel.");
        this.importNote(channel, prepared!);
      } else if (
        ["Create", "Update", "Delete"].includes(activity.type) &&
        object?.channel
      ) {
        if (
          sender.type !== "Person" ||
          typeof object.channel !== "string" ||
          !object.channel.startsWith(`${this.config.baseUrl}/actors/channels/`)
        )
          throw new Problem(400, "Message is not addressed to a home channel.");
        const channel = this.store.channel(
          object.channel.slice(
            `${this.config.baseUrl}/actors/channels/`.length,
          ),
        );
        const remote = this.remoteUser(sender);
        if (
          !channel.federation_enabled ||
          channel.remote_actor ||
          !this.acceptedFollower(channel.id, sender.id) ||
          this.store.rule(channel.id, remote.id) === "block"
        )
          throw new Problem(
            403,
            "Channel subscription or posting permission denied.",
          );
        this.store.active(remote.id);
        if (activity.type === "Delete") {
          const existing = this.store.db
            .prepare(
              "SELECT id FROM messages WHERE remote_object=? AND channel_id=? AND author_id=?",
            )
            .get(object.id, channel.id, remote.id) as
            | { id: string }
            | undefined;
          if (!existing)
            throw new Problem(403, "Delete target does not belong to sender.");
          this.store.db
            .prepare(
              "UPDATE messages SET body='',title=NULL,deleted_at=? WHERE id=?",
            )
            .run(time(), existing.id);
          this.relay(this.store.message(existing.id), "Delete", remote);
        } else {
          this.importNote(channel, prepared!);
          const message = this.store.db
            .prepare("SELECT id FROM messages WHERE remote_object=?")
            .get(object.id) as { id: string };
          this.relay(this.store.message(message.id), activity.type, remote);
        }
      } else if (activity.type === "Create" && !object?.channel) {
        if (
          !Array.isArray(object.to) ||
          object.to.length !== 1 ||
          !object.to[0].startsWith(`${this.config.baseUrl}/actors/users/`)
        )
          throw new Problem(
            400,
            "Direct message needs exactly one local recipient.",
          );
        const user = this.store.user(
          object.to[0].slice(`${this.config.baseUrl}/actors/users/`.length),
        );
        this.require(user, "federation_receive");
        if (this.store.isUserBlocked(user.id, sender.id))
          throw new Problem(403, "This member cannot receive this direct message.");
        this.store.active(this.remoteUser(sender).id);
        const existing = this.store.db
          .prepare(
            "SELECT user_id,peer,body,created_at FROM direct_messages WHERE id=?",
          )
          .get(object.id);
        if (
          existing &&
          (existing.user_id !== user.id ||
            existing.peer !== sender.id ||
            existing.body !== object.content.trim() ||
            existing.created_at !== object.published)
        )
          throw new Problem(
            409,
            "Direct message ID conflicts with an existing message.",
          );
        this.store.db
          .prepare(
            "INSERT OR IGNORE INTO direct_messages(id,user_id,peer,direction,body,emoji_tags,created_at) VALUES(?,?,?,'incoming',?,?,?)",
          )
          .run(
            object.id,
            user.id,
            sender.id,
            object.content.trim(),
            JSON.stringify(prepared!.emojis),
            object.published,
          );
      } else throw new Problem(400, "Unsupported federation activity.");
      this.store.db
        .prepare("INSERT INTO federation_incoming VALUES(?,?,?)")
        .run(activity.id, hash(raw.toString()), Date.now());
    });
  }
  private deliveryAllowed(outgoing: Outgoing, recipient: string) {
    this.ensureEnabled();
    this.allowed(recipient);
    const channel = outgoing.channel_id
      ? this.store.channel(outgoing.channel_id)
      : null;
    const user = outgoing.user_id ? this.store.user(outgoing.user_id) : null;
    if (outgoing.purpose === "cleanup") return;
    if (channel && !channel.federation_enabled)
      throw new Problem(403, "Channel federation disabled.");
    if (outgoing.purpose === "membership") {
      const activity = JSON.parse(outgoing.activity);
      if (
        activity.type === "Accept" &&
        !this.acceptedFollower(channel!.id, recipient)
      )
        throw new Problem(403, "Subscription withdrawn.");
      return;
    }
    if (outgoing.purpose === "subscribe") {
      this.require(user!, "federation_subscribe");
      this.require(user!, "federation_receive");
      const sub = this.store.db
        .prepare(
          "SELECT follow_id,status FROM federation_subscriptions WHERE channel_id=? AND user_id=?",
        )
        .get(channel!.id, user!.id) as
        | { follow_id: string; status: string }
        | undefined;
      if (!sub || sub.follow_id !== outgoing.id || sub.status === "left")
        throw new Problem(403, "Subscription withdrawn.");
      return;
    }
    if (outgoing.purpose === "relay" || outgoing.purpose === "moderation") {
      if (!this.acceptedFollower(channel!.id, recipient))
        throw new Problem(403, "Recipient no longer has channel access.");
      if (user?.remote_actor) {
        this.store.active(user.id);
        this.allowed(user.remote_actor);
        if (this.store.rule(channel!.id, user.id) === "block")
          throw new Problem(403, "Author blocked from channel.");
      } else if (outgoing.purpose === "relay") {
        this.require(user!, "federation_send");
        this.require(user!, "federation_post");
      } else if (user) this.store.active(user.id);
    } else if (outgoing.purpose === "post") {
      this.require(user!, "federation_send");
      this.require(user!, "federation_post");
      this.require(user!, "federation_subscribe");
      if (!this.store.role(channel!.id, user!.id))
        throw new Problem(403, "No longer subscribed.");
    } else if (outgoing.purpose === "profile") {
      this.store.active(user!.id);
      if (!flags.some(f => user![f]) || this.store.isUserBlocked(user!.id, recipient))
        throw new Problem(403, "Profile federation is disabled for this account.");
    } else if (outgoing.purpose === "direct") {
      this.require(user!, "federation_send");
      if (this.store.isUserBlocked(user!.id, recipient))
        throw new Problem(403, "You blocked this user.");
    }
    else throw new Problem(400, "Unknown delivery purpose.");
  }
  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      for (let step = 0; step < 20; step++) {
        // Preserve recipient order without allowing an offline peer to hold other peers.
        const delivery = this.store.db
          .prepare(
            "SELECT d.id AS delivery_id,d.recipient,d.attempts,o.* FROM federation_deliveries d JOIN federation_outgoing o ON o.id=d.activity_id WHERE d.status='pending' AND d.next_attempt<=? AND NOT EXISTS (SELECT 1 FROM federation_deliveries earlier WHERE earlier.recipient=d.recipient AND earlier.id<d.id AND earlier.status='pending') ORDER BY d.id LIMIT 1",
          )
          .get(Date.now()) as
          | (Outgoing & {
              delivery_id: number;
              recipient: string;
              attempts: number;
            })
          | undefined;
        if (!delivery) break;
        try {
          this.deliveryAllowed(delivery, delivery.recipient);
          const actor = await this.actor(delivery.recipient),
            url = this.allowed(actor.inbox);
          this.deliveryAllowed(delivery, delivery.recipient);
          await peerRequest(
            url,
            this.config,
            signedHeaders(
              url,
              "POST",
              delivery.signer,
              this.keys().private_key,
              delivery.activity,
            ),
            delivery.activity,
          );
          this.store.db
            .prepare(
              "UPDATE federation_deliveries SET status='sent',attempts=attempts+1,error=NULL WHERE id=?",
            )
            .run(delivery.delivery_id);
        } catch (error) {
          const problem = error as Problem;
          let cancelled = false;
          try {
            this.deliveryAllowed(delivery, delivery.recipient);
          } catch {
            cancelled = true;
          }
          const permanent =
            problem instanceof Problem &&
            [400, 401, 403, 404, 409, 410, 413].includes(problem.status);
          this.store.db
            .prepare(
              "UPDATE federation_deliveries SET status=?,attempts=attempts+1,next_attempt=?,error=? WHERE id=?",
            )
            .run(
              cancelled
                ? "cancelled"
                : permanent || delivery.attempts >= 11
                  ? "failed"
                  : "pending",
              Date.now() + Math.min(3600000, 5000 * 2 ** delivery.attempts),
              String(problem.message || "Network delivery failed").slice(
                0,
                200,
              ),
              delivery.delivery_id,
            );
        }
      }
    } finally {
      this.busy = false;
    }
  }
  async emojiSource(value: unknown) {
    const url = this.allowed(text(value, "Remote instance URL", 2048));
    url.pathname = "/federation/emojis";
    url.search = "";
    const result = await peerJson(url, this.config);
    if (!Array.isArray(result.emojis) || result.emojis.length > 500)
      throw new Problem(400, "Invalid remote emoji catalog.");
    return result.emojis.map((emoji: Doc) => {
      if (
        !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(emoji.name) ||
        this.allowed(emoji.url).origin !== url.origin
      )
        throw new Problem(400, "Invalid remote emoji.");
      return { name: emoji.name, url: emoji.url };
    });
  }
  async adoptEmoji(user: User, input: Doc) {
    this.store.active(user.id);
    let source: string;
    if (input.image_url) source = this.allowed(input.image_url).href;
    else {
      const catalog = await this.emojiSource(input.instance);
      const emoji = catalog.find((e: Doc) => e.name === input.source_name);
      if (!emoji) throw new Problem(404, "Remote emoji not found.");
      source = emoji.url;
    }
    const response = await peerRequest(this.allowed(source), this.config);
    this.allowed(source);
    this.store.active(user.id);
    return this.store.adoptEmoji(
      user,
      input.name,
      response.body.toString("base64"),
      source,
    );
  }
}
