import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { generateKeyPairSync, sign, createHash, randomUUID, createECDH, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import express, { type Request } from "express";
import { Store } from "../src/store.js";
import { loadConfig, type Config } from "../src/config.js";
import { createApp } from "../src/app.js";
import type { Push } from "../src/push.js";

test("remote avatar endpoints require membership and current federation and block permissions", async t => {
  const f = await application(t, { xmppDomain: "chat.example", xmppBridgeSecret: "s".repeat(43) });
  const alice = browser(f.origin), bob = browser(f.origin);
  await alice.login("alice"); const member = await bob.login("bob");
  f.store.db.prepare("INSERT OR REPLACE INTO instance_settings VALUES('federation_enabled','true')").run();
  f.store.db.prepare("UPDATE users SET federation_receive=1,federation_send=1 WHERE id=?").run(member.id);
  const image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC1lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=";
  const peers = ["xmpp:other@remote.example", "https://remote.example/actors/users/other"];
  for (const peer of peers) {
    f.store.cacheRemoteAvatar(peer, image, peer);
    const path = f.store.peerInfo(peer).avatar_url!;
    assert.equal((await fetch(f.origin + path)).status, 401);
    const picture = await bob.request(path);
    assert.equal(picture.status, 200);
    assert.equal(picture.headers.get("content-type"), "image/png");
    assert.deepEqual(Buffer.from(await picture.arrayBuffer()), Buffer.from(image, "base64"));
    f.store.setUserBlock(f.store.user(member.id), peer, true);
    assert.equal((await bob.request(path)).status, 403);
    f.store.setUserBlock(f.store.user(member.id), peer, false);
    f.store.db.prepare("INSERT INTO federation_blocks VALUES(?,'instance')").run("https://remote.example");
    assert.equal((await bob.request(path)).status, 403);
    f.store.db.prepare("DELETE FROM federation_blocks").run();
    f.store.db.prepare("UPDATE instance_settings SET value='false' WHERE key='federation_enabled'").run();
    assert.equal((await bob.request(path)).status, 403);
    f.store.db.prepare("UPDATE instance_settings SET value='true' WHERE key='federation_enabled'").run();
    f.store.cacheRemoteAvatar(peer, null, "");
    assert.equal((await bob.request(path)).status, 404);
  }
});

async function listen(t: TestContext) {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return {
    server,
    origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
  };
}
async function application(t: TestContext, override: Partial<Config> = {}) {
  const { server, origin } = await listen(t);
  const config = {
    ...loadConfig({ DEV_AUTH: "true" }),
    ...override,
    baseUrl: origin,
  };
  const store = new Store(":memory:", origin);
  t.after(() => store.close());
  const app = createApp(config, store);
  const observed: { ip: string | undefined; protocol: string }[] = [];
  server.on("request", (req, res) => {
    res.on("finish", () =>
      observed.push({
        ip: (req as Request).ip,
        protocol: (req as Request).protocol,
      }),
    );
    app(req, res);
  });
  return { store, origin, config, observed, app };
}
function browser(origin: string) {
  const cookies = new Map<string, string>();
  let csrf = "";
  return {
    cookies,
    async request(
      path: string,
      method = "GET",
      body?: unknown,
      headers: Record<string, string> = {},
    ) {
      const response = await fetch(origin + path, {
        method,
        redirect: "manual",
        headers: {
          Origin: origin,
          Cookie: [...cookies]
            .map(([key, value]) => `${key}=${value}`)
            .join("; "),
          ...(csrf ? { "X-CSRF-Token": csrf } : {}),
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...headers,
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      for (const raw of response.headers.getSetCookie()) {
        const pair = raw.split(";")[0],
          index = pair.indexOf("=");
        cookies.set(pair.slice(0, index), pair.slice(index + 1));
      }
      return response;
    },
    async login(username: string) {
      const response = await this.request("/api/dev-login", "POST", {
        username,
      });
      assert.equal(response.status, 200);
      const data = await response.json();
      csrf = data.csrf;
      return data.user;
    },
    async session() {
      const data = await (await this.request("/api/session")).json();
      csrf = data.csrf || "";
      return data;
    },
  };
}

test("external room HTTP APIs require session, CSRF, ownership and private adapter authentication", async t => {
  const f = await application(t, { xmppDomain: "chat.example", xmppBridgeSecret: "s".repeat(43) });
  const alice = browser(f.origin), bob = browser(f.origin), anonymous = browser(f.origin);
  const user = await alice.login("alice"); await bob.login("bob");
  f.store.db.prepare("INSERT OR REPLACE INTO instance_settings VALUES('federation_enabled','true')").run();
  f.store.db.prepare("UPDATE users SET federation_subscribe=1,federation_receive=1,federation_send=1,federation_post=1 WHERE id=?").run(user.id);
  const data = { room: "test@muc.remote.example", nick: "alice" };
  assert.equal((await anonymous.request("/api/xmpp/rooms", "POST", data)).status, 401);
  assert.equal((await alice.request("/api/xmpp/rooms", "POST", data, { "X-CSRF-Token": "bad" })).status, 403);
  const joined = await alice.request("/api/xmpp/rooms", "POST", data);
  assert.equal(joined.status, 201);
  const room = await joined.json(), path = `/api/xmpp/rooms/${room.id}`;
  assert.equal((await bob.request(`${path}/messages`)).status, 404);
  assert.equal((await bob.request(path, "DELETE")).status, 404);
  assert.equal((await alice.request(`${path}/messages`, "POST", { body: "Too early" })).status, 403);
  assert.equal((await fetch(`${f.origin}/internal/xmpp/remote-rooms/sync`, { method: "POST" })).status, 401);
  const adapter = async (path: string, data: unknown) => fetch(`${f.origin}/internal/xmpp/remote-rooms/${path}`, {
    method: "POST", headers: { Authorization: `Bearer ${"s".repeat(43)}`, "Content-Type": "application/json" }, body: JSON.stringify(data),
  });
  const sync = await (await adapter("sync", {})).json();
  const session = sync.desired[0].session;
  assert.equal((await adapter("receive", { session, from: `${data.room}/alice`, kind: "state", state: "joined", role: "participant" })).status, 200);
  assert.equal((await alice.request(`${path}/messages`, "POST", { body: "Valid" }, { "X-CSRF-Token": "bad" })).status, 403);
  assert.equal((await alice.request(`${path}/messages`, "POST", { body: "Valid" })).status, 201);
  assert.equal((await alice.request(path, "DELETE")).status, 200);
  assert.equal((await adapter("receive", { session, from: `${data.room}/host`, kind: "message", body: "Too late" })).status, 404);
});

test("remote contact names require a member session and CSRF and remain private to their owner", async t => {
  const {origin} = await application(t);
  const alice = browser(origin), bob = browser(origin), anonymous = browser(origin);
  const a = await alice.login("alice"); await bob.login("bob");
  const peer = "xmpp:other@remote.test", input = {peer,display_name:"My remote friend"};
  assert.equal((await anonymous.request("/api/contact-names", "POST", input)).status, 401);
  assert.equal((await bob.request("/api/contact-names", "POST", input, {"X-CSRF-Token":"bad"})).status, 403);
  assert.equal((await bob.request("/api/contact-names", "POST", input)).status, 200);
  const path = `/api/contact-names?peer=${encodeURIComponent(peer)}`;
  assert.equal((await (await bob.request(path)).json()).display_name, "My remote friend");
  assert.equal((await (await alice.request(path)).json()).display_name, "other@remote.test");
  assert.equal((await bob.request("/api/contact-names", "POST", {peer:a.actor_url,display_name:"Changed"})).status, 400);
  assert.equal((await bob.request("/api/contact-names", "POST", {...input,display_name:"x".repeat(81)})).status, 400);
  assert.equal((await bob.request("/api/contact-names", "POST", {...input,display_name:null})).status, 200);
  assert.equal((await (await bob.request(path)).json()).display_name, "other@remote.test");
});

test("members can block from their own account with CSRF and unblock to restore direct messages", async (t) => {
  const { origin } = await application(t);
  const alice = browser(origin), bob = browser(origin), anonymous = browser(origin);
  const a = await alice.login("alice"), b = await bob.login("bob");
  const input = { peer: a.actor_url, blocked: true };
  assert.equal((await anonymous.request("/api/user-blocks", "POST", input)).status, 401);
  assert.equal((await bob.request("/api/user-blocks", "POST", input, { "X-CSRF-Token": "invalid" })).status, 403);
  assert.equal((await bob.request("/api/user-blocks", "POST", input)).status, 200);
  assert.deepEqual((await (await bob.request("/api/overview")).json()).user_blocks, [a.actor_url]);
  assert.deepEqual((await (await alice.request("/api/overview")).json()).user_blocks, []);
  assert.equal((await alice.request("/api/dms", "POST", { to: b.actor_url, body: "Blocked" })).status, 403);
  assert.equal((await bob.request("/api/dms", "POST", { to: a.actor_url, body: "Blocked" })).status, 403);
  assert.equal((await bob.request("/api/user-blocks", "POST", { peer: b.actor_url, blocked: true })).status, 400);
  assert.equal((await bob.request("/api/user-blocks", "POST", { ...input, blocked: false })).status, 200);
  assert.equal((await alice.request("/api/dms", "POST", { to: b.actor_url, body: "Allowed" })).status, 201);
});

test("profile picture uploads require CSRF, remain scoped to the account and serve raster bytes to members", async (t) => {
  const { origin } = await application(t);
  const alice = browser(origin), bob = browser(origin), anonymous = browser(origin);
  const a = await alice.login("alice"), b = await bob.login("bob");
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=";
  // Larger than the ordinary JSON body and emoji limits.
  const bytes = Buffer.concat([Buffer.from(png, "base64"), Buffer.alloc(300000)]);
  const input = { image: bytes.toString("base64"), user_id: b.id };
  assert.equal((await anonymous.request("/api/profile/avatar", "POST", input)).status, 401);
  assert.equal((await alice.request("/api/profile/avatar", "POST", input, { "X-CSRF-Token": "invalid" })).status, 403);
  const uploaded = await alice.request("/api/profile/avatar", "POST", input);
  assert.equal(uploaded.status, 200);
  const profile = await uploaded.json();
  assert.ok(profile.avatar_url.includes(a.id));
  assert.equal((await bob.session()).user.avatar_url, null);
  const response = await bob.request(profile.avatar_url);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/png");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.ok(response.headers.get("cache-control")?.includes("no-store"));
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  assert.equal((await anonymous.request(profile.avatar_url)).status, 401);
  assert.equal((await alice.request("/api/profile/avatar", "POST", { image: Buffer.from('<svg/>').toString("base64") })).status, 400);
  assert.equal((await alice.request("/api/profile/avatar", "POST", { image: Buffer.alloc(2097153).toString("base64") })).status, 400);
  assert.equal((await alice.session()).user.avatar_url, profile.avatar_url);
  await bob.request("/api/profile/avatar", "DELETE");
  assert.equal((await alice.session()).user.avatar_url, profile.avatar_url);
  assert.equal((await alice.request("/api/profile/avatar", "DELETE", undefined, { "X-CSRF-Token": "invalid" })).status, 403);
  assert.equal((await alice.request("/api/profile/avatar", "DELETE")).status, 200);
  assert.equal((await alice.session()).user.avatar_url, null);
  assert.equal((await bob.request(profile.avatar_url)).status, 404);
});

test("personal emoji uploads require membership and CSRF and only their owner may rename or remove them", async (t) => {
  const { origin } = await application(t);
  const bob = browser(origin),
    alice = browser(origin),
    anonymous = browser(origin);
  const image =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=";
  const upload = { name: "my_wave", image };
  assert.equal(
    (await anonymous.request("/api/personal-emojis", "POST", upload)).status,
    401,
  );
  await bob.login("bob");
  await alice.login("alice");
  assert.equal(
    (
      await bob.request("/api/personal-emojis", "POST", upload, {
        "X-CSRF-Token": "wrong",
      })
    ).status,
    403,
  );
  const response = await bob.request("/api/personal-emojis", "POST", upload);
  assert.equal(response.status, 201);
  const emoji = await response.json();
  assert.deepEqual(
    await (await alice.request("/api/personal-emojis")).json(),
    [],
  );
  assert.equal(
    (
      await alice.request(`/api/personal-emojis/${emoji.id}`, "PATCH", {
        name: "stolen",
      })
    ).status,
    404,
  );
  assert.equal(
    (await alice.request(`/api/personal-emojis/${emoji.id}`, "DELETE")).status,
    404,
  );
  assert.equal(
    (
      await bob.request(`/api/personal-emojis/${emoji.id}`, "PATCH", {
        name: "renamed_wave",
      })
    ).status,
    200,
  );
  assert.equal(
    (await bob.request(`/api/personal-emojis/${emoji.id}`, "DELETE")).status,
    200,
  );
  assert.deepEqual(
    await (await bob.request("/api/personal-emojis")).json(),
    [],
  );
});

test("HTTP sessions, CSRF, permissions and logout work across independent browsers", async (t) => {
  const { origin } = await application(t);
  const alice = browser(origin),
    bob = browser(origin);
  assert.equal((await alice.request("/api/channels")).status, 401);
  assert.equal(
    (
      await alice.request(
        "/api/dev-login",
        "POST",
        { username: "alice" },
        { Origin: "https://attacker.example" },
      )
    ).status,
    403,
  );
  await alice.login("alice");
  const bobUser = await bob.login("bob");
  const created = await alice.request("/api/channels", "POST", {
    name: "private",
    mode: "timeline",
    description: "",
    visibility: "members",
    admission: "allowlist",
  });
  assert.equal(created.status, 201);
  const channel = await created.json();
  assert.equal(
    (await bob.request(`/api/channels/${channel.id}/messages`)).status,
    403,
  );
  assert.equal(
    (
      await alice.request(
        `/api/channels/${channel.id}/messages`,
        "POST",
        { body: "No CSRF" },
        { "X-CSRF-Token": "" },
      )
    ).status,
    403,
  );
  await alice.request(
    `/api/channels/${channel.id}/members/${bobUser.id}`,
    "PATCH",
    { rule: "allow" },
  );
  assert.equal(
    (await bob.request(`/api/channels/${channel.id}/join`, "POST", {})).status,
    200,
  );
  assert.equal(
    (
      await bob.request(`/api/channels/${channel.id}/messages`, "POST", {
        body: "Hello Alice",
      })
    ).status,
    201,
  );
  const history = await (
    await alice.request(`/api/channels/${channel.id}/messages`)
  ).json();
  assert.equal(history.messages[0].body, "Hello Alice");
  assert.equal(
    history.messages[0].object_url,
    `${origin}/objects/messages/${history.messages[0].id}`,
  );
  assert.equal(
    (await alice.request(`/objects/messages/${history.messages[0].id}`)).status,
    200,
  );
  assert.equal(
    (await bob.request(`/api/channels/${channel.id}/messages?before=NaN`))
      .status,
    400,
  );
  await alice.request(
    `/api/channels/${channel.id}/members/${bobUser.id}`,
    "PATCH",
    { rule: "block" },
  );
  assert.equal(
    (await bob.request(`/api/channels/${channel.id}/messages`)).status,
    403,
  );
  assert.equal(
    (await bob.request(`/objects/messages/${history.messages[0].id}`)).status,
    403,
  );
  await bob.request("/api/logout", "POST", {});
  assert.equal((await bob.request("/api/channels")).status, 401);
  assert.match(
    created.headers.get("content-security-policy")!,
    /script-src 'self'/,
  );
  assert.doesNotMatch(
    created.headers.get("content-security-policy")!,
    /upgrade-insecure-requests/,
  );
});

test("development sign-in is absent in OIDC mode", async (t) => {
  const { origin } = await application(t, { devAuth: false });
  const client = browser(origin);
  assert.equal(
    (await client.request("/api/dev-login", "POST", { username: "alice" }))
      .status,
    404,
  );
  assert.equal((await client.session()).dev_auth, false);
});

test("forwarded headers are honored only for the configured proxy peer", async (t) => {
  const trusted = await application(t, { trustedProxies: ["127.0.0.1/32"] });
  await fetch(`${trusted.origin}/health`, {
    headers: {
      "X-Forwarded-For": "198.51.100.10",
      "X-Forwarded-Proto": "https",
    },
  });
  assert.deepEqual(trusted.observed.at(-1), {
    ip: "198.51.100.10",
    protocol: "https",
  });
  await fetch(`${trusted.origin}/health`, {
    headers: { "X-Forwarded-For": "203.0.113.5, 198.51.100.10" },
  });
  assert.equal(trusted.observed.at(-1)?.ip, "198.51.100.10");
  const untrusted = await application(t, { trustedProxies: ["192.0.2.1"] });
  await fetch(`${untrusted.origin}/health`, {
    headers: {
      "X-Forwarded-For": "198.51.100.10",
      "X-Forwarded-Proto": "https",
    },
  });
  assert.deepEqual(untrusted.observed.at(-1), {
    ip: "127.0.0.1",
    protocol: "http",
  });
});

test("rate limits count the forwarded clients separately behind a trusted proxy", async (t) => {
  const { origin } = await application(t, { trustedProxies: ["127.0.0.1"] });
  const headers = { "X-Forwarded-For": "198.51.100.10" };
  const first = await fetch(`${origin}/api/session`, { headers });
  const second = await fetch(`${origin}/api/session`, { headers });
  const another = await fetch(`${origin}/api/session`, {
    headers: { "X-Forwarded-For": "198.51.100.11" },
  });
  assert.equal(
    first.headers.get("ratelimit"),
    another.headers.get("ratelimit"),
  );
  assert.notEqual(
    first.headers.get("ratelimit"),
    second.headers.get("ratelimit"),
  );
});

async function provider(
  t: TestContext,
  profile: Record<string, unknown> = {},
  options: {
    authentication?: "client_secret_basic" | "client_secret_post";
    secret?: string;
  } = {},
) {
  const { server, origin } = await listen(t);
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  server.on("request", app);
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const jwk = {
    ...publicKey.export({ format: "jwk" }),
    kid: "test-key",
    alg: "RS256",
    use: "sig",
  };
  type Mode =
    | "valid"
    | "nonce"
    | "issuer"
    | "audience"
    | "signature"
    | "userinfo"
    | "error";
  const codes = new Map<
    string,
    { nonce: string; challenge: string; mode: Mode }
  >();
  let discoveryStatus = 200;
  app.get("/.well-known/openid-configuration", (_req, res) => {
    if (discoveryStatus !== 200)
      return res
        .status(discoveryStatus)
        .type("text")
        .send("Provider temporarily unavailable");
    res.json({
      issuer: origin,
      authorization_endpoint: `${origin}/authorize`,
      token_endpoint: `${origin}/token`,
      jwks_uri: `${origin}/jwks`,
      userinfo_endpoint: `${origin}/userinfo`,
      response_types_supported: ["code"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["RS256"],
      token_endpoint_auth_methods_supported: [options.authentication || "none"],
      code_challenge_methods_supported: ["S256"],
    });
  });
  app.get("/jwks", (_req, res) => res.json({ keys: [jwk] }));
  app.post("/token", (req, res) => {
    if (options.authentication) {
      let clientId = req.body.client_id,
        secret = req.body.client_secret;
      if (options.authentication === "client_secret_basic") {
        const authorization = String(req.headers.authorization || "");
        const [encodedId, encodedSecret] = Buffer.from(
          authorization.replace(/^Basic /, ""),
          "base64",
        )
          .toString()
          .split(":");
        clientId = decodeURIComponent((encodedId || "").replace(/\+/g, " "));
        secret = decodeURIComponent((encodedSecret || "").replace(/\+/g, " "));
      }
      if (clientId !== "archipel-test" || secret !== options.secret)
        return res.status(401).json({
          error: "invalid_client",
          error_description: `Private provider details ${options.secret}`,
        });
    }
    const flow = codes.get(req.body.code);
    if (!flow || flow.mode === "error")
      return res.status(400).json({ error: "invalid_grant" });
    if (
      createHash("sha256")
        .update(req.body.code_verifier || "")
        .digest("base64url") !== flow.challenge
    )
      return res.status(400).json({ error: "invalid_grant" });
    const header = Buffer.from(
      JSON.stringify({ alg: "RS256", kid: "test-key" }),
    ).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({
        iss: flow.mode === "issuer" ? "https://wrong.example" : origin,
        sub: "stable-subject",
        aud: flow.mode === "audience" ? "wrong-client" : "archipel-test",
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 300,
        nonce: flow.mode === "nonce" ? "wrong-nonce" : flow.nonce,
      }),
    ).toString("base64url");
    const signature =
      flow.mode === "signature"
        ? Buffer.alloc(256).toString("base64url")
        : sign(
            "RSA-SHA256",
            Buffer.from(`${header}.${payload}`),
            privateKey,
          ).toString("base64url");
    res.json({
      access_token: req.body.code,
      token_type: "Bearer",
      expires_in: 300,
      id_token: `${header}.${payload}.${signature}`,
    });
  });
  app.get("/userinfo", (req, res) => {
    const flow = codes.get(
      req.headers.authorization?.replace("Bearer ", "") || "",
    );
    res.json({
      sub: flow?.mode === "userinfo" ? "different-user" : "stable-subject",
      preferred_username: "oidc-user",
      ...profile,
    });
  });
  return {
    issuer: origin,
    discoveryStatus(value: number) {
      discoveryStatus = value;
    },
    code(url: URL, mode: Mode = "valid") {
      const code = randomUUID();
      codes.set(code, {
        nonce: url.searchParams.get("nonce")!,
        challenge: url.searchParams.get("code_challenge")!,
        mode,
      });
      return code;
    },
  };
}

test("OIDC completes a signed code/PKCE/nonce flow and rejects replay and forged identities", async (t) => {
  const logs: Record<string, unknown>[] = [];
  t.mock.method(console, "error", (line: string) =>
    logs.push(JSON.parse(line)),
  );
  const idp = await provider(t);
  const { origin, store } = await application(t, {
    oidcIssuer: idp.issuer,
    oidcClientId: "archipel-test",
    adminSubjects: ["stable-subject"],
  });
  const client = browser(origin);
  async function begin(mode: Parameters<typeof idp.code>[1] = "valid") {
    const response = await client.request("/auth/login");
    assert.equal(response.status, 302);
    const authorization = new URL(response.headers.get("location")!);
    assert.equal(
      authorization.searchParams.get("code_challenge_method"),
      "S256",
    );
    const callback = `/auth/callback?code=${idp.code(authorization, mode)}&state=${authorization.searchParams.get("state")}`;
    return { callback, authorization };
  }
  await t.test(
    "signed sign-in with no social disclosure succeeds and creates only one identity",
    async () => {
      const { callback } = await begin();
      const response = await client.request(callback);
      assert.equal(response.headers.get("location"), "/");
      const session = await client.session();
      assert.equal(session.user.username, "oidc-user");
      assert.equal(session.user.admin, true);
      assert.deepEqual(session.user.verified_socials, []);
      assert.equal(
        store.db.prepare("SELECT COUNT(*) AS n FROM users").get()?.n,
        1,
      );
      assert.equal(
        (await client.request(callback)).headers.get("location"),
        "/?signin=failed",
      );
      await client.request("/api/logout", "POST", {});
    },
  );
  for (const mode of [
    "nonce",
    "issuer",
    "audience",
    "signature",
    "userinfo",
    "error",
  ] as const) {
    await t.test(
      `rejects ${mode} failure without creating a session`,
      async () => {
        const { callback } = await begin(mode);
        const response = await client.request(callback);
        assert.equal(response.headers.get("location"), "/?signin=failed");
        assert.equal(
          response.headers.get("x-request-id"),
          logs.at(-1)?.reference,
        );
        assert.equal(
          logs.at(-1)?.stage,
          mode === "userinfo" ? "userinfo" : "token_exchange",
        );
        assert.equal(logs.at(-1)?.flow_cookie_present, true);
        assert.equal(logs.at(-1)?.state_present, true);
        assert.equal(logs.at(-1)?.code_present, true);
        if (mode === "error")
          assert.equal(logs.at(-1)?.oauth_error, "invalid_grant");
        assert.equal((await client.session()).user, null);
      },
    );
  }
  await t.test("state is bound to the initiating browser", async () => {
    const { callback } = await begin();
    const stranger = browser(origin);
    assert.equal(
      (await stranger.request(callback)).headers.get("location"),
      "/?signin=failed",
    );
    assert.equal((await stranger.session()).user, null);
    assert.equal(logs.at(-1)?.stage, "callback_validation");
    assert.equal(logs.at(-1)?.reason, "missing_or_expired_flow");
    assert.equal((await client.request(callback)).headers.get("location"), "/");
  });
});

test("unconfigured OIDC preserves its service-unavailable response and logs the configuration stage", async (t) => {
  const logs: Record<string, unknown>[] = [];
  t.mock.method(console, "error", (line: string) =>
    logs.push(JSON.parse(line)),
  );
  const { origin } = await application(t);
  const response = await browser(origin).request("/auth/login");
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: "OIDC sign-in is not configured.",
  });
  assert.equal(logs.length, 1);
  assert.equal(logs[0].stage, "configuration");
  assert.equal(logs[0].reason, "oidc_not_configured");
  assert.equal(response.headers.get("x-request-id"), logs[0].reference);
});

test("session creation failures after valid OIDC authentication are logged without exception text", async (t) => {
  const idp = await provider(t),
    logs: Record<string, unknown>[] = [];
  t.mock.method(console, "error", (line: string) =>
    logs.push(JSON.parse(line)),
  );
  const { origin, store } = await application(t, {
    oidcIssuer: idp.issuer,
    oidcClientId: "archipel-test",
  });
  t.mock.method(store, "createSession", () => {
    throw new Error("sensitive-storage-detail");
  });
  const client = browser(origin);
  const start = await client.request("/auth/login");
  const authorization = new URL(start.headers.get("location")!);
  const response = await client.request(
    `/auth/callback?code=${idp.code(authorization)}&state=${authorization.searchParams.get("state")}`,
  );
  assert.equal(response.headers.get("location"), "/?signin=failed");
  assert.equal(logs.length, 1);
  assert.equal(logs[0].stage, "session_creation");
  assert.equal(response.headers.get("x-request-id"), logs[0].reference);
  assert.ok(!JSON.stringify(logs).includes("sensitive-storage-detail"));
  assert.equal((await client.session()).user, null);
});

test("OIDC discovery failures are logged once and a later attempt retries discovery", async (t) => {
  const idp = await provider(t),
    logs: Record<string, unknown>[] = [];
  t.mock.method(console, "error", (line: string) =>
    logs.push(JSON.parse(line)),
  );
  const { origin } = await application(t, {
    oidcIssuer: idp.issuer,
    oidcClientId: "archipel-test",
  });
  const client = browser(origin);
  idp.discoveryStatus(503);
  const failed = await client.request("/auth/login");
  assert.equal(failed.status, 500);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].stage, "discovery");
  assert.equal(logs[0].http_status, 503);
  assert.equal(failed.headers.get("x-request-id"), logs[0].reference);
  idp.discoveryStatus(200);
  assert.equal((await client.request("/auth/login")).status, 302);
});

