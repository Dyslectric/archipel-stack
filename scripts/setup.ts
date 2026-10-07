import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { parseEnv } from "node:util";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  renameSync,
  chmodSync,
} from "node:fs";
import { resolve, delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { loadConfig } from "../src/config.js";

export type Settings = Record<string, string>;
type Ask = (label: string, value: string, secret?: boolean) => Promise<string>;
const appKeys = [
  "PORT",
  "HOST",
  "BASE_URL",
  "DATABASE_PATH",
  "DEV_AUTH",
  "TRUSTED_PROXY",
  "OIDC_ISSUER",
  "OIDC_CLIENT_ID",
  "OIDC_CLIENT_SECRET",
  "OIDC_AUTH_METHOD",
  "ADMIN_SUBJECTS",
  "REGISTRATION_MODE",
];

export function parseRawEnv(source: string): Settings {
  const result: Settings = {};
  for (const line of source.split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const equals = line.indexOf("=");
    if (equals > 0) result[line.slice(0, equals)] = line.slice(equals + 1);
  }
  return result;
}
export function serializeNodeEnv(settings: Settings) {
  return (
    Object.entries(settings)
      .map(([key, value]) => {
        if (!/^[A-Z_][A-Z0-9_]*$/.test(key) || /[\r\n\0]/.test(value))
          throw new Error(`Invalid single-line environment value for ${key}`);
        const quote = ["'", '"', "`"].find((q) => !value.includes(q));
        if (!quote)
          throw new Error(
            `${key} cannot contain all three quote delimiters in a Node environment file`,
          );
        return `${key}=${quote}${value}${quote}`;
      })
      .join("\n") + "\n"
  );
}
export function validateSetup(settings: Settings) {
  const mode = settings.SETUP_MODE;
  if (!["local", "container", "proxy", "traefik"].includes(mode))
    throw new Error("Choose local, container, proxy, or traefik mode");
  loadConfig(settings);
  if (mode === "local" && settings.PROXY_NETWORK)
    throw new Error("An external Docker network requires a container mode");
  if (mode !== "local" && settings.DEV_AUTH !== "false")
    throw new Error(
      "Container deployments must disable development authentication",
    );
  if (["proxy", "traefik"].includes(mode)) {
    if (!settings.BASE_URL.startsWith("https://"))
      throw new Error("Proxy deployments require an HTTPS BASE_URL");
    if (!settings.TRUSTED_PROXY?.trim())
      throw new Error("Set the actual proxy peer IP or CIDR in TRUSTED_PROXY");
  }
  if (
    settings.PROXY_NETWORK &&
    !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(settings.PROXY_NETWORK)
  )
    throw new Error("Invalid external Docker network name");
  if (mode === "traefik") {
    if (!settings.PROXY_NETWORK)
      throw new Error("Traefik mode requires an external Docker network");
    if (!/^[a-zA-Z0-9.-]+$/.test(settings.TRAEFIK_HOST))
      throw new Error(
        "Traefik routing requires a DNS hostname or IPv4 address",
      );
    if (!/^[a-zA-Z0-9_.-]+$/.test(settings.TRAEFIK_ENTRYPOINT))
      throw new Error("Invalid Traefik entrypoint name");
    if (
      settings.TRAEFIK_CERT_RESOLVER &&
      !/^[a-zA-Z0-9_.-]+$/.test(settings.TRAEFIK_CERT_RESOLVER)
    )
      throw new Error("Invalid Traefik certificate resolver name");
  }
  for (const [key, value] of Object.entries(settings))
    if (/[\r\n\0]/.test(value)) throw new Error(`${key} must be a single line`);
}

export async function collectSetup(
  previous: Settings,
  ask: Ask,
  requestedMode?: string,
): Promise<Settings> {
  const mode =
    requestedMode ||
    (await ask(
      "Deployment mode (local / container / proxy / traefik)",
      previous.SETUP_MODE || "local",
    ));
  if (!["local", "container", "proxy", "traefik"].includes(mode))
    throw new Error("Unknown deployment mode");
  const container = mode !== "local",
    proxy = ["proxy", "traefik"].includes(mode);
  const port = await ask(
    container
      ? "Host port (used only for loopback publishing)"
      : "Application port",
    previous.PORT || "8788",
  );
  const baseDefault =
    previous.BASE_URL && (proxy ? previous.BASE_URL.startsWith("https:") : true)
      ? previous.BASE_URL
      : proxy
        ? "https://chat.example.org"
        : `http://127.0.0.1:${port}`;
  const baseUrl = await ask("Public base URL", baseDefault);
  const dev = container
    ? "false"
    : await ask(
        "Enable local development accounts? (true / false)",
        previous.DEV_AUTH || "true",
      );
  if (!["true", "false"].includes(dev))
    throw new Error("DEV_AUTH must be true or false");
  const host = container
    ? "0.0.0.0"
    : await ask(
        "Listen address",
        previous.HOST && previous.HOST !== "0.0.0.0"
          ? previous.HOST
          : "127.0.0.1",
      );
  let network = "",
    trusted = "";
  if (proxy) {
    const external =
      mode === "traefik"
        ? "yes"
        : await ask(
            "Use an existing external Docker proxy network? (yes / no)",
            previous.PROXY_NETWORK ? "yes" : "yes",
          );
    if (!["yes", "no"].includes(external))
      throw new Error("Choose yes or no for the external network");
    if (external === "yes")
      network = await ask(
        "Existing external Docker network name",
        previous.PROXY_NETWORK || "proxy",
      );
    trusted = await ask(
      "Trusted proxy peer IP or CIDR (comma-separated for several)",
      previous.TRUSTED_PROXY || "",
    );
  } else if (mode === "local" && dev === "false")
    trusted = await ask(
      "Trusted proxy IP/CIDR (empty disables trust)",
      previous.TRUSTED_PROXY || "",
    );
  const issuer = await ask(
    "OIDC issuer URL (empty configures login later)",
    previous.OIDC_ISSUER || "",
  );
  const clientId = issuer
    ? await ask("OIDC client ID", previous.OIDC_CLIENT_ID || "")
    : "";
  const method = issuer
    ? await ask(
        "OIDC authentication method (none / client_secret_basic / client_secret_post)",
        previous.OIDC_AUTH_METHOD || "none",
      )
    : "none";
  const secret =
    method === "none"
      ? ""
      : await ask(
          "OIDC client secret",
          previous.OIDC_CLIENT_SECRET || "",
          true,
        );
  const admins = await ask(
    "Administrator OIDC subjects (comma-separated; may be set after first sign-in)",
    previous.ADMIN_SUBJECTS || "",
  );
  const entrypoint =
    mode === "traefik"
      ? await ask(
          "Existing Traefik HTTPS entrypoint",
          previous.TRAEFIK_ENTRYPOINT || "websecure",
        )
      : "websecure";
  const resolver =
    mode === "traefik"
      ? await ask(
          "Existing Traefik certificate resolver (empty uses configured certificates)",
          previous.TRAEFIK_CERT_RESOLVER || "",
        )
      : "";
  const files = [
    "compose.yaml",
    ...(network ? ["compose.proxy.yaml"] : ["compose.local.yaml"]),
    ...(mode === "traefik" ? ["compose.traefik.yaml"] : []),
    ...(mode === "traefik" && resolver ? ["compose.acme.yaml"] : []),
  ];
  const settings: Settings = {
    ...previous,
    SETUP_MODE: mode,
    PORT: port,
    HOST: host,
    BASE_URL: baseUrl,
    DEV_AUTH: dev,
    DATABASE_PATH: container
      ? "/app/data/archipel.sqlite"
      : await ask(
          "SQLite database path",
          previous.DATABASE_PATH?.startsWith("/app/")
            ? "./data/archipel.sqlite"
            : previous.DATABASE_PATH || "./data/archipel.sqlite",
        ),
    TRUSTED_PROXY: trusted,
    OIDC_ISSUER: issuer,
    OIDC_CLIENT_ID: clientId,
    OIDC_AUTH_METHOD: method,
    OIDC_CLIENT_SECRET: secret,
    ADMIN_SUBJECTS: admins,
    REGISTRATION_MODE: await ask(
      "Initial instance registration (open / invite_only; admins can change it in the app)",
      previous.REGISTRATION_MODE || "open",
    ),
    PROXY_NETWORK: network,
    TRAEFIK_HOST: new URL(baseUrl).hostname,
    TRAEFIK_ENTRYPOINT: entrypoint,
    TRAEFIK_CERT_RESOLVER: resolver,
    COMPOSE_FILE: files.join(delimiter),
  };
  validateSetup(settings);
  return settings;
}

export function writeSetup(directory: string, settings: Settings) {
  validateSetup(settings);
  const container = settings.SETUP_MODE !== "local";
  // Compose reads .env for substitutions. Keep container credentials in the raw
  // env_file so dollar signs, hashes and quotes reach the process literally.
  const nodeSettings = {
    ...settings,
    ...(container ? { OIDC_CLIENT_SECRET: "" } : {}),
  };
  const files = [
    {
      name: ".env",
      data:
        "# Generated by npm run setup. Keep this file private.\n" +
        serializeNodeEnv(nodeSettings),
    },
  ];
  if (container)
    files.push({
      name: ".env.container",
      data:
        "# Literal container credentials; read by Compose using format: raw.\nOIDC_CLIENT_SECRET=" +
        settings.OIDC_CLIENT_SECRET +
        "\n",
    });
  const backups: string[] = [];
  for (const file of files) {
    const path = resolve(directory, file.name),
      temporary = `${path}.tmp.${randomUUID()}`;
    if (existsSync(path)) {
      const backup = `${path}.backup.${Date.now()}.${randomUUID()}`;
      copyFileSync(path, backup);
      chmodSync(backup, 0o600);
      backups.push(backup);
    }
    writeFileSync(temporary, file.data, { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  }
  return { files: files.map((f) => resolve(directory, f.name)), backups };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log(
      "Usage: npm run setup -- [--mode local|container|proxy|traefik] [--non-interactive] [--directory PATH]\nNon-interactive mode uses existing configuration and supplied environment variables.\nSetup writes configuration only; it does not start containers or alter proxy networks.",
    );
    return;
  }
  const options: Settings = {};
  let nonInteractive = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--non-interactive") nonInteractive = true;
    else if (["--mode", "--directory"].includes(args[i]) && args[i + 1]) {
      const key = args[i].slice(2);
      options[key] = args[++i];
    } else throw new Error(`Unknown or incomplete option: ${args[i]}`);
  }
  const directory = resolve(
    options.directory || fileURLToPath(new URL("../", import.meta.url)),
  );
  const envPath = resolve(directory, ".env"),
    rawPath = resolve(directory, ".env.container");
  const previous: Settings = existsSync(envPath)
    ? (parseEnv(readFileSync(envPath, "utf8")) as Settings)
    : {};
  if (previous.SETUP_MODE !== "local" && existsSync(rawPath))
    previous.OIDC_CLIENT_SECRET =
      parseRawEnv(readFileSync(rawPath, "utf8")).OIDC_CLIENT_SECRET || "";
  for (const key of [
    ...appKeys,
    "SETUP_MODE",
    "PROXY_NETWORK",
    "TRAEFIK_ENTRYPOINT",
    "TRAEFIK_CERT_RESOLVER",
  ])
    if (process.env[key] !== undefined) previous[key] = process.env[key]!;
  if (!nonInteractive && !process.stdin.isTTY)
    throw new Error(
      "Interactive setup requires a terminal. Use --non-interactive with environment variables instead.",
    );
  let muted = false;
  const output = new Writable({
    write(chunk, _encoding, done) {
      if (!muted) process.stdout.write(chunk);
      done();
    },
  });
  const readline = nonInteractive
    ? null
    : createInterface({
        input: process.stdin,
        output,
        terminal: true,
        historySize: 0,
      });
  const ask: Ask = async (label, value, secret = false) => {
    if (!readline) return value;
    if (secret) {
      process.stdout.write(
        `${label} (hidden${value ? "; Enter keeps current" : ""}; - clears): `,
      );
      muted = true;
      try {
        const answer = await readline.question("");
        return answer === "-" ? "" : answer || value;
      } finally {
        muted = false;
        process.stdout.write("\n");
      }
    }
    const answer = (
      await readline.question(
        `${label}${value ? ` [${value}]` : ""} (- clears): `,
      )
    ).trim();
    return answer === "-" ? "" : answer || value;
  };
  try {
    const settings = await collectSetup(previous, ask, options.mode);
    const result = writeSetup(directory, settings);
    console.log(
      `\nWrote ${result.files.map((f) => f.split(/[\\/]/).pop()).join(" and ")} with private file permissions.`,
    );
    if (result.backups.length)
      console.log(
        "Existing configuration was backed up beside the original files.",
      );
    console.log(`OIDC callback: ${settings.BASE_URL}/auth/callback`);
    if (!settings.OIDC_ISSUER && settings.DEV_AUTH !== "true")
      console.log(
        "Configure an OIDC issuer and client before users can sign in.",
      );
    if (settings.PROXY_NETWORK)
      console.log(
        `The proxy must already be attached to Docker network: ${settings.PROXY_NETWORK}`,
      );
    console.log(
      settings.SETUP_MODE === "local"
        ? "Start with: npm run build && npm start"
        : "Validate with: docker compose config --quiet\nStart with: docker compose up --build -d",
    );
  } finally {
    readline?.close();
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(`Setup failed: ${error.message}`);
    process.exitCode = 1;
  });
}
