import { lookup } from "node:dns/promises";
import { request as httpRequest, Agent as HttpAgent } from "node:http";
import { request as httpsRequest, Agent as HttpsAgent } from "node:https";
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";
import { createHash, sign, verify, createPublicKey } from "node:crypto";
import type { Request } from "express";
import type { Config } from "./config.js";
import { isLoopback } from "./config.js";
import { Problem } from "./store.js";

const peerAgents = new Map<string, HttpAgent | HttpsAgent>();
function peerAgent(url: URL, address: { address: string; family: number }, headers: Record<string, string>, body?: string | Buffer) {
  // Pin each pool to the currently validated IP, not just a hostname. DNS is
  // rechecked before every request; a different address selects a different pool.
  // Discovery, signed reads and POSTs have separate pools so inbox authentication
  // and signed history callbacks cannot deadlock behind each other's connections.
  const kind = headers.accept === "text/event-stream" ? "stream" : body !== undefined ? "post" : headers.signature ? "signed-read" : "discovery";
  const key = `${url.origin}|${address.family}|${address.address}|${kind}`;
  let agent = peerAgents.get(key);
  if (agent) { peerAgents.delete(key); peerAgents.set(key, agent); return agent; }
  if (peerAgents.size >= 64) {
    const oldest = peerAgents.keys().next().value!;
    peerAgents.get(oldest)!.destroy(); peerAgents.delete(oldest);
  }
  const options = { keepAlive: true, maxSockets: kind === "stream" ? 128 : 64, maxFreeSockets: 4, timeout: kind === "stream" ? 0 : 5000 };
  agent = url.protocol === "https:" ? new HttpsAgent(options) : new HttpAgent(options);
  peerAgents.set(key, agent); return agent;
}