test("confidential client methods preserve literal secrets and invalid credentials are logged without disclosure", async (t) => {
  for (const authentication of [
    "client_secret_basic",
    "client_secret_post",
  ] as const) {
    await t.test(authentication, async (t) => {
      const secret = "test$#'\"`:secret\\with-spaces",
        logs: Record<string, unknown>[] = [];
      t.mock.method(console, "error", (line: string) =>
        logs.push(JSON.parse(line)),
      );
      const idp = await provider(t, {}, { authentication, secret });
      const { origin } = await application(t, {
        oidcIssuer: idp.issuer,
        oidcClientId: "archipel-test",
        oidcAuthMethod: authentication,
        oidcSecret: secret,
      });
      const client = browser(origin);
      const start = await client.request("/auth/login"),
        authorization = new URL(start.headers.get("location")!);
      const callback = `/auth/callback?code=${idp.code(authorization)}&state=${authorization.searchParams.get("state")}`;
      assert.equal(
        (await client.request(callback)).headers.get("location"),
        "/",
      );
      assert.equal(logs.length, 0);
      const wrong = await application(t, {
        oidcIssuer: idp.issuer,
        oidcClientId: "archipel-test",
        oidcAuthMethod: authentication,
        oidcSecret: "incorrect-secret",
      });
      const badClient = browser(wrong.origin),
        badStart = await badClient.request("/auth/login"),
        badAuthorization = new URL(badStart.headers.get("location")!);
      const failed = await badClient.request(
        `/auth/callback?code=${idp.code(badAuthorization)}&state=${badAuthorization.searchParams.get("state")}`,
      );
      assert.equal(failed.headers.get("location"), "/?signin=failed");
      assert.equal(logs.at(-1)?.stage, "token_exchange");
      assert.equal(logs.at(-1)?.oauth_error, "invalid_client");
      assert.ok(!JSON.stringify(logs).includes(secret));
      assert.ok(!JSON.stringify(logs).includes("incorrect-secret"));
    });
  }
});

