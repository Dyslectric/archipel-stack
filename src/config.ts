import { availableParallelism } from "node:os";
import { parseTrustedProxies } from "./proxy.js";

export interface Config {
  port: number;
  host: string;
  baseUrl: string;
  databasePath: string;
  /** A postgres:// address; when set, PostgreSQL is used instead of the SQLite file. */
  databaseUrl: string;
  /** Optional native Rust chat process pool during the incremental server port. */
  nativeChatUrl: string;
  nativeBridgeSecret: string;
  devAuth: boolean;
  oidcIssuer: string;
  oidcClientId: string;
  oidcSecret: string;
  oidcAuthMethod: "none" | "client_secret_basic" | "client_secret_post";
  adminSubjects: string[];
  trustedProxies: string[];
  registrationMode: "open" | "invite_only";
  xmppDomain: string;
  xmppBridgeSecret: string;
  xmppClientPort: number;
  xmppServerPort: number;
  /** Requests each client may make per minute. */
  rateLimitApi: number;
  rateLimitAuth: number;
  rateLimitMedia: number;
  rateLimitFederation: number;
  /**
   * Outbound federation deliveries: how many go out at a time across all peers, and how many
   * milliseconds pass between one round and the next. Both are the defaults of the instance
   * settings an administrator can change while the instance runs.
   */
  federationSendRate: number;
  federationSendInterval: number;
  /** Independent recipient heads in flight; recipient order is preserved. */
  federationSendConcurrency: number;
  /** Outbound federation deliveries per minute to one peer host; 0 is unlimited. */
  federationPeerSendRate: number;
  /** Processes that write event streams once enough browsers are connected. */
  eventWorkers: number;
  /** Open streams before writing moves to those processes. */
  eventWorkerThreshold: number;
  federationChannelTransport: "off" | "batch" | "stream";
}

export function isLoopback(host: string) {
  return ["localhost", "127.0.0.1", "[::1]", "::1"].includes(host);
}

