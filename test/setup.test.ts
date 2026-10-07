import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  statSync,
  rmSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseEnv } from "node:util";
import { execFileSync } from "node:child_process";
import {
  collectSetup,
  parseRawEnv,
  serializeNodeEnv,
  writeSetup,
  type Settings,
} from "../scripts/setup.js";
import { loadConfig } from "../src/config.js";

const defaults = async (_label: string, value: string) => value;
const proxyInput = {
  BASE_URL: "https://chat.example.org",
  TRUSTED_PROXY: "172.20.0.2",
  PROXY_NETWORK: "edge",
  OIDC_ISSUER: "https://identity.example.org",
  OIDC_CLIENT_ID: "archipel",
  OIDC_AUTH_METHOD: "none",
};

test("local setup produces a valid loopback development environment", async () => {
  const settings = await collectSetup({}, defaults, "local");
  const config = loadConfig(settings);
  assert.equal(config.devAuth, true);
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.baseUrl, "http://127.0.0.1:8788");
  assert.deepEqual(config.trustedProxies, []);
  assert.deepEqual(parseEnv(serializeNodeEnv(settings)), settings);
});
test("Traefik setup selects the external network and optional certificate resolver", async () => {
  const settings = await collectSetup(
    {
      ...proxyInput,
      TRAEFIK_ENTRYPOINT: "https",
      TRAEFIK_CERT_RESOLVER: "letsencrypt",
    },
    defaults,
    "traefik",
  );
  assert.equal(settings.DEV_AUTH, "false");
  assert.equal(settings.HOST, "0.0.0.0");
  assert.equal(settings.PROXY_NETWORK, "edge");
  assert.equal(settings.TRAEFIK_HOST, "chat.example.org");
  assert.equal(
    settings.COMPOSE_FILE,
    "compose.yaml:compose.proxy.yaml:compose.traefik.yaml:compose.acme.yaml",
  );
  assert.deepEqual(loadConfig(settings).trustedProxies, ["172.20.0.2"]);
});
test("generic proxy setup supports an external network or a loopback host port", async () => {
  const external = await collectSetup(proxyInput, defaults, "proxy");
  assert.equal(external.COMPOSE_FILE, "compose.yaml:compose.proxy.yaml");
  const host = await collectSetup(
    proxyInput,
    async (label, value) =>
      label.startsWith("Use an existing") ? "no" : value,
    "proxy",
  );
  assert.equal(host.PROXY_NETWORK, "");
  assert.equal(host.COMPOSE_FILE, "compose.yaml:compose.local.yaml");
});
test("proxy trust accepts IPv4/IPv6 peers and CIDRs but rejects blanket and hop-count trust", () => {
  assert.deepEqual(
    loadConfig({
      TRUSTED_PROXY: "172.20.0.2, 2001:db8::2,172.21.0.0/24,::1/128",
    }).trustedProxies,
    ["172.20.0.2", "2001:db8::2", "172.21.0.0/24", "::1/128"],
  );
  for (const value of [
    "true",
    "1",
    "loopback",
    "proxy",
    "0.0.0.0/0",
    "::/0",
    "1.2.3.4/33",
    "::1/129",
    "1.2.3.4/",
    "1.2.3.4,",
  ])
    assert.throws(() => loadConfig({ TRUSTED_PROXY: value }), /TRUSTED_PROXY/);
});
test("setup rejects incomplete or unsafe proxy configuration", async () => {
  await assert.rejects(
    collectSetup({ ...proxyInput, TRUSTED_PROXY: "" }, defaults, "proxy"),
    /TRUSTED_PROXY/,
  );
  await assert.rejects(
    collectSetup(
      { ...proxyInput, PROXY_NETWORK: "bad network" },
      defaults,
      "traefik",
    ),
    /network name/,
  );
  await assert.rejects(
    collectSetup({ ...proxyInput, OIDC_CLIENT_ID: "" }, defaults, "traefik"),
    /OIDC_CLIENT_ID/,
  );
});
test("container secrets retain dollars, hashes, all quote types and backslashes literally", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "archipel-setup-"));
  t.after(() => rmSync(directory, { recursive: true }));
  const secret = "dollars$VARIABLE#'\"`\\keep";
  const settings = await collectSetup(
    {
      ...proxyInput,
      OIDC_AUTH_METHOD: "client_secret_basic",
      OIDC_CLIENT_SECRET: secret,
    },
    defaults,
    "traefik",
  );
  const result = writeSetup(directory, settings);
  assert.equal(result.files.length, 2);
  const raw = parseRawEnv(
    readFileSync(join(directory, ".env.container"), "utf8"),
  );
  assert.equal(raw.OIDC_CLIENT_SECRET, secret);
  assert.equal(
    parseEnv(readFileSync(join(directory, ".env"), "utf8")).OIDC_CLIENT_SECRET,
    "",
  );
  for (const file of result.files)
    assert.equal(statSync(file).mode & 0o777, 0o600);
});
test("reconfiguration creates private backups and preserves custom variables", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "archipel-setup-"));
  t.after(() => rmSync(directory, { recursive: true }));
  writeFileSync(join(directory, ".env"), "CUSTOM_SETTING=keep\n");
  const settings = await collectSetup(
    { CUSTOM_SETTING: "keep" },
    defaults,
    "local",
  );
  const result = writeSetup(directory, settings);
  assert.equal(result.backups.length, 1);
  assert.equal(
    readFileSync(result.backups[0], "utf8"),
    "CUSTOM_SETTING=keep\n",
  );
  assert.equal(statSync(result.backups[0]).mode & 0o777, 0o600);
  assert.equal(
    parseEnv(readFileSync(result.files[0], "utf8")).CUSTOM_SETTING,
    "keep",
  );
  assert.throws(() =>
    writeSetup(directory, { ...settings, TRUSTED_PROXY: "true" }),
  );
  assert.equal(
    parseEnv(readFileSync(result.files[0], "utf8")).TRUSTED_PROXY,
    "",
  );
});
test("CLI generates container files non-interactively without echoing secrets", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "archipel-setup-"));
  t.after(() => rmSync(directory, { recursive: true }));
  const output = execFileSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "scripts/setup.ts",
      "--non-interactive",
      "--mode",
      "traefik",
      "--directory",
      directory,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        ...proxyInput,
        OIDC_AUTH_METHOD: "client_secret_basic",
        OIDC_CLIENT_SECRET: "private$#secret",
      },
    },
  );
  assert.ok(existsSync(join(directory, ".env.container")));
  assert.doesNotMatch(output, /private\$#secret/);
  assert.match(output, /docker compose up --build -d/);
  assert.equal(
    parseRawEnv(readFileSync(join(directory, ".env.container"), "utf8"))
      .OIDC_CLIENT_SECRET,
    "private$#secret",
  );
});

test("setup accepts invite-only registration and rejects unknown policies", async () => {
  const settings = await collectSetup(
    { REGISTRATION_MODE: "invite_only" },
    defaults,
    "local",
  );
  assert.equal(loadConfig(settings).registrationMode, "invite_only");
  await assert.rejects(
    collectSetup({ REGISTRATION_MODE: "invalid" }, defaults, "local"),
    /REGISTRATION_MODE/,
  );
});