test("FedIdP-style claims reach only the admin review queue until membership is approved", async (t) => {
  const profile = {
    verified_socials: [
      {
        provider: "mastodon",
        handle: "@applicant@social.example",
        subject: "https://social.example/users/applicant",
      },
    ],
  };
  const idp = await provider(t, profile);
  const { origin } = await application(t, {
    oidcIssuer: idp.issuer,
    oidcClientId: "archipel-test",
    registrationMode: "invite_only",
  });
  const admin = browser(origin),
    applicant = browser(origin),
    outsider = browser(origin);
  await admin.login("alice");
  const channel = await (
    await admin.request("/api/channels", "POST", {
      name: "private-instance",
      mode: "timeline",
      visibility: "public",
      admission: "open",
    })
  ).json();
  const message = await (
    await admin.request(`/api/channels/${channel.id}/messages`, "POST", {
      body: "Members only",
    })
  ).json();
  async function signIn() {
    const start = await applicant.request("/auth/login");
    const authorization = new URL(start.headers.get("location")!);
    const callback = await applicant.request(
      `/auth/callback?code=${idp.code(authorization)}&state=${authorization.searchParams.get("state")}`,
    );
    assert.equal(callback.headers.get("location"), "/");
    return applicant.session();
  }
  const session = await signIn();
  assert.equal(session.user.admission_status, "pending");
  assert.equal(session.registration_mode, "invite_only");
  assert.equal(
    session.user.verified_socials[0].handle,
    "@applicant@social.example",
  );
  for (const path of [
    "/api/channels",
    `/api/channels/${channel.id}`,
    `/api/channels/${channel.id}/messages`,
    "/api/users",
    "/api/emojis",
    "/api/admin/applications",
    `/actors/users/${session.user.id}`,
    `/objects/messages/${message.id}`,
  ])
    assert.equal((await applicant.request(path)).status, 403, path);
  assert.equal(
    (await applicant.request(`/api/channels/${channel.id}/join`, "POST", {}))
      .status,
    403,
  );
  assert.equal(
    (
      await applicant.request(
        `/api/admin/applications/${session.user.id}`,
        "PATCH",
        { admission_status: "approved" },
      )
    ).status,
    403,
  );
  assert.equal((await outsider.request("/api/admin/applications")).status, 401);
  const queue = await (await admin.request("/api/admin/applications")).json();
  assert.equal(queue.length, 1);
  assert.deepEqual(queue[0].verified_socials, profile.verified_socials);
  assert.deepEqual(queue[0].identities, [
    { issuer: idp.issuer, subject: "stable-subject" },
  ]);
  assert.equal(
    (
      await admin.request(
        `/api/admin/applications/${session.user.id}`,
        "PATCH",
        { admission_status: "rejected" },
      )
    ).status,
    200,
  );
  assert.equal((await applicant.session()).user.admission_status, "rejected");
  assert.equal(
    (await applicant.request("/api/logout", "POST", {})).status,
    200,
  );
  profile.verified_socials = [];
  assert.equal((await signIn()).user.admission_status, "rejected");
  assert.deepEqual(
    (await (await admin.request("/api/admin/applications")).json())[0]
      .verified_socials,
    [],
  );
  assert.equal(
    (
      await admin.request(
        `/api/admin/applications/${session.user.id}`,
        "PATCH",
        { admission_status: "approved" },
      )
    ).status,
    200,
  );
  assert.equal((await applicant.session()).user.admission_status, "approved");
  assert.equal(
    (await applicant.request(`/api/channels/${channel.id}/messages`)).status,
    200,
  );
  assert.equal(
    (await applicant.request("/api/admin/applications")).status,
    403,
  );
  assert.equal(
    (
      await applicant.request("/api/admin/settings", "PATCH", {
        registration_mode: "open",
      })
    ).status,
    403,
  );
});

