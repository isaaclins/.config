import { execFile } from "node:child_process";
import { platform } from "node:os";
import { promisify } from "node:util";
import type {
  BeeperAccount,
  BeeperAddReactionOutput,
  BeeperInfo,
  BeeperListChatsOutput,
  BeeperListMessagesOutput,
  BeeperSearchChatsOutput,
  BeeperSearchMessagesOutput,
  OAuthClientRegistration,
  OAuthTokenResponse,
} from "./types.ts";
import { redactTokenText } from "./security.ts";

const execFileAsync = promisify(execFile);

export const BEEPER_BASE_URL = "http://127.0.0.1:23373";

export type BeeperDiagnosticCode =
  | "BEEPER_NOT_RUNNING"
  | "BEEPER_PORT_CLOSED"
  | "BEEPER_TOKEN_MISSING"
  | "BEEPER_TOKEN_REVOKED"
  | "BEEPER_ACCOUNT_LOGGED_OUT"
  | "BEEPER_ACCOUNT_NOT_READY"
  | "BEEPER_REMOTE_ACCESS_ENABLED"
  | "BEEPER_HTTP_ERROR"
  | "BEEPER_INVALID_RESPONSE";

const ACTIONS: Record<BeeperDiagnosticCode, string> = {
  BEEPER_NOT_RUNNING:
    "Open Beeper Desktop and wait for it to finish starting, then retry the Beeper tool.",
  BEEPER_PORT_CLOSED:
    "Beeper Desktop appears to be running, but local API port 23373 is closed. Quit and relaunch Beeper Desktop, then retry. Do not enable remote access.",
  BEEPER_TOKEN_MISSING:
    "Run /beeper-setup in an interactive Pi session, approve the one-time consent page manually, then let Pi reload. Environment tokens are not supported.",
  BEEPER_TOKEN_REVOKED:
    "The stored Beeper access token was rejected or revoked. Run /beeper-setup in an interactive Pi session and approve a new consent page manually, then let Pi reload.",
  BEEPER_ACCOUNT_LOGGED_OUT:
    "Open Beeper Desktop account settings and reconnect the affected network account. Do not retry writes until its status is connected.",
  BEEPER_ACCOUNT_NOT_READY:
    "Wait for the affected Beeper network account to finish connecting or backfilling, then retry.",
  BEEPER_REMOTE_ACCESS_ENABLED:
    "Beeper remote access is enabled. Disable it in Beeper Desktop before using pi-beeper; this extension never enables remote access.",
  BEEPER_HTTP_ERROR:
    "Inspect Beeper Desktop's account and API status, then retry after correcting the reported condition.",
  BEEPER_INVALID_RESPONSE:
    "Update or restart Beeper Desktop and retry. The running Client API response did not match its published schema.",
};

export class BeeperDiagnosticError extends Error {
  readonly code: BeeperDiagnosticCode;
  readonly status?: number;

  constructor(code: BeeperDiagnosticCode, detail?: string, status?: number) {
    super(`${code}: ${detail ? `${detail} ` : ""}${ACTIONS[code]}`);
    this.name = "BeeperDiagnosticError";
    this.code = code;
    this.status = status;
  }
}

export class BeeperHttpError extends BeeperDiagnosticError {
  readonly responseCode?: string;

  constructor(status: number, responseCode?: string) {
    const code = status === 401 ? "BEEPER_TOKEN_REVOKED" : "BEEPER_HTTP_ERROR";
    super(code, `Beeper API returned HTTP ${status}.`, status);
    this.name = "BeeperHttpError";
    this.responseCode = responseCode;
  }
}

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export type ProcessProbe = () => Promise<boolean | undefined>;

export interface BeeperApiClientOptions {
  token?: string;
  baseUrl?: string;
  fetchImpl?: FetchLike;
  processProbe?: ProcessProbe;
}

interface RequestOptions {
  method?: "GET" | "POST";
  body?: unknown;
  signal?: AbortSignal;
  authenticated?: boolean;
}

interface ErrorBody {
  code?: unknown;
  message?: unknown;
  error?: unknown;
}

export function diagnosticAction(code: BeeperDiagnosticCode): string {
  return ACTIONS[code];
}

