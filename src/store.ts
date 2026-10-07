import { decodeEmojiImage } from "./emoji-image.js";
import { standardEmojis, type CustomEmoji } from "./emojis.js";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";

export class Problem extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export interface User {
  id: string;
  username: string;
  display_name: string;
  admin: number;
  banned: number;
  admission_status: "pending" | "approved" | "rejected";
  reviewed_at: string | null;
  remote_actor: string | null;
  federation_send: number;
  federation_receive: number;
  federation_subscribe: number;
  federation_post: number;
  verified_socials: string;
  share_socials: number;
  created_at: string;
}
export interface Channel {
  id: string;
  name: string;
  description: string;
  mode: "timeline" | "topical" | "threaded";
  visibility: "public" | "members";
  admission: "open" | "allowlist";
  owner_id: string;
  remote_actor: string | null;
  federation_enabled: number;
  created_at: string;
}
export interface Message {
  seq: number;
  id: string;
  channel_id: string;
  author_id: string;
  body: string;
  title: string | null;
  topic_id: string | null;
  parent_id: string | null;
  created_at: string;
  deleted_at: string | null;
  edited_at: string | null;
  remote_object: string | null;
  emoji_tags: string;
  history_placeholder: number;
  username: string;
  display_name: string;
}
export const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export const randomToken = () => randomBytes(32).toString("base64url");
const now = () => new Date().toISOString();

export function text(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max)
    throw new Problem(400, `${label} must be 1–${max} characters.`);
  return value.trim();
}
function choice<T extends string>(
  value: unknown,
  allowed: T[],
  label: string,
): T {
  if (!allowed.includes(value as T))
    throw new Problem(400, `Invalid ${label}.`);
  return value as T;
}

