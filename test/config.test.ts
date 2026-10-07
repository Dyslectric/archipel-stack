import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";

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
