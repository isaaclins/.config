import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { BeeperApiClient } from "./api.ts";
import { storeToken, type TokenStore } from "./credentials.ts";
import type { OAuthClientRegistration, OAuthTokenResponse } from "./types.ts";

const execFileAsync = promisify(execFile);
const CALLBACK_PATH = "/oauth/callback";

export interface OAuthSetupOptions {
  api: BeeperApiClient;
  tokenStore: TokenStore;
  clientName?: string;
  openUrl?: (url: string) => Promise<void>;
  signal?: AbortSignal;
}

export interface OAuthSetupStarted {
  url: string;
  redirectURI: string;
  browserOpened: boolean;
  waitForCompletion: Promise<OAuthTokenResponse>;
  close(): Promise<void>;
}

export class OAuthSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OAuthSetupError";
  }
}

export function createCodeVerifier(): string {
  return base64url(randomBytes(32));
}

export function createCodeChallenge(codeVerifier: string): string {
  return base64url(createHash("sha256").update(codeVerifier).digest());
}

export function createOAuthState(): string {
  return base64url(randomBytes(24));
}

export function buildAuthorizationURL(
  registration: OAuthClientRegistration,
  redirectURI: string,
  codeChallenge: string,
  state: string,
): string {
  const url = new URL(registration.authorization_endpoint);
  url.searchParams.set("client_id", registration.client_id);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", redirectURI);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("scope", registration.scope || "read write");
  url.searchParams.set("state", state);
  return url.toString();
}

export async function openConsentURL(url: string): Promise<void> {
  await execFileAsync("open", [url], { encoding: "utf8" });
}

export async function startOAuthSetup(options: OAuthSetupOptions): Promise<OAuthSetupStarted> {
  const codeVerifier = createCodeVerifier();
  const codeChallenge = createCodeChallenge(codeVerifier);
  const state = createOAuthState();
  let server: Server | undefined;
  let registration: OAuthClientRegistration;
  let completionResolve: (value: OAuthTokenResponse) => void = () => {};
  let completionReject: (reason?: unknown) => void = () => {};
  let settled = false;

  const waitForCompletion = new Promise<OAuthTokenResponse>((resolve, reject) => {
    completionResolve = resolve;
    completionReject = reject;
  });

  const close = async (): Promise<void> => {
    if (!server) return;
    await new Promise<void>((resolve) => {
      server?.close(() => resolve());
      server = undefined;
    });
  };

  const complete = async (code: string): Promise<void> => {
    if (settled) return;
    settled = true;
    try {
      const token = await options.api.exchangeOAuthCode({
        tokenEndpoint: registration.token_endpoint,
        clientID: registration.client_id,
        code,
        codeVerifier,
        signal: options.signal,
      });
      storeToken(options.tokenStore, token.access_token);
      completionResolve(token);
    } catch (error) {
      completionReject(error);
    } finally {
      await close();
    }
  };

  const callbackHandler = (request: IncomingMessage, response: ServerResponse): void => {
    const requestURL = new URL(request.url ?? "/", "http://127.0.0.1");
    if (requestURL.pathname !== CALLBACK_PATH) {
      response.statusCode = 404;
      response.end("Not found");
      return;
    }

    if (requestURL.searchParams.get("state") !== state) {
      response.statusCode = 400;
      response.end("Invalid OAuth state. Return to Pi and start setup again.");
      return;
    }

    const error = requestURL.searchParams.get("error");
    if (error) {
      response.statusCode = 400;
      response.end("Beeper authorization was not completed. Return to Pi and retry setup.");
      completionReject(new OAuthSetupError(`Beeper authorization failed: ${error}`));
      settled = true;
      void close();
      return;
    }

    const code = requestURL.searchParams.get("code");
    if (!code) {
      response.statusCode = 400;
      response.end("Beeper authorization did not return a code.");
      return;
    }

    response.statusCode = 200;
    response.setHeader("Content-Type", "text/plain; charset=utf-8");
    response.end("Beeper authorization received. You can return to Pi.");
    void complete(code);
  };

  server = createServer(callbackHandler);
  try {
    await listenLoopback(server);
    const address = server.address();
    if (!address || typeof address === "string") throw new OAuthSetupError("Could not determine the loopback callback port");
    const redirectURI = `http://127.0.0.1:${address.port}${CALLBACK_PATH}`;
    registration = await options.api.registerOAuthClient({
      clientName: options.clientName ?? "Pi Beeper",
      redirectURI,
      signal: options.signal,
    });
    const url = buildAuthorizationURL(registration, redirectURI, codeChallenge, state);
    let browserOpened = false;
    try {
      await (options.openUrl ?? openConsentURL)(url);
      browserOpened = true;
    } catch {
      // The URL is still returned so the user can open it manually.
    }

    return { url, redirectURI, browserOpened, waitForCompletion, close };
  } catch (error) {
    await close();
    throw error;
  }
}

async function listenLoopback(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });
}

function base64url(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}