export function isLoggedOutAccountStatus(status: BeeperAccount["status"]): boolean {
  return [
    "connection_required",
    "reconnect_required",
    "attention_required",
    "disconnected",
    "disabled",
  ].includes(status);
}

export function accountDiagnostic(account: BeeperAccount): BeeperDiagnosticError | undefined {
  if (isLoggedOutAccountStatus(account.status)) {
    return new BeeperDiagnosticError(
      "BEEPER_ACCOUNT_LOGGED_OUT",
      `${account.network ?? account.accountID} account ${account.accountID} is ${account.status}${account.statusText ? ` (${redactTokenText(account.statusText, undefined)})` : ""}.`,
    );
  }
  if (account.status === "connecting" || account.status === "backfilling") {
    return new BeeperDiagnosticError(
      "BEEPER_ACCOUNT_NOT_READY",
      `${account.network ?? account.accountID} account ${account.accountID} is ${account.status}.`,
    );
  }
  return undefined;
}

export async function defaultBeeperProcessProbe(): Promise<boolean | undefined> {
  if (platform() !== "darwin") return undefined;
  try {
    await execFileAsync("pgrep", ["-x", "Beeper"], { encoding: "utf8" });
    return true;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === 1) return false;
    return undefined;
  }
}

export class BeeperApiClient {
  private readonly token: string | undefined;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly processProbe: ProcessProbe;

