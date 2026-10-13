import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";

test("rate limits default sensibly and reject values that are not bounded integers", () => {
  const defaults = loadConfig({});
  assert.deepEqual(
    [defaults.rateLimitApi, defaults.rateLimitAuth, defaults.rateLimitMedia, defaults.rateLimitFederation, defaults.federationSendRate, defaults.federationPeerSendRate],
    [300, 30, 600, 120, 20, 100],
  );
  const set = loadConfig({ RATE_LIMIT_FEDERATION: "500", FEDERATION_SEND_RATE: "5", FEDERATION_PEER_SEND_RATE: "0" });
  assert.deepEqual([set.rateLimitFederation, set.federationSendRate, set.federationPeerSendRate], [500, 5, 0]);
  for (const key of ["RATE_LIMIT_API", "RATE_LIMIT_AUTH", "RATE_LIMIT_MEDIA", "RATE_LIMIT_FEDERATION", "FEDERATION_SEND_RATE", "FEDERATION_PEER_SEND_RATE"])
    for (const value of ["-1", "1.5", "1e3", "many", "100001"])
      assert.throws(() => loadConfig({ [key]: value }), new RegExp(key));
  for (const key of ["RATE_LIMIT_API", "FEDERATION_SEND_RATE"])
    assert.throws(() => loadConfig({ [key]: "0" }), new RegExp(key));
  assert.throws(() => loadConfig({ FEDERATION_SEND_RATE: "1001" }), /FEDERATION_SEND_RATE/);
  assert.equal(defaults.federationSendConcurrency, 4);
  assert.equal(loadConfig({ FEDERATION_SEND_CONCURRENCY: "16" }).federationSendConcurrency, 16);
  for (const value of ["0", "33", "1.5", "many"]) assert.throws(() => loadConfig({ FEDERATION_SEND_CONCURRENCY: value }), /FEDERATION_SEND_CONCURRENCY/);
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
