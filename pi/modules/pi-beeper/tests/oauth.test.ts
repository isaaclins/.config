import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAuthorizationURL,
  createCodeChallenge,
  startOAuthSetup,
  type BeeperApiClient,
  type TokenStore,
} from "../src/index.ts";
import type { OAuthClientRegistration, OAuthTokenResponse } from "../src/types.ts";

const registration: OAuthClientRegistration = {
  client_id: "client-1",
  client_name: "Pi Beeper",
  grant_types: ["authorization_code"],
  response_types: ["code"],
  redirect_uris: [],
  scope: "read write",
  token_endpoint_auth_method: "none",
  client_id_issued_at: 1,
  authorization_endpoint: "http://127.0.0.1:23373/oauth/authorize",
  token_endpoint: "http://127.0.0.1:23373/oauth/token",
};

test("PKCE challenge and authorization URL use S256 and state", () => {
  assert.equal(
    createCodeChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
    "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  );
  const url = buildAuthorizationURL(
    registration,
    "http://127.0.0.1:4242/oauth/callback",
    "challenge",
    "state",
  );
  const parsed = new URL(url);
  assert.equal(parsed.searchParams.get("client_id"), "client-1");
  assert.equal(parsed.searchParams.get("response_type"), "code");
  assert.equal(parsed.searchParams.get("code_challenge"), "challenge");
  assert.equal(parsed.searchParams.get("code_challenge_method"), "S256");
  assert.equal(parsed.searchParams.get("state"), "state");
});

test("OAuth setup returns a human approval URL and exchanges only after the loopback callback", async () => {
  let openedURL = "";
  let storedToken = "";
  let exchangedCode = "";
  const tokenStore: TokenStore = {
    read: () => undefined,
    write: (token) => {
      storedToken = token;
    },
  };
  const api = {
    registerOAuthClient: async ({ redirectURI }: { redirectURI: string }) => ({
      ...registration,
      redirect_uris: [redirectURI],
    }),
    exchangeOAuthCode: async ({ code }: { code: string }): Promise<OAuthTokenResponse> => {
      exchangedCode = code;
      return { access_token: "synthetic-oauth-token", token_type: "Bearer", expires_in: 3600, scope: "read write" };
    },
  } as unknown as BeeperApiClient;

  const setup = await startOAuthSetup({
    api,
    tokenStore,
    openUrl: async (url) => {
      openedURL = url;
    },
  });
  assert.equal(openedURL, setup.url);
  const approvalURL = new URL(setup.url);
  const callback = new URL(setup.redirectURI);
  callback.searchParams.set("code", "human-approved-code");
  callback.searchParams.set("state", approvalURL.searchParams.get("state")!);
  const response = await fetch(callback);
  assert.equal(response.status, 200);
  await setup.waitForCompletion;
  assert.equal(exchangedCode, "human-approved-code");
  assert.equal(storedToken, "synthetic-oauth-token");
  await setup.close();
});
