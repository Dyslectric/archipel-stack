import * as oidc from "openid-client";
import { Config, isLoopback } from "./config.js";
import { Problem, Store, hash, randomToken } from "./store.js";

export type OidcStage =
  | "configuration"
  | "discovery"
  | "authorization_start"
  | "callback_validation"
  | "token_exchange"
  | "identity_validation"
  | "userinfo"
  | "profile_validation"
  | "identity_storage"
  | "session_creation";

export class OidcFailure extends Error {
  constructor(
    readonly stage: OidcStage,
    cause: unknown,
  ) {
    super("OIDC sign-in failed", { cause });
    this.name = "OidcFailure";
  }
}

function failure(stage: OidcStage, error: unknown) {
  return error instanceof OidcFailure ? error : new OidcFailure(stage, error);
}

export function createOidc(config: Config, store: Store) {
  let clientPromise: Promise<oidc.Configuration> | undefined;
  const callback = `${config.baseUrl}/auth/callback`;
  const safeFetch: oidc.CustomFetch = async (input, init) => {
    const url = new URL(input);
    if (
      url.protocol !== "https:" &&
      !(config.devAuth && url.protocol === "http:" && isLoopback(url.hostname))
    )
      throw new Error("OIDC endpoints require HTTPS");
    if (url.username || url.password) throw new Error("Invalid OIDC endpoint");
    return fetch(input, {
      ...init,
      body: init.body as BodyInit,
      redirect: "error",
      signal: init.signal
        ? AbortSignal.any([init.signal, AbortSignal.timeout(15000)])
        : AbortSignal.timeout(15000),
    });
  };
  async function client() {
    if (!config.oidcIssuer)
      throw failure(
        "configuration",
        new Problem(503, "OIDC sign-in is not configured."),
      );
    clientPromise ||= (async () => {
      const authentication =
        config.oidcAuthMethod === "client_secret_basic"
          ? oidc.ClientSecretBasic(config.oidcSecret)
          : config.oidcAuthMethod === "client_secret_post"
            ? oidc.ClientSecretPost(config.oidcSecret)
            : oidc.None();
      const result = await oidc.discovery(
        new URL(config.oidcIssuer),
        config.oidcClientId,
        { token_endpoint_auth_method: config.oidcAuthMethod },
        authentication,
        {
          [oidc.customFetch]: safeFetch,
          ...(config.devAuth ? { execute: [oidc.allowInsecureRequests] } : {}),
        },
      );
      if (result.serverMetadata().issuer !== config.oidcIssuer)
        throw new Error("OIDC issuer mismatch");
      result.timeout = 15;
      oidc.enableNonRepudiationChecks(result);
      return result;
    })().catch((error) => {
      clientPromise = undefined;
      throw failure("discovery", error);
    });
    return clientPromise;
  }
  return {
    async begin() {
      try {
        const configuration = await client();
        const state = oidc.randomState(),
          nonce = oidc.randomNonce(),
          verifier = oidc.randomPKCECodeVerifier(),
          browser = randomToken();
        store.db
          .prepare("DELETE FROM auth_flows WHERE expires_at<=?")
          .run(Date.now());
        store.db
          .prepare("INSERT INTO auth_flows VALUES(?,?,?,?,?)")
          .run(
            hash(state),
            hash(browser),
            verifier,
            nonce,
            Date.now() + 10 * 60000,
          );
        const url = oidc.buildAuthorizationUrl(configuration, {
          redirect_uri: callback,
          response_type: "code",
          scope: "openid profile",
          state,
          nonce,
          code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
          code_challenge_method: "S256",
        });
        return { url: url.href, browser };
      } catch (error) {
        throw failure("authorization_start", error);
      }
    },
    async complete(query: string, browser: string) {
      let stage: OidcStage = "callback_validation";
      try {
        const url = new URL(callback);
        url.search = query;
        const state = url.searchParams.get("state");
        if (!state || !browser)
          throw new Problem(400, "Sign-in expired. Please start again.");
        const flow = store.db
          .prepare(
            "SELECT * FROM auth_flows WHERE state_hash=? AND browser_hash=? AND expires_at>?",
          )
          .get(hash(state), hash(browser), Date.now()) as
          | { verifier: string; nonce: string }
          | undefined;
        if (!flow)
          throw new Problem(400, "Sign-in expired. Please start again.");
        store.db
          .prepare("DELETE FROM auth_flows WHERE state_hash=?")
          .run(hash(state));
        const configuration = await client();
        stage = "token_exchange";
        const tokens = await oidc.authorizationCodeGrant(configuration, url, {
          expectedState: state,
          expectedNonce: flow.nonce,
          pkceCodeVerifier: flow.verifier,
          idTokenExpected: true,
        });
        stage = "identity_validation";
        const claims = tokens.claims();
        if (!claims?.sub || !claims.iss || claims.iss !== config.oidcIssuer)
          throw new Problem(
            400,
            "The identity provider returned an invalid identity.",
          );
        if (String(tokens.id_token).split(".")[0]) {
          const header = JSON.parse(
            Buffer.from(tokens.id_token!.split(".")[0], "base64url").toString(),
          );
          if (
            typeof header.alg !== "string" ||
            header.alg === "none" ||
            header.alg.startsWith("HS")
          )
            throw new Problem(400, "A signed asymmetric ID token is required.");
        }
        stage = "userinfo";
        const profile = configuration.serverMetadata().userinfo_endpoint
          ? await oidc.fetchUserInfo(
              configuration,
              tokens.access_token,
              claims.sub,
            )
          : claims;
        stage = "profile_validation";
        const name =
          typeof profile.preferred_username === "string"
            ? profile.preferred_username
            : "member";
        const socials = Array.isArray(profile.verified_socials)
          ? profile.verified_socials.slice(0, 30)
          : [];
        if (JSON.stringify(socials).length > 16000)
          throw new Problem(400, "The identity profile is too large.");
        stage = "identity_storage";
        return store.loginIdentity(
          config.oidcIssuer,
          claims.sub,
          name,
          socials,
          config.adminSubjects.includes(claims.sub),
        );
      } catch (error) {
        throw failure(stage, error);
      }
    },
  };
}
