import { test } from "node:test";
import assert from "node:assert/strict";
import {
  logSignInFailure,
  signInFailureDetails,
  signInFailureHint,
} from "../src/auth-log.js";
import { OidcFailure } from "../src/oidc.js";
import { loadConfig } from "../src/config.js";

test("authentication diagnostics report nested validation identifiers without logging credentials or claims", (t) => {
  const sensitive = "private-secret-token-claim-and-provider-description";
  const cause = Object.assign(new Error(sensitive), {
    code: "OAUTH_JWT_CLAIM_COMPARISON_FAILED",
    cause: {
      claim: "nonce",
      expected: sensitive,
      claims: {
        nonce: sensitive,
        sub: sensitive,
        verified_socials: [sensitive],
      },
      body: { access_token: sensitive },
    },
  });
  const error = new OidcFailure("token_exchange", cause);
  const output: string[] = [];
  t.mock.method(console, "error", (line: string) => output.push(line));
  const config = loadConfig({
    BASE_URL: "https://chat.example",
    OIDC_ISSUER: "https://identity.example",
    OIDC_CLIENT_ID: "archipel",
    OIDC_AUTH_METHOD: "client_secret_basic",
    OIDC_CLIENT_SECRET: sensitive,
  });
  const reference = logSignInFailure(error, config, {
    stage: "callback_validation",
    flow_cookie_present: true,
    state_present: true,
    code_present: true,
  });
  assert.equal(output.length, 1);
  assert.ok(!output[0].includes(sensitive));
  const logged = JSON.parse(output[0]);
  assert.equal(logged.reference, reference);
  assert.equal(logged.stage, "token_exchange");
  assert.equal(logged.claim, "nonce");
  assert.deepEqual(logged.codes, ["OAUTH_JWT_CLAIM_COMPARISON_FAILED"]);
  assert.match(logged.hint, /nonce/);
});

test("provider errors and nested TLS/network errors produce actionable safe hints", () => {
  const sensitive = "provider echoed a private token";
  const error = Object.assign(new Error(sensitive), {
    name: "ResponseBodyError",
    code: "OAUTH_RESPONSE_BODY_ERROR",
    error: "invalid_client",
    error_description: sensitive,
    status: 401,
    cause: {
      error: "invalid_client",
      error_description: sensitive,
      access_token: sensitive,
    },
  });
  const detail = signInFailureDetails(error);
  assert.equal(detail.oauth_error, "invalid_client");
  assert.equal(detail.http_status, 401);
  assert.match(signInFailureHint(detail), /OIDC_AUTH_METHOD/);
  assert.ok(!JSON.stringify(detail).includes(sensitive));
  const network = signInFailureDetails(
    new TypeError("fetch failed", {
      cause: Object.assign(new Error(sensitive), {
        code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
      }),
    }),
  );
  assert.deepEqual(network.codes, ["UNABLE_TO_VERIFY_LEAF_SIGNATURE"]);
  assert.match(signInFailureHint(network), /TLS certificate/);
  const dns = signInFailureDetails(
    new TypeError("fetch failed", { cause: { code: "ENOTFOUND" } }),
  );
  assert.match(signInFailureHint(dns), /DNS inside the container/);
});

test("unknown exceptions and cycles remain bounded and never serialize untrusted error text", () => {
  const sensitive = "private-value";
  const error: Record<string, unknown> = {
    name: sensitive,
    code: sensitive,
    claim: sensitive,
    attribute: sensitive,
    error: sensitive,
    message: sensitive,
    stack: sensitive,
  };
  error.cause = error;
  assert.deepEqual(signInFailureDetails(error), {
    error_type: "Error",
    reason: "unexpected_error",
    codes: [],
  });
});
