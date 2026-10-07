import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { generateKeyPairSync, sign, createHash, randomUUID } from "node:crypto";
import express, { type Request } from "express";
import { Store } from "../src/store.js";
import { loadConfig, type Config } from "../src/config.js";
import { createApp } from "../src/app.js";

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

async function provider(t: TestContext, profile: Record<string, unknown> = {}) {
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
  app.get("/.well-known/openid-configuration", (_req, res) =>
    res.json({
      issuer: origin,
      authorization_endpoint: `${origin}/authorize`,
      token_endpoint: `${origin}/token`,
      jwks_uri: `${origin}/jwks`,
      userinfo_endpoint: `${origin}/userinfo`,
      response_types_supported: ["code"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["RS256"],
      token_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
    }),
  );
  app.get("/jwks", (_req, res) => res.json({ keys: [jwk] }));
  app.post("/token", (req, res) => {
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
    assert.equal((await client.request(callback)).headers.get("location"), "/");
  });
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
