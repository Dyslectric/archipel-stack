import {
  generateKeyPairSync,
  randomUUID,
  sign,
  verify,
  createPublicKey,
} from "node:crypto";
import { standardEmojis } from "./emojis.js";
import { ChannelFeed, type Checkpoint } from "./channel-feed.js";
import { WriteBatch } from "./write-batch.js";
import type { Request } from "express";
import type { Config } from "./config.js";
import {
  Store,
  Problem,
  hash,
  text,
  threadTitle,
  channelPermissions,
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
    fwdxp: "https://fwdxp.invalid/ns#",
    fwdxpVersion: "fwdxp:version",
    // The protocol's name before it was FWDXP, for instances that still ask for it.
    archipelVersion: "fwdxp:version",
    channel: "fwdxp:channel",
    mode: "fwdxp:mode",
    admission: "fwdxp:admission",
    visibility: "fwdxp:visibility",
    showMembers: "fwdxp:showMembers",
    hideHandles: "fwdxp:hideHandles",
    optionalTitles: "fwdxp:optionalTitles",
    topic: "fwdxp:topic",
    topics: "fwdxp:topics",
    proof: "fwdxp:proof",
    emoji: "fwdxp:emoji",
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
type Delivery = Outgoing & { delivery_id: number; recipient: string; attempts: number };
const time = () => new Date().toISOString();

export class Federation {
  readonly channelFeed = new ChannelFeed(this);
  private importing = false;
  private busy = false;
  private peerSends = new Map<string, number[]>();
  private rosterAsked = new Map<string, number>();
  private actorRequests = new Map<string, Promise<Doc>>();
  private actorFreshness = new Map<string, { digest: string; at: number }>();
  private channelBootstraps = new Map<string, { owner: string;
    job: Promise<{ snapshot: { items: Awaited<ReturnType<Federation["prepareNote"]>>[]; topics: Doc[] }; roster: Doc[] | undefined }> }>();
  private async nativeRequest(operation: string, input: Record<string,unknown>): Promise<Doc> {
    const response=await fetch(`${this.config.nativeChatUrl}/v1/federation/${operation}`,{
      method:"POST",redirect:"error",signal:AbortSignal.timeout(operation === "tick" ? 120000 : 25000),
      headers:{Authorization:`Bearer ${this.config.nativeBridgeSecret}`,"Content-Type":"application/json"},body:JSON.stringify(input),
    }).catch(()=>{throw new Problem(503,"Native federation worker unavailable.");});
    const value=await response.json().catch(()=>{throw new Problem(502,"Invalid native federation response.");}) as Doc;
    if(operation === "receive" && response.status === 501 && value.code === "native_unsupported") return {supported:false};
    if(!response.ok) throw new Problem(response.status,value.error || "Native federation operation failed.");
    return value;
  }
  /** Physical POST attempts, separate from per-recipient delivery audit rows. */
  readonly deliveryStats = { requests: 0, recipientAttempts: 0 };
  readonly nativeStats = { authenticated:0, received:0, unsupported:0, ticks:0,
    senderSelectionMs:0, senderDeliveryMs:0, senderJobs:0, senderActive:0, senderErrors:0,
    stages:{} as Record<string,{calls:number;totalMs:number;maxMs:number}> };
  /** Called when an administrator changes how often deliveries go out. */
  paceChanged?: () => void;
  constructor(
    readonly store: Store,
    readonly config: Config,
    private writes = new WriteBatch(store),
  ) {
    store.db
      .prepare(
        "INSERT OR IGNORE INTO instance_settings VALUES('federation_enabled','false')",
      )
      .run();
    store.federationHooks = {
      access: (channel, target) => {
        if (!target.remote_actor || target.remote_actor.startsWith("xmpp:") ||
            !this.enabled() || !channel.federation_enabled || channel.remote_actor) return;
        const follow = store.db.prepare("SELECT follow_id FROM federation_follows WHERE channel_id=? AND actor=? AND status='pending'")
          .get(channel.id, target.remote_actor) as { follow_id: string } | undefined;
        if (!follow || store.instanceBanned(channel.id, target.remote_actor)) return;
        store.active(target.id);
        this.allowed(target.remote_actor);
        store.db.prepare("UPDATE federation_follows SET status='accepted' WHERE channel_id=? AND actor=?")
          .run(channel.id, target.remote_actor);
        this.followAnswer(channel, target.remote_actor, follow.follow_id, true);
      },
      profile: (user) => this.profileChanged(user),
      permissions: (user) => this.permissionsChanged(user),
      expelled: (channel, who) => this.expelled(channel, who),
      roles: (channel, userIds) => this.rolesChanged(channel, userIds),
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
      channel: (channel, change) => this.channelChanged(channel, change),
      reaction: (user, message, emoji, on) => this.relayReaction(user, message, emoji, on),
      reactionCleared: (user, message, emoji) => this.relayReaction(user, message, emoji, false, true),
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
        .prepare("INSERT OR IGNORE INTO federation_keys VALUES(1,?,?)")
        .run(generated.privateKey, generated.publicKey);
      // Native workers may initialize the same persistent key concurrently.
      // Always use the committed winner, never an unpersisted generated key.
      keys = this.store.db.prepare("SELECT * FROM federation_keys WHERE id=1").get() as { private_key: string; public_key: string };
    }
    return keys;
  }
  async exportedActor(kind: "users" | "channels", id: string): Promise<Doc> {
    return this.config.nativeChatUrl ? this.nativeRequest("actor",{kind,id}) : this.publicActor(kind,id);
  }
  publicActor(kind: "users" | "channels", id: string): Doc {
    this.ensureEnabled();
    let data: Doc;
    if (kind === "users") {
      const user = this.store.user(id);
      const previouslyFederated = !flags.some(f => user[f]) && !!this.store.db
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
        showMembers: !!channel.show_members,
        hideHandles: !!channel.hide_handles,
        reactions: !!channel.reactions,
        reactionBans: this.store.reactionBans(channel),
        optionalTitles: !!channel.optional_titles,
      };
    }
    return {
      "@context": context,
      ...data,
      fwdxpVersion: 1,
      archipelVersion: 1,
      ...(this.config.federationChannelTransport !== "off" ? { channelEvents: kind === "channels" ? { version: 1, batches: `${data.id}/events`, stream: `${data.id}/stream`, instanceStream: `${this.config.baseUrl}/federation/stream`, instanceBatches: `${this.config.baseUrl}/federation/events` } : { version: 1 } } : {}),
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
    const verified = this.actorFreshness.get(id);
    const fetchedAt = verified && cache && verified.digest === hash(cache.document) ? verified.at : cache?.fetched_at;
    if (!refresh && cache && (fetchedAt ?? 0) > Date.now() - 60000)
      return JSON.parse(cache.document) as Doc;
    const pending = !refresh && this.actorRequests.get(id);
    if (pending) return pending;
    const job = this.fetchActor(id, url, refresh, cache);
    if (!refresh) this.actorRequests.set(id, job);
    try { return await job; }
    finally { if (this.actorRequests.get(id) === job) this.actorRequests.delete(id); }
  }
  private async fetchActor(id: string, url: URL, refresh: boolean, cache?: { document: string; fetched_at: number }) {
    const actor = await peerJson(url, this.config);
    if (
      actor.id !== id ||
      !["Person", "Group"].includes(actor.type) ||
      (actor.fwdxpVersion ?? actor.archipelVersion) !== 1 ||
      typeof actor.inbox !== "string" ||
      actor.publicKey?.owner !== id ||
      actor.publicKey?.id !== `${id}#main-key` ||
      typeof actor.publicKey?.publicKeyPem !== "string" ||
      actor.publicKey.publicKeyPem.length > 10000
    )
      throw new Problem(
        400,
        "This actor does not support FWDXP federation.",
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
    const document = JSON.stringify(actor);
    if (cache?.document === document) {
      // The network validation still occurs every minute. An unchanged public
      // document needs no durable rewrite merely to advance its cache timestamp.
      // After restart, the old disk timestamp requires fresh network validation.
      if (this.actorFreshness.size >= 4096) this.actorFreshness.delete(this.actorFreshness.keys().next().value!);
      this.actorFreshness.set(id, { digest: hash(document), at: Date.now() });
      return actor;
    }
    await this.writes.run(() => this.store.db
      .prepare(
        "INSERT INTO federation_actors VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET document=excluded.document,fetched_at=excluded.fetched_at",
      )
      .run(id, document, Date.now()));
    return actor;
  }
  async syncAvatar(actor: Doc, refresh = false) {
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
  // A followed channel shows its members here what its home shows them there.
  private keepPrivacy(channelId: string, actor: Doc) {
    this.store.db
      .prepare("UPDATE channels SET show_members=?,hide_handles=?,reactions=?,optional_titles=? WHERE id=?")
      .run(Number(actor.showMembers !== false), Number(actor.hideHandles === true), Number(actor.reactions !== false), Number(actor.optionalTitles === true), channelId);
    const bans = Array.isArray(actor.reactionBans) ? actor.reactionBans : [];
    this.store.keepReactionBans(
      channelId,
      bans.filter((name: unknown) => typeof name === "string" && /^[a-z0-9_+-]{1,64}$/.test(name)).slice(0, 200),
    );
  }
  private channelChanged(channel: Channel, change: "rename" | "privacy" | "delete") {
    const actor = this.channelActor(channel),
      announce = this.enabled() && !!channel.federation_enabled;
    const follows = this.store.db
      .prepare("SELECT * FROM federation_follows WHERE channel_id=?")
      .all(channel.id) as unknown as {
      actor: string;
      follow_id: string;
      status: string;
    }[];
    if (change !== "delete") {
      const recipients = follows
        .filter((f) => f.status === "accepted")
        .map((f) => f.actor);
      if (announce && recipients.length)
        this.queue(
          "Update",
          actor,
          this.publicActor("channels", channel.id),
          recipients,
          "moderation",
          null,
          channel.id,
        );
      return;
    }
    // Nothing still queued for the channel may go out, but the delivery record stays.
    this.store.db
      .prepare(
        "UPDATE federation_deliveries SET status='cancelled' WHERE status='pending' AND activity_id IN (SELECT id FROM federation_outgoing WHERE channel_id=?)",
      )
      .run(channel.id);
    this.store.db
      .prepare("UPDATE federation_outgoing SET channel_id=NULL WHERE channel_id=?")
      .run(channel.id);
    if (announce)
      for (const follow of follows.filter((f) => f.status !== "blocked"))
        this.queue(
          "Reject",
          actor,
          { id: follow.follow_id, type: "Follow", actor: follow.actor, object: actor },
          [follow.actor],
          "cleanup",
          null,
          null,
        );
    for (const table of ["federation_follows", "federation_subscriptions"])
      this.store.db
        .prepare(`DELETE FROM ${table} WHERE channel_id=?`)
        .run(channel.id);
    this.store.db
      .prepare("DELETE FROM federation_objects WHERE channel_actor=?")
      .run(actor);
  }
  async authenticate(req: Request, rawBody?: Buffer) {
    if (this.config.nativeChatUrl) {
      const headers: Record<string,string> = {};
      for (const [key,value] of Object.entries(req.headers)) if (typeof value === "string") headers[key]=value;
      const actor=await this.nativeRequest("authenticate",{headers,method:req.method,target:req.originalUrl,body:rawBody?.toString("base64") ?? null});
      this.nativeStats.authenticated++; return actor;
    }
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
      sending: this.sending(),
      channelStreams: { ...this.channelFeed.stats,
        cursors: this.store.db.prepare("SELECT c.id,c.name,c.remote_actor,p.cursor,p.error,p.retry_at FROM federation_channel_cursors p JOIN channels c ON c.id=p.channel_id").all() },
      instanceStreams: { ...this.channelFeed.instance.stats,
        cursors: this.store.db.prepare("SELECT origin,cursor,error,retry_at FROM federation_instance_cursors").all() },
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
  private setting(key: string) {
    return this.store.db
      .prepare("SELECT value FROM instance_settings WHERE key=?")
      .get(key)?.value as string | undefined;
  }
  // How queued deliveries are paced: how many go out in one round across all peers, and how
  // long until the next round. The environment gives the defaults; an administrator's choice
  // is kept with the instance and applies without a restart.
  sending() {
    return {
      batch: Number(this.setting("federation_send_batch") ?? this.config.federationSendRate),
      interval: Number(
        this.setting("federation_send_interval") ?? this.config.federationSendInterval,
      ),
    };
  }
  setSending(admin: User, input: Record<string, unknown>) {
    this.store.requireAdmin(admin);
    const whole = (value: unknown, label: string, min: number, max: number) => {
      if (!Number.isInteger(value) || (value as number) < min || (value as number) > max)
        throw new Problem(400, `${label} must be a whole number from ${min} to ${max}.`);
      return value as number;
    };
    const batch = whole(input.batch, "Deliveries per round", 1, 1000),
      interval = whole(input.interval, "Milliseconds between rounds", 100, 600000);
    this.store.transaction(() => {
      for (const [key, value] of [
        ["federation_send_batch", batch],
        ["federation_send_interval", interval],
      ] as const)
        this.store.db
          .prepare(
            "INSERT INTO instance_settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
          )
          .run(key, String(value));
      this.store.audit(admin.id, "federation.sending", JSON.stringify({ batch, interval }));
    });
    this.paceChanged?.();
    return this.status();
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
  // A role that no longer lets an account follow remote channels ends the follows it had.
  private permissionsChanged(user: User) {
    if (user.federation_subscribe && user.federation_receive) return;
    const subscriptions = this.store.db
      .prepare(
        "SELECT * FROM federation_subscriptions WHERE user_id=? AND status IN ('pending','accepted')",
      )
      .all(user.id) as unknown as { channel_id: string; follow_id: string }[];
    for (const sub of subscriptions)
      this.unsubscribe(user, sub.channel_id, true);
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
          .prepare("INSERT INTO federation_blocks VALUES(?,?) ON CONFLICT(target) DO UPDATE SET kind=excluded.kind")
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
    if (enabled && this.store.mirrorState(id))
      throw new Problem(400, "Mirrors cannot be federated.");
    if (enabled) this.ensureEnabled();
    if (enabled && !channel.federation_enabled)
      this.store.requirePermission(user, "federate_channels");
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
            "UPDATE federation_follows SET status='blocked',stream_start=NULL,stream_capable=0 WHERE channel_id=?",
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
        "SELECT f.*, u.username FROM federation_follows f LEFT JOIN users u ON u.remote_actor=f.actor WHERE f.channel_id=? ORDER BY f.actor",
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
  // Ends the follows of someone removed or banned from a home channel, or of everyone on a banned
  // instance, and tells them. Nothing is kept of the follow, so the ban alone decides a later one.
  private expelled(channel: Channel, who: { actor: string } | { instance: string }) {
    const follows = (
      this.store.db
        .prepare(
          "SELECT actor,follow_id FROM federation_follows WHERE channel_id=? AND status!='blocked'",
        )
        .all(channel.id) as { actor: string; follow_id: string }[]
    ).filter((f) =>
      "actor" in who ? f.actor === who.actor : new URL(f.actor).origin === who.instance,
    );
    for (const follow of follows) {
      if (this.enabled() && channel.federation_enabled)
        this.followAnswer(channel, follow.actor, follow.follow_id, false);
      this.store.db
        .prepare("DELETE FROM federation_follows WHERE channel_id=? AND actor=?")
        .run(channel.id, follow.actor);
      this.store.followEnded(channel.id, follow.actor);
    }
  }
  private followAnswer(
    channel: Channel,
    actor: string,
    followId: string,
    accept: boolean,
  ) {
    const document = this.store.db.prepare("SELECT document FROM federation_actors WHERE id=?").get(actor);
    const capable = this.config.federationChannelTransport !== "off" && document && JSON.parse(document.document).channelEvents?.version === 1;
    const start = this.channelFeed.tail(channel.id);
    this.store.db.prepare("UPDATE federation_follows SET stream_start=CASE WHEN ?=1 THEN COALESCE(stream_start,?) ELSE NULL END,stream_capable=?,instance_start=CASE WHEN ?=1 THEN COALESCE(instance_start,(SELECT tail FROM federation_instance_state WHERE id=1)) ELSE NULL END WHERE channel_id=? AND actor=?", { notify: false })
      .run(Number(accept && capable), start, Number(accept && capable), Number(accept && capable), channel.id, actor);
    const floor = this.store.db.prepare("SELECT stream_start,instance_start FROM federation_follows WHERE channel_id=? AND actor=?").get(channel.id, actor);
    this.queue(
      accept ? "Accept" : "Reject",
      this.channelActor(channel),
      {
        id: followId,
        ...(accept && capable ? { channelEvents: { version: 1, cursor: Number(floor?.stream_start), instanceCursor: Number(floor?.instance_start) } } : {}),
        type: "Follow",
        actor,
        object: this.channelActor(channel),
      },
      [actor],
      "membership",
      null,
      channel.id,
    );
    // A role kept from before the follow was accepted again is theirs again.
    const holder =
      accept &&
      (this.store.db.prepare("SELECT id FROM users WHERE remote_actor=?").get(actor) as
        | { id: string }
        | undefined);
    if (holder && this.store.channelRole(channel.id, holder.id))
      this.rolesChanged(channel, [holder.id]);
  }
  // A role as it is told to other instances: its name and what it allows.
  private roleDoc(channelId: string, userId: string) {
    const role = this.store.channelRole(channelId, userId);
    return role
      ? { name: role.name, permissions: channelPermissions.filter((p) => role[p]) }
      : null;
  }
  private roleFrom(doc: unknown) {
    const role = doc as { name?: unknown; permissions?: unknown } | null | undefined;
    if (!role || typeof role.name !== "string" || !Array.isArray(role.permissions))
      return null;
    const allowed = role.permissions as unknown[];
    return {
      name: role.name.slice(0, 40),
      permissions: channelPermissions.filter((p) => allowed.includes(p)),
    };
  }
  // Tells those following a home channel from elsewhere the role they now hold there, or that
  // they hold none. It is theirs to know; what it allows is decided here each time it is used.
  private rolesChanged(channel: Channel, userIds: string[]) {
    if (!this.enabled() || channel.remote_actor || !channel.federation_enabled) return;
    for (const id of userIds) {
      const actor = this.store.user(id).remote_actor;
      if (!actor || !this.acceptedFollower(channel.id, actor)) continue;
      this.queue(
        "Update",
        this.channelActor(channel),
        {
          type: "ChannelRole",
          channel: this.channelActor(channel),
          holder: actor,
          role: this.roleDoc(channel.id, id),
        },
        [actor],
        "moderation",
        null,
        channel.id,
      );
    }
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
      const name = String(actor.name || actor.preferredUsername || "Remote member").slice(0, 80);
      if (actor.type === "Person") this.store.db.prepare("UPDATE users SET display_name=? WHERE id=? AND display_name!=?")
        .run(name, existing.id, name);
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
  async resolveMember(value: unknown) {
    const local = this.store.localRecipient(value);
    if (local) return this.store.active(local);
    const actor = await this.resolve(text(value, "User address", 2048).replace(/^@/, ""));
    if (actor.type !== "Person") throw new Problem(400, "Choose a user, not a channel.");
    return this.store.active(this.remoteUser(actor).id);
  }
  allowAccess(user: User, channel: Channel, target: User) {
    this.store.active(user.id);
    if (!this.store.channelCan(user, channel, "allow_access"))
      throw new Problem(403, "Your role does not allow granting channel access.");
    if (target.remote_actor && !channel.federation_enabled)
      throw new Problem(403, "Enable channel federation before allowing remote users.");
    if (target.remote_actor) this.ensureEnabled();
    if (channel.remote_actor) this.moderateRemote(user, channel.id, target.id, { rule: "allow" });
    else this.store.setMember(user, channel.id, target.id, { rule: "allow" });
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
      throw new Problem(400, "Choose an FWDXP channel actor.");
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
        this.keepPrivacy(id, actor);
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
          "INSERT INTO federation_subscriptions(channel_id,user_id,follow_id,status) VALUES(?,?,?,'pending') ON CONFLICT(channel_id,user_id) DO UPDATE SET follow_id=excluded.follow_id,status='pending',stream_start=NULL",
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
      this.clearUnusedChannelCursor(id);
      this.store.db
        .prepare("DELETE FROM memberships WHERE channel_id=? AND user_id=?")
        .run(id, user.id);
      this.store.keepHeldRole(id, user.id, null);
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
    return this.store.transaction(() => {
    const activity: Doc = this.activity(type, actor, object);
    // A channel announcement addresses the conversation. Its durable recipient
    // rows determine delivery; expanding them on the wire leaks the roster and
    // makes an otherwise small update exceed the inbox limit on large channels.
    // The same immutable body/ID is retained across inboxes and retries.
    const broadcast = !!channelId && (type === "Announce" || type === "Update" && (object as Doc)?.type === "Group");
    activity.to = broadcast ? [actor] : recipients;
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
    let unique = [...new Set(recipients)];
    if (broadcast) {
      this.store.db.prepare("INSERT OR IGNORE INTO federation_channel_state(channel_id) VALUES(?)", { notify: false }).run(channelId);
      const state = this.store.db.prepare("UPDATE federation_channel_state SET tail=tail+1 WHERE channel_id=? RETURNING tail").get(channelId)!;
      this.store.db.prepare("INSERT INTO federation_channel_events(channel_id,seq,activity_id,created_at) VALUES(?,?,?,?)", { notify: false }).run(channelId, Number(state.tail), activity.id, Date.now());
      unique = unique.filter(recipient => !this.store.db.prepare("SELECT 1 FROM federation_follows WHERE channel_id=? AND actor=? AND stream_capable=1 AND stream_start IS NOT NULL").get(channelId,recipient));
    }
    for (let offset = 0; offset < unique.length; offset += 500) {
      const chunk = unique.slice(offset, offset + 500);
      this.store.db.prepare(
        `INSERT INTO federation_deliveries(activity_id,recipient) VALUES ${chunk.map(() => "(?,?)").join(",")}`,
      ).run(...chunk.flatMap(recipient => [activity.id, recipient]));
    }
    return activity.id;
    });
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
          ...this.store.emojiOwner(e.id),
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
          "SELECT actor FROM federation_follows WHERE channel_id=? AND status='accepted' AND (stream_capable=0 OR stream_start IS NULL)",
        )
        .all(channel.id) as unknown as { actor: string }[]
    ).map((f) => f.actor);
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
  // The message of a channel that an object address stands for, here or on its home.
  private messageAt(channelId: string, object: unknown) {
    const local = `${this.config.baseUrl}/objects/messages/`;
    return this.store.db
      .prepare(
        "SELECT id FROM messages WHERE channel_id=? AND (remote_object=? OR (? LIKE ? AND id=?))",
      )
      .get(channelId, String(object), String(object), `${local}%`, String(object).slice(local.length)) as
      | { id: string }
      | undefined;
  }
  // A custom emoji goes with the address of its picture: this instance's own, or where the one
  // kept from another instance came from.
  private reactionObject(channel: Channel, message: Message, emoji: string, on: boolean) {
    const picture = on ? this.store.reactionEmojiId(message.id, emoji) : undefined,
      source =
        picture &&
        (this.store.db.prepare("SELECT source_url FROM remote_emoji_cache WHERE id=?").get(picture) as
          | { source_url: string }
          | undefined);
    return {
      type: "Reaction",
      id: `${this.config.baseUrl}/federation/objects/${randomUUID()}`,
      target: message.remote_object || `${this.config.baseUrl}/objects/messages/${message.id}`,
      channel: this.channelActor(channel),
      emoji,
      on,
      ...(picture
        ? { image: source ? source.source_url : `${this.config.baseUrl}/federation/emojis/${picture}/image` }
        : {}),
    };
  }
  // The picture sent along with a custom emoji reaction, kept here: nothing when there is none
  // to be had from the instance of whoever sent it.
  private async reactionPicture(reaction: Doc, from: string[]) {
    if (
      reaction.on !== true ||
      typeof reaction.image !== "string" ||
      typeof reaction.emoji !== "string" ||
      !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(reaction.emoji) ||
      standardEmojis.has(reaction.emoji)
    )
      return undefined;
    try {
      const origin = this.allowed(reaction.image).origin;
      if (!from.some((actor) => new URL(actor).origin === origin)) return undefined;
      return await this.cacheEmoji(reaction.image);
    } catch {
      return undefined;
    }
  }
  // Keeps a copy of an emoji picture hosted on another instance; says which it is here.
  private async cacheEmoji(url: string) {
    const cached = this.store.db
      .prepare("SELECT id FROM remote_emoji_cache WHERE source_url=?")
      .get(url) as { id: string } | undefined;
    if (cached) return cached.id;
    const image = await peerRequest(this.allowed(url), this.config);
    const { decodeEmojiImage } = await import("./emoji-image.js");
    const decoded = decodeEmojiImage(image.body.toString("base64"));
    const id = randomUUID();
    this.store.db
      .prepare("INSERT INTO remote_emoji_cache VALUES(?,?,?,?)")
      .run(id, url, decoded.mime, decoded.image);
    return id;
  }
  // Tells the channel's followers about a reaction its home accepted, or one a moderator took
  // off for everyone.
  private relayReaction(user: User, message: Message, emoji: string, on: boolean, all = false) {
    const channel = this.store.channel(message.channel_id);
    if (this.importing || channel.remote_actor || !channel.federation_enabled) return;
    if (user.remote_actor?.startsWith("xmpp:")) return;
    const recipients = (
      this.store.db
        .prepare("SELECT actor FROM federation_follows WHERE channel_id=? AND status='accepted'")
        .all(channel.id) as unknown as { actor: string }[]
    ).map((f) => f.actor);
    if (!recipients.length) return;
    this.queue(
      "Announce",
      this.channelActor(channel),
      this.activity("React", this.userActor(user), {
        ...this.reactionObject(channel, message, emoji, on),
        ...(all ? { all: true } : {}),
      }),
      recipients,
      "relay",
      user.id,
      channel.id,
    );
  }
  // A reaction on a followed channel goes to its home, which sends it back to everyone, us included.
  remoteReact(user: User, id: string, input: Doc) {
    this.require(user, "federation_send");
    this.require(user, "federation_post");
    this.require(user, "federation_subscribe");
    const message = this.store.message(id),
      channel = this.store.channel(message.channel_id);
    this.store.requireRead(user, channel);
    if (!channel.remote_actor || !this.store.role(channel.id, user.id))
      throw new Problem(403, "Subscribe and wait for channel admission before reacting.");
    if (!channel.reactions) throw new Problem(403, "Reactions are turned off in this channel.");
    if (message.deleted_at) throw new Problem(409, "Removed messages cannot be reacted to.");
    if (typeof input.emoji !== "string" || typeof input.on !== "boolean" || !/^[a-z0-9_+-]{1,64}$/i.test(input.emoji))
      throw new Problem(400, "Choose an emoji.");
    // A custom emoji is this instance's, sent along with its picture, or one already on the message.
    if (input.on && !standardEmojis.has(input.emoji) && !this.store.reactionEmojiId(id, input.emoji))
      throw new Problem(400, "That emoji is not available here.");
    if (input.on && this.store.emojiBans(channel).has(input.emoji))
      throw new Problem(403, "That emoji is banned here.");
    this.queue(
      "React",
      this.userActor(user),
      this.reactionObject(channel, message, input.emoji, input.on),
      [channel.remote_actor],
      "post",
      user.id,
      channel.id,
    );
    return this.store.reactionsOf(user, id);
  }
  async sendDirect(user: User, value: unknown, bodyValue: unknown) {
    this.store.requirePermission(user, "direct_messages");
    this.require(user, "federation_send");
    const peer = await this.resolve(value);
    if (peer.type !== "Person")
      throw new Problem(400, "Direct messages need a remote user actor.");
    return this.sendResolvedDirect(user, peer.id, bodyValue);
  }
  sendResolvedDirect(user: User, peerId: string, bodyValue: unknown) {
    this.store.requirePermission(user, "direct_messages");
    this.require(user, "federation_send");
    this.allowed(peerId);
    if (this.store.isUserBlocked(user.id, peerId))
      throw new Problem(403, "You blocked this user.");
    const body = text(bodyValue, "Message", 8000),
      id = `${this.config.baseUrl}/federation/objects/${randomUUID()}`,
      emojis = this.store.messageEmojiTags(user, body);
    const note = this.signNote(
      {
        id,
        type: "Note",
        attributedTo: this.userActor(user),
        to: [peerId],
        mediaType: "text/plain",
        content: body,
        published: time(),
        emoji: emojis.slice(0, 8).map((e) => ({
          ...e,
          url: `${this.config.baseUrl}/federation/emojis/${e.id}/image`,
          ...this.store.emojiOwner(e.id),
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
          peerId,
          body,
          JSON.stringify(emojis),
          note.published,
        );
      this.store.publishAttachments(body, user.id);
      const activity = this.queue(
        "Create",
        this.userActor(user),
        note,
        [peerId],
        "direct",
        user.id,
        null,
      );
      return { id, activity, body, peer: peerId };
    });
  }
  // Finds the person behind an address, so a conversation with them can be opened.
  async resolveDirect(user: User, value: unknown) {
    this.store.requirePermission(user, "direct_messages");
    this.require(user, "federation_send");
    const peer = await this.resolve(value);
    if (peer.type !== "Person")
      throw new Problem(400, "Direct messages need a remote user actor.");
    return this.store.peerInfo(peer.id);
  }
  directMessages(user: User): Doc[] {
    const waiting = this.store.directDeliveryStates(user);
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
        ...(message.direction === "outgoing" ? waiting.get(String(message.id)) : {}),
        emojis: JSON.parse(String(message.emoji_tags)),
      }));
  }
  async remotePost(user: User, id: string, input: Doc) {
    return this.createRemotePost(user, id, input);
  }
  createRemotePost(user: User, id: string, input: Doc) {
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
      title = threadTitle(input.title);
    this.store.refuseBanned(body + (title || ""), channel);
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
      (channel.mode === "timeline" && (title || input.topic_id)) ||
      (channel.mode === "threaded" &&
        ((!parent && !title && !channel.optional_titles) ||
          (parent && title) ||
          input.topic_id)) ||
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
          ...this.store.emojiOwner(e.id),
        })),
      },
      this.userActor(user),
    );
    return this.store.transaction(() => {
      this.store.db
        .prepare("INSERT INTO federation_objects VALUES(?,?,?,?)")
        .run(objectId, user.id, channel.remote_actor, JSON.stringify(note));
      this.store.publishAttachments(body, user.id);
      this.queue(
        "Create",
        this.userActor(user),
        note,
        [channel.remote_actor!],
        "post",
        user.id,
        id,
      );
      return this.pendingPost(user, id, note, null);
    });
  }
  // A post on its way to the channel's home, shaped like the message it will come back as.
  private pendingPost(user: User, channelId: string, note: Doc, failed: string | null) {
    const parent = note.inReplyTo
      ? (this.store.db
          .prepare(
            "SELECT id FROM messages WHERE channel_id=? AND (remote_object=? OR (? LIKE ? AND id=?))",
          )
          .get(
            channelId,
            note.inReplyTo,
            note.inReplyTo,
            `${this.config.baseUrl}/objects/messages/%`,
            String(note.inReplyTo).split("/").at(-1) || "",
          ) as { id: string } | undefined)
      : undefined;
    const topic = note.topic
      ? (this.store.db
          .prepare("SELECT id FROM topics WHERE remote_id=? AND channel_id=?")
          .get(String(note.topic.id), channelId) as { id: string } | undefined)
      : undefined;
    const title = typeof note.name === "string" ? note.name : null;
    return {
      ...this.store.messageInfo({
        seq: 0,
        id: `queued-${String(note.id).split("/").at(-1)}`,
        channel_id: channelId,
        author_id: user.id,
        body: String(note.content),
        title,
        topic_id: topic?.id ?? null,
        parent_id: parent?.id ?? null,
        created_at: String(note.published),
        deleted_at: null,
        edited_at: null,
        remote_object: String(note.id),
        emoji_tags: JSON.stringify(
          this.store.messageEmojiTags(user, String(note.content) + (title || "")),
        ),
        history_placeholder: 0,
        username: user.username,
        display_name: user.display_name,
      }),
      queued: true,
      ...(failed === null ? {} : { failed }),
    };
  }
  /** The reader's own posts to a remote channel that its home has not sent back yet. */
  pendingPosts(user: User, channelId: string) {
    const channel = this.store.channel(channelId);
    if (!channel.remote_actor) return [];
    // One that was delivered but never came back, or that failed, is not shown forever.
    const rows = this.store.db
      .prepare(
        "SELECT o.activity,d.status,d.error FROM federation_deliveries d JOIN federation_outgoing o ON o.id=d.activity_id WHERE d.recipient=? AND o.channel_id=? AND o.user_id=? AND o.purpose='post' AND (d.status='pending' OR (d.status='sent' AND o.created_at>?) OR (d.status IN ('failed','cancelled') AND o.created_at>?)) ORDER BY d.id",
      )
      .all(
        channel.remote_actor,
        channelId,
        user.id,
        Date.now() - 3600000,
        Date.now() - 86400000,
      ) as unknown as { activity: string; status: string; error: string | null }[];
    return rows.flatMap((row) => {
      const activity = JSON.parse(row.activity) as Doc,
        note = activity.object as Doc;
      if (
        activity.type !== "Create" ||
        this.store.db
          .prepare("SELECT 1 FROM messages WHERE remote_object=?")
          .get(String(note.id))
      )
        return [];
      return [
        this.pendingPost(
          user,
          channelId,
          note,
          (row.status === "failed" || row.status === "cancelled") ? row.error || "Delivery failed." : null,
        ),
      ];
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
      const title = threadTitle(input.title);
      if (!title && message.title && !channel.optional_titles)
        throw new Problem(400, "Threads in this channel need a title.");
      if (title) note.name = title;
      else delete note.name;
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
      this.store.publishAttachments(note.content, user.id);
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
    // Someone else's message is removed by its home, for a subscriber whose role there allows it.
    const own = message.author_id === user.id;
    if (
      !channel.remote_actor ||
      !this.store.role(channel.id, user.id) ||
      (!own && !this.store.channelCan(user, channel, "delete_messages"))
    )
      throw new Problem(
        403,
        "Only the subscribed author, or a subscriber whose role allows it, can delete a remote message.",
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
      own ? "cleanup" : "moderate",
      user.id,
      channel.id,
    );
    if (!own) this.store.audit(user.id, "message.delete.remote", id);
  }
  // Granting access, removing or banning in a followed channel is asked of its home, for a subscriber whose role
  // there allows it. The home decides, and tells whoever it concerns.
  moderateRemote(user: User, id: string, targetId: string, input: Doc) {
    this.store.active(user.id);
    this.ensureEnabled();
    const channel = this.store.channel(id),
      target = this.store.user(targetId),
      banning = input.rule === "block" || input.rule === "clear",
      allowing = input.rule === "allow";
    if (
      !channel.remote_actor ||
      Object.keys(input).length !== 1 ||
      !(input.remove === true || banning || allowing) ||
      !this.store.channelCan(user, channel, allowing ? "allow_access" : banning ? "ban_members" : "kick_members")
    )
      throw new Problem(
        403,
        this.store.heldRole(id, user.id)
          ? "Your role in this channel does not allow that."
          : "Channel moderation belongs to its home instance.",
      );
    if (target.remote_actor?.startsWith("xmpp:"))
      throw new Problem(400, "The channel's home does not know this person.");
    this.queue(
      allowing ? "Add" : banning ? "Block" : "Remove",
      this.userActor(user),
      {
        type: "Person",
        id: this.userActor(target),
        channel: channel.remote_actor,
        ...(banning ? { on: input.rule === "block" } : {}),
      },
      [channel.remote_actor!],
      "moderate",
      user.id,
      id,
    );
    this.store.audit(
      user.id,
      "channel.membership.remote",
      JSON.stringify({ channel: id, user: targetId, ...input }),
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
  // Who is in a home channel, for the instances following it. Nothing leaves while the channel
  // keeps its member list to itself. Bounded like history: the first 500 by handle.
  roster(actor: Doc, id: string) {
    this.ensureEnabled();
    const channel = this.store.channel(id);
    if (
      !channel.federation_enabled ||
      channel.remote_actor ||
      !this.acceptedFollower(id, actor.id)
    )
      throw new Problem(403, "An accepted channel subscription is required.");
    // Whoever may remove or ban members is shown them, as a member here with that role is.
    const asking = this.store.db
        .prepare("SELECT id FROM users WHERE remote_actor=?")
        .get(actor.id) as { id: string } | undefined,
      held = asking && this.store.channelRole(id, asking.id);
    if (!channel.show_members && !held?.kick_members && !held?.ban_members)
      throw new Problem(403, "This channel does not show its members.");
    const items = this.store
      .members(id)
      .filter((u) => {
        if (u.banned || u.admission_status !== "approved") return false;
        if (!u.remote_actor) return true;
        try {
          // Occupants of bridged XMPP rooms have no actor to name.
          return this.allowed(u.remote_actor).protocol !== "xmpp:";
        } catch {
          return false;
        }
      })
      .slice(0, 500)
      .map((u) => ({
        type: "Person",
        id: u.remote_actor || this.userActor(u),
        preferredUsername: u.remote_actor ? u.username.split("@")[0] : u.username,
        name: u.display_name,
        role: u.role,
        ...(u.channel_role_id ? { channelRole: this.roleDoc(id, u.id) } : {}),
      }));
    return {
      "@context": context,
      type: "OrderedCollection",
      id: `${this.channelActor(channel)}/members`,
      totalItems: items.length,
      orderedItems: items,
    };
  }
  private async askRoster(channel: Channel, user: User) {
    try {
      const url = this.allowed(`${channel.remote_actor}/members`);
      const roster = await peerJson(
        url,
        this.config,
        signedHeaders(url, "GET", this.userActor(user), this.keys().private_key),
      );
      if (
        roster.type !== "OrderedCollection" ||
        !Array.isArray(roster.orderedItems) ||
        roster.orderedItems.length > 500
      )
        return;
      return roster.orderedItems as Doc[];
    } catch {
      // A home that hides its members, or does not offer the list, leaves what is known as it is.
    }
  }
  // The home's list replaces the last one. Only the home's own accounts can run the channel,
  // and a name it gives for someone already known here is not taken over theirs.
  private keepRoster(channel: Channel, items: Doc[]) {
    const home = new URL(channel.remote_actor!).origin,
      local = `${this.config.baseUrl}/actors/users/`;
    this.store.transaction(() => {
      this.store.db
        .prepare("DELETE FROM channel_roster WHERE channel_id=?")
        .run(channel.id);
      for (const item of items) {
        try {
          if (item?.type !== "Person" || typeof item.id !== "string") continue;
          const origin = this.allowed(item.id).origin;
          const known = (
            item.id.startsWith(local)
              ? this.store.db
                  .prepare("SELECT id FROM users WHERE id=? AND remote_actor IS NULL")
                  .get(item.id.slice(local.length))
              : this.store.db
                  .prepare("SELECT id FROM users WHERE remote_actor=?")
                  .get(item.id)
          ) as { id: string } | undefined;
          if (!known && origin === this.config.baseUrl) continue;
          // What the home says of a subscriber here replaces what it said before.
          if (known && origin === this.config.baseUrl)
            this.store.keepHeldRole(channel.id, known.id, this.roleFrom(item.channelRole));
          this.store.db
            .prepare("INSERT OR IGNORE INTO channel_roster VALUES(?,?,?)")
            .run(
              channel.id,
              known?.id ?? this.remoteUser(item).id,
              origin === home && ["owner", "moderator"].includes(item.role)
                ? item.role
                : "member",
            );
        } catch {
          // A blocked or malformed entry is left out; the rest of the list stands.
        }
      }
    });
  }
  // A subscriber opening a followed channel has its home asked again, at most once a minute.
  async refreshRoster(user: User, id: string) {
    const channel = this.store.channel(id);
    if (
      !this.enabled() ||
      !channel.remote_actor ||
      !this.store.sees(user, channel, "members") ||
      (this.rosterAsked.get(id) || 0) > Date.now() - 60000 ||
      !user.federation_receive ||
      !user.federation_subscribe ||
      !this.store.db
        .prepare(
          "SELECT 1 FROM federation_subscriptions WHERE channel_id=? AND user_id=? AND status='accepted'",
        )
        .get(id, user.id)
    )
      return;
    this.rosterAsked.set(id, Date.now());
    const items = await this.askRoster(channel, user);
    if (
      items &&
      this.store.db.prepare("SELECT 1 FROM channels WHERE id=? AND remote_actor IS NOT NULL").get(id)
    )
      this.keepRoster(channel, items);
  }
  acceptedFollower(id: string, actor: string) {
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
    const emojis: { id: string; name: string; url: string; personal?: boolean; owner?: string }[] = [];
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
      const cached = { id: await this.cacheEmoji(emoji.url) };
      emojis.push({
        id: cached.id,
        name: emoji.name,
        url: `/api/emojis/${cached.id}/image`,
        ...(emoji.personal === true &&
        typeof emoji.owner === "string" &&
        /^[a-zA-Z0-9._-]{1,64}$/.test(emoji.owner)
          ? { personal: true, owner: emoji.owner }
          : {}),
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
    // A followed channel's home has already decided whether a thread may go untitled; here the
    // channel's own setting does, and a thread that had no title may stay without one.
    const untitled =
      !!channel.remote_actor ||
      !!channel.optional_titles ||
      (!!found && this.store.message(found.id).title === null);
    if (
      (channel.mode === "timeline" && (topicId || note.name)) ||
      (channel.mode === "threaded" &&
        ((!parentId && !note.name && !untitled) ||
          (parentId && note.name) ||
          topicId)) ||
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
  async receive(req: Request, raw: Buffer, transport?: { sender: Doc; checkpoint: Checkpoint }) {
    if (this.config.nativeChatUrl && !this.config.xmppDomain) {
      await this.store.db.listenExternalChanges();
      const headers: Record<string,string>={};
      if (!transport) for(const [key,value] of Object.entries(req.headers)) if(typeof value === "string") headers[key]=value;
      const result=await this.nativeRequest("receive",{headers,method:transport ? "GET" : req.method,target:transport ? "" : req.originalUrl,body:raw.toString("base64"),
        ...(transport ? { stream: { actor: transport.sender.id, ...transport.checkpoint } } : {}) });
      if(result.supported) { this.nativeStats.received++; this.store.mirrorHooks?.pull(); return; }
      this.nativeStats.unsupported++;
    }
    const sender = transport?.sender || await this.authenticate(req, raw);
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
      if (transport) await this.writes.run(() => this.store.transaction(() => this.commitChannelCheckpoint(transport.checkpoint)));
      return;
    }
    const object = activity.object;
    let prepared: Awaited<ReturnType<Federation["prepareNote"]>> | undefined;
    let snapshot: Awaited<ReturnType<Federation["snapshot"]>> | undefined;
    let roster: Doc[] | undefined;
    let picture: string | undefined;
    const profileUpdate = activity.type === "Update" && object?.type === "Person";
    const profileRelay = activity.type === "Announce" && sender.type === "Group" && object?.type === "Update" && object.object?.type === "Person";
    const channelUpdate = activity.type === "Update" && object?.type === "Group";
    let renamed: Doc | undefined;
    let reactor: Doc | undefined;
    let accessTarget: Doc | undefined;
    const roleUpdate = activity.type === "Update" && object?.type === "ChannelRole";
    if (activity.type === "Add") {
      const home = `${this.config.baseUrl}/actors/channels/`;
      if (sender.type !== "Person" || object?.type !== "Person" ||
          typeof object.id !== "string" || typeof object.channel !== "string" ||
          !object.channel.startsWith(home))
        throw new Problem(400, "Name a person to allow into a home channel.");
      const channel = this.store.channel(object.channel.slice(home.length));
      const remote = this.remoteUser(sender);
      if (!channel.federation_enabled || channel.remote_actor ||
          !this.acceptedFollower(channel.id, sender.id) ||
          !this.store.channelCan(remote, channel, "allow_access"))
        throw new Problem(403, "Channel access permission denied.");
      accessTarget = await this.actor(object.id);
      if (accessTarget.type !== "Person") throw new Problem(400, "Choose a user actor.");
    } else if (roleUpdate) {
      if (sender.type !== "Group" || object.channel !== sender.id)
        throw new Problem(403, "A role is told by the channel it is held in.");
    } else if (channelUpdate) {
      if (sender.type !== "Group" || object.id !== sender.id)
        throw new Problem(403, "Channel update must belong to its signing actor.");
      // As with profiles, the channel's own endpoint is the authority on its name.
      renamed = await this.actor(sender.id, true);
    } else if (profileUpdate) {
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
    } else if (activity.type === "React") {
      if (sender.type !== "Person" || object?.type !== "Reaction")
        throw new Problem(403, "Only a person can react.");
      picture = await this.reactionPicture(object, [sender.id]);
    } else if (activity.type === "Announce" && object?.type === "React") {
      if (sender.type !== "Group" || typeof object.actor !== "string" || object.object?.type !== "Reaction")
        throw new Problem(400, "Invalid channel distribution activity.");
      reactor = await this.actor(object.actor);
      picture = await this.reactionPicture(object.object, [object.actor, sender.id]);
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
      const channel = this.store.channel(sub.channel_id);
      const negotiated = object.channelEvents?.version === 1 && Number.isSafeInteger(object.channelEvents.cursor) && object.channelEvents.cursor >= 0;
      if (object.channelEvents?.version === 1 && !negotiated) throw new Problem(400, "Invalid channel stream admission cursor.");
      if (negotiated && this.hasChannelConsumer(channel.id, object.channelEvents.cursor)) {
        snapshot = { items: [], topics: [] };
      } else if (negotiated) {
        const bootstrapKey = `${channel.id}:${object.channelEvents.cursor}`;
        let bootstrap = this.channelBootstraps.get(bootstrapKey);
        if (!bootstrap) {
          bootstrap = { owner: user.id,
            job: (async () => ({ snapshot: await this.snapshot(channel, user), roster: await this.askRoster(channel, user) }))() };
          this.channelBootstraps.set(bootstrapKey, bootstrap);
          void bootstrap.job.finally(() => { if (this.channelBootstraps.get(bootstrapKey) === bootstrap) this.channelBootstraps.delete(bootstrapKey); }).catch(() => {});
        }
        try { ({ snapshot, roster } = await bootstrap.job); }
        catch (error) {
          // One follower's revoked admission must not poison other accepted
          // followers sharing this peer's initial channel bootstrap.
          if (bootstrap.owner === user.id) throw error;
          snapshot = await this.snapshot(channel, user);
          roster = await this.askRoster(channel, user);
        }
      } else {
        snapshot = await this.snapshot(channel, user);
        roster = await this.askRoster(channel, user);
      }
    }
    await this.writes.run(() => this.store.transaction(() => {
      this.ensureEnabled();
      this.allowed(sender.id);
      if (transport) this.checkChannelCheckpoint(transport.checkpoint);
      const duplicate = this.store.db
        .prepare("SELECT digest FROM federation_incoming WHERE id=?")
        .get(activity.id) as { digest: string } | undefined;
      if (duplicate) {
        if (duplicate.digest !== hash(raw.toString()))
          throw new Problem(409, "Conflicting activity.");
        if (transport) this.commitChannelCheckpoint(transport.checkpoint);
        return;
      }
      if (channelUpdate) {
        const channel = this.store.db.prepare("SELECT id FROM channels WHERE remote_actor=?").get(sender.id) as { id: string } | undefined;
        if (!channel) throw new Problem(403, "Unknown remote channel.");
        const name = `${String(renamed!.preferredUsername).slice(0, 40)}@${new URL(sender.id).host}`;
        if (!this.store.db.prepare("SELECT 1 FROM channels WHERE name=? AND id!=?").get(name, channel.id))
          this.store.db.prepare("UPDATE channels SET name=?,description=? WHERE id=?")
            .run(name, String(renamed!.summary || "").slice(0, 500), channel.id);
        this.keepPrivacy(channel.id, renamed!);
      } else if (roleUpdate) {
        const channel = this.store.db.prepare("SELECT id FROM channels WHERE remote_actor=?").get(sender.id) as { id: string } | undefined;
        if (!channel) throw new Problem(403, "Unknown remote channel.");
        const local = `${this.config.baseUrl}/actors/users/`,
          holder = typeof object.holder === "string" && object.holder.startsWith(local) ? object.holder.slice(local.length) : "";
        if (
          !this.store.db
            .prepare("SELECT 1 FROM federation_subscriptions WHERE channel_id=? AND user_id=? AND status='accepted'")
            .get(channel.id, holder)
        )
          throw new Problem(403, "The role is not for a subscriber here.");
        this.store.keepHeldRole(channel.id, holder, this.roleFrom(object.role));
      } else if (profileUpdate || profileRelay) {
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
        const banned =
            this.store.rule(channel.id, remote.id) === "block" ||
            this.store.instanceBanned(channel.id, sender.id),
          blocked = banned || old?.status === "blocked";
        const accept =
          !blocked &&
          (channel.admission === "open" ||
            old?.status === "accepted" ||
            this.store.rule(channel.id, remote.id) === "allow");
        // A ban answers for itself: no follow is kept, so once it is lifted they can ask again.
        if (banned)
          this.store.db
            .prepare(
              "DELETE FROM federation_follows WHERE channel_id=? AND actor=? AND status!='blocked'",
            )
            .run(channel.id, sender.id);
        else
          this.store.db
            .prepare(
              "INSERT INTO federation_follows(channel_id,actor,follow_id,status) VALUES(?,?,?,?) ON CONFLICT(channel_id,actor) DO UPDATE SET follow_id=excluded.follow_id,status=excluded.status,stream_start=CASE WHEN federation_follows.follow_id=excluded.follow_id THEN federation_follows.stream_start ELSE NULL END,instance_start=CASE WHEN federation_follows.follow_id=excluded.follow_id THEN federation_follows.instance_start ELSE NULL END",
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
        for (const { channel_id } of this.store.db
          .prepare("SELECT channel_id FROM federation_follows WHERE actor=? AND follow_id=?")
          .all(sender.id, object.id) as { channel_id: string }[])
          this.store.followEnded(channel_id, sender.id);
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
          const bootstrap = object.channelEvents?.version !== 1 || !this.hasChannelConsumer(channel.id, object.channelEvents.cursor);
          if (bootstrap) {
            for (const topic of snapshot!.topics) this.importTopic(channel, topic);
            for (const item of snapshot!.items) this.importNote(channel, item);
            if (roster) this.keepRoster(channel, roster);
          }
          this.store.db
            .prepare("INSERT OR IGNORE INTO memberships VALUES(?,?,'member')")
            .run(channel.id, sub.user_id);
          this.store.startReading(sub.user_id, channel.id);
        } else {
          this.store.db
            .prepare("DELETE FROM memberships WHERE channel_id=? AND user_id=?")
            .run(channel.id, sub.user_id);
          this.store.keepHeldRole(channel.id, sub.user_id, null);
        }
        this.store.db
          .prepare(
            "UPDATE federation_subscriptions SET status=? WHERE follow_id=?",
          )
          .run(accepted ? "accepted" : "rejected", object.id);
        const start = accepted && object.channelEvents?.version === 1 && Number.isSafeInteger(object.channelEvents.cursor) && object.channelEvents.cursor >= 0
          ? object.channelEvents.cursor : null;
        this.store.db.prepare("UPDATE federation_subscriptions SET stream_start=?,instance_start=? WHERE follow_id=?", { notify: false }).run(start, start !== null && Number.isSafeInteger(object.channelEvents.instanceCursor) && object.channelEvents.instanceCursor >= 0 ? object.channelEvents.instanceCursor : null, object.id);
        this.clearUnusedChannelCursor(channel.id);
      } else if (activity.type === "React") {
        const home = `${this.config.baseUrl}/actors/channels/`;
        if (typeof object.channel !== "string" || !object.channel.startsWith(home))
          throw new Problem(400, "Reaction is not addressed to a home channel.");
        const channel = this.store.channel(object.channel.slice(home.length));
        const remote = this.remoteUser(sender);
        if (
          !channel.federation_enabled ||
          channel.remote_actor ||
          !this.acceptedFollower(channel.id, sender.id) ||
          this.store.rule(channel.id, remote.id) === "block"
        )
          throw new Problem(403, "Channel subscription or reaction permission denied.");
        this.store.active(remote.id);
        const target = this.messageAt(channel.id, object.target);
        if (!channel.reactions || !target || this.store.message(target.id).deleted_at)
          throw new Problem(409, "That message cannot be reacted to.");
        // A custom emoji is one of this instance's, one already on the message, or the picture sent along.
        const known =
          typeof object.emoji === "string" ? this.store.reactionEmojiId(target.id, object.emoji) ?? picture : undefined;
        if (
          typeof object.emoji !== "string" ||
          typeof object.on !== "boolean" ||
          !/^[a-z0-9_+-]{1,64}$/i.test(object.emoji) ||
          (object.on && !standardEmojis.has(object.emoji) && !known)
        )
          throw new Problem(400, "That emoji is not available here.");
        if (object.on && this.store.emojiBans(channel).has(object.emoji))
          throw new Problem(403, "That emoji is banned here.");
        this.store.applyReaction(remote.id, target.id, object.emoji, object.on, known);
        this.relayReaction(remote, this.store.message(target.id), object.emoji, object.on);
      } else if (activity.type === "Announce" && object?.type === "React") {
        const channel = this.store.db
          .prepare("SELECT * FROM channels WHERE remote_actor=?")
          .get(sender.id) as unknown as Channel | undefined;
        if (!channel) throw new Problem(403, "Unknown remote channel.");
        const reaction = object.object,
          target = this.messageAt(channel.id, reaction.target);
        if (
          reaction.channel !== sender.id ||
          typeof reaction.emoji !== "string" ||
          !/^[a-z0-9_+-]{1,64}$/i.test(reaction.emoji) ||
          typeof reaction.on !== "boolean"
        )
          throw new Problem(400, "Invalid reaction.");
        // A message from before this instance followed the channel may not be here.
        if (target && reaction.all === true) this.store.dropReaction(target.id, reaction.emoji);
        else if (target)
          this.store.applyReaction(this.remoteUser(reactor!).id, target.id, reaction.emoji, reaction.on, picture);
      } else if (activity.type === "Announce") {
        const channel = this.store.db
          .prepare("SELECT * FROM channels WHERE remote_actor=?")
          .get(sender.id) as unknown as Channel | undefined;
        if (!channel) throw new Problem(403, "Unknown remote channel.");
        const subscriber = transport || this.store.db
          .prepare(
            "SELECT 1 FROM federation_subscriptions s JOIN users u ON u.id=s.user_id WHERE s.channel_id=? AND s.status='accepted' AND u.banned=0 AND u.admission_status='approved' AND u.federation_receive=1 AND u.federation_subscribe=1 LIMIT 1",
          )
          .get(channel.id);
        if (!subscriber)
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
          // Someone else's message goes only for a follower whose role here allows it, which
          // the channel's own roles say; removing it tells the followers as a member's removal does.
          const other = existing ? undefined : this.messageAt(channel.id, object.id);
          if (other && this.store.channelRole(channel.id, remote.id)?.delete_messages) {
            if (!this.store.message(other.id).deleted_at)
              this.store.deleteMessage(remote, other.id);
          } else if (!existing)
            throw new Problem(403, "Delete target does not belong to sender.");
          else {
            this.store.db
              .prepare(
                "UPDATE messages SET body='',title=NULL,deleted_at=? WHERE id=?",
              )
              .run(time(), existing.id);
            this.relay(this.store.message(existing.id), "Delete", remote);
          }
        } else {
          this.importNote(channel, prepared!);
          const message = this.store.db
            .prepare("SELECT id FROM messages WHERE remote_object=?")
            .get(object.id) as { id: string };
          this.relay(this.store.message(message.id), activity.type, remote);
        }
      } else if (["Remove", "Block", "Add"].includes(activity.type)) {
        const home = `${this.config.baseUrl}/actors/channels/`,
          people = `${this.config.baseUrl}/actors/users/`;
        if (
          sender.type !== "Person" ||
          object?.type !== "Person" ||
          typeof object.id !== "string" ||
          typeof object.channel !== "string" ||
          !object.channel.startsWith(home) ||
          (activity.type === "Block" && typeof object.on !== "boolean")
        )
          throw new Problem(400, "Name someone in a home channel.");
        const channel = this.store.channel(object.channel.slice(home.length));
        const remote = this.remoteUser(sender);
        if (
          !channel.federation_enabled ||
          channel.remote_actor ||
          !this.acceptedFollower(channel.id, sender.id)
        )
          throw new Problem(403, "Channel subscription or moderation permission denied.");
        const target = activity.type === "Add" ? this.remoteUser(accessTarget!) : (
          object.id.startsWith(people)
            ? this.store.db
                .prepare("SELECT id FROM users WHERE id=? AND remote_actor IS NULL")
                .get(object.id.slice(people.length))
            : this.store.db.prepare("SELECT id FROM users WHERE remote_actor=?").get(object.id)
        ) as { id: string } | undefined;
        if (!target) throw new Problem(404, "This channel does not know that person.");
        // As for a member here who holds a role: the channel's own roles say what the sender may
        // do, and the owner, moderators and other role holders are out of reach.
        this.store.setMember(
          remote,
          channel.id,
          target.id,
          activity.type === "Add"
            ? { rule: "allow" }
            : activity.type === "Remove"
            ? { remove: true }
            : { rule: object.on ? "block" : "clear" },
        );
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
      if (transport) this.commitChannelCheckpoint(transport.checkpoint);
    }));
    this.store.mirrorHooks?.pull();
  }
  channelPageAllowance(recipient: string) {
    const sends = this.peerAllowance(recipient);
    if (!sends) return false;
    sends.push(Date.now()); return true;
  }
  channelPeerUrl(value: string) { return this.allowed(value); }
  channelDeliveryAllowed(outgoing: Outgoing, recipient: string) { this.deliveryAllowed(outgoing, recipient); }
  private clearUnusedChannelCursor(id: string) {
    this.store.db.prepare("DELETE FROM federation_channel_cursors WHERE channel_id=? AND NOT EXISTS(SELECT 1 FROM federation_subscriptions s JOIN users u ON u.id=s.user_id WHERE s.channel_id=? AND s.status='accepted' AND s.stream_start IS NOT NULL AND u.banned=0 AND u.admission_status='approved' AND u.federation_receive=1 AND u.federation_subscribe=1)", { notify: false }).run(id, id);
  }
  private hasChannelConsumer(id: string, boundary: number) {
    return !!this.store.db.prepare("SELECT 1 FROM federation_subscriptions s JOIN users u ON u.id=s.user_id WHERE s.channel_id=? AND s.status='accepted' AND s.stream_start IS NOT NULL AND u.banned=0 AND u.admission_status='approved' AND u.federation_receive=1 AND u.federation_subscribe=1 AND MAX(s.stream_start,COALESCE((SELECT cursor FROM federation_channel_cursors WHERE channel_id=s.channel_id),0))>=? LIMIT 1").get(id, boundary);
  }
  private checkChannelCheckpoint(checkpoint: Checkpoint) {
    this.ensureEnabled(); this.allowed(checkpoint.channel);
    const row = this.store.db.prepare("SELECT c.id,s.stream_start,p.cursor FROM channels c JOIN federation_subscriptions s ON s.channel_id=c.id JOIN users u ON u.id=s.user_id JOIN federation_channel_cursors p ON p.channel_id=c.id WHERE c.remote_actor=? AND s.follow_id=? AND s.status='accepted' AND u.banned=0 AND u.admission_status='approved' AND u.federation_receive=1 AND u.federation_subscribe=1").get(checkpoint.channel, checkpoint.follow);
    if (!row || row.stream_start == null || !Number.isSafeInteger(checkpoint.after) || !Number.isSafeInteger(checkpoint.cursor) || checkpoint.cursor !== checkpoint.after + 1 || checkpoint.after !== Math.max(Number(row.cursor), Number(row.stream_start)))
      throw new Problem(409, "Channel consumption checkpoint or admission changed.");
    return row;
  }
  private commitChannelCheckpoint(checkpoint: Checkpoint) {
    const row = this.checkChannelCheckpoint(checkpoint);
    this.store.db.prepare("UPDATE federation_channel_cursors SET cursor=?,error=NULL,retry_at=0 WHERE channel_id=?", { notify: false }).run(checkpoint.cursor, row.id);
  }
  async receiveChannelEvent(sender: Doc, raw: string | null, checkpoint: Checkpoint) {
    if (sender.id !== checkpoint.channel || sender.type !== "Group") throw new Problem(403, "Invalid channel stream authority.");
    if (raw === null) {
      await this.writes.run(() => this.store.transaction(() => this.commitChannelCheckpoint(checkpoint)));
      return false;
    }
    if (Buffer.byteLength(raw) > 65536) throw new Problem(413, "Channel activity exceeds the inbox limit.");
    const activity = JSON.parse(raw);
    if (activity.actor !== sender.id || !(activity.type === "Announce" || activity.type === "Update" && activity.object?.type === "Group" && activity.object.id === sender.id))
      throw new Problem(403, "Activity does not belong to the authenticated channel stream.");
    const inner = activity.type === "Announce" ? activity.object : null;
    const author = inner?.object?.type === "Note" ? inner.object.attributedTo
      : inner?.type === "React" || inner?.type === "Update" && inner.object?.type === "Person" ? inner.actor : null;
    if (typeof author === "string") {
      let denied = false;
      try { this.allowed(author); } catch (error) { if (error instanceof Problem && error.status === 403) denied = true; else throw error; }
      const prefix = `${this.config.baseUrl}/actors/users/`;
      const known = this.store.db.prepare("SELECT banned,admission_status FROM users WHERE remote_actor=? OR (remote_actor IS NULL AND id=?)").get(author, author.startsWith(prefix) ? author.slice(prefix.length) : "");
      if (denied || known && (Number(known.banned) !== 0 || known.admission_status !== "approved")) {
        // Local author blocks discard this content, while later allowed authors
        // continue on the same channel. Channel/follower revocation still stops
        // consumption through the atomic checkpoint's own admission checks.
        if (typeof activity.id !== "string" || this.allowed(activity.id).origin !== new URL(sender.id).origin)
          throw new Problem(403, "Activity authority does not match its channel.");
        await this.writes.run(() => this.store.transaction(() => {
          this.checkChannelCheckpoint(checkpoint);
          const digest = hash(raw), previous = this.store.db.prepare("SELECT digest FROM federation_incoming WHERE id=?").get(activity.id);
          if (previous && previous.digest !== digest) throw new Problem(409, "Activity ID reused with different content.");
          if (!previous) this.store.db.prepare("INSERT INTO federation_incoming(id,digest,received_at) VALUES(?,?,?)", { notify: false }).run(activity.id, digest, Date.now());
          this.commitChannelCheckpoint(checkpoint);
        }));
        return false;
      }
    }
    await this.receive(undefined as unknown as Request, Buffer.from(raw), { sender, checkpoint });
    return true;
  }
  /** Common publication policy, evaluated once per shared event, without followers. */
  channelPublicationAllowed(outgoing: Outgoing) {
    this.ensureEnabled();
    const channel = this.store.channel(outgoing.channel_id!);
    if (!channel.federation_enabled || channel.remote_actor) throw new Problem(403, "Channel federation disabled.");
    if (!outgoing.user_id) return;
    const user = this.store.active(outgoing.user_id);
    if (user.remote_actor) {
      this.allowed(user.remote_actor);
      if (this.store.rule(channel.id, user.id) === "block") throw new Problem(403, "Author blocked from channel.");
    } else if (outgoing.purpose === "relay") {
      this.require(user, "federation_send"); this.require(user, "federation_post");
    }
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
    } else if (outgoing.purpose === "moderate") {
      this.store.active(user!.id);
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
  // This minute's sends to the recipient's host, or null once the peer allowance is spent.
  private peerAllowance(recipient: string) {
    const host = URL.parse(recipient)?.host || recipient,
      limit = this.config.federationPeerSendRate,
      recent = (this.peerSends.get(host) || []).filter(
        (at) => at > Date.now() - 60000,
      );
    this.peerSends.set(host, recent);
    return limit && recent.length >= limit ? null : recent;
  }
  /** A fresh policy snapshot for the followers sharing one announcement. */
  private followerPolicies(channel: string, recipients: string[]) {
    const result=new Map<string,Problem | null>();
    const candidates:{actor:string;origin:string}[]=[];
    for(const actor of recipients) {
      try { candidates.push({actor,origin:peerUrl(actor,this.config).origin}); }
      catch(error) { result.set(actor,error as Problem); }
    }
    for(let offset=0;offset<candidates.length;offset+=400) {
      const chunk=candidates.slice(offset,offset+400);
      const rows=this.store.db.prepare(`WITH candidates(actor,origin) AS (VALUES ${chunk.map(()=>"(?,?)").join(",")})
        SELECT c.actor,
          CASE WHEN EXISTS(SELECT 1 FROM federation_blocks b WHERE b.target=c.actor OR b.target=c.origin) THEN 1 ELSE 0 END AS blocked,
          CASE WHEN EXISTS(SELECT 1 FROM federation_follows f JOIN users u ON u.remote_actor=f.actor
            WHERE f.channel_id=? AND f.actor=c.actor AND f.status='accepted'
              AND u.banned=0 AND u.admission_status='approved'
              AND NOT EXISTS(SELECT 1 FROM channel_rules r WHERE r.channel_id=f.channel_id AND r.user_id=u.id AND r.rule='block'))
            THEN 1 ELSE 0 END AS admitted
        FROM candidates c`).all(...chunk.flatMap(c=>[c.actor,c.origin]),channel);
      for(const row of rows) result.set(row.actor,row.blocked ? new Problem(403,"This remote instance or actor is blocked.")
        : !row.admitted ? new Problem(403,"Recipient no longer has channel access.") : null);
    }
    return result;
  }
  private async deliver(delivery: Delivery, peers: Delivery[]) {
    let group = [delivery];
    try {
      this.deliveryAllowed(delivery, delivery.recipient);
      const actor = await this.actor(delivery.recipient), url = this.allowed(actor.inbox);
      // Only channel-wide Announce activities share a POST, and only when the
      // current actor documents advertise exactly the same inbox URL.
      for (let offset = 0; offset < peers.length; offset += 8) {
        const candidates = await Promise.all(peers.slice(offset, offset + 8).map(async row => {
          if (row.delivery_id === delivery.delivery_id) return null;
          try {
            const destination = await this.actor(row.recipient);
            return this.allowed(destination.inbox).href === url.href ? row : null;
          } catch { return null; } // Record an unavailable/denied peer independently at its own head.
        }));
        group.push(...candidates.filter((row): row is Delivery => row !== null));
      }
      // Discovery yields to other requests. Recheck every member synchronously
      // just before transmission; revocation cancels only that recipient's row.
      const shared = ["relay", "moderation"].includes(delivery.purpose) && JSON.parse(delivery.activity).type === "Announce";
      const followerPolicies=shared?this.followerPolicies(delivery.channel_id!,group.map(row=>row.recipient)):null;
      let commonAuthorized = false;
      const cancelled: { id: number; error: string }[] = [];
      group = group.filter(row => {
        try {
          if (!shared || !commonAuthorized) {
            this.deliveryAllowed(row, row.recipient);
            commonAuthorized = true;
          } else {
            // These rows share the exact channel/author/activity. No await occurs
            // during this pass, so common policy stays current while each distinct
            // follower's instance/actor block and admission are still checked.
            const denied=followerPolicies!.get(row.recipient);
            if(denied) throw denied;
            if(!followerPolicies!.has(row.recipient)) throw new Problem(403,"Recipient no longer has channel access.");
          }
          return true;
        }
        catch (error) {
          cancelled.push({id:row.delivery_id,error:String((error as Error).message).slice(0,200)});
          return false;
        }
      });
      if (cancelled.length) this.store.transaction(() => {
        for(let offset=0;offset<cancelled.length;offset+=250) {
          const chunk=cancelled.slice(offset,offset+250);
          this.store.db.prepare(`UPDATE federation_deliveries SET status='cancelled',error=CASE id ${chunk.map(()=>"WHEN ? THEN ?").join(" ")} END WHERE id IN (${chunk.map(()=>"?").join(",")}) AND status='pending'`)
            .run(...chunk.flatMap(row=>[row.id,row.error]),...chunk.map(row=>row.id));
        }
      });
      if (!group.length) return;
      // Other in-flight groups may have spent the last allowance during discovery.
      const sends = this.peerAllowance(delivery.recipient);
      if (!sends) return;
      sends.push(Date.now());
      this.deliveryStats.requests++;
      this.deliveryStats.recipientAttempts += group.length;
      await peerRequest(url, this.config,
        signedHeaders(url, "POST", delivery.signer, this.keys().private_key, delivery.activity), delivery.activity);
      await this.writes.run(() => this.store.transaction(() => {
        for (let offset = 0; offset < group.length; offset += 500) {
          const ids = group.slice(offset, offset + 500).map(row => row.delivery_id);
          this.store.db.prepare(
            `UPDATE federation_deliveries SET status='sent',attempts=attempts+1,error=NULL WHERE id IN (${ids.map(() => "?").join(",")})`,
          ).run(...ids);
        }
      }));
    } catch (error) {
      const problem = error as Problem;
      const permanent = problem instanceof Problem && [400, 401, 403, 404, 409, 410, 413].includes(problem.status);
      const failedAt = Date.now();
      await this.writes.run(() => this.store.transaction(() => {
        const updates=group.map(row=>{
          let cancelled=false;
          try { this.deliveryAllowed(row,row.recipient); } catch { cancelled=true; }
          return {id:row.delivery_id,status:cancelled ? "cancelled" : permanent || row.attempts>=11 ? "failed" : "pending",
            due:failedAt+Math.min(3600000,5000*2**row.attempts)};
        });
        for(let offset=0;offset<updates.length;offset+=250) {
          const chunk=updates.slice(offset,offset+250);
          this.store.db.prepare(`UPDATE federation_deliveries SET status=CASE id ${chunk.map(()=>"WHEN ? THEN ?").join(" ")} END,attempts=attempts+1,next_attempt=CASE id ${chunk.map(()=>"WHEN ? THEN CAST(? AS BIGINT)").join(" ")} END,error=? WHERE id IN (${chunk.map(()=>"?").join(",")}) AND status='pending'`)
            .run(...chunk.flatMap(row=>[row.id,row.status]),...chunk.flatMap(row=>[row.id,row.due]),
              String(problem.message || "Network delivery failed").slice(0,200),...chunk.map(row=>row.id));
        }
      }));
    }
  }
  async tick(options: {wait?:boolean;drainOnly?:boolean} = {}) {
    await this.channelFeed.sync(options.drainOnly, options.wait === false);
    if (this.busy) return;
    this.busy = true;
    if (this.config.nativeChatUrl) {
      try {
        const result = await this.nativeRequest("tick",options);
        this.nativeStats.ticks++;
        this.nativeStats.senderSelectionMs += result.selectionMs || 0;
        this.nativeStats.senderDeliveryMs += result.deliveryMs || 0;
        this.nativeStats.senderJobs += result.jobs || 0;
        this.nativeStats.senderActive = result.active || 0;
        if(result.stages) this.nativeStats.stages = result.stages;
        this.deliveryStats.requests += result.requests;
        this.deliveryStats.recipientAttempts += result.recipientAttempts;
      } catch (error) { this.nativeStats.senderErrors++; throw error; }
      finally { this.busy = false; }
      return;
    }
    const active = new Set<Promise<void>>(), claimed = new Set<number>(), exhausted = new Set<string>();
    try {
      const batch = this.sending().batch;
      const deadline = Date.now() + 1000;
      let work = 0;
      while ((work < batch && Date.now() < deadline) || active.size) {
        if (work >= batch || Date.now() >= deadline || active.size >= this.config.federationSendConcurrency) {
          // The clock can cross the deadline between the loop condition and
          // this guard. Promise.race([]) would never settle and stall the sender.
          if(!active.size)break;
          await Promise.race(active); continue;
        }
        const omit = [...exhausted].flatMap(host => ["http", "https"].map(scheme =>
          `${scheme}://${host}/`.replace(/[\\%_]/g, "\\$&") + "%"));
        const ids = [...claimed];
        // The adapter's iterate() materializes all rows. Fetch just one narrow
        // recipient head instead of copying every eligible activity in the backlog.
        const head = this.store.db.prepare(
          "SELECT d.id,d.recipient FROM federation_deliveries d " +
          (this.store.db.dialect === "sqlite" ? "INDEXED BY federation_pending_order " : "") +
          "WHERE d.status='pending' AND d.next_attempt<=? " +
          (omit.length ? `AND NOT (${omit.map(() => "d.recipient LIKE ? ESCAPE '\\'").join(" OR ")}) ` : "") +
          (ids.length ? `AND d.id NOT IN (${ids.map(() => "?").join(",")}) ` : "") +
          "AND NOT EXISTS (SELECT 1 FROM federation_deliveries earlier WHERE earlier.recipient=d.recipient AND earlier.id<d.id AND earlier.status='pending') ORDER BY d.id LIMIT 1",
        ).get(Date.now(), ...omit, ...ids);
        if (!head) {
          if (!active.size) break;
          await Promise.race(active); continue;
        }
        if (!this.peerAllowance(head.recipient)) { exhausted.add(new URL(head.recipient).host); continue; }
        const delivery = this.store.db.prepare(
          "SELECT d.id AS delivery_id,d.recipient,d.attempts,o.* FROM federation_deliveries d JOIN federation_outgoing o ON o.id=d.activity_id WHERE d.id=?",
        ).get(head.id) as Delivery;
        const peers: Delivery[] = [];
        if (["relay", "moderation"].includes(delivery.purpose) && JSON.parse(delivery.activity).type === "Announce") {
          const origin = new URL(delivery.recipient).origin;
          const rows = this.store.db.prepare(
            "SELECT d.id AS delivery_id,d.recipient,d.attempts FROM federation_deliveries d WHERE d.activity_id=? AND d.status='pending' AND d.next_attempt<=? " +
            "AND NOT EXISTS (SELECT 1 FROM federation_deliveries earlier WHERE earlier.recipient=d.recipient AND earlier.id<d.id AND earlier.status='pending') ORDER BY d.id",
          ).all(delivery.id, Date.now());
          for (const row of rows) if (!claimed.has(row.delivery_id) && new URL(row.recipient).origin === origin)
            peers.push({ ...delivery, ...row } as Delivery);
        }
        if (!peers.length) peers.push(delivery);
        // Claim before any async discovery: another worker must not send this
        // announcement to the same inbox or advance a recipient past its head.
        for (const row of peers) claimed.add(row.delivery_id);
        work++;
        const job = this.deliver(delivery, peers).finally(() => {
          for (const row of peers) claimed.delete(row.delivery_id);
          active.delete(job);
        });
        active.add(job);
      }
    } finally {
      await Promise.all(active);
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