  constructor(options: BeeperApiClientOptions = {}) {
    this.token = options.token;
    this.baseUrl = (options.baseUrl ?? BEEPER_BASE_URL).replace(/\/$/u, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.processProbe = options.processProbe ?? defaultBeeperProcessProbe;
  }

  hasToken(): boolean {
    return Boolean(this.token);
  }

  async getInfo(signal?: AbortSignal): Promise<BeeperInfo> {
    const info = await this.request<BeeperInfo>("/v1/info", {
      signal,
      authenticated: false,
    });
    if (info.server.remote_access) {
      throw new BeeperDiagnosticError("BEEPER_REMOTE_ACCESS_ENABLED");
    }
    return info;
  }

  async listAccounts(signal?: AbortSignal): Promise<BeeperAccount[]> {
    await this.requireDataPlane(signal);
    return this.request<BeeperAccount[]>("/v1/accounts", { signal });
  }

  async listChats(options: {
    cursor?: string;
    direction?: "before" | "after";
    accountIDs?: string[];
    signal?: AbortSignal;
  } = {}): Promise<BeeperListChatsOutput> {
    await this.requireDataPlane(options.signal);
    const query = new URLSearchParams();
    addString(query, "cursor", options.cursor);
    addString(query, "direction", options.direction);
    addArray(query, "accountIDs", options.accountIDs);
    return this.request<BeeperListChatsOutput>(`/v1/chats${formatQuery(query)}`, { signal: options.signal });
  }

  async searchChats(options: {
    query?: string;
    cursor?: string;
    direction?: "before" | "after";
    inbox?: "primary" | "low-priority" | "archive";
    unreadOnly?: boolean;
    limit?: number;
    type?: "single" | "group" | "any";
    scope?: "titles" | "participants";
    lastActivityBefore?: string;
    lastActivityAfter?: string;
    accountIDs?: string[];
    includeMuted?: boolean;
    signal?: AbortSignal;
  }): Promise<BeeperSearchChatsOutput> {
    await this.requireDataPlane(options.signal);
    const query = new URLSearchParams();
    addString(query, "query", options.query);
    addString(query, "cursor", options.cursor);
    addString(query, "direction", options.direction);
    addString(query, "inbox", options.inbox);
    addBoolean(query, "unreadOnly", options.unreadOnly);
    addNumber(query, "limit", options.limit);
    addString(query, "type", options.type);
    addString(query, "scope", options.scope);
    addString(query, "lastActivityBefore", options.lastActivityBefore);
    addString(query, "lastActivityAfter", options.lastActivityAfter);
    addArray(query, "accountIDs", options.accountIDs);
    addBoolean(query, "includeMuted", options.includeMuted);
    return this.request<BeeperSearchChatsOutput>(`/v1/chats/search${formatQuery(query)}`, { signal: options.signal });
  }

  async listMessages(options: {
    chatID: string;
    cursor?: string;
    direction?: "before" | "after";
    signal?: AbortSignal;
  }): Promise<BeeperListMessagesOutput> {
    await this.requireDataPlane(options.signal);
    const query = new URLSearchParams();
    addString(query, "cursor", options.cursor);
    addString(query, "direction", options.direction);
    return this.request<BeeperListMessagesOutput>(
      `/v1/chats/${encodeURIComponent(options.chatID)}/messages${formatQuery(query)}`,
      { signal: options.signal },
    );
  }

  async searchMessages(options: {
    query?: string;
    cursor?: string;
    direction?: "before" | "after";
    chatIDs?: string[];
    accountIDs?: string[];
    chatType?: "group" | "single";
    mediaTypes?: Array<"any" | "video" | "image" | "link" | "file">;
    sender?: string;
    dateAfter?: string;
    dateBefore?: string;
    limit?: number;
    excludeLowPriority?: boolean;
    includeMuted?: boolean;
    signal?: AbortSignal;
  }): Promise<BeeperSearchMessagesOutput> {
    await this.requireDataPlane(options.signal);
    const query = new URLSearchParams();
    addString(query, "query", options.query);
    addString(query, "cursor", options.cursor);
    addString(query, "direction", options.direction);
    addArray(query, "chatIDs", options.chatIDs);
    addArray(query, "accountIDs", options.accountIDs);
    addString(query, "chatType", options.chatType);
    addArray(query, "mediaTypes", options.mediaTypes);
    addString(query, "sender", options.sender);
    addString(query, "dateAfter", options.dateAfter);
    addString(query, "dateBefore", options.dateBefore);
    addNumber(query, "limit", options.limit);
    addBoolean(query, "excludeLowPriority", options.excludeLowPriority);
    addBoolean(query, "includeMuted", options.includeMuted);
    return this.request<BeeperSearchMessagesOutput>(`/v1/messages/search${formatQuery(query)}`, { signal: options.signal });
  }

  async sendMessage(options: {
    chatID: string;
    text: string;
    replyToMessageID?: string;
    signal?: AbortSignal;
  }): Promise<{ chatID: string; pendingMessageID: string }> {
    await this.requireDataPlane(options.signal);
    return this.request<{ chatID: string; pendingMessageID: string }>(
      `/v1/chats/${encodeURIComponent(options.chatID)}/messages`,
      {
        method: "POST",
        body: {
          text: options.text,
          ...(options.replyToMessageID ? { replyToMessageID: options.replyToMessageID } : {}),
        },
        signal: options.signal,
      },
    );
  }

  async addReaction(options: {
    chatID: string;
    messageID: string;
    reactionKey: string;
    transactionID?: string;
    signal?: AbortSignal;
  }): Promise<BeeperAddReactionOutput> {
    await this.requireDataPlane(options.signal);
    return this.request<BeeperAddReactionOutput>(
      `/v1/chats/${encodeURIComponent(options.chatID)}/messages/${encodeURIComponent(options.messageID)}/reactions`,
      {
        method: "POST",
        body: {
          reactionKey: options.reactionKey,
          ...(options.transactionID ? { transactionID: options.transactionID } : {}),
        },
        signal: options.signal,
      },
    );
  }

  async registerOAuthClient(options: {
    clientName: string;
    redirectURI: string;
    signal?: AbortSignal;
  }): Promise<OAuthClientRegistration> {
    return this.request<OAuthClientRegistration>("/oauth/register", {
      method: "POST",
      body: {
        client_name: options.clientName,
        redirect_uris: [options.redirectURI],
        grant_types: ["authorization_code"],
        response_types: ["code"],
        scope: "read write",
        token_endpoint_auth_method: "none",
      },
      signal: options.signal,
      authenticated: false,
    });
  }

  async exchangeOAuthCode(options: {
    tokenEndpoint: string;
    clientID: string;
    code: string;
    codeVerifier: string;
    signal?: AbortSignal;
  }): Promise<OAuthTokenResponse> {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code: options.code,
      code_verifier: options.codeVerifier,
      client_id: options.clientID,
    });
    return this.request<OAuthTokenResponse>(options.tokenEndpoint, {
      method: "POST",
      body,
      signal: options.signal,
      authenticated: false,
    });
  }

  private async requireDataPlane(signal?: AbortSignal): Promise<void> {
    if (!this.token) throw new BeeperDiagnosticError("BEEPER_TOKEN_MISSING");
    await this.getInfo(signal);
  }

  private async request<T>(pathOrUrl: string, options: RequestOptions): Promise<T> {
    const url = pathOrUrl.startsWith("http://") || pathOrUrl.startsWith("https://")
      ? pathOrUrl
      : `${this.baseUrl}${pathOrUrl}`;
    const headers = new Headers({ Accept: "application/json" });
    const authenticated = options.authenticated !== false;
    if (authenticated) {
      if (!this.token) throw new BeeperDiagnosticError("BEEPER_TOKEN_MISSING");
      headers.set("Authorization", `Bearer ${this.token}`);
    }

    let body: BodyInit | undefined;
    if (options.body instanceof URLSearchParams) {
      body = options.body;
      headers.set("Content-Type", "application/x-www-form-urlencoded");
    } else if (options.body !== undefined) {
      body = JSON.stringify(options.body);
      headers.set("Content-Type", "application/json");
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: options.method ?? "GET",
        headers,
        body,
        signal: options.signal,
      });
    } catch (error) {
      if (isConnectionFailure(error)) {
        const running = await this.processProbe();
        if (running === false) throw new BeeperDiagnosticError("BEEPER_NOT_RUNNING");
        throw new BeeperDiagnosticError("BEEPER_PORT_CLOSED");
      }
      throw new BeeperDiagnosticError(
        "BEEPER_HTTP_ERROR",
        describeThrownError(error, this.token),
      );
    }

    const responseText = await response.text();
    if (!response.ok) {
      const errorBody = parseErrorBody(responseText);
      throw new BeeperHttpError(
        response.status,
        typeof errorBody?.code === "string"
          ? errorBody.code
          : typeof errorBody?.error === "string"
            ? errorBody.error
            : undefined,
      );
    }

    if (response.status === 204 || responseText.trim() === "") {
      return undefined as T;
    }
    try {
      return JSON.parse(responseText) as T;
    } catch {
      throw new BeeperDiagnosticError("BEEPER_INVALID_RESPONSE");
    }
  }
}