test("message edits and custom image APIs enforce CSRF, authorship and administrator permissions", async (t) => {
  const { origin } = await application(t);
  const alice = browser(origin),
    bob = browser(origin);
  await alice.login("alice");
  await bob.login("bob");
  const c = await (
    await alice.request("/api/channels", "POST", {
      name: "editing",
      mode: "timeline",
      visibility: "public",
      admission: "open",
    })
  ).json();
  await bob.request(`/api/channels/${c.id}/join`, "POST", {});
  const message = await (
    await bob.request(`/api/channels/${c.id}/messages`, "POST", {
      body: "Original",
    })
  ).json();
  assert.equal(
    (
      await alice.request(`/api/messages/${message.id}`, "PATCH", {
        body: "Admin rewrite",
        expected_edited_at: null,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await bob.request(
        `/api/messages/${message.id}`,
        "PATCH",
        { body: "No CSRF", expected_edited_at: null },
        { "X-CSRF-Token": "invalid" },
      )
    ).status,
    403,
  );
  const updated = await (
    await bob.request(`/api/messages/${message.id}`, "PATCH", {
      body: "Edited :heart:",
      expected_edited_at: null,
    })
  ).json();
  assert.equal(updated.body, "Edited :heart:");
  assert.ok(updated.edited_at);
  assert.equal(
    (
      await bob.request(`/api/messages/${message.id}`, "PATCH", {
        body: "Stale",
        expected_edited_at: null,
      })
    ).status,
    409,
  );
  const image =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=";
  assert.equal(
    (await bob.request("/api/admin/emojis", "POST", { name: "island", image }))
      .status,
    403,
  );
  const emoji = await (
    await alice.request("/api/admin/emojis", "POST", { name: "island", image })
  ).json();
  const response = await bob.request(emoji.url);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/png");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(
    Buffer.from(await response.arrayBuffer()).toString("base64"),
    image,
  );
  assert.equal(
    (await bob.request(`/api/admin/emojis/island`, "DELETE")).status,
    403,
  );
  assert.equal(
    (await alice.request(`/api/admin/emojis/island`, "DELETE")).status,
    200,
  );
});

test("channel rename and delete APIs enforce CSRF and ownership", async (t) => {
  const { origin } = await application(t);
  const bob = browser(origin),
    charlie = browser(origin);
  await bob.login("bob");
  await charlie.login("charlie");
  const c = await (
    await bob.request("/api/channels", "POST", {
      name: "temporary",
      mode: "timeline",
      visibility: "public",
      admission: "open",
    })
  ).json();
  await charlie.request(`/api/channels/${c.id}/join`, "POST", {});
  for (const [method, body] of [
    ["PATCH", { name: "renamed" }],
    ["DELETE", undefined],
  ] as const)
    assert.equal(
      (await charlie.request(`/api/channels/${c.id}`, method, body)).status,
      403,
    );
  assert.equal(
    (
      await bob.request(`/api/channels/${c.id}`, "DELETE", undefined, {
        "X-CSRF-Token": "wrong",
      })
    ).status,
    403,
  );
  const renamed = await bob.request(`/api/channels/${c.id}`, "PATCH", {
    name: "Renamed",
  });
  assert.equal(renamed.status, 200);
  assert.equal((await renamed.json()).name, "renamed");
  assert.equal(
    (await bob.request(`/api/channels/${c.id}`, "PATCH", { name: "x" })).status,
    400,
  );
  assert.equal(
    (await bob.request(`/api/channels/${c.id}`, "DELETE")).status,
    200,
  );
  assert.equal((await charlie.request(`/api/channels/${c.id}`)).status, 404);
  assert.deepEqual(await (await charlie.request("/api/channels")).json(), []);
});

test("attachments upload by role, serve by unguessable address with ranges, and leave with their message", async t => {
  const f = await application(t);
  const alice = browser(f.origin), bob = browser(f.origin);
  const admin = await alice.login("alice"); await bob.login("bob");
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC1lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=", "base64");
  const upload = async (who: ReturnType<typeof browser>, data: Buffer, name: string, type = "image/png", csrf = true) => fetch(`${f.origin}/api/attachments`, {
    method: "POST", body: new Uint8Array(data),
    headers: { Origin: f.origin, "Content-Type": type, "X-Filename": encodeURIComponent(name),
      Cookie: [...who.cookies].map(([k, v]) => `${k}=${v}`).join("; "), ...(csrf ? { "X-CSRF-Token": (await who.session()).csrf } : {}) },
  });
  assert.equal((await fetch(`${f.origin}/api/attachments`, { method: "POST", body: new Uint8Array(png), headers: { Origin: f.origin, "Content-Type": "image/png" } })).status, 401);
  assert.equal((await upload(bob, png, "cat.png", "image/png", false)).status, 403);
  // What a file is comes from its bytes, never from what the browser called it.
  assert.equal((await upload(bob, Buffer.from("<svg onload=alert(1)>"), "x.png")).status, 415);
  assert.equal((await upload(bob, Buffer.from("<html><script>alert(1)</script>"), "x.mp4", "video/mp4")).status, 415);
  const heic = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypheic"), Buffer.alloc(16)]);
  assert.equal((await upload(bob, heic, "x.mp4", "video/mp4")).status, 415);
  const sent = await upload(bob, png, 'my [cat](x) "1".png', "text/html");
  assert.equal(sent.status, 201);
  const file = await sent.json();
  assert.deepEqual([file.mime, file.name, file.size], ["image/png", "my catx 1.png", png.length]);
  assert.match(file.url, new RegExp(`^${f.origin}/media/[A-Za-z0-9_-]{43}\.png$`));
  const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.alloc(16)]);
  const video = await (await upload(bob, mp4, "clip.mp4", "video/mp4")).json();
  assert.equal(video.mime, "video/mp4");
  // Anyone holding the address reads it, signed in or not; it can never act as a page.
  const got = await fetch(file.url);
  assert.equal(got.status, 200);
  assert.equal(got.headers.get("content-type"), "image/png");
  assert.equal(got.headers.get("content-security-policy"), "default-src 'none'; sandbox");
  assert.equal(got.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(Buffer.from(await got.arrayBuffer()), png);
  const part = await fetch(file.url, { headers: { Range: "bytes=1-3" } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get("content-range"), `bytes 1-3/${png.length}`);
  assert.deepEqual(Buffer.from(await part.arrayBuffer()), png.subarray(1, 4));
  const tail = await fetch(file.url, { headers: { Range: "bytes=-4" } });
  assert.deepEqual(Buffer.from(await tail.arrayBuffer()), png.subarray(png.length - 4));
  assert.equal((await fetch(file.url, { headers: { Range: `bytes=${png.length}-` } })).status, 416);
  assert.equal((await fetch(file.url.replace(/\.png$/, ".mp4"))).status, 404);
  assert.equal((await fetch(`${f.origin}/media/${"a".repeat(43)}.png`)).status, 404);
  // Removing the message removes what its author attached to it, and nobody else's copy of the address.
  const channel = await (await bob.request("/api/channels", "POST", { name: "pictures", description: "", mode: "timeline", visibility: "public", admission: "open" })).json();
  await alice.session();
  assert.equal((await alice.request(`/api/channels/${channel.id}/join`, "POST", {})).status, 200);
  const theirs = await (await alice.request(`/api/channels/${channel.id}/messages`, "POST", { body: `Reposting ![cat](${video.url})` })).json();
  await bob.session();
  const mine = await (await bob.request(`/api/channels/${channel.id}/messages`, "POST", { body: `Look ![cat](${file.url}) and ![clip](${video.url})` })).json();
  assert.equal((await alice.request(`/api/messages/${theirs.id}`, "DELETE")).status, 200);
  assert.equal((await fetch(video.url)).status, 200);
  assert.equal((await bob.request(`/api/messages/${mine.id}`, "DELETE")).status, 200);
  assert.equal((await fetch(file.url)).status, 404);
  assert.equal((await fetch(video.url)).status, 404);
  // A role without the grant cannot upload.
  await alice.session();
  const role = await (await alice.request("/api/admin/roles", "POST", { name: "Text only", attachments: false })).json();
  assert.equal((await bob.request("/api/admin/roles")).status, 403);
  const member = (await bob.session()).user;
  assert.equal((await bob.request(`/api/admin/users/${admin.id}/role`, "PATCH", { role_id: role.id })).status, 403);
  assert.equal((await alice.request(`/api/admin/users/${member.id}/role`, "PATCH", { role_id: role.id })).status, 200);
  assert.equal((await upload(bob, png, "cat.png")).status, 403);
  assert.deepEqual([(await bob.session()).user.attachments, (await bob.session()).user.instance_role.name], [false, "Text only"]);
  assert.equal((await alice.request(`/api/admin/roles/${role.id}`, "DELETE")).status, 200);
  assert.equal((await upload(bob, png, "cat.png")).status, 201);
});

// What a browser does with a push message: RFC 8291, from the receiving side.
function pushReceiver() {
  const ecdh = createECDH("prime256v1"),
    auth = randomBytes(16);
  const keys = { p256dh: ecdh.generateKeys().toString("base64url"), auth: auth.toString("base64url") };
  return {
    keys,
    open(body: Buffer) {
      const salt = body.subarray(0, 16), server = body.subarray(21, 21 + body[20]), sealed = body.subarray(21 + body[20]);
      const derive = (key: Buffer, salt: Buffer, info: Buffer | string, length: number) => Buffer.from(hkdfSync("sha256", key, salt, info, length));
      const ikm = derive(ecdh.computeSecret(server), auth, Buffer.concat([Buffer.from("WebPush: info\0"), ecdh.getPublicKey(), server]), 32);
      const decipher = createDecipheriv("aes-128-gcm", derive(ikm, salt, "Content-Encoding: aes128gcm\0", 16), derive(ikm, salt, "Content-Encoding: nonce\0", 12));
      decipher.setAuthTag(sealed.subarray(-16));
      const plain = Buffer.concat([decipher.update(sealed.subarray(0, -16)), decipher.final()]);
      assert.equal(plain.at(-1), 2);
      return JSON.parse(plain.subarray(0, -1).toString());
    },
  };
}
test("browsers that subscribed are notified of new messages until they sign out or the push service forgets them", async t => {
  const f = await application(t);
  const received: { path: string; headers: Record<string, unknown>; body: Buffer }[] = [];
  let gone = false;
  const service = await listen(t);
  service.server.on("request", (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      received.push({ path: req.url!, headers: req.headers, body: Buffer.concat(chunks) });
      res.statusCode = gone ? 410 : 201;
      res.end();
    });
  });
  const push = f.app.locals.push as Push;
  const alice = browser(f.origin), bob = browser(f.origin), phone = browser(f.origin);
  const a = await alice.login("alice"); const b = await bob.login("bob"); await phone.login("bob");
  const channel = await (await alice.request("/api/channels", "POST", { name: "general", description: "", mode: "topical", visibility: "public", admission: "open" })).json();
  await bob.request(`/api/channels/${channel.id}/join`, "POST", {});
  const topic = await (await alice.request(`/api/channels/${channel.id}/topics`, "POST", { title: "Plans" })).json();
  const say = (who: ReturnType<typeof browser>, body: string) => who.request(`/api/channels/${channel.id}/messages`, "POST", { body, topic_id: topic.id });

  const status = await (await bob.request("/api/push")).json();
  assert.equal(status.endpoint, null);
  assert.equal(Buffer.from(status.public_key, "base64url").length, 65);
  const desk = pushReceiver(), pocket = pushReceiver();
  assert.equal((await fetch(`${f.origin}/api/push`)).status, 401);
  assert.equal((await bob.request("/api/push", "PUT", { endpoint: "http://10.0.0.1/push", keys: desk.keys })).status, 400);
  assert.equal((await bob.request("/api/push", "PUT", { endpoint: `${service.origin}/desk`, keys: { ...desk.keys, auth: "short" } })).status, 400);
  assert.equal((await bob.request("/api/push/test", "POST", {})).status, 409);
  assert.equal((await (await bob.request("/api/push", "PUT", { endpoint: `${service.origin}/desk`, keys: desk.keys })).json()).endpoint, `${service.origin}/desk`);
  await phone.request("/api/push", "PUT", { endpoint: `${service.origin}/pocket`, keys: pocket.keys });
  assert.equal((await bob.request("/api/push/test", "POST", {})).status, 200);
  assert.equal(desk.open(received[0].body).test, true);
  assert.match(String(received[0].headers.authorization), /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=/);
  const [, claims, signature] = String(received[0].headers.authorization).slice(8).split(",")[0].split(".");
  assert.equal(JSON.parse(Buffer.from(claims, "base64url").toString()).aud, service.origin);
  assert.equal(Buffer.from(signature, "base64url").length, 64);
  received.length = 0;

  // What was already there is not news; what comes next is, once for each of Bob's browsers.
  await say(alice, "Before anyone was listening");
  await push.tick();
  assert.equal(received.length, 0);
  await say(alice, "First"); await say(alice, "Second"); await say(bob, "Bob's own");
  await push.tick();
  assert.deepEqual(received.map((r) => r.path).sort(), ["/desk", "/pocket"]);
  const notice = desk.open(received.find((r) => r.path === "/desk")!.body);
  assert.deepEqual(notice, { tag: `topic:${topic.id}`, title: "#general › Plans", body: "2 new messages", url: `/#/c/${channel.id}/t/${topic.id}` });
  assert.ok(!JSON.stringify(notice).includes("First"));
  assert.throws(() => pocket.open(received.find((r) => r.path === "/desk")!.body));
  received.length = 0;
  await push.tick();
  assert.equal(received.length, 0);

  // A silenced channel, a hidden topic and a read conversation stay quiet.
  assert.equal((await bob.request("/api/prefs", "PUT", { target: channel.id, notify: false })).status, 200);
  await say(alice, "Silenced"); await push.tick();
  assert.equal(received.length, 0);
  await bob.request("/api/prefs", "PUT", { target: `topic:${topic.id}`, notify: true });
  await say(alice, "This topic asked"); await push.tick();
  assert.equal(desk.open(received.find((r) => r.path === "/desk")!.body).body, "New message from alice");
  received.length = 0;
  await bob.request("/api/prefs", "PUT", { target: `topic:${topic.id}`, hidden: true });
  assert.deepEqual((await (await bob.request("/api/overview")).json()).prefs, { [channel.id]: { hidden: false, notify: false }, [`topic:${topic.id}`]: { hidden: true, notify: true } });
  assert.deepEqual((await (await bob.request("/api/prefs")).json()).map((p: { kind: string; title: string | null }) => [p.kind, p.title]), [["channel", null], ["topic", "Plans"]]);
  await say(alice, "Hidden"); await push.tick();
  assert.equal(received.length, 0);
  assert.equal((await (await bob.request("/api/overview")).json()).unread[channel.id], undefined);

  // Direct messages notify too. Signing out stops that browser; a subscription the push service dropped is forgotten.
  await alice.request("/api/dms", "POST", { to: b.username, body: "Psst" });
  await push.tick();
  assert.deepEqual(pocket.open(received.find((r) => r.path === "/pocket")!.body), { tag: `dm:${f.origin}/actors/users/${a.id}`, title: "alice", body: "New direct message", url: `/#/dm/${a.id}` });
  received.length = 0;
  await phone.request("/api/logout", "POST", {});
  gone = true;
  await alice.request("/api/dms", "POST", { to: b.username, body: "Again" });
  await push.tick();
  assert.deepEqual(received.map((r) => r.path), ["/desk"]);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM push_subscriptions").get()!.n, 0);
  assert.equal((await (await bob.request("/api/push")).json()).endpoint, null);
});
