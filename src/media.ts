import type { Request, Response } from "express";
import type { Config } from "./config.js";
import { Store, Problem, type User, type Channel } from "./store.js";
import { Federation } from "./federation.js";
import { peerJson, peerRequest, signedHeaders } from "./federation-net.js";
import { mediaPath } from "./media-url.js";

export class Media {
  constructor(readonly store: Store, readonly federation: Federation, readonly config: Config) {}

  private subscribed(user: User, channel: Channel) {
    try {
      this.store.requireRead(user, channel);
      if (!this.store.role(channel.id, user.id) || this.store.rule(channel.id, user.id) === "block") return false;
      return !channel.remote_actor || !!this.store.db.prepare(
        "SELECT 1 FROM federation_subscriptions WHERE channel_id=? AND user_id=? AND status='accepted'",
      ).get(channel.id, user.id);
    } catch { return false; }
  }

  private channelViewer(channel: Channel, actor: string) {
    const prefix = `${this.config.baseUrl}/actors/users/`;
    const local = this.store.db.prepare("SELECT * FROM users WHERE remote_actor IS NULL AND id=?")
      .get(actor.startsWith(prefix) ? actor.slice(prefix.length) : "") as User | undefined;
    if (local) return this.subscribed(local, channel);
    return !!channel.federation_enabled && this.federation.acceptedFollower(channel.id, actor);
  }

  // The channel's authoritative home answers the file server, which signs as the uploader.
  // A cached roster or a second user's subscription never grants the requester access.
  channelAccess(signer: Record<string, any>, channelId: string, viewer: unknown, value: unknown) {
    const channel = this.store.channel(channelId);
    if (channel.remote_actor || !channel.federation_enabled || signer.type !== "Person" ||
        typeof viewer !== "string" || typeof value !== "string")
      throw new Problem(403, "An accepted channel subscription is required.");
    const url = this.federation.allowed(value);
    if (!mediaPath.test(url.pathname) || url.search || url.origin !== new URL(signer.id).origin)
      throw new Problem(403, "The media server must authenticate as its uploader.");
    const reference = this.store.db.prepare(
      "SELECT 1 FROM messages m JOIN users u ON u.id=m.author_id WHERE m.channel_id=? AND m.deleted_at IS NULL AND u.remote_actor=? AND instr(m.body,?)>0",
    ).get(channel.id, signer.id, url.href);
    if (!reference) throw new Problem(403, "Media is not published by this user in this channel.");
    return { allowed: this.channelViewer(channel, viewer) };
  }

  private async remoteChannel(channel: Channel, owner: User, viewer: string, url: string) {
    try {
      this.federation.ensureEnabled();
      const home = this.federation.allowed(channel.remote_actor!);
      const query = new URL("/federation/media-access", home);
      query.searchParams.set("channel", home.href);
      query.searchParams.set("viewer", viewer);
      query.searchParams.set("url", url);
      const result = await peerJson(query, this.config, signedHeaders(query, "GET",
        this.federation.userActor(owner), this.federation.keys().private_key));
      return result.allowed === true;
    } catch { return false; }
  }