function describeThrownError(error: unknown, token: string | undefined): string {
  const parts: string[] = [];
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current && !seen.has(current) && parts.length < 3) {
    seen.add(current);
    if (current instanceof Error) {
      parts.push(current.message);
      current = current.cause;
      continue;
    }
    parts.push(String(current));
    break;
  }
  return redactTokenText(parts.join("; "), token);
}

function parseErrorBody(value: string): ErrorBody | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object") return undefined;
    return parsed as ErrorBody;
  } catch {
    return undefined;
  }
}

function isConnectionFailure(error: unknown): boolean {
  if (!error) return false;
  const candidate = error as { code?: unknown; cause?: unknown; message?: unknown };
  if (["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EHOSTUNREACH", "ETIMEDOUT"].includes(String(candidate.code))) {
    return true;
  }
  const message = typeof candidate.message === "string" ? candidate.message : "";
  if (/fetch failed|connect|socket|network/iu.test(message)) return true;
  return candidate.cause !== undefined && isConnectionFailure(candidate.cause);
}

function addString(query: URLSearchParams, key: string, value: string | undefined): void {
  if (value !== undefined) query.set(key, value);
}

function addBoolean(query: URLSearchParams, key: string, value: boolean | undefined): void {
  if (value !== undefined) query.set(key, String(value));
}

function addNumber(query: URLSearchParams, key: string, value: number | undefined): void {
  if (value !== undefined) query.set(key, String(value));
}

function addArray(query: URLSearchParams, key: string, values: readonly unknown[] | undefined): void {
  for (const value of values ?? []) query.append(key, String(value));
}

function formatQuery(query: URLSearchParams): string {
  const text = query.toString();
  return text ? `?${text}` : "";
}
