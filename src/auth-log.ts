import { randomUUID } from "node:crypto";
import type { Config } from "./config.js";
import { OidcFailure, type OidcStage } from "./oidc.js";

const names = new Set([
  "Error",
  "TypeError",
  "SyntaxError",
  "ClientError",
  "ResponseBodyError",
  "AuthorizationResponseError",
  "WWWAuthenticateChallengeError",
  "OperationProcessingError",
  "UnsupportedOperationError",
  "TimeoutError",
  "AbortError",
  "Problem",
]);
const codes = new Set([
  "OAUTH_WWW_AUTHENTICATE_CHALLENGE",
  "OAUTH_RESPONSE_BODY_ERROR",
  "OAUTH_UNSUPPORTED_OPERATION",
  "OAUTH_AUTHORIZATION_RESPONSE_ERROR",
  "OAUTH_JWT_USERINFO_EXPECTED",
  "OAUTH_PARSE_ERROR",
  "OAUTH_INVALID_RESPONSE",
  "OAUTH_INVALID_REQUEST",
  "OAUTH_RESPONSE_IS_NOT_JSON",
  "OAUTH_RESPONSE_IS_NOT_CONFORM",
  "OAUTH_HTTP_REQUEST_FORBIDDEN",
  "OAUTH_REQUEST_PROTOCOL_FORBIDDEN",
  "OAUTH_JWT_TIMESTAMP_CHECK_FAILED",
  "OAUTH_JWT_CLAIM_COMPARISON_FAILED",
  "OAUTH_JSON_ATTRIBUTE_COMPARISON_FAILED",
  "OAUTH_KEY_SELECTION_FAILED",
  "OAUTH_MISSING_SERVER_METADATA",
  "OAUTH_INVALID_SERVER_METADATA",
  "OAUTH_TIMEOUT",
  "OAUTH_ABORT",
  "ERR_INVALID_ARG_TYPE",
  "ERR_INVALID_ARG_VALUE",
  "ERR_SQLITE_ERROR",
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);
const oauthErrors = new Set([
  "invalid_request",
  "invalid_client",
  "invalid_grant",
  "invalid_scope",
  "unauthorized_client",
  "access_denied",
  "unsupported_response_type",
  "server_error",
  "temporarily_unavailable",
  "interaction_required",
  "login_required",
  "consent_required",
  "account_selection_required",
  "invalid_token",
  "insufficient_scope",
  "unsupported_grant_type",
]);
const claims = new Set([
  "iss",
  "sub",
  "aud",
  "nonce",
  "exp",
  "iat",
  "nbf",
  "auth_time",
  "azp",
  "c_hash",
  "s_hash",
  "at_hash",
]);
const attributes = new Set([
  "issuer",
  "authorization_endpoint",
  "token_endpoint",
  "userinfo_endpoint",
  "jwks_uri",
  "sub",
  "state",
  "client_id",
  "redirect_uri",
  "scope",
]);
const reasons = new Map([
  ["OIDC sign-in is not configured.", "oidc_not_configured"],
  ["OIDC issuer mismatch", "discovery_issuer_mismatch"],
  ["OIDC endpoints require HTTPS", "insecure_oidc_endpoint"],
  ["Invalid OIDC endpoint", "invalid_oidc_endpoint"],
  ["Sign-in expired. Please start again.", "missing_or_expired_flow"],
  ["The identity provider returned an invalid identity.", "invalid_identity"],
  [
    "A signed asymmetric ID token is required.",
    "unsupported_id_token_algorithm",
  ],
  ["The identity profile is too large.", "profile_too_large"],
  ["fetch failed", "network_request_failed"],
  ["JWT signature verification failed", "invalid_token_signature"],
]);

/** Select diagnostic identifiers only. Never serialize an exception, response,
 * provider description, JWT claims, HTTP headers, or callback query. */
export function signInFailureDetails(error: unknown) {
  const root = error instanceof OidcFailure ? error.cause : error;
  const detail: {
    error_type: string;
    reason: string;
    codes: string[];
    oauth_error?: string;
    http_status?: number;
    claim?: string;
    attribute?: string;
  } = { error_type: "Error", reason: "unexpected_error", codes: [] };
  const visited = new Set<object>();
  let current = root;
  for (
    let depth = 0;
    depth < 6 &&
    current &&
    typeof current === "object" &&
    !visited.has(current);
    depth++
  ) {
    visited.add(current);
    const value = current as Record<string, unknown>;
    if (depth === 0 && typeof value.name === "string" && names.has(value.name))
      detail.error_type = value.name;
    if (typeof value.message === "string" && reasons.has(value.message))
      detail.reason = reasons.get(value.message)!;
    if (
      typeof value.code === "string" &&
      codes.has(value.code) &&
      !detail.codes.includes(value.code)
    )
      detail.codes.push(value.code);
    if (typeof value.error === "string" && oauthErrors.has(value.error))
      detail.oauth_error ||= value.error;
    if (
      typeof value.status === "number" &&
      Number.isInteger(value.status) &&
      value.status >= 100 &&
      value.status <= 599
    )
      detail.http_status ||= value.status;
    if (typeof value.claim === "string" && claims.has(value.claim))
      detail.claim ||= value.claim;
    if (typeof value.attribute === "string" && attributes.has(value.attribute))
      detail.attribute ||= value.attribute;
    current = value.cause;
  }
  if (detail.reason === "unexpected_error")
    detail.reason = detail.oauth_error || detail.codes[0] || detail.reason;
  return detail;
}

export function signInFailureHint(
  detail: ReturnType<typeof signInFailureDetails>,
) {
  if (
    detail.oauth_error === "invalid_client" ||
    detail.oauth_error === "unauthorized_client"
  )
    return "Check OIDC_CLIENT_ID, the client secret, and OIDC_AUTH_METHOD against the provider's client registration.";
  if (detail.oauth_error === "invalid_grant")
    return "Start a fresh sign-in and verify the registered redirect URI matches this application's callback exactly.";
  if (detail.reason === "missing_or_expired_flow")
    return "Start sign-in again. Check BASE_URL and that the browser sends the archipel-flow cookie on the callback.";
  if (
    detail.reason === "discovery_issuer_mismatch" ||
    detail.claim === "iss" ||
    detail.attribute === "issuer"
  )
    return "OIDC_ISSUER must exactly match the provider's advertised issuer and ID token issuer.";
  if (detail.claim === "aud")
    return "The ID token audience must match OIDC_CLIENT_ID.";
  if (detail.claim === "nonce")
    return "The provider's ID token nonce did not match this sign-in attempt.";
  if (detail.claim === "sub" || detail.attribute === "sub")
    return "UserInfo must identify the same subject as the validated ID token.";
  if (detail.reason === "invalid_token_signature")
    return "Check that the provider's published JWKS contains the key that signed the ID token.";
  if (detail.codes.some((code) => ["ENOTFOUND", "EAI_AGAIN"].includes(code)))
    return "The application could not resolve the provider hostname. Check DNS inside the container.";
  if (detail.codes.includes("ECONNREFUSED"))
    return "The provider refused the connection. Check reachability from inside the container.";
  if (detail.codes.some((code) => /CERT|ISSUER_CERT|LEAF_SIGNATURE/.test(code)))
    return "Check the provider's TLS certificate chain and the container's trusted certificates.";
  if (detail.codes.some((code) => /TIMEOUT/.test(code)))
    return "The provider request timed out. Check connectivity from inside the container.";
  if (
    detail.http_status === 403 ||
    detail.codes.includes("OAUTH_RESPONSE_IS_NOT_JSON")
  )
    return "Check the provider's proxy/WAF rules: discovery, token, JWKS, and UserInfo endpoints must accept server requests and return protocol responses.";
  if (detail.codes.includes("OAUTH_JWT_TIMESTAMP_CHECK_FAILED"))
    return "Check both server clocks and the ID token's validity period.";
  if (detail.codes.includes("OAUTH_KEY_SELECTION_FAILED"))
    return "Check the provider's JWKS and the ID token's signing key identifier.";
  return "Check the failed stage and diagnostic identifiers; tokens and provider response bodies are deliberately omitted.";
}

export function logSignInFailure(
  error: unknown,
  config: Config,
  context: {
    stage: OidcStage;
    flow_cookie_present?: boolean;
    state_present?: boolean;
    code_present?: boolean;
    request_host_matches_base?: boolean;
  },
) {
  const reference = randomUUID();
  const detail = signInFailureDetails(error);
  console.error(
    JSON.stringify({
      event: "oidc.signin_failed",
      reference,
      ...context,
      stage: error instanceof OidcFailure ? error.stage : context.stage,
      issuer: config.oidcIssuer,
      redirect_uri: `${config.baseUrl}/auth/callback`,
      client_auth_method: config.oidcAuthMethod,
      ...detail,
      hint: signInFailureHint(detail),
    }),
  );
  return reference;
}
