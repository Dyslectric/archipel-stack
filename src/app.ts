import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import helmet from "helmet";
import { rateLimit, ipKeyGenerator } from "express-rate-limit";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { Config } from "./config.js";
import { Problem, Store, text, type User } from "./store.js";
import { Federation } from "./federation.js";
import { createOidc, OidcFailure, type OidcStage } from "./oidc.js";
import { logSignInFailure } from "./auth-log.js";
import { Xmpp } from "./xmpp.js";
import { Mirrors } from "./mirrors.js";
import { Push } from "./push.js";
import { Events } from "./events.js";

function cookie(req: Request, name: string) {
  const value = (req.headers.cookie || "")
    .split(";")
    .map((s) => s.trim())
    .find((s) => s.startsWith(`${name}=`))
    ?.slice(name.length + 1);
  return value && /^[A-Za-z0-9_-]{1,200}$/.test(value) ? value : "";
}
export function createApp(config: Config, store: Store) {
  store.applyAuthPolicy(
    config.oidcIssuer,
    config.adminSubjects,
    config.devAuth,
  );
  store.initializeRegistration(config.registrationMode);
  const federation = new Federation(store, config);
  const xmpp = new Xmpp(store, config);
  const mirrors = new Mirrors(store, xmpp);
  const push = new Push(store, config);
  const events = new Events(store);
  const app = express();
  app.locals.events = events;
  app.locals.mirrors = mirrors;
  app.locals.push = push;
  app.locals.federation = federation;
  app.locals.xmpp = xmpp;
  app.set(
    "trust proxy",
    config.trustedProxies.length ? config.trustedProxies : false,
  );
  const oidc = createOidc(config, store);
  const secure = config.baseUrl.startsWith("https:");
  const cookieOptions = {
    httpOnly: true,
    sameSite: "lax" as const,
    secure,
    path: "/",
  };
  const authCookie = secure ? "__Host-archipel" : "archipel";
  app.disable("x-powered-by");
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: { "upgrade-insecure-requests": secure ? [] : null },
      },
      strictTransportSecurity: secure ? undefined : false,
    }),
  );
  app.use(
    ["/api/admin/emojis", "/api/personal-emojis"],
    express.json({ limit: "360kb" }),
  );
  app.use("/api/profile/avatar", express.json({ limit: "3mb" }));
  app.use("/internal/xmpp/avatars", express.json({ limit: "3mb" }));
  // Federation authenticates with signed requests; browser APIs keep Origin/CSRF.
  app.use(
    "/federation",
    rateLimit({
      windowMs: 60000,
      limit: config.rateLimitFederation,
      message: { error: "Too many federation requests." },
    }),
  );
  app.post(
    "/federation/inbox",
    express.raw({
      type: [
        "application/activity+json",
        "application/ld+json",
        "application/json",
      ],
      limit: "64kb",
    }),
    async (req, res) => {
      if (!Buffer.isBuffer(req.body))
        throw new Problem(415, "Use an ActivityStreams JSON content type.");
      await federation.receive(req, req.body);
      res.status(202).json({ accepted: true });
    },
  );
  app.use(["/federation", "/.well-known"], (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  app.get("/.well-known/webfinger", (req, res) => {
    federation.ensureEnabled();
    const resource = String(req.query.resource || "");
    const domain = new URL(config.baseUrl).host;
    if (!resource.startsWith("acct:") || !resource.endsWith(`@${domain}`))
      throw new Problem(404, "Unknown account.");
    const name = resource.slice(5, -(domain.length + 1));
    const channel = name.startsWith("#")
      ? (store.db
          .prepare(
            "SELECT id FROM channels WHERE name=? AND remote_actor IS NULL AND federation_enabled=1",
          )
          .get(name.slice(1)) as { id: string } | undefined)
      : undefined;
    const localUser = store.db
      .prepare("SELECT id FROM users WHERE username=? AND remote_actor IS NULL")
      .get(name) as { id: string } | undefined;
    const actor = channel
      ? federation.publicActor("channels", channel.id)
      : localUser
        ? federation.publicActor("users", localUser.id)
        : null;
    if (!actor) throw new Problem(404, "Unknown federated account.");
    res
      .type("application/jrd+json")
      .json({
        subject: resource,
        links: [
          { rel: "self", type: "application/activity+json", href: actor.id },
        ],
      });
  });
  app.get("/actors/:kind/:id/outbox", async (req, res) => {
    if (req.params.kind !== "channels")
      throw new Problem(404, "User outboxes are private.");
    const actor = await federation.authenticate(req);
    const before =
      req.query.before === undefined ? undefined : Number(req.query.before);
    if (before !== undefined && (!Number.isSafeInteger(before) || before < 1))
      throw new Problem(400, "Invalid history cursor.");
    res
      .type("application/activity+json")
      .json(federation.history(actor, String(req.params.id), before));
  });
  app.get("/actors/channels/:id/members", async (req, res) => {
    const actor = await federation.authenticate(req);
    res
      .type("application/activity+json")
      .json(federation.roster(actor, String(req.params.id)));
  });
  app.get("/actors/:kind/:id", (req, res, next) => {
    if (
      !/application\/(activity\+json|ld\+json)/i.test(req.headers.accept || "")
    )
      return next();
    if (!["users", "channels"].includes(String(req.params.kind)))
      throw new Problem(404, "Actor not found.");
    res
      .setHeader("Cache-Control", "no-store")
      .type("application/activity+json")
      .json(
        federation.publicActor(
          req.params.kind as "users" | "channels",
          String(req.params.id),
        ),
      );
  });
  app.get("/federation/emojis", (_req, res) => {
    federation.ensureEnabled();
    res.json({
      emojis: store
        .emojis()
        .map((e) => ({
          name: e.name,
          url: `${config.baseUrl}/federation/emojis/${e.id}/image`,
        })),
    });
  });
  app.get("/federation/emojis/:id/image", (req, res) => {
    federation.ensureEnabled();
    // Only emoji owned here are exported; received cache entries stay local.
    const image = store.db
      .prepare(
        "SELECT mime,image FROM custom_emojis WHERE id=? UNION ALL SELECT mime,image FROM personal_emojis WHERE id=?",
      )
      .get(String(req.params.id), String(req.params.id)) as
      | { mime: string; image: Uint8Array }
      | undefined;
    if (!image) throw new Problem(404, "Emoji not found.");
    res.type(image.mime).send(Buffer.from(image.image));
  });
  app.get("/federation/avatars/:id", (req, res) => {
    const actor = federation.publicActor("users", String(req.params.id));
    store.active(String(req.params.id));
    if (!actor.icon) throw new Problem(404, "Profile picture is not federated.");
    const picture = store.avatarImage(String(req.params.id));
    res.type(picture.mime).send(Buffer.from(picture.image));
  });
  app.use(express.json({ limit: "64kb" }));
  // Private bearer-authenticated adapter, before browser Origin/session checks.
  app.use("/internal/xmpp", xmpp.internalRouter());
  app.use(
    ["/api", "/actors", "/objects"],
    rateLimit({
      windowMs: 60000,
      limit: config.rateLimitApi,
      keyGenerator: (req) => {
        try {
          const session = store.session(cookie(req, authCookie));
          if (session) return `user:${session.user.id}`;
        } catch {
          /* Authentication middleware reports revoked accounts. */
        }
        return ipKeyGenerator(req.ip || "unknown");
      },
      standardHeaders: "draft-8",
      legacyHeaders: false,
      message: { error: "Too many requests. Please try again shortly." },
    }),
  );
  app.use(["/api", "/auth", "/actors", "/objects"], (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  app.use(
    "/auth",
    rateLimit({
      windowMs: 60000,
      limit: config.rateLimitAuth,
      message: {
        error: "Too many sign-in attempts. Please try again shortly.",
      },
    }),
  );
  app.use((req, res, next) => {
    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      req.headers.origin !== config.baseUrl
    )
      return next(
        new Problem(403, "This request must come from this instance."),
      );
    next();
  });
  app.get("/health", (_req, res) => res.json({ status: "ok" }));
  // Attachments are fetched by address alone: the unguessable name in a message is the permission,
  // so the same link works for readers on other servers. Nothing served here can run as a page.
  app.get(
    "/media/:file",
    rateLimit({
      windowMs: 60000,
      limit: config.rateLimitMedia,
      message: { error: "Too many requests. Please try again shortly." },
    }),
    (req, res) => {
      const file = store.attachment(String(req.params.file));
      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
      res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
      res.setHeader(
        "Content-Disposition",
        `inline; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      );
      res.type(file.mime);
      let start = 0,
        end = file.size - 1;
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
        res.status(206);
        res.setHeader("Content-Range", `bytes ${start}-${end}/${file.size}`);
      }
      res.setHeader("Content-Length", end - start + 1);
      if (req.method === "HEAD") {
        res.end();
        return;
      }
      res.end(store.attachmentBytes(file.id, start, end - start + 1));
    },
  );
  app.get("/api/session", (req, res) => {
    const session = store.session(cookie(req, authCookie));
    res.json({
      user: session ? store.profile(session.user, true) : null,
      csrf: session?.csrf || null,
      dev_auth: config.devAuth,
      oidc_enabled: !!config.oidcIssuer,
      instance: new URL(config.baseUrl).host,
      registration_mode: store.registrationMode(),
      federation_enabled: federation.enabled(),
    });
  });
  app.post(
    "/api/dev-login",
    rateLimit({
      windowMs: 60000,
      limit: config.rateLimitAuth,
      message: {
        error: "Too many sign-in attempts. Please try again shortly.",
      },
    }),
    (req, res) => {
      if (!config.devAuth) throw new Problem(404, "Not found.");
      const username = req.body?.username;
      if (!["alice", "bob", "charlie"].includes(username))
        throw new Problem(400, "Choose a development persona.");
      const user = store.loginIdentity(
        "urn:archipel:development",
        username,
        username,
        [],
        username === "alice",
      );
      store.logout(cookie(req, authCookie));
      const session = store.createSession(user.id);
      res.cookie(authCookie, session.token, {
        ...cookieOptions,
        maxAge: 7 * 86400000,
      });
      res.json({ user: store.profile(user, true), csrf: session.csrf });
    },
  );
  app.get("/auth/login", async (_req, res) => {
    try {
      const flow = await oidc.begin();
      res.cookie("archipel-flow", flow.browser, {
        ...cookieOptions,
        maxAge: 10 * 60000,
      });
      res.redirect(flow.url);
    } catch (error) {
      res.locals.authFailureLogged = true;
      res.setHeader(
        "X-Request-ID",
        logSignInFailure(error, config, { stage: "authorization_start" }),
      );
      throw error instanceof OidcFailure && error.cause instanceof Problem
        ? error.cause
        : error;
    }
  });
  app.get("/auth/callback", async (req, res) => {
    let stage: OidcStage = "callback_validation";
    try {
      const user = await oidc.complete(
        req.originalUrl.split("?")[1] || "",
        cookie(req, "archipel-flow"),
      );
      stage = "session_creation";
      store.logout(cookie(req, authCookie));
      const session = store.createSession(user.id);
      res.cookie(authCookie, session.token, {
        ...cookieOptions,
        maxAge: 7 * 86400000,
      });
      res.clearCookie("archipel-flow", cookieOptions);
      res.redirect("/");
    } catch (error) {
      res.setHeader(
        "X-Request-ID",
        logSignInFailure(error, config, {
          stage,
          flow_cookie_present: !!cookie(req, "archipel-flow"),
          state_present:
            typeof req.query.state === "string" && !!req.query.state,
          code_present: typeof req.query.code === "string" && !!req.query.code,
          request_host_matches_base:
            req.headers.host === new URL(config.baseUrl).host,
        }),
      );
      res.clearCookie("archipel-flow", cookieOptions);
      res.redirect("/?signin=failed");
    }
  });
  app.use(["/api", "/actors", "/objects"], (req, res, next) => {
    const session = store.session(cookie(req, authCookie));
    if (!session) return next(new Problem(401, "Sign in to continue."));
    res.locals.user = session.user;
    if (
      !["GET", "HEAD"].includes(req.method) &&
      req.headers["x-csrf-token"] !== session.csrf
    )
      return next(
        new Problem(403, "Your session changed. Refresh and try again."),
      );
    next();
  });
  // What changed is pushed to open browsers. An account still waiting for approval listens
  // too: being let in is news to it.
  app.get("/api/events", (req, res) => {
    events.open(req, res, cookie(req, authCookie));
  });
  const user = (res: Response) => res.locals.user as User;
  // Unapproved identities can inspect their session and sign out, but cannot
  // access members, messages, actor/object endpoints, or management APIs.
  app.use(["/api", "/actors", "/objects"], (req, res, next) => {
    if (
      req.path === "/logout" &&
      req.baseUrl === "/api" &&
      req.method === "POST"
    )
      return next();
    store.active(user(res).id);
    next();
  });
  app.get("/api/emojis", (_req, res) =>
    res.json(store.labelledEmojis(user(res))),
  );
  // The file itself is the request body; its name travels beside it.
  app.post(
    "/api/attachments",
    (req, res, next) => {
      store.requirePermission(user(res), "attachments");
      next();
    },
    express.raw({ type: () => true, limit: "51mb" }),
    (req, res) => {
      let name = "";
      try {
        name = decodeURIComponent(String(req.headers["x-filename"] || ""));
      } catch {
        /* An unreadable name is replaced with a plain one. */
      }
      res.status(201).json(store.addAttachment(user(res), req.body, name));
    },
  );
  app.get("/api/xmpp", (_req, res) => res.json(xmpp.status(user(res))));
  app.get("/api/xmpp/rooms", (_req, res) => res.json(xmpp.remoteRooms.list(user(res))));
  app.post("/api/xmpp/rooms", (req, res) => res.status(201).json(xmpp.remoteRooms.join(user(res), req.body || {})));
  app.delete("/api/xmpp/rooms/:id", (req, res) => res.json(xmpp.remoteRooms.leave(user(res), String(req.params.id))));
  app.get("/api/xmpp/rooms/:id/messages", (req, res) => res.json(xmpp.remoteRooms.history(user(res), String(req.params.id), req.query.before)));
  app.post("/api/xmpp/rooms/:id/messages", (req, res) => res.status(201).json(xmpp.remoteRooms.post(user(res), String(req.params.id), req.body?.body)));
  app.post("/api/xmpp/credentials", (req, res) =>
    res.status(201).json(xmpp.issue(user(res), req.body?.label)),
  );
  app.delete("/api/xmpp/credentials/:id", (req, res) => {
    xmpp.revoke(user(res), String(req.params.id));
    res.json({ ok: true });
  });
  app.get("/api/emojis/:id/image", (req, res) => {
    const emoji = store.emojiImage(String(req.params.id));
    res.type(emoji.mime).send(Buffer.from(emoji.image));
  });
  app.get("/api/personal-emojis", (_req, res) =>
    res.json(store.personalEmojis(user(res))),
  );
  app.post("/api/personal-emojis", (req, res) =>
    res
      .status(201)
      .json(
        store.adoptEmoji(
          user(res),
          req.body?.name,
          req.body?.image,
          "local-upload",
        ),
      ),
  );
  app.patch("/api/personal-emojis/:id", (req, res) =>
    res.json(
      store.renamePersonalEmoji(
        user(res),
        String(req.params.id),
        req.body?.name,
      ),
    ),
  );
  app.delete("/api/personal-emojis/:id", (req, res) => {
    store.removePersonalEmoji(user(res), String(req.params.id));
    res.json({ ok: true });
  });
  app.get("/api/emoji-sources", async (req, res) =>
    res.json(await federation.emojiSource(req.query.instance)),
  );
  app.post("/api/personal-emojis/adopt", async (req, res) =>
    res
      .status(201)
      .json(await federation.adoptEmoji(user(res), req.body || {})),
  );
  app.get("/api/admin/federation", (_req, res) => {
    store.requireAdmin(user(res));
    res.json(federation.status());
  });
  app.patch("/api/admin/federation", (req, res) =>
    res.json(federation.setEnabled(user(res), req.body?.enabled)),
  );
  app.get("/api/admin/roles", (_req, res) => res.json(store.roles(user(res))));
  app.post("/api/admin/roles", (req, res) =>
    res.status(201).json(store.createRole(user(res), req.body || {})),
  );
  app.patch("/api/admin/roles/:id", (req, res) =>
    res.json(store.updateRole(user(res), String(req.params.id), req.body || {})),
  );
  app.delete("/api/admin/roles/:id", (req, res) => {
    store.deleteRole(user(res), String(req.params.id));
    res.json({ ok: true });
  });
  app.patch("/api/admin/users/:id/role", (req, res) =>
    res.json(
      store.setUserRole(user(res), String(req.params.id), req.body?.role_id),
    ),
  );
  app.patch("/api/admin/federation/sending", (req, res) =>
    res.json(federation.setSending(user(res), req.body || {})),
  );
  app.post("/api/admin/federation/blocks", (req, res) =>
    res.json(federation.block(user(res), req.body || {})),
  );
  app.get("/api/federation/subscriptions", (_req, res) =>
    res.json(federation.subscriptions(user(res))),
  );
  app.post("/api/federation/subscriptions", async (req, res) =>
    res
      .status(202)
      .json(await federation.subscribe(user(res), req.body?.address)),
  );
  app.delete("/api/federation/subscriptions/:id", (req, res) => {
    federation.unsubscribe(user(res), String(req.params.id));
    res.json({ ok: true });
  });
  app.get("/api/federation/messages", (_req, res) =>
    res.json(federation.directMessages(user(res))),
  );
  app.post("/api/federation/messages", async (req, res) =>
    res
      .status(202)
      .json(
        await federation.sendDirect(
          user(res),
          req.body?.address,
          req.body?.body,
        ),
      ),
  );
  // Direct messages: members here are written to directly, anyone else through federation.
  app.get("/api/dms/messages", (req, res) => {
    const before =
      req.query.before === undefined ? undefined : Number(req.query.before);
    if (before !== undefined && (!Number.isSafeInteger(before) || before < 1))
      throw new Problem(400, "Invalid message cursor.");
    const history = store.directHistory(user(res), req.query.peer, before);
    if (history.conversation.peer.startsWith("xmpp:")) xmpp.requestAvatar(user(res), history.conversation.peer);
    res.json(history);
  });
  app.get("/api/contact-names", (req, res) =>
    res.json(store.peerInfo(text(req.query.peer, "User", 2048), user(res))),
  );
  app.post("/api/contact-names", (req, res) =>
    res.json(store.setContactName(user(res), req.body?.peer, req.body?.display_name)),
  );
  app.post("/api/dms/resolve", async (req, res) => {
    if (typeof req.body?.to === "string" && req.body.to.startsWith("xmpp:")) {
      xmpp.enabled();
      const target = xmpp.remoteJid(req.body.to);
      if (!target.endsWith(`@${config.xmppDomain}`)) xmpp.requestAvatar(user(res), `xmpp:${target}`);
      res.json(target.endsWith(`@${config.xmppDomain}`)
        ? store.peerInfo(`${config.baseUrl}/actors/users/${xmpp.local(target).id}`, user(res))
        : store.peerInfo(`xmpp:${target}`, user(res)));
      return;
    }
    const local = store.localRecipient(req.body?.to);
    res.json(
      local
        ? store.peerInfo(`${config.baseUrl}/actors/users/${local}`, user(res))
        : store.peerInfo((await federation.resolveDirect(user(res), req.body?.to)).peer, user(res)),
    );
  });
  app.post("/api/dms", async (req, res) => {
    if (typeof req.body?.to === "string" && req.body.to.startsWith("xmpp:")) {
      xmpp.enabled();
      res.status(201).json(xmpp.sendDirect(user(res), req.body.to, req.body?.body));
      return;
    }
    const local = store.localRecipient(req.body?.to);
    if (local) {
      res.status(201).json(store.sendDirect(user(res), local, req.body?.body));
      return;
    }
    const sent = await federation.sendDirect(
      user(res),
      req.body?.to,
      req.body?.body,
    );
    res.status(202).json({ peer: sent.peer, queued: true });
  });
  // Conversations the reader closed: out of their sidebar until reopened or written in again.
  app.get("/api/dms/closed", (_req, res) =>
    res.json(store.closedConversations(user(res))),
  );
  app.post("/api/dms/close", (req, res) =>
    res.json(store.setDirectClosed(user(res), req.body?.peer, req.body?.closed)),
  );
  app.get("/api/overview", (_req, res) => res.json({ ...store.overview(user(res)), xmpp_enabled: !!config.xmppDomain, xmpp_rooms: xmpp.remoteRooms.list(user(res)) }));
  app.post("/api/user-blocks", (req, res) =>
    res.json(store.setUserBlock(user(res), req.body?.peer, req.body?.blocked)),
  );
  app.get("/api/inbox", (_req, res) => res.json(store.inbox(user(res))));
  app.post("/api/read", (req, res) => {
    store.markRead(user(res), req.body || {});
    res.json({ ok: true });
  });
  app.put("/api/sidebar", (req, res) =>
    res.json(store.setLayout(user(res), req.body || {})),
  );
  // What the reader hid or silenced, and the browsers they asked to be notified in.
  app.get("/api/prefs", (_req, res) => res.json(store.prefList(user(res))));
  app.put("/api/prefs", (req, res) =>
    res.json(store.setPref(user(res), req.body || {})),
  );
  app.get("/api/push", (req, res) =>
    res.json(push.status(cookie(req, authCookie))),
  );
  app.put("/api/push", (req, res) =>
    res.json(push.subscribe(user(res), cookie(req, authCookie), req.body || {})),
  );
  app.delete("/api/push", (req, res) =>
    res.json(push.unsubscribe(cookie(req, authCookie))),
  );
  app.post("/api/push/test", async (req, res) => {
    await push.test(cookie(req, authCookie));
    res.json({ ok: true });
  });
  app.patch("/api/channels/:id/federation", (req, res) =>
    res.json(
      federation.setChannel(
        user(res),
        String(req.params.id),
        req.body?.enabled,
      ),
    ),
  );
  app.get("/api/channels/:id/followers", (req, res) =>
    res.json(federation.followers(user(res), String(req.params.id))),
  );
  app.patch("/api/channels/:id/followers", (req, res) => {
    federation.decideFollow(
      user(res),
      String(req.params.id),
      req.body?.actor,
      req.body?.status,
    );
    res.json({ ok: true });
  });
  app.get("/api/admin/emojis", (_req, res) => {
    store.requireAdmin(user(res));
    res.json(store.emojis());
  });
  app.post("/api/admin/emojis", (req, res) =>
    res.status(201).json(store.addEmoji(user(res), req.body || {})),
  );
  app.patch("/api/admin/emojis/:name", (req, res) =>
    res.json(
      store.renameEmoji(user(res), String(req.params.name), req.body?.name),
    ),
  );
  app.post("/api/emojis/:id/adopt", (req, res) =>
    res
      .status(201)
      .json(store.adoptCachedEmoji(user(res), String(req.params.id), req.body || {})),
  );
  app.delete("/api/admin/emojis/:name", (req, res) => {
    store.removeEmoji(user(res), String(req.params.name));
    res.json({ ok: true });
  });
  app.get("/api/admin/settings", (_req, res) => {
    store.requireAdmin(user(res));
    res.json({ registration_mode: store.registrationMode() });
  });
  app.patch("/api/admin/settings", (req, res) =>
    res.json(store.setRegistration(user(res), req.body?.registration_mode)),
  );
  app.get("/api/admin/applications", (_req, res) =>
    res.json(store.applications(user(res))),
  );
  app.patch("/api/admin/applications/:id", (req, res) =>
    res.json(
      store.reviewApplication(
        user(res),
        String(req.params.id),
        req.body?.admission_status,
      ),
    ),
  );
  app.patch("/api/messages/:id", async (req, res) =>
    res.json(
      await (store.channel(store.message(String(req.params.id)).channel_id)
        .remote_actor
        ? federation.editRemote(
            user(res),
            String(req.params.id),
            req.body || {},
          )
        : store.editMessage(user(res), String(req.params.id), req.body || {})),
    ),
  );
  app.get("/actors/users/:id", (req, res) =>
    res.json(store.profile(store.user(String(req.params.id)))),
  );
  app.get("/actors/channels/:id", (req, res) =>
    res.json(store.details(user(res), String(req.params.id))),
  );
  app.get("/objects/messages/:id", (req, res) => {
    const message = store.message(String(req.params.id));
    store.requireRead(user(res), store.channel(message.channel_id));
    if (message.remote_object && !store.user(user(res).id).federation_receive)
      throw new Problem(
        403,
        "Receiving federated messages is disabled for this account.",
      );
    res.json(store.veiled(user(res), store.messageFor(user(res), message)));
  });
  app.post("/api/logout", (req, res) => {
    store.logout(cookie(req, authCookie));
    res.clearCookie(authCookie, cookieOptions);
    res.json({ ok: true });
  });
  app.get("/api/channels", (_req, res) =>
    res.json(store.listChannels(user(res))),
  );
  app.post("/api/channels", (req, res) =>
    res.status(201).json(store.createChannel(user(res), req.body || {})),
  );
  app.get("/api/channels/:id", (req, res) => {
    const detail = store.details(user(res), String(req.params.id));
    // A followed channel's member list is its home's to tell; it is asked again in the background.
    void federation.refreshRoster(user(res), detail.id).catch(() => {});
    res.json(detail);
  });
  app.patch("/api/channels/:id", (req, res) =>
    res.json(
      store.renameChannel(user(res), String(req.params.id), req.body?.name),
    ),
  );
  app.patch("/api/channels/:id/privacy", (req, res) =>
    res.json(
      store.setPrivacy(user(res), String(req.params.id), req.body || {}),
    ),
  );
  app.patch("/api/channels/:id/reactions", (req, res) =>
    res.json(
      store.setReactions(user(res), String(req.params.id), req.body?.enabled),
    ),
  );
  app.patch("/api/channels/:id/titles", (req, res) =>
    res.json(
      store.setOptionalTitles(user(res), String(req.params.id), req.body?.optional),
    ),
  );
  app.put("/api/messages/:id/reactions", (req, res) =>
    res.json(
      store.channel(store.message(String(req.params.id)).channel_id).remote_actor
        ? federation.remoteReact(user(res), String(req.params.id), req.body || {})
        : store.react(user(res), String(req.params.id), req.body || {}),
    ),
  );
  app.delete("/api/channels/:id", (req, res) => {
    store.deleteChannel(user(res), String(req.params.id));
    res.json({ ok: true });
  });
  app.post("/api/mirrors", (req, res) =>
    res.status(201).json(mirrors.create(user(res), req.body || {})),
  );
  app.get("/api/channels/:id/mirror", (req, res) =>
    res.json(mirrors.sources(user(res), String(req.params.id))),
  );
  app.patch("/api/channels/:id/mirror", (req, res) =>
    res.json(
      mirrors.setWritable(user(res), String(req.params.id), req.body?.writable),
    ),
  );
  app.post("/api/channels/:id/mirror/sources", (req, res) =>
    res
      .status(201)
      .json(mirrors.addSource(user(res), String(req.params.id), req.body || {})),
  );
  app.patch("/api/channels/:id/mirror/sources/:source", (req, res) =>
    res.json(
      mirrors.setSource(
        user(res),
        String(req.params.id),
        String(req.params.source),
        req.body || {},
      ),
    ),
  );
  app.delete("/api/channels/:id/mirror/sources/:source", (req, res) =>
    res.json(
      mirrors.removeSource(
        user(res),
        String(req.params.id),
        String(req.params.source),
      ),
    ),
  );
  app.get("/api/channels/:id/bridge", (req, res) =>
    res.json(xmpp.remoteRooms.bridge(user(res), String(req.params.id))),
  );
  app.put("/api/channels/:id/bridge", (req, res) =>
    res.json(
      xmpp.remoteRooms.setBridge(user(res), String(req.params.id), req.body?.room),
    ),
  );
  app.delete("/api/channels/:id/bridge", (req, res) =>
    res.json(xmpp.remoteRooms.removeBridge(user(res), String(req.params.id))),
  );
  app.post("/api/channels/:id/join", (req, res) => {
    store.join(user(res), String(req.params.id));
    res.json({ ok: true });
  });
  app.post("/api/channels/:id/leave", (req, res) => {
    if (store.channel(String(req.params.id)).remote_actor)
      federation.unsubscribe(user(res), String(req.params.id));
    else store.leave(user(res), String(req.params.id));
    res.json({ ok: true });
  });
  app.get("/api/channels/:id/rules", (req, res) =>
    res.json(store.rules(user(res), String(req.params.id))),
  );
  app.patch("/api/channels/:id/members/:user", (req, res) => {
    store.setMember(
      user(res),
      String(req.params.id),
      String(req.params.user),
      req.body || {},
    );
    res.json({ ok: true });
  });
  app.post("/api/channels/:id/topics", (req, res) =>
    res
      .status(201)
      .json(
        store.createTopic(user(res), String(req.params.id), req.body?.title),
      ),
  );
  app.get("/api/channels/:id/messages", (req, res) => {
    const before =
      req.query.before === undefined ? undefined : Number(req.query.before);
    if (before !== undefined && (!Number.isSafeInteger(before) || before < 1))
      throw new Problem(400, "Invalid message cursor.");
    const messages = store.messages(user(res), String(req.params.id), before);
    res.json({
      messages,
      older_cursor: messages.length === 100 ? messages[0].seq : null,
      pending:
        before === undefined
          ? federation.pendingPosts(user(res), String(req.params.id))
          : [],
    });
  });
  app.post("/api/channels/:id/messages", async (req, res) =>
    res
      .status(201)
      .json(
        await (store.channel(String(req.params.id)).remote_actor
          ? federation.remotePost(
              user(res),
              String(req.params.id),
              req.body || {},
            )
          : store.post(user(res), String(req.params.id), req.body || {})),
      ),
  );
  app.delete("/api/messages/:id", (req, res) => {
    if (
      store.channel(store.message(String(req.params.id)).channel_id)
        .remote_actor
    )
      federation.deleteRemote(user(res), String(req.params.id));
    else store.deleteMessage(user(res), String(req.params.id));
    res.json({ ok: true });
  });
  app.get("/api/users", (_req, res) => res.json(store.directory(user(res))));
  app.patch("/api/profile", (req, res) =>
    res.json(store.updateProfile(user(res), req.body || {})),
  );
  app.post("/api/profile/avatar", (req, res) =>
    res.json(store.setAvatar(user(res), req.body?.image)),
  );
  app.delete("/api/profile/avatar", (_req, res) =>
    res.json(store.removeAvatar(user(res))),
  );
  app.get("/api/avatars/:id", (req, res) => {
    const picture = store.avatarImage(String(req.params.id));
    res.setHeader("Cache-Control", "private, no-store");
    res.type(picture.mime).send(Buffer.from(picture.image));
  });
  app.get("/api/remote-avatars/:id", (_req, res) => {
    const picture = store.remoteAvatarImage(String(_req.params.id));
    const viewer = user(res);
    if (picture.peer.startsWith("xmpp:")) {
      const access = xmpp.remoteAccess(viewer, picture.peer);
      if (access.blocked || (!access.incoming && !access.outgoing)) throw new Problem(403, "Remote profile access is disabled.");
    } else {
      federation.require(viewer, "federation_receive");
      federation.allowed(picture.peer);
      if (store.isUserBlocked(viewer.id, picture.peer)) throw new Problem(403, "This user is blocked.");
    }
    res.setHeader("Cache-Control", "private, no-store");
    res.type(picture.mime).send(Buffer.from(picture.image));
  });
  app.patch("/api/admin/users/:id", (req, res) => {
    store.ban(user(res), String(req.params.id), req.body?.banned);
    res.json({ ok: true });
  });
  app.get("/api/admin/audit", (_req, res) => {
    if (!user(res).admin)
      throw new Problem(403, "Instance administrator access is required.");
    res.json(
      store.db
        .prepare(
          "SELECT a.*,u.username FROM audit a JOIN users u ON u.id=a.actor_id ORDER BY a.seq DESC LIMIT 100",
        )
        .all(),
    );
  });
  app.use("/api", (_req, _res, next) => next(new Problem(404, "Not found.")));
  const clientPath = fileURLToPath(new URL("../dist/client/", import.meta.url));
  app.use(express.static(clientPath, { index: false, maxAge: 0 }));
  app.get("/", (_req, res) => {
    if (!existsSync(`${clientPath}/index.html`))
      return res
        .status(503)
        .type("text")
        .send("Run npm run build:client to build the browser application.");
    res.sendFile(`${clientPath}/index.html`);
  });
  app.use((_req, _res, next) => next(new Problem(404, "Not found.")));
  app.use(
    (
      error: Error & { type?: string },
      _req: Request,
      res: Response,
      _next: NextFunction,
    ) => {
      const status =
        error instanceof Problem
          ? error.status
          : error.type === "entity.parse.failed"
            ? 400
            : error.type === "entity.too.large"
              ? 413
              : 500;
      if (status === 500 && !res.locals.authFailureLogged)
        console.error("Request failed:", error.name);
      res.status(status).json({
        error:
          error instanceof Problem
            ? error.message
            : status === 400
              ? "Invalid JSON."
              : status === 413
                ? "Request is too large."
                : "The request could not be completed.",
      });
    },
  );
  return app;
}
