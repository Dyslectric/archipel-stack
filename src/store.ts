import { decodeEmojiImage, decodeRasterImage, imageMime } from "./emoji-image.js";
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
  show_members: number; // members see who else is in the channel
  hide_handles: number; // members see names without the handles behind them
  reactions: number; // members may react to messages with emoji
  created_at: string;
}
const notifyChoice = (n: number | null) =>
  n === null ? null : n === 2 ? ("mentions" as const) : !!n;
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
interface DirectRow {
  seq: number;
  id: string;
  peer: string;
  direction: "incoming" | "outgoing";
  body: string;
  emoji_tags: string;
  created_at: string;
}
// What a member may see of, and say to, a peer on another instance.
export interface DirectAccess {
  incoming: boolean;
  outgoing: boolean;
  blocked: string | null;
}
// What a role grants. The four federation grants are also kept on each account (users.federation_*).
export const permissions = [
  "create_channels",
  "federate_channels",
  "direct_messages",
  "attachments",
  "xmpp_rooms",
  "federation_send",
  "federation_receive",
  "federation_subscribe",
  "federation_post",
] as const;
export type Permission = (typeof permissions)[number];
export type Role = {
  id: string;
  name: string;
  is_default: number;
  created_at: string;
} & Record<Permission, number>;
const denied: Record<Permission, string> = {
  create_channels: "Your role does not allow creating channels.",
  federate_channels: "Your role does not allow opening channels to federation.",
  direct_messages: "Your role does not allow sending direct messages.",
  attachments: "Your role does not allow attaching files.",
  xmpp_rooms: "Your role does not allow joining XMPP rooms on other servers.",
  federation_send: "Your role does not allow sending federated messages.",
  federation_receive: "Your role does not allow receiving federated messages.",
  federation_subscribe: "Your role does not allow joining federated channels.",
  federation_post: "Your role does not allow posting in federated channels.",
};
const mediaTypes: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "video/webm": "webm",
};
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

const everyone = `
  SELECT user_id, role, 1 AS held FROM memberships WHERE channel_id=?
  UNION ALL SELECT u.id, 'member', 0 FROM federation_follows f JOIN users u ON u.remote_actor=f.actor
    WHERE f.channel_id=? AND f.status='accepted' AND u.banned=0
    AND NOT EXISTS (SELECT 1 FROM channel_rules b WHERE b.channel_id=f.channel_id AND b.user_id=u.id AND b.rule='block')
  UNION ALL SELECT r.user_id, r.role, 0 FROM channel_roster r
    WHERE r.channel_id=? AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.channel_id=r.channel_id AND m.user_id=r.user_id)`;

