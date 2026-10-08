import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { generateKeyPairSync, sign, createHash, randomUUID } from "node:crypto";
import express, { type Request } from "express";
import { Store } from "../src/store.js";
import { loadConfig, type Config } from "../src/config.js";
import { createApp } from "../src/app.js";

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
  return { store, origin, config, observed };
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