export function publicAddress(address: string) {
  try {
    return ipaddr.process(address).range() === "unicast";
  } catch {
    return false;
  }
}
export function peerUrl(value: unknown, config: Config) {
  if (typeof value !== "string" || value.length > 2048)
    throw new Problem(400, "Invalid federation URL.");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Problem(400, "Use an absolute HTTPS actor or instance URL.");
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const local =
    config.devAuth &&
    isLoopback(config.host) &&
    isLoopback(new URL(config.baseUrl).hostname) &&
    isLoopback(hostname);
  if (
    url.username ||
    url.password ||
    url.hash ||
    (url.protocol !== "https:" && !(local && url.protocol === "http:"))
  )
    throw new Problem(
      400,
      "Federation requires HTTPS; loopback HTTP is allowed only in local development.",
    );
  if (isIP(hostname) && !publicAddress(hostname) && !local)
    throw new Problem(
      400,
      "Private network federation targets are prohibited.",
    );
  return url;
}
export function digest(body: Buffer | string) {
  return `SHA-256=${createHash("sha256").update(body).digest("base64")}`;
}
export function signedHeaders(
  url: URL,
  method: string,
  actor: string,
  privateKey: string,
  body?: Buffer | string,
  date = new Date().toUTCString(),
) {
  const headers: Record<string, string> = {
    host: url.host,
    date,
    accept: "application/activity+json",
  };
  const names = ["(request-target)", "host", "date"];
  if (body !== undefined) {
    headers.digest = digest(body);
    headers["content-type"] = "application/activity+json";
    names.push("digest");
  }
  const canonical = names
    .map(
      (name) =>
        `${name}: ${name === "(request-target)" ? `${method.toLowerCase()} ${url.pathname}${url.search}` : headers[name]}`,
    )
    .join("\n");
  const signature = sign(
    "RSA-SHA256",
    Buffer.from(canonical),
    privateKey,
  ).toString("base64");
  headers.signature = `keyId="${actor}#main-key",algorithm="rsa-sha256",headers="${names.join(" ")}",signature="${signature}"`;
  return headers;
}
export async function peerRequest(
  url: URL,
  config: Config,
  headers: Record<string, string> = {},
  body?: string | Buffer,
  maxBytes = 262144,
  timeoutMs = 15000,
  method?: "GET" | "HEAD",
  stream?: (response: import("node:http").IncomingMessage) => Promise<void>,
  signal?: AbortSignal,
) {
  peerUrl(url.href, config);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const local = config.devAuth && isLoopback(hostname);
  const addresses = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) }]
    : await lookup(hostname, { all: true });
  if (
    !addresses.length ||
    addresses.some(
      (a) => !publicAddress(a.address) && !(local && isLoopback(a.address)),
    )
  )
    throw new Problem(
      400,
      "Federation DNS resolved to a private or reserved address.",
    );
  const address = addresses[0];
  return await new Promise<{ body: Buffer; type: string; status: number; headers: import("node:http").IncomingHttpHeaders }>(
    (resolve, reject) => {
      const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
        url,
        {
          method: method || (body === undefined ? "GET" : "POST"),
          headers,
          agent: peerAgent(url, address, headers, body),
          family: address.family,
          lookup: (_host, _options, done) =>
            done(null, address.address, address.family),
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
        },
        (response) => {
          if (
            !response.statusCode ||
            response.statusCode < 200 ||
            (response.statusCode >= 300 && !(method && response.statusCode === 416))
          ) {
            response.resume();
            reject(
              new Problem(
                response.statusCode || 502,
                `Peer returned HTTP ${response.statusCode || 502}.`,
              ),
            );
            return;
          }
          if (stream) {
            stream(response).then(() => resolve({body: Buffer.alloc(0), type: String(response.headers["content-type"] || ""), status: response.statusCode!, headers: response.headers}), reject);
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          response.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > maxBytes) {
              response.destroy();
              reject(new Problem(502, "Peer response exceeds the size limit."));
            } else chunks.push(chunk);
          });
          response.on("end", () =>
            resolve({
              body: Buffer.concat(chunks),
              type: String(response.headers["content-type"] || ""),
              status: response.statusCode!,
              headers: response.headers,
            }),
          );
          response.on("error", reject);
        },
      );
      request.on("error", reject);
      request.end(body);
    },
  );
}
export async function peerJson(
  url: URL,
  config: Config,
  headers: Record<string, string> = {},
) {
  const response = await peerRequest(url, config, {
    accept: "application/activity+json, application/json",
    ...headers,
  });
  if (
    !/^application\/(activity\+json|ld\+json|jrd\+json|json)(;|$)/i.test(
      response.type,
    )
  )
    throw new Problem(502, "Peer did not return ActivityStreams JSON.");
  try {
    return JSON.parse(response.body.toString()) as Record<string, any>;
  } catch {
    throw new Problem(502, "Peer returned invalid JSON.");
  }
}
export function signatureKey(req: Request) {
  const raw = req.headers.signature;
  if (typeof raw !== "string" || raw.length > 8000)
    throw new Problem(401, "A signed federation request is required.");
  const values: Record<string, string> = {};
  for (const part of raw.split(",")) {
    const match = /^\s*([a-zA-Z]+)="([^"\r\n]+)"\s*$/.exec(part);
    if (!match || values[match[1]])
      throw new Problem(401, "Invalid HTTP signature.");
    values[match[1]] = match[2];
  }
  if (values.algorithm !== "rsa-sha256" || !values.keyId?.endsWith("#main-key"))
    throw new Problem(401, "Unsupported HTTP signature.");
  return values;
}
export function verifyRequest(
  req: Request,
  actor: Record<string, any>,
  rawBody?: Buffer,
) {
  const values = signatureKey(req);
  if (
    actor.publicKey?.id !== values.keyId ||
    actor.publicKey?.owner !== actor.id
  )
    throw new Problem(401, "Signing key does not belong to the actor.");
  const date = req.headers.date;
  if (
    typeof date !== "string" ||
    !Number.isFinite(Date.parse(date)) ||
    Math.abs(Date.now() - Date.parse(date)) > 5 * 60000
  )
    throw new Problem(401, "Federation signature date expired.");
  const names = values.headers?.split(" ") || [];
  const required = [
    "(request-target)",
    "host",
    "date",
    ...(rawBody ? ["digest"] : []),
  ];
  if (
    !required.every((n) => names.includes(n)) ||
    new Set(names).size !== names.length
  )
    throw new Problem(401, "HTTP signature omits required headers.");
  if (rawBody && req.headers.digest !== digest(rawBody))
    throw new Problem(401, "Federation body digest mismatch.");
  const canonical = names
    .map((name) => {
      const value =
        name === "(request-target)"
          ? `${req.method.toLowerCase()} ${req.originalUrl}`
          : req.headers[name];
      if (typeof value !== "string" || /[\r\n]/.test(value))
        throw new Problem(401, "Invalid signed header.");
      return `${name}: ${value}`;
    })
    .join("\n");
  const key = createPublicKey(actor.publicKey.publicKeyPem);
  if (
    key.asymmetricKeyType !== "rsa" ||
    (key.asymmetricKeyDetails?.modulusLength || 0) < 2048 ||
    !verify(
      "RSA-SHA256",
      Buffer.from(canonical),
      key,
      Buffer.from(values.signature || "", "base64"),
    )
  )
    throw new Problem(401, "Federation signature verification failed.");
}