export class Store {
  db: DatabaseSync;
  private transactionDepth = 0;
  federationHooks?: {
    profile: (user: User) => void;
    // An account's role, or what its role grants, changed.
    permissions: (user: User) => void;
    write: (user: User, channel: Channel) => void;
    message: (
      message: Message,
      type: "Create" | "Update" | "Delete",
      actor: User,
    ) => void;
    read: (user: User, channel: Channel) => void;
    // Runs inside the change's transaction, while the channel's rows still exist.
    channel: (channel: Channel, change: "rename" | "privacy" | "delete") => void;
    direct: (user: User, peer: string) => DirectAccess;
  };
  mirrorHooks?: {
    // Called after remote content arrives; copies what active mirror sources have not taken yet.
    pull: () => void;
  };
  xmppHooks?: {
    profile: (user: User) => void;
    message: (message: Message, kind: "Create" | "Update" | "Delete") => void;
    direct: (id: string, sender: User, recipient: User) => void;
    access: (user: User, peer: string) => DirectAccess;
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
    if (version > 17) throw new Error("Database is newer than this application");
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
    if (version < 4)
      this.transaction(() =>
        this.db.exec(
          readFileSync(
            new URL("../migrations/004_inbox.sql", import.meta.url),
            "utf8",
          ),
        ),
      );
    if (version < 5)
      this.transaction(() =>
        this.db.exec(
          readFileSync(
            new URL("../migrations/005_user_blocks.sql", import.meta.url),
            "utf8",
          ),
        ),
      );
    if (version < 6)
      this.transaction(() =>
        this.db.exec(
          readFileSync(
            new URL("../migrations/006_user_avatars.sql", import.meta.url),
            "utf8",
          ),
        ),
      );
    if (version < 7)
      this.transaction(() => this.db.exec(readFileSync(
        new URL("../migrations/007_xmpp.sql", import.meta.url), "utf8",
      )));
    if (version < 8)
      this.transaction(() => this.db.exec(readFileSync(
        new URL("../migrations/008_contact_names.sql", import.meta.url), "utf8",
      )));
    if (version < 9)
      this.transaction(() => this.db.exec(readFileSync(
        new URL("../migrations/009_xmpp_stream_ids.sql", import.meta.url), "utf8",
      )));
    if (version < 10)
      this.transaction(() => this.db.exec(readFileSync(
        new URL("../migrations/010_remote_avatars.sql", import.meta.url), "utf8",
      )));
    if (version < 11)
      this.transaction(() => this.db.exec(readFileSync(
        new URL("../migrations/011_xmpp_remote_rooms.sql", import.meta.url), "utf8",
      )));
    if (version < 12)
      this.transaction(() => this.db.exec(readFileSync(
        new URL("../migrations/012_bridges_mirrors.sql", import.meta.url), "utf8",
      )));
    if (version < 13)
      this.transaction(() => this.db.exec(readFileSync(
        new URL("../migrations/013_roles_attachments.sql", import.meta.url), "utf8",
      )));
    if (version < 14)
      this.transaction(() => this.db.exec(readFileSync(
        new URL("../migrations/014_prefs_push.sql", import.meta.url), "utf8",
      )));
    if (version < 15)
      this.transaction(() => this.db.exec(readFileSync(
        new URL("../migrations/015_channel_privacy.sql", import.meta.url), "utf8",
      )));
    if (version < 16)
      this.transaction(() => this.db.exec(readFileSync(
        new URL("../migrations/016_channel_roster.sql", import.meta.url), "utf8",
      )));
    if (version < 17)
      this.transaction(() => this.db.exec(readFileSync(
        new URL("../migrations/017_reactions.sql", import.meta.url), "utf8",
      )));
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
      avatar_url: this.avatarUrl(user.id),
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
            ...this.grants(user),
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
      this.applyRoles("id=?", id);
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
      this.db.prepare(
        "UPDATE xmpp_credentials SET revoked_at=? WHERE revoked_at IS NULL AND user_id NOT IN (SELECT user_id FROM oidc_bindings WHERE issuer=? OR (?=1 AND issuer='urn:archipel:development'))",
      ).run(now(), issuer, Number(devAuth));
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
  // ---- roles: what local accounts may do here ----
  private defaultRole() {
    return this.db
      .prepare("SELECT * FROM roles WHERE is_default=1")
      .get() as unknown as Role;
  }
  roleOf(user: User): Role {
    const own = this.db
      .prepare(
        "SELECT r.* FROM user_roles u JOIN roles r ON r.id=u.role_id WHERE u.user_id=?",
      )
      .get(user.id) as Role | undefined;
    return own || this.defaultRole();
  }
  can(user: User, permission: Permission) {
    return !user.remote_actor && !!this.roleOf(user)[permission];
  }
  requirePermission(user: User, permission: Permission) {
    const current = this.active(user.id);
    if (!this.can(current, permission))
      throw new Problem(403, denied[permission]);
    return current;
  }
  // The role and the grants the browser shows or hides things by; federation grants are in the profile already.
  private grants(user: User) {
    const role = this.roleOf(user);
    return {
      instance_role: { id: role.id, name: role.name },
      create_channels: !!role.create_channels,
      federate_channels: !!role.federate_channels,
      direct_messages: !!role.direct_messages,
      attachments: !!role.attachments,
      xmpp_rooms: !!role.xmpp_rooms,
    };
  }
  // Copies each matching local account's role onto its federation grants, and tells federation who changed.
  private applyRoles(where: string, ...values: string[]) {
    const users = this.db
      .prepare(`SELECT * FROM users WHERE remote_actor IS NULL AND (${where})`)
      .all(...values) as unknown as User[];
    for (const user of users) {
      const role = this.roleOf(user);
      if (
        user.federation_send === role.federation_send &&
        user.federation_receive === role.federation_receive &&
        user.federation_subscribe === role.federation_subscribe &&
        user.federation_post === role.federation_post
      )
        continue;
      this.db
        .prepare(
          "UPDATE users SET federation_send=?,federation_receive=?,federation_subscribe=?,federation_post=? WHERE id=?",
        )
        .run(
          role.federation_send,
          role.federation_receive,
          role.federation_subscribe,
          role.federation_post,
          user.id,
        );
      this.federationHooks?.permissions(this.user(user.id));
    }
  }
  private roleRow(id: string) {
    const role = this.db.prepare("SELECT * FROM roles WHERE id=?").get(id) as
      | Role
      | undefined;
    if (!role) throw new Problem(404, "Role not found.");
    return role;
  }
  private roleView(role: Role) {
    return {
      id: role.id,
      name: role.name,
      is_default: !!role.is_default,
      ...(Object.fromEntries(permissions.map((p) => [p, !!role[p]])) as Record<
        Permission,
        boolean
      >),
      members: Number(
        this.db
          .prepare(
            "SELECT COUNT(*) AS n FROM users WHERE remote_actor IS NULL AND (id IN (SELECT user_id FROM user_roles WHERE role_id=?) OR (?=1 AND id NOT IN (SELECT user_id FROM user_roles)))",
          )
          .get(role.id, role.is_default)?.n,
      ),
    };
  }
  roles(user: User) {
    this.requireAdmin(user);
    return (
      this.db
        .prepare("SELECT * FROM roles ORDER BY is_default DESC,name")
        .all() as unknown as Role[]
    ).map((role) => this.roleView(role));
  }
  private roleInput(input: Record<string, unknown>, current?: Role) {
    if (
      Object.keys(input).some(
        (key) =>
          key !== "name" &&
          key !== "is_default" &&
          !permissions.includes(key as Permission),
      )
    )
      throw new Problem(400, "Unknown role setting.");
    const name =
      input.name === undefined && current
        ? current.name
        : text(input.name, "Role name", 40);
    // A new role starts like the default one does: everything local, nothing federated.
    const flags = permissions.map((p) => {
      if (input[p] === undefined)
        return current ? current[p] : p.startsWith("federation_") ? 0 : 1;
      if (typeof input[p] !== "boolean")
        throw new Problem(400, "Role permissions are on or off.");
      return Number(input[p]);
    });
    if (
      this.db
        .prepare("SELECT 1 FROM roles WHERE name=? AND id!=?")
        .get(name, current?.id || "")
    )
      throw new Problem(409, "That role name is already used.");
    return { name, flags };
  }
  createRole(user: User, input: Record<string, unknown>) {
    this.requireAdmin(user);
    if (input.is_default !== undefined)
      throw new Problem(400, "Create the role, then make it the default.");
    return this.transaction(() => {
      const { name, flags } = this.roleInput(input);
      if (Number(this.db.prepare("SELECT COUNT(*) AS n FROM roles").get()?.n) >= 50)
        throw new Problem(409, "An instance has up to 50 roles.");
      const id = randomUUID();
      this.db
        .prepare(
          `INSERT INTO roles(id,name,${permissions.join(",")},created_at) VALUES(?,?,${permissions.map(() => "?").join(",")},?)`,
        )
        .run(id, name, ...flags, now());
      this.audit(user.id, "role.create", JSON.stringify({ role: id, name }));
      return this.roleView(this.roleRow(id));
    });
  }
  updateRole(user: User, id: string, input: Record<string, unknown>) {
    this.requireAdmin(user);
    return this.transaction(() => {
      const current = this.roleRow(id),
        { name, flags } = this.roleInput(input, current);
      if (input.is_default !== undefined && input.is_default !== true)
        throw new Problem(400, "Make another role the default instead.");
      // Accounts on the old default by omission keep it by name, so only new arrivals move.
      if (input.is_default === true && !current.is_default) {
        this.db
          .prepare(
            "INSERT INTO user_roles SELECT id,(SELECT id FROM roles WHERE is_default=1) FROM users WHERE remote_actor IS NULL AND id NOT IN (SELECT user_id FROM user_roles)",
          )
          .run();
        this.db.prepare("UPDATE roles SET is_default=0").run();
        this.db.prepare("UPDATE roles SET is_default=1 WHERE id=?").run(id);
        this.db.prepare("DELETE FROM user_roles WHERE role_id=?").run(id);
      }
      this.db
        .prepare(
          `UPDATE roles SET name=?,${permissions.map((p) => `${p}=?`).join(",")} WHERE id=?`,
        )
        .run(name, ...flags, id);
      this.applyRoles(
        "id IN (SELECT user_id FROM user_roles WHERE role_id=?) OR id NOT IN (SELECT user_id FROM user_roles)",
        id,
      );
      this.audit(
        user.id,
        "role.update",
        JSON.stringify({ role: id, ...input }),
      );
      return this.roleView(this.roleRow(id));
    });
  }
  // Its accounts fall back to the default role.
  deleteRole(user: User, id: string) {
    this.requireAdmin(user);
    this.transaction(() => {
      const role = this.roleRow(id);
      if (role.is_default)
        throw new Problem(409, "Make another role the default before deleting this one.");
      const members = (
        this.db
          .prepare("SELECT user_id AS id FROM user_roles WHERE role_id=?")
          .all(id) as { id: string }[]
      ).map((row) => row.id);
      this.db.prepare("DELETE FROM user_roles WHERE role_id=?").run(id);
      this.db.prepare("DELETE FROM roles WHERE id=?").run(id);
      for (const member of members) this.applyRoles("id=?", member);
      this.audit(
        user.id,
        "role.delete",
        JSON.stringify({ role: id, name: role.name }),
      );
    });
  }
  setUserRole(user: User, targetId: string, roleId: unknown) {
    this.requireAdmin(user);
    const target = this.user(targetId);
    if (target.remote_actor)
      throw new Problem(400, "Only local accounts have roles.");
    if (roleId !== null && typeof roleId !== "string")
      throw new Problem(400, "Choose a role.");
    return this.transaction(() => {
      const role = roleId === null ? this.defaultRole() : this.roleRow(roleId);
      this.db.prepare("DELETE FROM user_roles WHERE user_id=?").run(targetId);
      if (!role.is_default)
        this.db
          .prepare("INSERT INTO user_roles VALUES(?,?)")
          .run(targetId, role.id);
      this.applyRoles("id=?", targetId);
      this.audit(
        user.id,
        "user.role",
        JSON.stringify({ user: targetId, role: role.id }),
      );
      return this.profile(this.user(targetId), true);
    });
  }
  // ---- attachments: pictures and videos put in messages ----
  addAttachment(user: User, data: unknown, nameValue: unknown) {
    const me = this.requirePermission(user, "attachments");
    if (!Buffer.isBuffer(data) || !data.length)
      throw new Problem(
        400,
        "Attach a PNG, JPEG, GIF or WebP image, or an MP4 or WebM video.",
      );
    const mime = imageMime(data) || videoMime(data);
    if (!mime)
      throw new Problem(
        415,
        "Only PNG, JPEG, GIF and WebP images and MP4 and WebM videos can be attached.",
      );
    const video = mime.startsWith("video/"),
      limit = video ? 52428800 : 10485760;
    if (data.length > limit)
      throw new Problem(
        413,
        `${video ? "Videos" : "Images"} can be up to ${limit / 1048576} MiB.`,
      );
    const recent = this.db
      .prepare(
        "SELECT COUNT(*) AS n,COALESCE(SUM(size),0) AS bytes FROM attachments WHERE owner_id=? AND created_at>?",
      )
      .get(me.id, new Date(Date.now() - 86400000).toISOString()) as {
      n: number;
      bytes: number;
    };
    if (recent.n >= 200 || recent.bytes + data.length > 524288000)
      throw new Problem(429, "You have attached a lot today. Try again tomorrow.");
    // The name ends up inside ![name](address), so nothing that would end either part.
    const name =
      (typeof nameValue === "string" ? nameValue : "")
        .replace(/[\x00-\x1f\x7f\\/[\]()<>"`*_~|!]/g, "")
        .trim()
        .slice(0, 100) || `attachment.${mediaTypes[mime]}`;
    const id = randomToken();
    this.db
      .prepare("INSERT INTO attachments VALUES(?,?,?,?,?,?,?)")
      .run(id, me.id, name, mime, data.length, data, now());
    return {
      id,
      url: `${this.baseUrl}/media/${id}.${mediaTypes[mime]}`,
      name,
      mime,
      size: data.length,
    };
  }
  attachment(file: string) {
    const [, id, extension] =
      /^([A-Za-z0-9_-]{43})\.([a-z0-9]{3,4})$/.exec(file) || [];
    const row = id
      ? (this.db
          .prepare("SELECT id,name,mime,size FROM attachments WHERE id=?")
          .get(id) as
          | { id: string; name: string; mime: string; size: number }
          | undefined)
      : undefined;
    if (!row || mediaTypes[row.mime] !== extension)
      throw new Problem(404, "Attachment not found.");
    return row;
  }
  // A slice of the file, so a video plays from wherever the viewer seeks to.
  attachmentBytes(id: string, start: number, length: number) {
    const row = this.db
      .prepare("SELECT substr(data,?,?) AS bytes FROM attachments WHERE id=?")
      .get(start + 1, length, id) as { bytes: Uint8Array } | undefined;
    if (!row) throw new Problem(404, "Attachment not found.");
    return Buffer.from(row.bytes);
  }
  // A removed message takes the files its author attached to it along.
  private dropMedia(body: string, authorId: string) {
    const prefix = `${this.baseUrl}/media/`;
    for (
      let at = body.indexOf(prefix);
      at >= 0;
      at = body.indexOf(prefix, at + 1)
    )
      this.db
        .prepare("DELETE FROM attachments WHERE id=? AND owner_id=?")
        .run(body.slice(at + prefix.length, at + prefix.length + 43), authorId);
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
    if (this.mirrorState(channel.id) === "read-only")
      throw new Problem(
        403,
        "This mirror is read-only until its owner opens it for writing.",
      );
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
  // Renaming changes a channel's address and deleting ends it, so neither is delegated to moderators.
  requireOwner(user: User, channel: Channel) {
    this.active(user.id);
    if (channel.remote_actor)
      throw new Problem(
        403,
        "Channel moderation belongs to its home instance.",
      );
    if (!user.admin && channel.owner_id !== user.id)
      throw new Problem(403, "Only the channel owner can do that.");
  }
  // The room on another XMPP server this channel is bridged with, if any.
  bridgeRoom(id: string) {
    return (
      (
        this.db
          .prepare("SELECT room FROM channel_bridges WHERE channel_id=?")
          .get(id) as { room: string } | undefined
      )?.room ?? null
    );
  }
  // Whether the channel is a mirror of sources hosted elsewhere, and whether its owner opened it.
  mirrorState(id: string) {
    const row = this.db
      .prepare("SELECT writable FROM channel_mirrors WHERE channel_id=?")
      .get(id) as { writable: number } | undefined;
    return row ? (row.writable ? ("writable" as const) : ("read-only" as const)) : null;
  }
  // What a channel can keep from its members: who else is in it, and the handles behind the names.
  // Its owner, its moderators and those they allowed see them all the same.
  sees(user: User, channel: Channel, what: "members" | "handles") {
    if (what === "members" ? channel.show_members : !channel.hide_handles)
      return true;
    if (user.admin) return true;
    const role = this.role(channel.id, user.id);
    if (!role) return false;
    if (!channel.remote_actor && role !== "member") return true;
    return !!(
      this.db
        .prepare(
          `SELECT see_${what} AS allowed FROM channel_grants WHERE channel_id=? AND user_id=?`,
        )
        .get(channel.id, user.id) as { allowed: number } | undefined
    )?.allowed;
  }
  channelInfo(user: User, channel: Channel) {
    const rule = this.rule(channel.id, user.id);
    return {
      ...channel,
      sees_members: this.sees(user, channel, "members"),
      sees_handles: this.sees(user, channel, "handles"),
      actor_url:
        channel.remote_actor || `${this.baseUrl}/actors/channels/${channel.id}`,
      role: this.role(channel.id, user.id),
      bridge_room: this.bridgeRoom(channel.id),
      mirror: this.mirrorState(channel.id),
      readable: this.readable(user, channel),
      can_join:
        !channel.remote_actor &&
        rule !== "block" &&
        (channel.admission === "open" || rule === "allow"),
      member_count: Number(
        (
          this.db
            .prepare(`SELECT COUNT(*) AS n FROM (${everyone})`)
            .get(channel.id, channel.id, channel.id) as { n: number }
        ).n,
      ),
    };
  }
  // Everyone in a channel: members here, a home channel's accepted followers on other
  // instances, and whoever a followed channel's home says is in it.
  members(id: string) {
    return this.db
      .prepare(
        `SELECT u.*, e.role, e.held, COALESCE(g.see_members,0) AS see_members, COALESCE(g.see_handles,0) AS see_handles FROM (${everyone}) e JOIN users u ON u.id=e.user_id LEFT JOIN channel_grants g ON g.channel_id=? AND g.user_id=e.user_id ORDER BY u.username`,
      )
      .all(id, id, id, id) as unknown as (User & {
      role: string;
      held: number; // a membership kept here, which this instance can change
      see_members: number;
      see_handles: number;
    })[];
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
  private channelName(value: unknown) {
    const name = text(value, "Channel name", 40).toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]{1,39}$/.test(name))
      throw new Problem(
        400,
        "Use 2–40 lowercase letters, numbers, hyphens, or underscores.",
      );
    return name;
  }
  createChannel(user: User, input: Record<string, unknown>) {
    this.requirePermission(user, "create_channels");
    const name = this.channelName(input.name);
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
    // What members see of each other; the owner can change either later.
    for (const key of ["show_members", "hide_handles"] as const)
      if (input[key] !== undefined && typeof input[key] !== "boolean")
        throw new Problem(400, "Choose what the channel shows its members.");
    const showMembers = input.show_members !== false,
      hideHandles = input.hide_handles === true;
    return this.transaction(() => {
      if (this.db.prepare("SELECT 1 FROM channels WHERE name=?").get(name))
        throw new Problem(409, "That channel name is already taken.");
      const id = randomUUID();
      this.db
        .prepare(
          "INSERT INTO channels(id,name,description,mode,visibility,admission,owner_id,created_at,show_members,hide_handles) VALUES(?,?,?,?,?,?,?,?,?,?)",
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
          Number(showMembers),
          Number(hideHandles),
        );
      this.db
        .prepare("INSERT INTO memberships VALUES(?,?,?)")
        .run(id, user.id, "owner");
      this.startReading(user.id, id);
      this.audit(user.id, "channel.create", id);
      return this.channelInfo(user, this.channel(id));
    });
  }
  renameChannel(user: User, id: string, value: unknown) {
    const channel = this.channel(id);
    this.requireOwner(user, channel);
    const name = this.channelName(value);
    return this.transaction(() => {
      if (name !== channel.name) {
        if (
          this.db
            .prepare("SELECT 1 FROM channels WHERE name=? AND id!=?")
            .get(name, id)
        )
          throw new Problem(409, "That channel name is already taken.");
        this.db.prepare("UPDATE channels SET name=? WHERE id=?").run(name, id);
        this.federationHooks?.channel(this.channel(id), "rename");
        this.audit(
          user.id,
          "channel.rename",
          JSON.stringify({ channel: id, from: channel.name, to: name }),
        );
      }
      return this.channelInfo(user, this.channel(id));
    });
  }
  // Removes the channel and everything said in it; the audit entry is all that remains.
  deleteChannel(user: User, id: string) {
    const channel = this.channel(id);
    this.requireOwner(user, channel);
    this.transaction(() => {
      this.federationHooks?.channel(channel, "delete");
      const said = "(SELECT id FROM messages WHERE channel_id=?)";
      this.db
        .prepare(
          `DELETE FROM xmpp_events WHERE kind IN ('Create','Update','Delete') AND object_id IN ${said}`,
        )
        .run(id);
      this.db
        .prepare(`DELETE FROM xmpp_message_ids WHERE message_id IN ${said}`)
        .run(id);
      for (const message of this.db
        .prepare(
          "SELECT body,author_id FROM messages WHERE channel_id=? AND instr(body,'/media/')>0",
        )
        .all(id) as { body: string; author_id: string }[])
        this.dropMedia(message.body, message.author_id);
      this.db
        .prepare(`DELETE FROM message_reactions WHERE message_id IN ${said}`)
        .run(id);
      this.db.prepare("DELETE FROM messages WHERE channel_id=?").run(id);
      // Members' occupants in a bridged room existed only for this channel.
      this.db
        .prepare(
          "UPDATE xmpp_remote_rooms SET desired=0,state='left',role='none' WHERE bridged=1 AND room=(SELECT room FROM channel_bridges WHERE channel_id=?)",
        )
        .run(id);
      for (const table of [
        "mirror_sources",
        "channel_mirrors",
        "channel_bridge_seen",
        "channel_bridges",
        "topics",
        "memberships",
        "channel_roster",
        "channel_rules",
        "channel_grants",
        "conversation_prefs",
      ])
        this.db.prepare(`DELETE FROM ${table} WHERE channel_id=?`).run(id);
      this.db.prepare("DELETE FROM read_marks WHERE target=?").run(id);
      this.db.prepare("DELETE FROM channels WHERE id=?").run(id);
      this.audit(
        user.id,
        "channel.delete",
        JSON.stringify({ channel: id, name: channel.name }),
      );
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
    this.startReading(user.id, id);
  }
  leave(user: User, id: string) {
    this.active(user.id);
    const channel = this.channel(id);
    if (channel.owner_id === user.id)
      throw new Problem(409, "The owner cannot leave their channel.");
    this.db
      .prepare("DELETE FROM memberships WHERE channel_id=? AND user_id=?")
      .run(id, user.id);
    this.dropGrants(id, user.id);
  }
  // What a member was allowed to see ends with their membership.
  dropGrants(channelId: string, userId: string) {
    this.db
      .prepare("DELETE FROM channel_grants WHERE channel_id=? AND user_id=?")
      .run(channelId, userId);
  }
  details(user: User, id: string) {
    const channel = this.channel(id);
    this.requireRead(user, channel);
    const members = this.sees(user, channel, "members") ? this.members(id) : [];
    const topics = this.db
      .prepare("SELECT * FROM topics WHERE channel_id=? ORDER BY created_at")
      .all(id);
    const handles = this.sees(user, channel, "handles");
    return {
      ...this.channelInfo(user, channel),
      members: members.map((u) => ({
        ...this.profile(u), role: u.role, held: !!u.held,
        display_name: u.remote_actor ? this.contactName(user, u.remote_actor) ?? u.display_name : u.display_name,
        see_members: !!u.see_members,
        see_handles: !!u.see_handles,
        // Without the handle there is nothing to look the member up by.
        ...(handles || u.id === user.id
          ? {}
          : { username: "", actor_url: null, verified_socials: [] }),
      })),
      topics,
    };
  }
  // The owner decides what the channel shows its members of one another.
  setPrivacy(user: User, id: string, input: Record<string, unknown>) {
    const channel = this.channel(id);
    this.requireOwner(user, channel);
    for (const key of ["show_members", "hide_handles"] as const)
      if (input[key] !== undefined && typeof input[key] !== "boolean")
        throw new Problem(400, "Choose what the channel shows its members.");
    const show = input.show_members ?? !!channel.show_members,
      hide = input.hide_handles ?? !!channel.hide_handles;
    return this.transaction(() => {
      this.db
        .prepare("UPDATE channels SET show_members=?,hide_handles=? WHERE id=?")
        .run(Number(show), Number(hide), id);
      this.federationHooks?.channel(this.channel(id), "privacy");
      this.audit(
        user.id,
        "channel.privacy",
        JSON.stringify({ channel: id, show_members: show, hide_handles: hide }),
      );
      return this.channelInfo(user, this.channel(id));
    });
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
    if (input.role === "moderator" && this.user(targetId).remote_actor)
      throw new Problem(400, "Only local members can moderate a channel.");
    const grants = (["see_members", "see_handles"] as const).filter(
      (key) => input[key] !== undefined,
    );
    if (grants.some((key) => typeof input[key] !== "boolean"))
      throw new Problem(400, "Choose whether the member is allowed to see it.");
    if (grants.length && !role)
      throw new Problem(409, "The user must join before being allowed to see more.");
    if (
      input.rule === undefined &&
      input.role === undefined &&
      !grants.length &&
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
      for (const key of grants)
        this.db
          .prepare(
            `INSERT INTO channel_grants(channel_id,user_id,${key}) VALUES(?,?,?) ON CONFLICT(channel_id,user_id) DO UPDATE SET ${key}=excluded.${key}`,
          )
          .run(channelId, targetId, Number(input[key]));
      if (input.remove === true || input.rule === "block") {
        this.db
          .prepare("DELETE FROM memberships WHERE channel_id=? AND user_id=?")
          .run(channelId, targetId);
        this.dropGrants(channelId, targetId);
      } else if (input.role)
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
    if (channel.mode === "timeline" && (topicId || title))
      throw new Problem(400, "Timeline messages cannot have a topic or title.");
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
      this.xmppHooks?.message(result, "Create");
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
  messageInfo(message: Message, viewer?: User) {
    const author = this.user(message.author_id);
    return {
      ...message,
      ...(viewer && author.remote_actor
        ? { display_name: this.contactName(viewer, author.remote_actor) ?? message.display_name }
        : {}),
      ...(message.history_placeholder
        ? { username: "history", display_name: "Earlier message" }
        : {}),
      object_url:
        message.remote_object ||
        `${this.baseUrl}/objects/messages/${message.id}`,
      emojis: this.liveEmojis(message.emoji_tags),
      author_actor_url:
        author.remote_actor ||
        `${this.baseUrl}/actors/users/${message.author_id}`,
      avatar_url: message.history_placeholder ? null : this.avatarUrl(message.author_id),
    };
  }
  private liveEmojis(tags: string) {
    return (JSON.parse(tags) as CustomEmoji[]).filter(
      (e) =>
        !!this.db
          .prepare(
            "SELECT 1 FROM custom_emojis WHERE id=? UNION ALL SELECT 1 FROM personal_emojis WHERE id=? UNION ALL SELECT 1 FROM remote_emoji_cache WHERE id=?",
          )
          .get(e.id, e.id, e.id),
    );
  }
  messages(user: User, id: string, before?: number) {
    this.requireRead(user, this.channel(id));
    const page = (
      this.db
        .prepare(
          "SELECT m.*,u.username,u.display_name FROM messages m JOIN users u ON u.id=m.author_id WHERE m.channel_id=? AND m.seq<? AND ((m.remote_object IS NULL AND COALESCE(u.remote_actor,'') NOT LIKE 'xmpp:%') OR ?=1) ORDER BY m.seq DESC LIMIT 100",
        )
        .all(
          id,
          before ?? Number.MAX_SAFE_INTEGER,
          Number(!!this.active(user.id).federation_receive),
        ) as unknown as Message[]
    )
      .reverse()
      .map((m) => this.veiled(user, this.messageFor(user, m)));
    this.withReactions(user, page);
    // Threads this reader hid stay in the page, marked, so they can be shown again.
    const hidden = this.hiddenThreadMessages(user.id, id);
    return hidden.size
      ? page.map((m) => (hidden.has(m.id) ? { ...m, hidden_thread: true } : m))
      : page;
  }
  // ---- reactions: emoji put on a message, if its channel allows them ----
  // Adds { emoji, count, mine } for each reaction to the messages of a page, in the order first used.
  private withReactions(user: User, page: (Message & { reactions?: unknown })[]) {
    if (!page.length) return;
    const rows = this.db
      .prepare(
        `SELECT message_id,emoji,user_id FROM message_reactions WHERE message_id IN (${page.map(() => "?").join(",")}) ORDER BY created_at,rowid`,
      )
      .all(...page.map((m) => m.id)) as { message_id: string; emoji: string; user_id: string }[];
    const by = new Map<string, Map<string, { emoji: string; count: number; mine: boolean }>>();
    for (const r of rows) {
      const list = by.get(r.message_id) ?? new Map();
      const entry = list.get(r.emoji) ?? { emoji: r.emoji, count: 0, mine: false };
      entry.count++;
      if (r.user_id === user.id) entry.mine = true;
      list.set(r.emoji, entry);
      by.set(r.message_id, list);
    }
    for (const m of page)
      m.reactions = [...(by.get(m.id)?.values() ?? [])];
  }
  // Moderators (and the owner) decide whether a channel has reactions.
  setReactions(user: User, id: string, enabled: unknown) {
    const channel = this.channel(id);
    this.requireManage(user, channel);
    if (typeof enabled !== "boolean")
      throw new Problem(400, "Choose whether reactions are on.");
    return this.transaction(() => {
      this.db
        .prepare("UPDATE channels SET reactions=? WHERE id=?")
        .run(Number(enabled), id);
      this.audit(
        user.id,
        "channel.reactions",
        JSON.stringify({ channel: id, reactions: enabled }),
      );
      return this.channelInfo(user, this.channel(id));
    });
  }
  // Puts the reader's reaction on a message, or takes it off.
  react(user: User, messageId: string, input: Record<string, unknown>) {
    const message = this.message(messageId),
      channel = this.channel(message.channel_id);
    this.requirePost(user, channel);
    if (channel.remote_actor)
      throw new Problem(403, "Reactions stay on the instance that hosts the channel.");
    if (!channel.reactions)
      throw new Problem(403, "Reactions are turned off in this channel.");
    if (message.deleted_at)
      throw new Problem(409, "Removed messages cannot be reacted to.");
    if (typeof input.emoji !== "string" || typeof input.on !== "boolean")
      throw new Problem(400, "Choose an emoji.");
    const emoji = input.emoji;
    if (
      !standardEmojis.has(emoji) &&
      !this.db.prepare("SELECT 1 FROM custom_emojis WHERE name=?").get(emoji)
    )
      throw new Problem(400, "That emoji is not available here.");
    this.transaction(() => {
      if (!input.on)
        this.db
          .prepare("DELETE FROM message_reactions WHERE message_id=? AND user_id=? AND emoji=?")
          .run(messageId, user.id, emoji);
      else {
        const total = this.db
          .prepare("SELECT COUNT(DISTINCT emoji) AS n FROM message_reactions WHERE message_id=?")
          .get(messageId) as { n: number };
        const used = this.db
          .prepare("SELECT 1 FROM message_reactions WHERE message_id=? AND emoji=?")
          .get(messageId, emoji);
        if (!used && Number(total.n) >= 20)
          throw new Problem(409, "A message has up to 20 different reactions.");
        this.db
          .prepare("INSERT OR IGNORE INTO message_reactions VALUES(?,?,?,?)")
          .run(messageId, user.id, emoji, now());
      }
    });
    const page = [this.message(messageId)] as (Message & { reactions?: unknown })[];
    this.withReactions(user, page);
    return page[0].reactions;
  }
  // Where a channel hides handles, its readers get names alone: nothing to look an author up by.
  veiled<T extends { channel_id: string; author_id: string }>(user: User, info: T) {
    return info.author_id === user.id ||
      this.sees(user, this.channel(info.channel_id), "handles")
      ? info
      : { ...info, username: "", author_actor_url: null };
  }
  messageFor(user: User, message: Message) {
    const info = this.messageInfo(message, user);
    return this.isUserBlocked(user.id, info.author_actor_url)
      ? {
          ...info,
          body: "This message is hidden because you blocked this user.",
          title: info.title === null ? null : "Hidden thread",
          emoji_tags: "[]",
          emojis: [],
          edited_at: null,
        }
      : info;
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
      this.xmppHooks?.message(this.message(id), "Update");
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
      this.dropMedia(message.body, message.author_id);
      this.db
        .prepare(
          "UPDATE messages SET body='', title=NULL, deleted_at=? WHERE id=?",
        )
        .run(now(), id);
      this.federationHooks?.message(this.message(id), "Delete", user);
      this.xmppHooks?.message(this.message(id), "Delete");
      this.audit(user.id, "message.delete", id);
    });
  }
  // ---- direct messages: one row per reader, so each side keeps its own copy ----
  userBlocks(user: User) {
    this.active(user.id);
    return (
      this.db
        .prepare("SELECT peer FROM user_blocks WHERE user_id=? ORDER BY peer")
        .all(user.id) as { peer: string }[]
    ).map((row) => row.peer);
  }
  isUserBlocked(userId: string, peer: string) {
    return !!this.db
      .prepare("SELECT 1 FROM user_blocks WHERE user_id=? AND peer=?")
      .get(userId, peer);
  }
  setUserBlock(user: User, peerValue: unknown, blocked: unknown) {
    this.active(user.id);
    const value = text(peerValue, "User", 2048);
    // A room that hides its occupants' addresses leaves only the nickname there to block.
    const peer = /^xmpp:[^@/:\s]+@[a-z0-9.-]+\/[^\x00-\x1f\x7f]{1,1000}$/.test(value)
      ? value
      : this.peerInfo(value).peer;
    if (peer === this.actorOf(user.id))
      throw new Problem(400, "You can't block yourself.");
    if (typeof blocked !== "boolean")
      throw new Problem(400, "Choose a boolean block status.");
    if (blocked)
      this.db
        .prepare("INSERT OR IGNORE INTO user_blocks VALUES(?,?)")
        .run(user.id, peer);
    else
      this.db
        .prepare("DELETE FROM user_blocks WHERE user_id=? AND peer=?")
        .run(user.id, peer);
    return { peer, blocked };
  }
  private actorOf(id: string) {
    return `${this.baseUrl}/actors/users/${id}`;
  }
  private localPeer(peer: string) {
    const prefix = this.actorOf("");
    return peer.startsWith(prefix) ? peer.slice(prefix.length) : null;
  }
  private directAccess(user: User, peer: string): DirectAccess {
    const access = this.peerAccess(user, peer);
    return access.blocked || this.can(user, "direct_messages")
      ? access
      : { ...access, blocked: denied.direct_messages };
  }
  private peerAccess(user: User, peer: string): DirectAccess {
    if (this.isUserBlocked(user.id, peer))
      return {
        incoming: true,
        outgoing: true,
        blocked: "You blocked this user. Unblock them from their name menu to send direct messages.",
      };
    const local = this.localPeer(peer);
    if (peer.startsWith("xmpp:")) return this.xmppHooks?.access(user, peer) || {
      incoming: false, outgoing: false, blocked: "XMPP is disabled on this instance.",
    };
    if (local !== null) {
      const target = this.db
        .prepare("SELECT * FROM users WHERE id=? AND remote_actor IS NULL")
        .get(local) as unknown as User | undefined;
      return {
        incoming: true,
        outgoing: true,
        blocked:
          !target || target.banned || target.admission_status !== "approved" ||
          this.isUserBlocked(target.id, this.actorOf(user.id))
            ? "This member can no longer receive direct messages."
            : target.id === user.id
              ? "You can't send a direct message to yourself."
              : null,
      };
    }
    return (
      this.federationHooks?.direct(user, peer) || {
        incoming: false,
        outgoing: false,
        blocked: "Federation is disabled on this instance.",
      }
    );
  }
  private contactName(user: User, peer: string) {
    return (this.db.prepare("SELECT display_name FROM contact_names WHERE user_id=? AND peer=?")
      .get(user.id, peer) as { display_name: string } | undefined)?.display_name ?? null;
  }
  setContactName(user: User, peerValue: unknown, value: unknown) {
    const me = this.active(user.id), peer = text(peerValue, "User", 2048);
    const localDomain = this.db.prepare("SELECT value FROM instance_settings WHERE key='xmpp_domain'").get()?.value;
    if (!this.peerIdentity(peer).remote || (localDomain && peer.startsWith("xmpp:") && peer.slice(peer.lastIndexOf("@") + 1) === localDomain))
      throw new Problem(400, "Contact names can only be set for users on other hosts.");
    if (value !== null && typeof value !== "string")
      throw new Problem(400, "Display name must be text or null.");
    const name = value === null || !value.trim() ? null : text(value, "Display name", 80);
    if (name === null)
      this.db.prepare("DELETE FROM contact_names WHERE user_id=? AND peer=?").run(me.id, peer);
    else
      this.db.prepare("INSERT INTO contact_names VALUES(?,?,?) ON CONFLICT(user_id,peer) DO UPDATE SET display_name=excluded.display_name")
        .run(me.id, peer, name);
    return this.peerInfo(peer, me);
  }
  peerInfo(peer: string, viewer?: User) {
    const info = this.peerIdentity(peer);
    const contact_name = viewer && info.remote ? this.contactName(viewer, peer) : null;
    return { ...info, display_name: contact_name ?? info.display_name, contact_name };
  }
  private peerIdentity(peer: string) {
    if (peer.startsWith("xmpp:") && /^xmpp:[^@/:\s]+@[a-z0-9.-]+$/.test(peer)) {
      const address = peer.slice(5);
      return { peer, id: peer, username: address, display_name: address, avatar_url: this.remoteAvatarUrl(peer), remote: true };
    }
    const local = this.localPeer(peer);
    const user = (
      local !== null
        ? this.db
            .prepare("SELECT * FROM users WHERE id=? AND remote_actor IS NULL")
            .get(local)
        : this.db.prepare("SELECT * FROM users WHERE remote_actor=?").get(peer)
    ) as unknown as User | undefined;
    if (user)
      return {
        peer,
        id: user.id,
        username: user.username,
        display_name: user.display_name,
        avatar_url: this.avatarUrl(user.id),
        remote: local === null,
      };
    if (local !== null) throw new Problem(404, "User not found.");
    let host: string;
    try {
      const url = new URL(peer);
      if (!["http:", "https:"].includes(url.protocol)) throw new Error();
      host = url.host;
    } catch {
      throw new Problem(400, "Invalid direct message address.");
    }
    // Someone written to but never heard from is only known by their actor document.
    const cached = this.db
      .prepare("SELECT document FROM federation_actors WHERE id=?")
      .get(peer) as { document: string } | undefined;
    const actor = cached ? JSON.parse(cached.document) : {};
    const name =
      String(actor.preferredUsername || "")
        .replace(/[^a-zA-Z0-9._-]/g, "")
        .slice(0, 40) || "remote";
    return {
      peer,
      id: peer,
      username: `${name}@${host}`,
      display_name: String(actor.name || name).slice(0, 80),
      avatar_url: this.remoteAvatarUrl(peer),
      remote: true,
    };
  }
  // Who an address typed by a member means here; null when it names another instance.
  localRecipient(value: unknown) {
    const input = text(value, "Recipient", 2048);
    const id = this.localPeer(input);
    if (id !== null) return this.user(id).id;
    if (input.includes("://")) return null;
    const clean = input.replace(/^@/, ""),
      at = clean.lastIndexOf("@");
    if (at > 0 && clean.slice(at + 1) !== new URL(this.baseUrl).host)
      return null;
    const name = at > 0 ? clean.slice(0, at) : clean;
    const found = this.db
      .prepare("SELECT id FROM users WHERE username=? AND remote_actor IS NULL")
      .get(name) as { id: string } | undefined;
    if (!found)
      throw new Problem(404, `Nobody here is called @${name.slice(0, 80)}.`);
    return found.id;
  }
  sendDirect(user: User, targetId: string, bodyValue: unknown) {
    const sender = this.active(user.id),
      target = this.user(targetId);
    const blocked = this.directAccess(sender, this.actorOf(target.id)).blocked;
    if (blocked) throw new Problem(target.id === sender.id ? 400 : 403, blocked);
    const body = text(bodyValue, "Message", 8000),
      tags = JSON.stringify(this.messageEmojiTags(sender, body)),
      at = now();
    const insert = this.db.prepare(
      "INSERT INTO direct_messages(id,user_id,peer,direction,body,emoji_tags,created_at) VALUES(?,?,?,?,?,?,?)",
    );
    const outgoingId = randomUUID();
    const incomingId = randomUUID();
    this.transaction(() => {
      insert.run(
        outgoingId,
        sender.id,
        this.actorOf(target.id),
        "outgoing",
        body,
        tags,
        at,
      );
      insert.run(
        incomingId,
        target.id,
        this.actorOf(sender.id),
        "incoming",
        body,
        tags,
        at,
      );
      this.db.prepare("UPDATE direct_messages SET xmpp_source_id=? WHERE id=? OR id=?")
        .run(outgoingId, outgoingId, incomingId);
      this.xmppHooks?.direct(outgoingId, sender, target);
    });
    return { peer: this.actorOf(target.id), id: outgoingId };
  }
  private mark(userId: string, target: string) {
    return (
      this.db
        .prepare("SELECT seq FROM read_marks WHERE user_id=? AND target=?")
        .get(userId, target) as { seq: number } | undefined
    )?.seq;
  }
  conversations(user: User) {
    const me = this.active(user.id);
    const peers = this.db
      .prepare(
        "SELECT peer FROM direct_messages WHERE user_id=? GROUP BY peer ORDER BY MAX(seq) DESC LIMIT 200",
      )
      .all(me.id) as unknown as { peer: string }[];
    return peers.flatMap(({ peer }) => {
      const access = this.directAccess(me, peer);
      const last = this.db
        .prepare(
          "SELECT seq,created_at FROM direct_messages WHERE user_id=? AND peer=? AND ((direction='outgoing' AND ?=1) OR (direction='incoming' AND ?=1)) ORDER BY seq DESC LIMIT 1",
        )
        .get(me.id, peer, Number(access.outgoing), Number(access.incoming)) as
        | { seq: number; created_at: string }
        | undefined;
      if (!last) return [];
      return [
        {
          ...this.peerInfo(peer, me),
          last_seq: last.seq,
          last_at: last.created_at,
          unread: this.isUserBlocked(me.id, peer) ? 0 : Number(
            this.db
              .prepare(
                "SELECT COUNT(*) AS n FROM direct_messages WHERE user_id=? AND peer=? AND direction='incoming' AND ?=1 AND seq>?",
              )
              .get(
                me.id,
                peer,
                Number(access.incoming),
                this.mark(me.id, `dm:${peer}`) ?? 0,
              )?.n,
          ),
        },
      ];
    });
  }
  // Shaped like channel messages, so the same conversation view shows both.
  private directInfo(
    me: User,
    info: ReturnType<Store["peerInfo"]>,
    row: DirectRow,
  ) {
    const author = row.direction === "outgoing" ? me : info;
    return {
      id: `dm-${row.seq}`,
      seq: row.seq,
      author_id: author.id,
      username: author.username,
      display_name: author.display_name,
      author_actor_url:
        row.direction === "outgoing" ? this.actorOf(me.id) : info.peer,
      avatar_url: row.direction === "outgoing" ? this.avatarUrl(me.id) : info.avatar_url,
      body: row.body,
      title: null,
      parent_id: null,
      topic_id: null,
      created_at: row.created_at,
      deleted_at: null,
      edited_at: null,
      emojis: this.liveEmojis(row.emoji_tags),
    };
  }
  // Shared by the conversation view and the list of messages to other servers.
  directDeliveryStates(user: User, peer: string | null = null) {
    const me = this.active(user.id);
    const rows = this.db.prepare(
      "SELECT json_extract(o.activity,'$.object.id') AS id,d.status,d.error FROM federation_deliveries d JOIN federation_outgoing o ON o.id=d.activity_id WHERE o.user_id=? AND (? IS NULL OR d.recipient=?) AND o.purpose='direct' AND d.status IN ('pending','failed','cancelled')",
    ).all(me.id, peer, peer) as unknown as { id: string; status: string; error: string | null }[];
    return new Map(rows.map(d => [d.id, {
      queued: true,
      ...(d.status !== "pending" ? { failed: d.error || "Delivery failed." } : {}),
    }]));
  }
  directHistory(user: User, peerValue: unknown, before?: number) {
    const me = this.active(user.id),
      info = this.peerInfo(text(peerValue, "Recipient", 2048), me),
      access = this.directAccess(me, info.peer);
    const waiting = this.directDeliveryStates(me, info.peer);
    const messages = (
      this.db
        .prepare(
          "SELECT * FROM direct_messages WHERE user_id=? AND peer=? AND seq<? AND ((direction='outgoing' AND ?=1) OR (direction='incoming' AND ?=1)) ORDER BY seq DESC LIMIT 100",
        )
        .all(
          me.id,
          info.peer,
          before ?? Number.MAX_SAFE_INTEGER,
          Number(access.outgoing),
          Number(access.incoming),
        ) as unknown as DirectRow[]
    )
      .reverse()
      .map((row) => ({
        ...this.directInfo(me, info, row),
        ...(row.direction === "outgoing" ? waiting.get(row.id) : {}),
      }));
    return {
      conversation: { ...info, blocked: access.blocked },
      messages,
      older_cursor: messages.length === 100 ? messages[0].seq : null,
    };
  }

  // ---- what is new: a mark per reader and conversation, at the last message seen ----
  // Joining starts from here: what was said before is not news.
  startReading(userId: string, channelId: string) {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO read_marks VALUES(?,?,(SELECT COALESCE(MAX(seq),0) FROM messages))",
      )
      .run(userId, channelId);
  }
  private channelMark(userId: string, channelId: string) {
    this.startReading(userId, channelId);
    return this.mark(userId, channelId)!;
  }
  private joined(user: User) {
    return (
      this.db
        .prepare(
          "SELECT c.* FROM channels c JOIN memberships m ON m.channel_id=c.id WHERE m.user_id=? ORDER BY c.name",
        )
        .all(user.id) as unknown as Channel[]
    ).filter((c) => this.readable(user, c));
  }
  // Every message of the threads this reader hid in a channel: the first message and all under it.
  private hiddenThreads =
    "WITH RECURSIVE hid(id) AS (SELECT substr(target,8) FROM conversation_prefs WHERE user_id=? AND channel_id=? AND hidden=1 AND target>='thread:' AND target<'thread;' UNION SELECT r.id FROM messages r JOIN hid ON r.parent_id=hid.id) ";
  private unreadWhere =
    "m.channel_id=? AND m.seq>? AND m.author_id!=? AND m.deleted_at IS NULL AND m.history_placeholder=0 AND (?=1 OR (m.remote_object IS NULL AND NOT EXISTS (SELECT 1 FROM users foreigner WHERE foreigner.id=m.author_id AND foreigner.remote_actor LIKE 'xmpp:%'))) AND NOT EXISTS (SELECT 1 FROM user_blocks b JOIN users author ON author.id=m.author_id WHERE b.user_id=? AND b.peer=COALESCE(author.remote_actor,?||author.id)) AND m.id NOT IN (SELECT id FROM hid) AND (m.topic_id IS NULL OR NOT EXISTS (SELECT 1 FROM conversation_prefs p WHERE p.user_id=? AND p.target='topic:'||m.topic_id AND p.hidden=1))";
  // What hiddenThreads and unreadWhere ask for, in order.
  private unreadArgs(me: User, channelId: string, after: number) {
    return [
      me.id,
      channelId,
      channelId,
      after,
      me.id,
      Number(!!me.federation_receive),
      me.id,
      this.actorOf(""),
      me.id,
    ];
  }
  private hiddenThreadMessages(userId: string, channelId: string) {
    return new Set(
      (
        this.db
          .prepare(`${this.hiddenThreads}SELECT id FROM hid`)
          .all(userId, channelId) as { id: string }[]
      ).map((row) => row.id),
    );
  }
  overview(user: User) {
    const me = this.active(user.id),
      unread: Record<string, number> = {};
    for (const c of this.joined(me)) {
      const n = Number(
        this.db
          .prepare(
            `${this.hiddenThreads}SELECT COUNT(*) AS n FROM messages m WHERE ${this.unreadWhere}`,
          )
          .get(...this.unreadArgs(me, c.id, this.channelMark(me.id, c.id)))?.n,
      );
      if (n) unread[c.id] = n;
    }
    return {
      dms: this.conversations(me),
      unread,
      prefs: this.prefs(me),
      layout: this.layout(me),
      user_blocks: this.userBlocks(me),
    };
  }
  inbox(user: User) {
    const me = this.active(user.id);
    const channels = this.joined(me).filter((c) => {
      try { this.requireRead(me, c); return true; }
      catch (error) {
        if (error instanceof Problem && error.status === 403) return false;
        throw error;
      }
    }).flatMap((c) =>
      (
        this.db
          .prepare(
            `${this.hiddenThreads}SELECT m.*,u.username,u.display_name,t.title AS topic_title FROM messages m JOIN users u ON u.id=m.author_id LEFT JOIN topics t ON t.id=m.topic_id WHERE ${this.unreadWhere} ORDER BY m.seq DESC LIMIT 50`,
          )
          .all(
            ...this.unreadArgs(me, c.id, this.channelMark(me.id, c.id)),
          ) as unknown as Message[]
      ).map((m) => ({
        ...this.veiled(me, this.messageInfo(m, me)),
        kind: "channel" as const,
        target: c.id,
        channel: {
          id: c.id,
          name: c.name,
          mode: c.mode,
          visibility: c.visibility,
          remote_actor: c.remote_actor,
        },
      })),
    );
    const directs = this.conversations(me)
      .filter((conversation) => conversation.unread)
      .flatMap((conversation) =>
        (
          this.db
            .prepare(
              "SELECT * FROM direct_messages WHERE user_id=? AND peer=? AND direction='incoming' AND seq>? ORDER BY seq DESC LIMIT 50",
            )
            .all(
              me.id,
              conversation.peer,
              this.mark(me.id, `dm:${conversation.peer}`) ?? 0,
            ) as unknown as DirectRow[]
        ).map((row) => ({
          ...this.directInfo(me, conversation, row),
          kind: "dm" as const,
          target: `dm:${conversation.peer}`,
          conversation,
        })),
      );
    const at = (value: string) => Date.parse(value) || 0;
    return [...channels, ...directs]
      .sort((a, b) => at(b.created_at) - at(a.created_at))
      .slice(0, 200);
  }
  // Marks a conversation read up to seq (or its end), or everything of a kind.
  markRead(user: User, input: Record<string, unknown>) {
    const me = this.active(user.id);
    const set = (target: string, latest: number, upTo?: number) =>
      this.db
        .prepare(
          "INSERT INTO read_marks VALUES(?,?,?) ON CONFLICT(user_id,target) DO UPDATE SET seq=MAX(seq,excluded.seq)",
        )
        .run(me.id, target, Math.min(upTo ?? latest, latest));
    const latestIn = (channelId: string) =>
      Number(
        this.db
          .prepare(
            "SELECT COALESCE(MAX(seq),0) AS n FROM messages WHERE channel_id=?",
          )
          .get(channelId)?.n,
      );
    const latestWith = (peer: string) =>
      Number(
        this.db
          .prepare(
            "SELECT COALESCE(MAX(seq),0) AS n FROM direct_messages WHERE user_id=? AND peer=?",
          )
          .get(me.id, peer)?.n,
      );
    if (input.all !== undefined) {
      const kind = choice(input.all, ["all", "channels", "dms"], "kind");
      this.transaction(() => {
        if (kind !== "dms")
          for (const c of this.joined(me)) set(c.id, latestIn(c.id));
        if (kind !== "channels")
          for (const c of this.conversations(me))
            set(`dm:${c.peer}`, latestWith(c.peer));
      });
      return;
    }
    const target = text(input.target, "Conversation", 2100);
    if (
      input.seq !== undefined &&
      (!Number.isSafeInteger(input.seq) || (input.seq as number) < 0)
    )
      throw new Problem(400, "Invalid read position.");
    const seq = input.seq as number | undefined;
    if (target.startsWith("dm:")) {
      set(target, latestWith(target.slice(3)), seq);
      return;
    }
    if (!this.role(this.channel(target).id, me.id))
      throw new Problem(403, "Join this channel first.");
    set(target, latestIn(target), seq);
  }

  // ---- what a reader hid, and what may notify them ----
  // notify is kept as 1, 0 or 2: everything, nothing, or only what mentions the reader.
  prefs(user: User) {
    return Object.fromEntries(
      (
        this.db
          .prepare(
            "SELECT target,hidden,notify FROM conversation_prefs WHERE user_id=?",
          )
          .all(user.id) as {
          target: string;
          hidden: number;
          notify: number | null;
        }[]
      ).map((p) => [
        p.target,
        { hidden: !!p.hidden, notify: notifyChoice(p.notify) },
      ]),
    );
  }
  // The same, with the names a settings page lists them under.
  prefList(user: User) {
    const me = this.active(user.id);
    return (
      this.db
        .prepare(
          "SELECT p.target,p.hidden,p.notify,c.id AS channel_id,c.name AS channel_name,t.title AS topic_title,m.title AS thread_title FROM conversation_prefs p LEFT JOIN channels c ON c.id=p.channel_id LEFT JOIN topics t ON p.target='topic:'||t.id LEFT JOIN messages m ON p.target='thread:'||m.id WHERE p.user_id=? ORDER BY c.name,p.target",
        )
        .all(me.id) as {
        target: string;
        hidden: number;
        notify: number | null;
        channel_id: string | null;
        channel_name: string | null;
        topic_title: string | null;
        thread_title: string | null;
      }[]
    ).flatMap((p) => {
      const kind = p.target.startsWith("dm:")
        ? ("dm" as const)
        : p.target.startsWith("topic:")
          ? ("topic" as const)
          : p.target.startsWith("thread:")
            ? ("thread" as const)
            : ("channel" as const);
      // Kept for a channel this reader left or lost sight of, but not listed.
      if (
        kind !== "dm" &&
        (!p.channel_id ||
          !this.role(p.channel_id, me.id) ||
          !this.readable(me, this.channel(p.channel_id)))
      )
        return [];
      return [
        {
          target: p.target,
          kind,
          hidden: !!p.hidden,
          notify: notifyChoice(p.notify),
          channel: p.channel_id
            ? { id: p.channel_id, name: p.channel_name! }
            : null,
          title:
            kind === "dm"
              ? this.peerInfo(p.target.slice(3), me).display_name
              : kind === "topic"
                ? p.topic_title
                : kind === "thread"
                  ? p.thread_title
                  : null,
        },
      ];
    });
  }
  setPref(user: User, input: Record<string, unknown>) {
    const me = this.active(user.id),
      target = text(input.target, "Conversation", 2100);
    if (input.hidden !== undefined && typeof input.hidden !== "boolean")
      throw new Problem(400, "Choose whether it is hidden.");
    if (
      input.notify !== undefined &&
      input.notify !== null &&
      input.notify !== "mentions" &&
      typeof input.notify !== "boolean"
    )
      throw new Problem(400, "Choose whether it notifies you.");
    if (input.hidden === undefined && input.notify === undefined)
      throw new Problem(400, "Choose a change.");
    let channelId: string | null = null;
    if (target.startsWith("dm:")) {
      this.peerInfo(target.slice(3));
      if (input.notify === "mentions")
        throw new Problem(400, "A direct conversation notifies you or it doesn't.");
    } else {
      if (target.startsWith("topic:")) {
        const topic = this.db
          .prepare("SELECT channel_id FROM topics WHERE id=?")
          .get(target.slice(6)) as { channel_id: string } | undefined;
        if (!topic) throw new Problem(404, "Topic not found.");
        channelId = topic.channel_id;
      } else if (target.startsWith("thread:")) {
        const first = this.message(target.slice(7));
        channelId = first.channel_id;
        if (first.parent_id || this.channel(channelId).mode !== "threaded")
          throw new Problem(400, "Choose the first message of a thread.");
      } else channelId = this.channel(target).id;
      this.requireRead(me, this.channel(channelId));
      if (!this.role(channelId, me.id))
        throw new Problem(403, "Join this channel first.");
    }
    // A channel or a direct conversation, rather than a part of one.
    const whole = !channelId || channelId === target;
    if (whole && input.hidden)
      throw new Problem(400, "Only topics and threads can be hidden.");
    this.transaction(() => {
      const old = this.pref(me.id, target);
      const hidden =
          input.hidden === undefined ? old?.hidden || 0 : Number(input.hidden),
        notify =
          input.notify === undefined
            ? (old?.notify ?? null)
            : input.notify === null
              ? null
              : input.notify === "mentions"
                ? 2
                : Number(input.notify);
      // Nothing out of the ordinary needs no row: a whole conversation notifies unless told not to.
      if (!hidden && (notify === null || (whole && notify === 1)))
        this.db
          .prepare("DELETE FROM conversation_prefs WHERE user_id=? AND target=?")
          .run(me.id, target);
      else
        this.db
          .prepare(
            "INSERT INTO conversation_prefs VALUES(?,?,?,?,?) ON CONFLICT(user_id,target) DO UPDATE SET hidden=excluded.hidden,notify=excluded.notify",
          )
          .run(me.id, target, channelId, hidden, notify);
    });
    return this.prefs(me);
  }
  private pref(userId: string, target: string) {
    return this.db
      .prepare(
        "SELECT hidden,notify FROM conversation_prefs WHERE user_id=? AND target=?",
      )
      .get(userId, target) as
      | { hidden: number; notify: number | null }
      | undefined;
  }
  // What to tell this reader about a new channel message, or null when it should stay quiet:
  // they wrote it, read it, cannot see it, hid its topic or thread, or turned its notifications off.
  channelNotice(userId: string, message: Message) {
    const user = this.user(userId),
      channel = this.channel(message.channel_id);
    if (
      user.banned ||
      user.admission_status !== "approved" ||
      !this.role(channel.id, user.id) ||
      !this.readable(user, channel)
    )
      return null;
    if (
      !this.db
        .prepare(
          `${this.hiddenThreads}SELECT 1 FROM messages m WHERE ${this.unreadWhere} AND m.seq=?`,
        )
        .get(
          ...this.unreadArgs(
            user,
            channel.id,
            this.channelMark(user.id, channel.id),
          ),
          message.seq,
        )
    )
      return null;
    let first = message;
    if (channel.mode === "threaded")
      for (let depth = 0; first.parent_id && depth < 1000; depth++) {
        const parent = this.db
          .prepare("SELECT * FROM messages WHERE id=?")
          .get(first.parent_id) as unknown as Message | undefined;
        if (!parent) break;
        first = parent;
      }
    const part =
      channel.mode === "topical" && message.topic_id
        ? `topic:${message.topic_id}`
        : channel.mode === "threaded" && !first.parent_id
          ? `thread:${first.id}`
          : null;
    const notify =
      (part ? this.pref(user.id, part)?.notify : null) ??
      this.pref(user.id, channel.id)?.notify ??
      1;
    if (!notify || (notify === 2 && !this.mentions(user, message))) return null;
    const topic = message.topic_id
      ? (
          this.db
            .prepare("SELECT title FROM topics WHERE id=?")
            .get(message.topic_id) as { title: string } | undefined
        )?.title
      : null;
    const within = topic || (part?.startsWith("thread:") ? first.title : null);
    return {
      tag: part || channel.id,
      title: `#${channel.name}${within ? ` › ${within}` : ""}`,
      from: this.messageFor(user, this.message(message.id)).display_name as string | null,
      url: `/#/c/${channel.id}${message.topic_id ? `/t/${message.topic_id}` : ""}`,
    };
  }
  // Whether a message is meant for this reader in particular: it names their handle, or
  // answers something they wrote.
  private mentions(user: User, message: Message) {
    const name = user.username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(^|[^\\w@.-])@${name}(?![\\w@-]|\\.[\\w-])`, "i").test(message.body))
      return true;
    return (
      !!message.parent_id &&
      (
        this.db
          .prepare("SELECT author_id FROM messages WHERE id=?")
          .get(message.parent_id) as { author_id: string } | undefined
      )?.author_id === user.id
    );
  }
  // The same for a direct message that arrived.
  directNotice(row: { seq: number; user_id: string; peer: string }) {
    const user = this.user(row.user_id);
    if (user.banned || user.admission_status !== "approved") return null;
    const target = `dm:${row.peer}`;
    if (
      !this.directAccess(user, row.peer).incoming ||
      this.isUserBlocked(user.id, row.peer) ||
      (this.mark(user.id, target) ?? 0) >= row.seq ||
      this.pref(user.id, target)?.notify === 0
    )
      return null;
    return {
      tag: target,
      title: this.peerInfo(row.peer, user).display_name as string,
      from: null as string | null,
      url: `/#/dm/${this.localPeer(row.peer) ?? encodeURIComponent(row.peer)}`,
    };
  }

  // ---- the sidebar as its reader arranged it ----
  layout(user: User) {
    const saved = this.db
      .prepare("SELECT layout FROM sidebar_layouts WHERE user_id=?")
      .get(user.id) as { layout: string } | undefined;
    return saved ? JSON.parse(saved.layout) : null;
  }
  setLayout(user: User, input: Record<string, unknown>) {
    const me = this.active(user.id);
    const ids = (value: unknown) =>
      Array.isArray(value)
        ? [
            ...new Set(
              value.filter(
                (id): id is string =>
                  typeof id === "string" && !!id && id.length <= 2100,
              ),
            ),
          ].slice(0, 500)
        : [];
    const section = (value: unknown) => {
      const v = (value && typeof value === "object" ? value : {}) as Record<
        string,
        unknown
      >;
      const groups = Array.isArray(v.groups) ? v.groups : [];
      if (groups.length > 50)
        throw new Problem(400, "A section holds up to 50 groups.");
      return {
        collapsed: v.collapsed === true,
        items: ids(v.items),
        groups: groups.map((g) => ({
          id: text(g?.id, "Group ID", 40),
          name: text(g?.name, "Group name", 40),
          collapsed: g?.collapsed === true,
          items: ids(g?.items),
        })),
      };
    };
    const layout = {
      dms: section(input.dms),
      channels: section(input.channels),
      xmpp: section(input.xmpp),
    };
    this.db
      .prepare(
        "INSERT INTO sidebar_layouts VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET layout=excluded.layout",
      )
      .run(me.id, JSON.stringify(layout));
    return layout;
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
  avatarUrl(userId: string) {
    const user = this.user(userId);
    if (user.remote_actor) return this.remoteAvatarUrl(user.remote_actor);
    const row = this.db
      .prepare("SELECT revision FROM user_avatars WHERE user_id=?")
      .get(userId) as { revision: string } | undefined;
    return row ? `/api/avatars/${userId}?v=${row.revision}` : null;
  }
  avatarImage(userId: string) {
    const row = this.db
      .prepare("SELECT mime,image FROM user_avatars WHERE user_id=?")
      .get(userId) as { mime: string; image: Uint8Array } | undefined;
    if (!row) throw new Problem(404, "Profile picture not found.");
    return row;
  }
  setAvatar(user: User, encoded: unknown) {
    this.active(user.id);
    const { image, mime } = decodeRasterImage(encoded, 2097152, "profile picture");
    this.transaction(() => {
      this.db
        .prepare("INSERT INTO user_avatars VALUES(?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET revision=excluded.revision,mime=excluded.mime,image=excluded.image")
        .run(user.id, randomUUID(), mime, image);
      this.federationHooks?.profile(this.user(user.id));
      this.xmppHooks?.profile(this.user(user.id));
    });
    return this.profile(this.user(user.id), true);
  }
  removeAvatar(user: User) {
    this.active(user.id);
    this.transaction(() => {
      this.db.prepare("DELETE FROM user_avatars WHERE user_id=?").run(user.id);
      this.federationHooks?.profile(this.user(user.id));
      this.xmppHooks?.profile(this.user(user.id));
    });
    return this.profile(this.user(user.id), true);
  }
  remoteAvatarUrl(peer: string) {
    const row = this.db.prepare("SELECT id,revision FROM remote_avatars WHERE peer=?").get(peer) as { id: string; revision: string } | undefined;
    return row ? `/api/remote-avatars/${row.id}?v=${row.revision}` : null;
  }
  remoteAvatarImage(id: string) {
    const row = this.db.prepare("SELECT peer,mime,image FROM remote_avatars WHERE id=?").get(id) as { peer: string; mime: string; image: Uint8Array } | undefined;
    if (!row) throw new Problem(404, "Profile picture not found.");
    return row;
  }
  cacheRemoteAvatar(peer: string, encoded: unknown, source: string) {
    if (encoded === null) {
      this.db.prepare("DELETE FROM remote_avatars WHERE peer=?").run(peer);
      return;
    }
    const { image, mime } = decodeRasterImage(encoded, 2097152, "profile picture");
    const revision = hash(image.toString("base64"));
    this.db.prepare("INSERT INTO remote_avatars VALUES(?,?,?,?,?,?,?) ON CONFLICT(peer) DO UPDATE SET revision=excluded.revision,mime=excluded.mime,image=excluded.image,source=excluded.source,fetched_at=excluded.fetched_at")
      .run(hash(peer), peer, revision, mime, image, source, Date.now());
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
            instance_role: this.grants(u).instance_role,
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

// ISO media: an "ftyp" box naming a brand browsers play as MP4. WebM starts with an EBML header.
function videoMime(data: Buffer) {
  if (data.length >= 12 && data.toString("latin1", 4, 8) === "ftyp")
    return /^(isom|iso[2-9]|mp4[12]|avc1|M4V |dash|mmp4|3gp[4-7])$/.test(
      data.toString("latin1", 8, 12),
    )
      ? "video/mp4"
      : "";
  if (data.length >= 4 && data.readUInt32BE(0) === 0x1a45dfa3)
    return "video/webm";
  return "";
}