  async authorize(file: ReturnType<Store["attachment"]>, viewer: User | Record<string, any>, remote = false) {
    const owner = this.store.active(file.owner_id);
    const actor = remote ? viewer.id as string : this.federation.userActor(viewer as User);
    if (remote) {
      if ((viewer as Record<string, any>).type !== "Person") throw new Problem(403, "Media access requires a user actor.");
      const known = this.store.db.prepare("SELECT id FROM users WHERE remote_actor=?").get(actor) as { id: string } | undefined;
      if (known) this.store.active(known.id);
    } else this.store.active(viewer.id);
    if (!file.published && !remote && viewer.id === owner.id) return;
    const url = `${this.config.baseUrl}/media/${file.file}`;
    const references = this.store.db.prepare(
      "SELECT DISTINCT channel_id FROM messages WHERE author_id=? AND deleted_at IS NULL AND instr(body,?)>0",
    ).all(owner.id, url) as { channel_id: string }[];
    for (const reference of references) {
      const channel = this.store.channel(reference.channel_id);
      if (channel.remote_actor) {
        if (!remote && !this.subscribed(viewer as User, channel)) continue;
        if (await this.remoteChannel(channel, owner, actor, url)) return;
      } else if (this.channelViewer(channel, actor)) return;
    }
    // Direct attachments belong to the two participants, with the same authenticated path.
    const directs = this.store.db.prepare(
      "SELECT peer FROM direct_messages WHERE user_id=? AND direction='outgoing' AND instr(body,?)>0",
    ).all(owner.id, url) as { peer: string }[];
    if (directs.some(({ peer }) => (actor === this.federation.userActor(owner) || actor === peer) &&
        !this.store.isUserBlocked(owner.id, peer) &&
        (remote || !this.store.isUserBlocked(viewer.id, this.federation.userActor(owner))))) return;
    throw new Problem(403, "Subscribe to the channel to access this media.");
  }

  serve(req: Request, res: Response, file: ReturnType<Store["attachment"]>) {
    this.headers(res);
    res.setHeader("Content-Disposition", `${file.mime === "application/octet-stream" || req.query.download === "1" ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(file.name)}`);
    res.type(file.mime);
    let start = 0, end = file.size - 1;
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
    if (range && (range[1] || range[2])) {
      if (range[1]) {
        start = Number(range[1]);
        if (range[2]) end = Math.min(end, Number(range[2]));
      } else start = Math.max(0, file.size - Number(range[2]));
      if (start > end || start >= file.size) {
        res.setHeader("Content-Range", `bytes */${file.size}`);
        res.status(416).end();
        return;
      }
      res.status(206).setHeader("Content-Range", `bytes ${start}-${end}/${file.size}`);
    }
    res.setHeader("Content-Length", end - start + 1);
    res.end(req.method === "HEAD" ? undefined : this.store.attachmentBytes(file.id, start, end - start + 1));
  }

  private headers(res: Response) {
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
  }

  async proxy(req: Request, res: Response, user: User) {
    this.store.active(user.id);
    this.federation.require(user, "federation_receive");
    if (typeof req.query.url !== "string") throw new Problem(400, "Use a remote attachment URL.");
    const url = this.federation.allowed(req.query.url);
    if (url.origin === this.config.baseUrl || !mediaPath.test(url.pathname) || url.search)
      throw new Problem(400, "Use a remote attachment URL.");
    const references = this.store.db.prepare(
      "SELECT DISTINCT channel_id FROM messages WHERE deleted_at IS NULL AND instr(body,?)>0",
    ).all(url.href) as { channel_id: string }[];
    const direct = this.store.db.prepare("SELECT peer FROM direct_messages WHERE user_id=? AND instr(body,?)>0")
      .all(user.id, url.href) as { peer: string }[];
    if (!references.some(({ channel_id }) => this.subscribed(user, this.store.channel(channel_id))) &&
        !direct.some(({ peer }) => !this.store.isUserBlocked(user.id, peer)))
      throw new Problem(403, "Subscribe to the channel to access this media.");
    if (req.query.download === "1") url.searchParams.set("download", "1");
    const method = req.method === "HEAD" ? "HEAD" : "GET";
    const headers = signedHeaders(url, method, this.federation.userActor(user), this.federation.keys().private_key);
    headers.accept = "*/*";
    if (req.headers.range) headers.range = req.headers.range;
    const response = await peerRequest(url, this.config, headers, undefined, 52428800, 30000, method);
    this.headers(res);
    res.status(response.status).type(response.type);
    for (const name of ["content-disposition", "content-range", "content-length"])
      if (typeof response.headers[name] === "string") res.setHeader(name, response.headers[name]);
    res.end(method === "HEAD" ? undefined : response.body);
  }
}