export function loadConfig(env = process.env): Config {
  const federationChannelTransport = env.FEDERATION_CHANNEL_TRANSPORT || "stream";
  if (!["off", "batch", "stream"].includes(federationChannelTransport))
    throw new Error("FEDERATION_CHANNEL_TRANSPORT must be off, batch or stream");
  const xmppDomain = env.XMPP_DOMAIN || "";
  if (xmppDomain && (!/^[a-z0-9]+(?:[a-z0-9.-]*[a-z0-9])?$/.test(xmppDomain) ||
      xmppDomain.length > 253 || xmppDomain.split(".").some(s => !s || s.length > 63 || s.startsWith("-") || s.endsWith("-"))))
    throw new Error("XMPP_DOMAIN must be a lowercase DNS hostname");
  const xmppBridgeSecret = env.XMPP_BRIDGE_SECRET || "";
  if (xmppDomain && !/^[A-Za-z0-9_-]{43,128}$/.test(xmppBridgeSecret))
    throw new Error("XMPP_BRIDGE_SECRET must be a random base64url secret of at least 43 characters");
  const xmppPort = (key: string, fallback: number) => {
    const value = env[key] || String(fallback);
    if (!/^[0-9]{1,5}$/.test(value) || Number(value) < 1 || Number(value) > 65535)
      throw new Error(`${key} must be an integer between 1 and 65535`);
    return Number(value);
  };
  const xmppClientPort = xmppPort("XMPP_CLIENT_PORT", 5222);
  const xmppServerPort = xmppPort("XMPP_SERVER_PORT", 5269);
  if (xmppDomain && xmppClientPort === xmppServerPort)
    throw new Error("XMPP client and server ports must differ");
  const rate = (key: string, fallback: number, min = 1, max = 100000) => {
    const value = env[key] || String(fallback);
    if (!/^[0-9]{1,6}$/.test(value) || Number(value) < min || Number(value) > max)
      throw new Error(`${key} must be an integer between ${min} and ${max}`);
    return Number(value);
  };
  const databaseUrl = env.DATABASE_URL || "";
  if (databaseUrl && !/^postgres(ql)?:\/\/./.test(databaseUrl))
    throw new Error("DATABASE_URL must be a postgres:// address");
  const nativeBridgeSecret = env.NATIVE_BRIDGE_SECRET || "";
  let nativeChatUrl = env.NATIVE_CHAT_URL || "";
  if (nativeChatUrl) {
    const url = new URL(nativeChatUrl);
    if (!databaseUrl || !["http:","https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/")
      throw new Error("NATIVE_CHAT_URL requires PostgreSQL and an HTTP(S) service origin");
    if (!/^[A-Za-z0-9_-]{43,128}$/.test(nativeBridgeSecret)) throw new Error("NATIVE_BRIDGE_SECRET must be a random base64url secret of at least 43 characters");
    nativeChatUrl = url.origin;
  }
  const registrationMode = env.REGISTRATION_MODE || "open";
  if (!["open", "invite_only"].includes(registrationMode))
    throw new Error("REGISTRATION_MODE must be open or invite_only");
  const port = Number(env.PORT || 8788);
  const host = env.HOST || "127.0.0.1";
  const base = new URL(env.BASE_URL || `http://127.0.0.1:${port}`);
  const devAuth = env.DEV_AUTH === "true";
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid PORT");
  if (
    base.pathname !== "/" ||
    base.search ||
    base.hash ||
    base.username ||
    base.password
  )
    throw new Error("BASE_URL must be an origin");
  if (
    base.protocol !== "https:" &&
    !(base.protocol === "http:" && isLoopback(base.hostname))
  )
    throw new Error("BASE_URL must use HTTPS outside loopback");
  if (
    devAuth &&
    (!isLoopback(host) ||
      !isLoopback(base.hostname) ||
      base.protocol !== "http:")
  )
    throw new Error("DEV_AUTH requires a loopback HTTP listener and BASE_URL");
  const oidcIssuer = env.OIDC_ISSUER || "";
  const oidcClientId = env.OIDC_CLIENT_ID || "";
  if (!!oidcIssuer !== !!oidcClientId)
    throw new Error("Set both OIDC_ISSUER and OIDC_CLIENT_ID");
  if (oidcIssuer) {
    const issuer = new URL(oidcIssuer);
    if (issuer.username || issuer.password || issuer.hash || issuer.search)
      throw new Error("Invalid OIDC_ISSUER");
    if (
      issuer.protocol !== "https:" &&
      !(devAuth && issuer.protocol === "http:" && isLoopback(issuer.hostname))
    )
      throw new Error("OIDC requires HTTPS outside local development");
  }
  const oidcAuthMethod =
    env.OIDC_AUTH_METHOD ||
    (env.OIDC_CLIENT_SECRET ? "client_secret_basic" : "none");
  if (
    !["none", "client_secret_basic", "client_secret_post"].includes(
      oidcAuthMethod,
    )
  )
    throw new Error("Invalid OIDC_AUTH_METHOD");
  if (oidcAuthMethod !== "none" && !env.OIDC_CLIENT_SECRET)
    throw new Error("OIDC_CLIENT_SECRET is required");
  return {
    port,
    host,
    baseUrl: base.origin,
    databasePath: env.DATABASE_PATH || "./data/archipel.sqlite",
    databaseUrl,
    nativeChatUrl, nativeBridgeSecret,
    devAuth,
    oidcIssuer,
    oidcClientId,
    oidcSecret: env.OIDC_CLIENT_SECRET || "",
    oidcAuthMethod: oidcAuthMethod as Config["oidcAuthMethod"],
    trustedProxies: parseTrustedProxies(env.TRUSTED_PROXY),
    registrationMode: registrationMode as Config["registrationMode"],
    xmppDomain,
    xmppBridgeSecret,
    xmppClientPort,
    xmppServerPort,
    rateLimitApi: rate("RATE_LIMIT_API", 300),
    rateLimitAuth: rate("RATE_LIMIT_AUTH", 30),
    rateLimitMedia: rate("RATE_LIMIT_MEDIA", 600),
    rateLimitFederation: rate("RATE_LIMIT_FEDERATION", 120),
    federationChannelTransport: federationChannelTransport as Config["federationChannelTransport"],
    federationSendRate: rate("FEDERATION_SEND_RATE", 20, 1, 1000),
    federationSendInterval: rate("FEDERATION_SEND_INTERVAL", 1000, 100, 600000),
    federationSendConcurrency: rate("FEDERATION_SEND_CONCURRENCY", 4, 1, 32),
    federationPeerSendRate: rate("FEDERATION_PEER_SEND_RATE", 100, 0),
    eventWorkers: rate("EVENT_WORKERS", Math.min(4, Math.max(0, availableParallelism() - 2)), 0, 32),
    eventWorkerThreshold: rate("EVENT_WORKER_THRESHOLD", 512, 0),
    adminSubjects: (env.ADMIN_SUBJECTS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  };
}