export class Store {
  db: DatabaseSync;
  private transactionDepth = 0;
  federationHooks?: {
    write: (user: User, channel: Channel) => void;
    message: (
      message: Message,
      type: "Create" | "Update" | "Delete",
      actor: User,
    ) => void;
    read: (user: User, channel: Channel) => void;
  };
  constructor(
    path: string,
    readonly baseUrl = "http://127.0.0.1:8788",
  ) {
    if (path !== ":memory:")
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(
      "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;",
    );
    const version = (
      this.db.prepare("PRAGMA user_version").get() as { user_version: number }
    ).user_version;
    if (version > 3) throw new Error("Database is newer than this application");
    if (version === 0)
      this.transaction(() =>
        this.db.exec(
          readFileSync(
            new URL("../migrations/001_initial.sql", import.meta.url),
            "utf8",
          ),
        ),
      );
    if (version < 2)
      this.transaction(() =>
        this.db.exec(
          readFileSync(
            new URL("../migrations/002_community.sql", import.meta.url),
            "utf8",
          ),
        ),
      );
    if (version < 3)
      this.transaction(() =>
        this.db.exec(
          readFileSync(
            new URL("../migrations/003_federation.sql", import.meta.url),
            "utf8",
          ),
        ),
      );
  }
  close() {
    this.db.close();
  }
  transaction<T>(fn: () => T): T {
    if (this.transactionDepth) return fn();
    this.db.exec("BEGIN IMMEDIATE");
    this.transactionDepth++;
    try {
      const value = fn();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.transactionDepth--;
    }
  }
  user(id: string): User {
    const user = this.db
      .prepare("SELECT * FROM users WHERE id=?")
      .get(id) as unknown as User | undefined;
    if (!user) throw new Problem(404, "User not found.");
    return user;
  }
  authenticated(id: string) {
    const user = this.user(id);
    if (user.banned) throw new Problem(403, "This account has been suspended.");
    return user;
  }
  active(id: string) {
    const user = this.authenticated(id);
    if (user.admission_status !== "approved")
      throw new Problem(403, "Instance membership approval is required.");
    return user;
  }
  profile(user: User, own = false) {
    return {
      id: user.id,
      actor_url: user.remote_actor || `${this.baseUrl}/actors/users/${user.id}`,
      username: user.username,
      display_name: user.display_name,
      ...(own
        ? {
            admission_status: user.admission_status,
            admin: !!user.admin,
            banned: !!user.banned,
            share_socials: !!user.share_socials,
            federation_send: !!user.federation_send,
            federation_receive: !!user.federation_receive,
            federation_subscribe: !!user.federation_subscribe,
            federation_post: !!user.federation_post,
          }
        : {}),
      verified_socials:
        own || user.share_socials ? JSON.parse(user.verified_socials) : [],
    };
  }
  loginIdentity(
    issuer: string,
    subject: string,
    name: string,
    socials: unknown[],
    admin = false,
  ): User {
    return this.transaction(() => {
      const binding = this.db
        .prepare(
          "SELECT user_id FROM oidc_bindings WHERE issuer=? AND subject=?",
        )
        .get(issuer, subject) as { user_id: string } | undefined;
      if (binding) {
        this.db
          .prepare(
            "UPDATE users SET verified_socials=?, admin=?, admission_status=CASE WHEN ?=1 THEN 'approved' ELSE admission_status END WHERE id=?",
          )
          .run(
            JSON.stringify(socials),
            Number(admin),
            Number(admin),
            binding.user_id,
          );
        return this.authenticated(binding.user_id);
      }
      let stem =
        name
          .toLowerCase()
          .replace(/[^a-z0-9._-]/g, "")
          .replace(/^[^a-z0-9]+/, "")
          .slice(0, 32) || "member";
      if (stem.length < 3) stem = `member-${stem}`;
      let username = stem;
      while (
        this.db.prepare("SELECT 1 FROM users WHERE username=?").get(username)
      )
        username = `${stem}-${randomBytes(3).toString("hex")}`;
      const id = randomUUID();
      this.db
        .prepare(
          "INSERT INTO users(id,username,display_name,admin,verified_socials,created_at,admission_status) VALUES(?,?,?,?,?,?,?)",
        )
        .run(
          id,
          username,
          name.slice(0, 80) || username,
          Number(admin),
          JSON.stringify(socials),
          now(),
          admin || this.registrationMode() === "open" ? "approved" : "pending",
        );
      this.db
        .prepare("INSERT INTO oidc_bindings VALUES(?,?,?)")
        .run(issuer, subject, id);
      return this.user(id);
    });
  }
  createSession(id: string) {
    this.authenticated(id);
    const token = randomToken(),
      csrf = randomToken();
    this.db.prepare("DELETE FROM sessions WHERE expires_at<=?").run(Date.now());
    this.db
      .prepare("INSERT INTO sessions VALUES(?,?,?,?)")
      .run(hash(token), id, csrf, Date.now() + 7 * 86400000);
    return { token, csrf };
  }
  session(token: string) {
    const session = this.db
      .prepare("SELECT * FROM sessions WHERE token_hash=? AND expires_at>?")
      .get(hash(token), Date.now()) as
      | { user_id: string; csrf: string }
      | undefined;
    return session
      ? { user: this.authenticated(session.user_id), csrf: session.csrf }
      : null;
  }
  logout(token: string) {
    this.db.prepare("DELETE FROM sessions WHERE token_hash=?").run(hash(token));
  }
  applyAuthPolicy(issuer: string, admins: string[], devAuth: boolean) {
    this.transaction(() => {
      this.db.prepare("UPDATE users SET admin=0").run();
      if (issuer)
        for (const subject of admins)
          this.db
            .prepare(
              "UPDATE users SET admin=1, admission_status='approved' WHERE id IN (SELECT user_id FROM oidc_bindings WHERE issuer=? AND subject=?)",
            )
            .run(issuer, subject);
      if (devAuth)
        this.db
          .prepare(
            "UPDATE users SET admin=1, admission_status='approved' WHERE id IN (SELECT user_id FROM oidc_bindings WHERE issuer='urn:archipel:development' AND subject='alice')",
          )
          .run();
      this.db
        .prepare(
          "DELETE FROM sessions WHERE user_id NOT IN (SELECT user_id FROM oidc_bindings WHERE issuer=? OR (?=1 AND issuer='urn:archipel:development'))",
        )
        .run(issuer, Number(devAuth));
    });
  }
  initializeRegistration(mode: "open" | "invite_only") {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO instance_settings VALUES('registration_mode',?)",
      )
      .run(mode);
  }
  registrationMode(): "open" | "invite_only" {
    return (
      (this.db
        .prepare(
          "SELECT value FROM instance_settings WHERE key='registration_mode'",
        )
        .get()?.value as "open" | "invite_only") || "open"
    );
  }
  requireAdmin(user: User) {
    const current = this.active(user.id);
    if (!current.admin)
      throw new Problem(403, "Instance administrator access is required.");
    return current;
  }
  setRegistration(user: User, mode: unknown) {
    this.requireAdmin(user);
    const value = choice(mode, ["open", "invite_only"], "registration mode");
    this.transaction(() => {
      this.db
        .prepare(
          "INSERT INTO instance_settings VALUES('registration_mode',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        )
        .run(value);
      this.audit(user.id, "instance.registration", value);
    });
    return { registration_mode: value };
  }
  applications(user: User) {
    this.requireAdmin(user);
    return (
      this.db
        .prepare(
          "SELECT * FROM users WHERE admission_status!='approved' ORDER BY created_at",
        )
        .all() as unknown as User[]
    ).map((u) => ({
      ...this.profile(u, true),
      created_at: u.created_at,
      reviewed_at: u.reviewed_at,
      identities: this.db
        .prepare("SELECT issuer,subject FROM oidc_bindings WHERE user_id=?")
        .all(u.id),
    }));
  }
  reviewApplication(user: User, id: string, status: unknown) {
    this.requireAdmin(user);
    const value = choice(status, ["approved", "rejected"], "approval decision");
    const target = this.user(id);
    if (target.admin || target.admission_status === "approved")
      throw new Problem(409, "This account already has instance membership.");
    this.transaction(() => {
      this.db
        .prepare("UPDATE users SET admission_status=?,reviewed_at=? WHERE id=?")
        .run(value, now(), id);
      this.audit(
        user.id,
        value === "approved" ? "user.approve" : "user.reject",
        id,
      );
    });
    return this.profile(this.user(id), true);
  }
  emojis(): CustomEmoji[] {
    return (
      this.db
        .prepare("SELECT name,id FROM custom_emojis ORDER BY name")
        .all() as unknown as { name: string; id: string }[]
    ).map((e) => ({ ...e, url: `/api/emojis/${e.id}/image` }));
  }
  emojiImage(id: string) {
    const result = this.db
      .prepare(
        "SELECT mime,image FROM custom_emojis WHERE id=? UNION ALL SELECT mime,image FROM personal_emojis WHERE id=? UNION ALL SELECT mime,image FROM remote_emoji_cache WHERE id=?",
      )
      .get(id, id, id) as { mime: string; image: Uint8Array } | undefined;
    if (!result) throw new Problem(404, "Emoji not found.");
    return result;
  }
  addEmoji(user: User, input: Record<string, unknown>) {
    this.requireAdmin(user);
    const name = text(input.name, "Emoji name", 64);
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(name) || standardEmojis.has(name))
      throw new Problem(
        400,
        "Choose a unique lowercase shortcode using letters, numbers, underscores or hyphens; standard names are reserved.",
      );
    const { image, mime } = decodeEmojiImage(input.image);
    this.transaction(() => {
      if (this.db.prepare("SELECT 1 FROM custom_emojis WHERE name=?").get(name))
        throw new Problem(409, "That emoji name already exists.");
      if (
        Number(
          this.db.prepare("SELECT COUNT(*) AS n FROM custom_emojis").get()?.n,
        ) >= 500
      )
        throw new Problem(409, "The instance emoji limit is 500.");
      this.db
        .prepare("INSERT INTO custom_emojis VALUES(?,?,?,?,?,?)")
        .run(name, randomUUID(), mime, image, user.id, now());
      this.audit(user.id, "emoji.create", name);
    });
    return this.emojis().find((e) => e.name === name);
  }
  personalEmojis(user: User): (CustomEmoji & { source_url: string })[] {
    this.active(user.id);
    return (
      this.db
        .prepare(
          "SELECT name,id,source_url FROM personal_emojis WHERE user_id=? AND deleted=0 ORDER BY name",
        )
        .all(user.id) as unknown as (CustomEmoji & { source_url: string })[]
    ).map((e) => ({ ...e, url: `/api/emojis/${e.id}/image` }));
  }
  emojiCatalog(user: User) {
    return [...this.emojis(), ...this.personalEmojis(user)];
  }
  emojiName(user: User, value: unknown, exceptId = "") {
    const name = text(value, "Emoji name", 64);
    if (
      !/^[a-z0-9][a-z0-9_-]*$/.test(name) ||
      standardEmojis.has(name) ||
      this.emojis().some((e) => e.name === name)
    )
      throw new Problem(
        400,
        "Choose a lowercase shortcode that is not a standard or instance emoji name.",
      );
    if (
      this.db
        .prepare(
          "SELECT 1 FROM personal_emojis WHERE user_id=? AND name=? AND id!=? AND deleted=0",
        )
        .get(user.id, name, exceptId)
    )
      throw new Problem(409, "That saved emoji name already exists.");
    return name;
  }
  adoptEmoji(
    user: User,
    nameInput: unknown,
    imageInput: string,
    source: string,
  ) {
    this.active(user.id);
    const name = this.emojiName(user, nameInput),
      { image, mime } = decodeEmojiImage(imageInput);
    if (
      Number(
        this.db
          .prepare(
            "SELECT COUNT(*) AS n FROM personal_emojis WHERE user_id=? AND deleted=0",
          )
          .get(user.id)?.n,
      ) >= 200
    )
      throw new Problem(409, "You can save up to 200 emoji.");
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO personal_emojis(id,user_id,name,mime,image,source_url,created_at) VALUES(?,?,?,?,?,?,?)",
      )
      .run(id, user.id, name, mime, image, source, now());
    return this.personalEmojis(user).find((e) => e.id === id);
  }
  renamePersonalEmoji(user: User, id: string, input: unknown) {
    this.active(user.id);
    const name = this.emojiName(user, input, id);
    if (
      !this.db
        .prepare(
          "UPDATE personal_emojis SET name=? WHERE id=? AND user_id=? AND deleted=0",
        )
        .run(name, id, user.id).changes
    )
      throw new Problem(404, "Saved emoji not found.");
    return this.personalEmojis(user).find((e) => e.id === id);
  }
  removePersonalEmoji(user: User, id: string) {
    this.active(user.id);
    if (
      !this.db
        .prepare(
          "UPDATE personal_emojis SET deleted=1,name='__removed_'||id WHERE id=? AND user_id=? AND deleted=0",
        )
        .run(id, user.id).changes
    )
      throw new Problem(404, "Saved emoji not found.");
  }
  messageEmojiTags(user: User, body: string) {
    const catalog = new Map(this.emojiCatalog(user).map((e) => [e.name, e]));
    const names = new Set(
      [...body.matchAll(/:([a-z0-9_+\-]{1,64}):/g)].map((m) => m[1]),
    );
    return [...names].flatMap((name) => {
      const e = catalog.get(name);
      return e ? [e] : [];
    });
  }
  removeEmoji(user: User, name: string) {
    this.requireAdmin(user);
    this.transaction(() => {
      if (
        !this.db.prepare("DELETE FROM custom_emojis WHERE name=?").run(name)
          .changes
      )
        throw new Problem(404, "Emoji not found.");
      this.audit(user.id, "emoji.delete", name);
    });
  }
  channel(id: string): Channel {
    const channel = this.db
      .prepare("SELECT * FROM channels WHERE id=?")
      .get(id) as unknown as Channel | undefined;
    if (!channel) throw new Problem(404, "Channel not found.");
    return channel;
  }
  role(channel: string, user: string) {
    return (
      (
        this.db
          .prepare(
            "SELECT role FROM memberships WHERE channel_id=? AND user_id=?",
          )
          .get(channel, user) as { role: string } | undefined
      )?.role || null
    );
  }
  rule(channel: string, user: string) {
    return (
      (
        this.db
          .prepare(
            "SELECT rule FROM channel_rules WHERE channel_id=? AND user_id=?",
          )
          .get(channel, user) as { rule: string } | undefined
      )?.rule || null
    );
  }
  readable(user: User, channel: Channel) {
    if (
      channel.remote_actor &&
      (!user.federation_receive || !user.federation_subscribe)
    )
      return false;
    if (user.admin) return true;
    if (this.rule(channel.id, user.id) === "block") return false;
    return channel.visibility === "public" || !!this.role(channel.id, user.id);
  }
  requireRead(user: User, channel: Channel) {
    this.active(user.id);
    this.federationHooks?.read(user, channel);
    if (!this.readable(user, channel))
      throw new Problem(403, "You do not have access to this channel.");
  }
  requirePost(user: User, channel: Channel) {
    this.active(user.id);
    this.federationHooks?.write(user, channel);
    if (
      this.rule(channel.id, user.id) === "block" ||
      !this.role(channel.id, user.id)
    )
      throw new Problem(403, "Join this channel before posting.");
  }
  requireManage(user: User, channel: Channel) {
    this.active(user.id);
    if (channel.remote_actor)
      throw new Problem(
        403,
        "Channel moderation belongs to its home instance.",
      );
    if (user.admin) return;
    if (
      this.rule(channel.id, user.id) === "block" ||
      !["owner", "moderator"].includes(this.role(channel.id, user.id) || "")
    )
      throw new Problem(403, "Only channel moderators can do that.");
  }
  channelInfo(user: User, channel: Channel) {
    const rule = this.rule(channel.id, user.id);
    return {
      ...channel,
      actor_url:
        channel.remote_actor || `${this.baseUrl}/actors/channels/${channel.id}`,
      role: this.role(channel.id, user.id),
      readable: this.readable(user, channel),
      can_join:
        !channel.remote_actor &&
        rule !== "block" &&
        (channel.admission === "open" || rule === "allow"),
      member_count: Number(
        (
          this.db
            .prepare("SELECT COUNT(*) AS n FROM memberships WHERE channel_id=?")
            .get(channel.id) as { n: number }
        ).n,
      ),
    };
  }
  listChannels(user: User) {
    this.active(user.id);
    const channels = this.db
      .prepare("SELECT * FROM channels ORDER BY name")
      .all() as unknown as Channel[];
    return channels
      .filter(
        (c) =>
          (!c.remote_actor || !!this.role(c.id, user.id)) &&
          (user.admin ||
            (this.rule(c.id, user.id) !== "block" &&
              (c.visibility === "public" ||
                !!this.role(c.id, user.id) ||
                this.rule(c.id, user.id) === "allow"))),
      )
      .map((c) => this.channelInfo(user, c));
  }
  createChannel(user: User, input: Record<string, unknown>) {
    this.active(user.id);
    const name = text(input.name, "Channel name", 40).toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]{1,39}$/.test(name))
      throw new Problem(
        400,
        "Use 2–40 lowercase letters, numbers, hyphens, or underscores.",
      );
    const description =
      typeof input.description === "string" ? input.description.trim() : "";
    if (description.length > 500)
      throw new Problem(400, "Description is too long.");
    const mode = choice(
      input.mode,
      ["timeline", "topical", "threaded"],
      "conversation mode",
    );
    const visibility = choice(
      input.visibility,
      ["public", "members"],
      "visibility",
    );
    const admission = choice(
      input.admission,
      ["open", "allowlist"],
      "admission",
    );
    return this.transaction(() => {
      if (this.db.prepare("SELECT 1 FROM channels WHERE name=?").get(name))
        throw new Problem(409, "That channel name is already taken.");
      const id = randomUUID();
      this.db
        .prepare(
          "INSERT INTO channels(id,name,description,mode,visibility,admission,owner_id,created_at) VALUES(?,?,?,?,?,?,?,?)",
        )
        .run(
          id,
          name,
          description,
          mode,
          visibility,
          admission,
          user.id,
          now(),
        );
      this.db
        .prepare("INSERT INTO memberships VALUES(?,?,?)")
        .run(id, user.id, "owner");
      this.audit(user.id, "channel.create", id);
      return this.channelInfo(user, this.channel(id));
    });
  }
  join(user: User, id: string) {
    this.active(user.id);
    const channel = this.channel(id);
    if (channel.remote_actor)
      throw new Problem(
        400,
        "Subscribe to remote channels through federation.",
      );
    if (this.rule(id, user.id) === "block")
      throw new Problem(403, "You are blocked from this channel.");
    if (this.role(id, user.id)) return;
    if (channel.admission === "allowlist" && this.rule(id, user.id) !== "allow")
      throw new Problem(403, "This channel requires an invitation.");
    this.db
      .prepare("INSERT INTO memberships VALUES(?,?,?)")
      .run(id, user.id, "member");
  }
  leave(user: User, id: string) {
    this.active(user.id);
    const channel = this.channel(id);
    if (channel.owner_id === user.id)
      throw new Problem(409, "The owner cannot leave their channel.");
    this.db
      .prepare("DELETE FROM memberships WHERE channel_id=? AND user_id=?")
      .run(id, user.id);
  }
  details(user: User, id: string) {
    const channel = this.channel(id);
    this.requireRead(user, channel);
    const members = this.db
      .prepare(
        "SELECT u.*, m.role FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.channel_id=? ORDER BY u.username",
      )
      .all(id) as unknown as (User & { role: string })[];
    const topics = this.db
      .prepare("SELECT * FROM topics WHERE channel_id=? ORDER BY created_at")
      .all(id);
    return {
      ...this.channelInfo(user, channel),
      members: members.map((u) => ({ ...this.profile(u), role: u.role })),
      topics,
    };
  }
  setMember(
    user: User,
    channelId: string,
    targetId: string,
    input: Record<string, unknown>,
  ) {
    const channel = this.channel(channelId);
    this.requireManage(user, channel);
    this.user(targetId);
    if (targetId === channel.owner_id)
      throw new Problem(403, "The channel owner cannot be removed or demoted.");
    const role = this.role(channelId, targetId);
    const ownRole = this.role(channelId, user.id);
    if (
      !user.admin &&
      ownRole !== "owner" &&
      (role === "moderator" || input.role !== undefined)
    )
      throw new Problem(403, "Only the owner can manage moderators.");
    if (
      input.rule !== undefined &&
      !["allow", "block", "clear"].includes(input.rule as string)
    )
      throw new Problem(400, "Invalid access rule.");
    if (
      input.role !== undefined &&
      !["member", "moderator"].includes(input.role as string)
    )
      throw new Problem(400, "Invalid role.");
    if (input.role !== undefined && !role)
      throw new Problem(409, "The user must join before receiving a role.");
    if (
      input.rule === undefined &&
      input.role === undefined &&
      input.remove !== true
    )
      throw new Problem(400, "Choose a membership change.");
    this.transaction(() => {
      if (input.rule === "clear")
        this.db
          .prepare("DELETE FROM channel_rules WHERE channel_id=? AND user_id=?")
          .run(channelId, targetId);
      else if (input.rule)
        this.db
          .prepare(
            "INSERT INTO channel_rules VALUES(?,?,?) ON CONFLICT(channel_id,user_id) DO UPDATE SET rule=excluded.rule",
          )
          .run(channelId, targetId, input.rule as string);
      if (input.remove === true || input.rule === "block")
        this.db
          .prepare("DELETE FROM memberships WHERE channel_id=? AND user_id=?")
          .run(channelId, targetId);
      else if (input.role)
        this.db
          .prepare(
            "UPDATE memberships SET role=? WHERE channel_id=? AND user_id=?",
          )
          .run(input.role as string, channelId, targetId);
      this.audit(
        user.id,
        "channel.membership",
        JSON.stringify({ channel: channelId, user: targetId, ...input }),
      );
    });
  }
  rules(user: User, id: string) {
    this.requireManage(user, this.channel(id));
    return this.db
      .prepare(
        "SELECT r.user_id,r.rule,u.username FROM channel_rules r JOIN users u ON u.id=r.user_id WHERE channel_id=? ORDER BY u.username",
      )
      .all(id);
  }
  createTopic(user: User, id: string, title: unknown) {
    const channel = this.channel(id);
    this.requirePost(user, channel);
    if (channel.mode !== "topical")
      throw new Problem(400, "Only topical channels have topics.");
    const name = text(title, "Topic title", 100);
    if (
      this.db
        .prepare("SELECT 1 FROM topics WHERE channel_id=? AND title=?")
        .get(id, name)
    )
      throw new Problem(409, "That topic already exists.");
    const topicId = randomUUID();
    this.db
      .prepare(
        "INSERT INTO topics(id,channel_id,title,created_at) VALUES(?,?,?,?)",
      )
      .run(topicId, id, name, now());
    return { id: topicId, channel_id: id, title: name };
  }
  post(user: User, id: string, input: Record<string, unknown>) {
    const channel = this.channel(id);
    this.requirePost(user, channel);
    const body = text(input.body, "Message", 8000);
    const parentId =
      input.parent_id === undefined || input.parent_id === null
        ? null
        : text(input.parent_id, "Reply ID", 100);
    const topicId =
      input.topic_id === undefined || input.topic_id === null
        ? null
        : text(input.topic_id, "Topic ID", 100);
    const title =
      input.title === undefined || input.title === null
        ? null
        : text(input.title, "Thread title", 160);
    if (channel.mode === "timeline" && (parentId || topicId || title))
      throw new Problem(
        400,
        "Timeline messages cannot have a parent, topic, or title.",
      );
    if (channel.mode !== "topical" && topicId)
      throw new Problem(400, "This channel does not use topics.");
    if (channel.mode === "topical") {
      if (
        !topicId ||
        !this.db
          .prepare("SELECT 1 FROM topics WHERE id=? AND channel_id=?")
          .get(topicId, id)
      )
        throw new Problem(400, "Choose a topic in this channel.");
      if (title)
        throw new Problem(400, "Topic messages do not have thread titles.");
    }
    if (channel.mode === "threaded" && !parentId && !title)
      throw new Problem(400, "A new thread needs a title.");
    if (parentId) {
      const parent = this.db
        .prepare("SELECT * FROM messages WHERE id=? AND channel_id=?")
        .get(parentId, id) as unknown as Message | undefined;
      if (!parent || parent.deleted_at)
        throw new Problem(400, "Reply to an existing message in this channel.");
      if (parent.topic_id !== topicId)
        throw new Problem(400, "Replies must stay in the same topic.");
      if (title) throw new Problem(400, "Replies do not have thread titles.");
    }
    const messageId = randomUUID();
    return this.transaction(() => {
      this.db
        .prepare(
          "INSERT INTO messages(id,channel_id,author_id,body,title,topic_id,parent_id,created_at) VALUES(?,?,?,?,?,?,?,?)",
        )
        .run(messageId, id, user.id, body, title, topicId, parentId, now());
      this.db
        .prepare("UPDATE messages SET emoji_tags=? WHERE id=?")
        .run(
          JSON.stringify(this.messageEmojiTags(user, body + (title || ""))),
          messageId,
        );
      const result = this.message(messageId);
      this.federationHooks?.message(result, "Create", user);
      return result;
    });
  }
  message(id: string): Message {
    const result = this.db
      .prepare(
        "SELECT m.*,u.username,u.display_name FROM messages m JOIN users u ON u.id=m.author_id WHERE m.id=?",
      )
      .get(id) as unknown as Message | undefined;
    if (!result) throw new Problem(404, "Message not found.");
    return this.messageInfo(result);
  }
  messageInfo(message: Message) {
    return {
      ...message,
      ...(message.history_placeholder
        ? { username: "history", display_name: "Earlier message" }
        : {}),
      object_url:
        message.remote_object ||
        `${this.baseUrl}/objects/messages/${message.id}`,
      emojis: (JSON.parse(message.emoji_tags) as CustomEmoji[]).filter(
        (e) =>
          !!this.db
            .prepare(
              "SELECT 1 FROM custom_emojis WHERE id=? UNION ALL SELECT 1 FROM personal_emojis WHERE id=? UNION ALL SELECT 1 FROM remote_emoji_cache WHERE id=?",
            )
            .get(e.id, e.id, e.id),
      ),
      author_actor_url:
        this.user(message.author_id).remote_actor ||
        `${this.baseUrl}/actors/users/${message.author_id}`,
    };
  }
  messages(user: User, id: string, before?: number) {
    this.requireRead(user, this.channel(id));
    return (
      this.db
        .prepare(
          "SELECT m.*,u.username,u.display_name FROM messages m JOIN users u ON u.id=m.author_id WHERE m.channel_id=? AND m.seq<? AND (m.remote_object IS NULL OR ?=1) ORDER BY m.seq DESC LIMIT 100",
        )
        .all(
          id,
          before ?? Number.MAX_SAFE_INTEGER,
          Number(!!this.active(user.id).federation_receive),
        ) as unknown as Message[]
    )
      .reverse()
      .map((m) => this.messageInfo(m));
  }
  editMessage(user: User, id: string, input: Record<string, unknown>) {
    this.active(user.id);
    const message = this.message(id),
      channel = this.channel(message.channel_id);
    this.requirePost(user, channel);
    if (message.author_id !== user.id)
      throw new Problem(403, "Only the author can edit this message.");
    if (message.deleted_at)
      throw new Problem(409, "Removed messages cannot be edited.");
    if (
      Object.keys(input).some(
        (key) => !["body", "title", "expected_edited_at"].includes(key),
      )
    )
      throw new Problem(
        400,
        "Editing cannot move a message or change its author or replies.",
      );
    if (input.expected_edited_at !== message.edited_at)
      throw new Problem(
        409,
        "This message changed. Close the editor and try again.",
      );
    const body = text(input.body, "Message", 8000);
    const title =
      input.title === undefined
        ? message.title
        : text(input.title, "Thread title", 160);
    if (
      input.title !== undefined &&
      (channel.mode !== "threaded" || message.parent_id)
    )
      throw new Problem(400, "Only thread roots have editable titles.");
    this.transaction(() => {
      this.db
        .prepare("UPDATE messages SET body=?,title=?,edited_at=? WHERE id=?")
        .run(
          body,
          title,
          new Date(
            Math.max(
              Date.now(),
              Date.parse(message.edited_at || message.created_at) + 1,
            ),
          ).toISOString(),
          id,
        );
      this.db
        .prepare("UPDATE messages SET emoji_tags=? WHERE id=?")
        .run(
          JSON.stringify(this.messageEmojiTags(user, body + (title || ""))),
          id,
        );
      this.federationHooks?.message(this.message(id), "Update", user);
      this.audit(user.id, "message.edit", id);
    });
    return this.message(id);
  }
  deleteMessage(user: User, id: string) {
    this.active(user.id);
    const message = this.message(id),
      channel = this.channel(message.channel_id);
    if (message.author_id === user.id) this.requirePost(user, channel);
    else this.requireManage(user, channel);
    this.transaction(() => {
      this.db
        .prepare(
          "UPDATE messages SET body='', title=NULL, deleted_at=? WHERE id=?",
        )
        .run(now(), id);
      this.federationHooks?.message(this.message(id), "Delete", user);
      this.audit(user.id, "message.delete", id);
    });
  }
  updateProfile(user: User, input: Record<string, unknown>) {
    this.active(user.id);
    const name = text(input.display_name, "Display name", 80);
    if (typeof input.share_socials !== "boolean")
      throw new Problem(400, "Invalid social sharing preference.");
    this.db
      .prepare("UPDATE users SET display_name=?,share_socials=? WHERE id=?")
      .run(name, Number(input.share_socials), user.id);
    return this.profile(this.user(user.id), true);
  }
  directory(user: User) {
    this.active(user.id);
    return (
      this.db
        .prepare(
          "SELECT * FROM users WHERE admission_status='approved' AND remote_actor IS NULL ORDER BY username LIMIT 500",
        )
        .all() as unknown as User[]
    ).map((u) => ({
      ...this.profile(u),
      ...(user.admin
        ? {
            banned: !!u.banned,
            admin: !!u.admin,
            federation_send: !!u.federation_send,
            federation_receive: !!u.federation_receive,
            federation_subscribe: !!u.federation_subscribe,
            federation_post: !!u.federation_post,
          }
        : {}),
    }));
  }
  ban(user: User, targetId: string, banned: unknown) {
    this.active(user.id);
    if (!user.admin)
      throw new Problem(403, "Instance administrator access is required.");
    if (typeof banned !== "boolean")
      throw new Problem(400, "Invalid account status.");
    if (this.user(targetId).admin)
      throw new Problem(
        403,
        "Administrator accounts cannot be suspended through this interface.",
      );
    this.transaction(() => {
      this.db
        .prepare("UPDATE users SET banned=? WHERE id=?")
        .run(Number(banned), targetId);
      if (banned)
        this.db.prepare("DELETE FROM sessions WHERE user_id=?").run(targetId);
      this.audit(user.id, banned ? "user.ban" : "user.unban", targetId);
    });
  }
  audit(actor: string, action: string, target: string) {
    this.db
      .prepare(
        "INSERT INTO audit(actor_id,action,target,created_at) VALUES(?,?,?,?)",
      )
      .run(actor, action, target, now());
  }
}
