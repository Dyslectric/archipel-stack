import {
  createCipheriv,
  createECDH,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign,
  type KeyObject,
} from "node:crypto";
import type { Config } from "./config.js";
import { peerRequest, peerUrl } from "./federation-net.js";
import { hash, Problem, text, type Message, type Store, type User } from "./store.js";

// Web Push: browsers that asked for notifications are told about new messages, even with no
// Archipel Web tab open. A notification names the conversation, and shows who wrote, their picture
// and what they said. Only the browser can read it: the payload is encrypted to its keys.
export interface Notice {
  tag: string;
  title: string;
  body: string;
  icon?: string;
  url: string;
  test?: boolean;
}
interface Subscription {
  endpoint: string;
  p256dh: string;
  auth: string;
}
const FRESH = 15 * 60000; // history that arrives late (a mirror, a backfill) is not news
const EVERY = 1500;

// RFC 8291: the payload encrypted to the browser's keys, as one aes128gcm record.
export function encryptPush(
  payload: Buffer,
  p256dh: string,
  auth: string,
) {
  const client = Buffer.from(p256dh, "base64url"),
    secret = Buffer.from(auth, "base64url"),
    ecdh = createECDH("prime256v1"),
    server = ecdh.generateKeys(),
    salt = randomBytes(16);
  const derive = (
    key: Buffer,
    with_: Buffer,
    info: Buffer | string,
    length: number,
  ) => Buffer.from(hkdfSync("sha256", key, with_, info, length));
  const ikm = derive(
    ecdh.computeSecret(client),
    secret,
    Buffer.concat([Buffer.from("WebPush: info\0"), client, server]),
    32,
  );
  const cipher = createCipheriv(
    "aes-128-gcm",
    derive(ikm, salt, "Content-Encoding: aes128gcm\0", 16),
    derive(ikm, salt, "Content-Encoding: nonce\0", 12),
  );
  const head = Buffer.alloc(21);
  salt.copy(head);
  head.writeUInt32BE(4096, 16);
  head[20] = server.length;
  return Buffer.concat([
    head,
    server,
    cipher.update(Buffer.concat([payload, Buffer.from([2])])),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
}

export class Push {
  private busy = false;
  private key?: { private: KeyObject; public: string };
  private running = false;
  private timer?: NodeJS.Timeout;
  /** Whether a member has Archipel Web open: they see what arrives there, so no push. */
  live: (user: string) => boolean = () => false;
  constructor(
    private store: Store,
    private config: Config,
  ) {}
  // The worker runs only while some browser has asked to be notified.
  start() {
    this.running = true;
    this.wake();
  }
  stop() {
    this.running = false;
    clearInterval(this.timer);
    this.timer = undefined;
  }
  private wake() {
    if (!this.running || this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch(() => console.error("Notification worker failed."));
    }, EVERY);
    this.timer.unref();
  }
  private setting(key: string) {
    return (
      this.store.db
        .prepare("SELECT value FROM instance_settings WHERE key=?")
        .get(key) as { value: string } | undefined
    )?.value;
  }
  private set(key: string, value: string) {
    this.store.db
      .prepare(
        "INSERT INTO instance_settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, value);
  }
  // The instance's VAPID key, made the first time a browser asks for it.
  private vapid() {
    if (this.key) return this.key;
    let pem = this.setting("push_vapid_key");
    if (!pem) {
      pem = generateKeyPairSync("ec", { namedCurve: "prime256v1" })
        .privateKey.export({ type: "pkcs8", format: "pem" })
        .toString();
      this.set("push_vapid_key", pem);
    }
    const secret = createPrivateKey(pem),
      jwk = createPublicKey(secret).export({ format: "jwk" });
    return (this.key = {
      private: secret,
      public: Buffer.concat([
        Buffer.from([4]),
        Buffer.from(jwk.x!, "base64url"),
        Buffer.from(jwk.y!, "base64url"),
      ]).toString("base64url"),
    });
  }
  private mine(token: string) {
    return this.store.db
      .prepare("SELECT endpoint FROM push_subscriptions WHERE session_hash=?")
      .get(hash(token)) as { endpoint: string } | undefined;
  }
  status(token: string) {
    return {
      public_key: this.vapid().public,
      endpoint: this.mine(token)?.endpoint ?? null,
    };
  }
  // One browser per session: registering again replaces what the session had.
  subscribe(user: User, token: string, input: Record<string, any>) {
    const endpoint = text(input.endpoint, "Push endpoint", 2048),
      p256dh = text(input.keys?.p256dh, "Push key", 200),
      auth = text(input.keys?.auth, "Push secret", 200);
    try {
      peerUrl(endpoint, this.config);
    } catch {
      throw new Problem(400, "Invalid push subscription.");
    }
    if (
      Buffer.from(p256dh, "base64url").length !== 65 ||
      Buffer.from(auth, "base64url").length !== 16
    )
      throw new Problem(400, "Invalid push subscription.");
    this.store.transaction(() => {
      this.store.db
        .prepare(
          "DELETE FROM push_subscriptions WHERE session_hash=? OR endpoint=?",
        )
        .run(hash(token), endpoint);
      // The first browser to ask starts from now: the worker slept through what came before.
      if (!this.store.db.prepare("SELECT 1 FROM push_subscriptions LIMIT 1").get())
        for (const table of ["messages", "direct_messages"]) this.since(table, "0");
      this.store.db
        .prepare("INSERT INTO push_subscriptions VALUES(?,?,?,?,?,?)")
        .run(
          endpoint,
          user.id,
          hash(token),
          p256dh,
          auth,
          new Date().toISOString(),
        );
    });
    this.wake();
    return this.status(token);
  }
  unsubscribe(token: string) {
    this.store.db
      .prepare("DELETE FROM push_subscriptions WHERE session_hash=?")
      .run(hash(token));
    return this.status(token);
  }
  async test(token: string) {
    const mine = this.store.db
      .prepare("SELECT * FROM push_subscriptions WHERE session_hash=?")
      .get(hash(token)) as unknown as Subscription | undefined;
    if (!mine)
      throw new Problem(409, "Notifications are not turned on in this browser.");
    if (
      !(await this.send(mine, {
        tag: "test",
        title: "Archipel Web",
        body: "Notifications are working on this device.",
        url: "/#/settings/personal/notifications",
        test: true,
      }))
    )
      throw new Problem(502, "The browser's push service did not accept the notification.");
  }
  private async send(to: Subscription, notice: Notice) {
    try {
      const url = new URL(to.endpoint),
        part = (value: object) =>
          Buffer.from(JSON.stringify(value)).toString("base64url"),
        claims = `${part({ typ: "JWT", alg: "ES256" })}.${part({
          aud: url.origin,
          exp: Math.floor(Date.now() / 1000) + 12 * 3600,
          sub: this.config.baseUrl,
        })}`,
        key = this.vapid(),
        body = encryptPush(
          Buffer.from(JSON.stringify(notice)),
          to.p256dh,
          to.auth,
        );
      await peerRequest(
        url,
        this.config,
        {
          authorization: `vapid t=${claims}.${sign("sha256", Buffer.from(claims), { key: key.private, dsaEncoding: "ieee-p1363" }).toString("base64url")}, k=${key.public}`,
          "content-encoding": "aes128gcm",
          "content-type": "application/octet-stream",
          "content-length": String(body.length),
          ttl: "86400",
          // Anything less waits for a sleeping phone to be picked up again.
          urgency: "high",
          // A later notification for the same conversation replaces one still waiting for the device.
          topic: hash(notice.tag).slice(0, 32),
        },
        body,
        4096,
      );
      return true;
    } catch (error) {
      // The browser withdrew the subscription.
      const dropped = error instanceof Problem && [404, 410].includes(error.status);
      if (dropped)
        this.store.db
          .prepare("DELETE FROM push_subscriptions WHERE endpoint=?")
          .run(to.endpoint);
      // Why a device went quiet is otherwise known to nobody. The endpoint is a secret; its host is not.
      console.error(
        JSON.stringify({
          event: dropped ? "push.subscription_dropped" : "push.send_failed",
          service: to.endpoint.replace(/^\w+:\/\/([^/]*).*$/, "$1"),
          status: error instanceof Problem ? error.status : null,
          error: error instanceof Problem ? undefined : (error as Error)?.name,
        }),
      );
      return false;
    }
  }
  // Rows of a table that arrived since the last look, however they got there: posted here,
  // federated, bridged or mirrored. Nothing is sent twice, or for what was there before.
  private since<T extends { seq: number }>(table: string, where: string) {
    const key = `push_seq_${table}`,
      latest = Number(
        (
          this.store.db
            .prepare(`SELECT COALESCE(MAX(seq),0) AS n FROM ${table}`)
            .get() as { n: number }
        ).n,
      ),
      from = this.setting(key);
    const rows =
      from === undefined
        ? []
        : (this.store.db
            .prepare(
              `SELECT * FROM ${table} WHERE seq>? AND seq<=? AND ${where} ORDER BY seq`,
            )
            .all(Number(from), latest) as unknown as T[]);
    if (from === undefined || Number(from) !== latest)
      this.set(key, String(latest));
    return rows;
  }
  // Called every second or so: tells subscribed browsers what was said since the last call.
  // With no subscription left the worker stops; the next browser to subscribe wakes it.
  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      if (!this.store.db.prepare("SELECT 1 FROM push_subscriptions LIMIT 1").get()) {
        clearInterval(this.timer);
        this.timer = undefined;
        return;
      }
      const fresh = new Date(Date.now() - FRESH).toISOString(),
        notices = new Map<string, { user: string; notice: Notice; lines: string[] }>();
      const add = (
        user: string,
        found: { tag: string; title: string; from: string | null; text: string; icon: string | null; url: string } | null,
      ) => {
        if (!found) return;
        const key = `${user}\n${found.tag}`,
          what = found.text || "Sent a message";
        // The picture is of whoever wrote last.
        notices.set(key, {
          user,
          lines: [...(notices.get(key)?.lines || []), found.from ? `${found.from}: ${what}` : what],
          notice: {
            tag: found.tag,
            title: found.title,
            body: "",
            ...(found.icon ? { icon: found.icon } : {}),
            url: found.url,
          },
        });
      };
      for (const message of this.since<Message>(
        "messages",
        "deleted_at IS NULL AND history_placeholder=0",
      )) {
        if (message.created_at < fresh) continue;
        for (const { user_id } of this.store.db
          .prepare(
            "SELECT DISTINCT s.user_id FROM push_subscriptions s JOIN memberships m ON m.user_id=s.user_id AND m.channel_id=? WHERE s.user_id!=?",
          )
          .all(message.channel_id, message.author_id) as { user_id: string }[])
          if (!this.live(user_id)) add(user_id, this.store.channelNotice(user_id, message));
      }
      for (const row of this.since<{
        seq: number;
        user_id: string;
        peer: string;
        created_at: string;
      }>("direct_messages", "direction='incoming'"))
        if (
          row.created_at >= fresh &&
          !this.live(row.user_id) &&
          this.store.db
            .prepare("SELECT 1 FROM push_subscriptions WHERE user_id=?")
            .get(row.user_id)
        )
          add(row.user_id, this.store.directNotice(row));
      await Promise.all(
        [...notices.values()].flatMap(({ user, notice, lines }) => {
          // Several at once: the latest few, each on its line, within what a push message holds.
          const shown = lines.slice(-4);
          if (lines.length > shown.length)
            shown.unshift(`${lines.length - shown.length} earlier`);
          while (shown.length > 1 && Buffer.byteLength(shown.join("\n")) > 2000)
            shown.shift();
          notice.body = shown.join("\n");
          return (
            this.store.db
              .prepare(
                "SELECT s.* FROM push_subscriptions s JOIN sessions x ON x.token_hash=s.session_hash AND x.expires_at>? WHERE s.user_id=?",
              )
              .all(Date.now(), user) as unknown as Subscription[]
          ).map((to) => this.send(to, notice));
        }),
      );
    } finally {
      this.busy = false;
    }
  }
}
