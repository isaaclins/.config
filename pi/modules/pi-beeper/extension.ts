import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { randomUUID } from "node:crypto";
import {
  BeeperApiClient,
  BeeperDiagnosticError,
  accountDiagnostic,
  type BeeperApiClientOptions,
  type FetchLike,
  type ProcessProbe,
} from "./src/api.ts";
import {
  createMacKeychainTokenStore,
  readTokenOnce,
  type TokenState,
  type TokenStore,
} from "./src/credentials.ts";
import {
  buildBeeperCompactionSummary,
  dropHistoricalBeeperResults,
  hasBeeperToolResults,
} from "./src/compaction.ts";
import {
  formatAccounts,
  formatChats,
  formatMessages,
  formatResolveResult,
  projectAccount,
  projectChat,
} from "./src/format.ts";
import { startOAuthSetup } from "./src/oauth.ts";
import { createNonce, redactTokenText } from "./src/security.ts";
import {
  BEEPER_AUDIT_PATH,
  FileAuditWriter,
  FileKillSwitch,
  SendBudget,
  readAuditRecords,
  restoreSafeDetails,
  type AuditWriter,
  type KillSwitch,
  type SendAuditRecord,
} from "./src/state.ts";
import type {
  BeeperAccount,
  BeeperChat,
  BeeperMessage,
  SeenAccount,
  SeenChat,
} from "./src/types.ts";

const DEFAULT_READ_LIMIT = 20;
const MAX_READ_LIMIT = 50;
const CHILD_MARKER_ENV = "PI_CODRIVE_CHILD";

export interface PiBeeperExtensionOptions {
  token?: string;
  tokenState?: TokenState;
  tokenStore?: TokenStore;
  fetchImpl?: FetchLike;
  processProbe?: ProcessProbe;
  baseUrl?: string;
  auditWriter?: AuditWriter;
  auditPath?: string;
  killSwitch?: KillSwitch;
  childEnvironment?: boolean;
  now?: () => number;
  nonce?: () => string;
  auditRecords?: SendAuditRecord[];
}

interface BleeperSessionState {
  sessionID: string;
  accounts: Map<string, SeenAccount>;
  rawAccounts: Map<string, BeeperAccount>;
  chats: Map<string, SeenChat>;
  rawChats: Map<string, BeeperChat>;
  messageIDs: Map<string, { id: string; chatID: string }>;
  ambiguousChatIDs: Set<string>;
  uniqueResolutionChatIDs: Set<string>;
  readChatIDsThisTurn: Set<string>;
  readAllThisTurn: boolean;
  budget: SendBudget;
  auditLoadError?: string;
}

export default function piBeeper(pi: ExtensionAPI): void {
  registerPiBeeper(pi);
}

export function registerPiBeeper(
  pi: ExtensionAPI,
  options: PiBeeperExtensionOptions = {},
): void {
  const tokenStore = options.tokenStore ?? createMacKeychainTokenStore();
  const credentials = options.tokenState ??
    (options.token !== undefined
      ? { status: "available" as const, token: options.token }
      : readTokenOnce(tokenStore));
  const token = credentials.token;
  const apiOptions: BeeperApiClientOptions = {
    token,
    baseUrl: options.baseUrl,
    fetchImpl: options.fetchImpl,
    processProbe: options.processProbe,
  };
  const api = new BeeperApiClient(apiOptions);
  const auditWriter = options.auditWriter ?? new FileAuditWriter(options.auditPath ?? BEEPER_AUDIT_PATH);
  const killSwitch = options.killSwitch ?? new FileKillSwitch();
  const childEnvironment = options.childEnvironment ?? isCodriveChildEnvironment();
  const nonceFactory = options.nonce ?? createNonce;
  const now = options.now ?? Date.now;

  const state: BleeperSessionState = {
    sessionID: "unknown",
    accounts: new Map(),
    rawAccounts: new Map(),
    chats: new Map(),
    rawChats: new Map(),
    messageIDs: new Map(),
    ambiguousChatIDs: new Set(),
    uniqueResolutionChatIDs: new Set(),
    readChatIDsThisTurn: new Set(),
    readAllThisTurn: false,
    budget: new SendBudget(undefined, undefined, undefined, now),
  };
  let setupInProgress = false;
  let activeSetup: Awaited<ReturnType<typeof startOAuthSetup>> | undefined;

  pi.registerFlag("beeper-no-redaction", {
    type: "boolean",
    default: false,
    description: "Disable pi-beeper's default secret redaction for message text",
  });

  pi.on("session_start", async (event, ctx) => {
    state.sessionID = ctx.sessionManager.getSessionId();
    state.accounts.clear();
    state.rawAccounts.clear();
    state.chats.clear();
    state.rawChats.clear();
    state.messageIDs.clear();
    state.ambiguousChatIDs.clear();
    state.uniqueResolutionChatIDs.clear();
    state.readChatIDsThisTurn.clear();
    state.readAllThisTurn = false;
    state.auditLoadError = undefined;

    const restored = event.reason === "fork" || event.reason === "new"
      ? undefined
      : restoreSafeDetails(ctx.sessionManager.getBranch());
    for (const account of restored?.accounts ?? []) {
      state.accounts.set(account.accountID, account);
      state.rawAccounts.set(account.accountID, rawAccountFromSeen(account));
    }
    for (const chat of restored?.chats ?? []) {
      state.chats.set(chat.id, chat);
      state.rawChats.set(chat.id, rawChatFromSeen(chat));
    }
    for (const chatID of restored?.ambiguousChatIDs ?? []) state.ambiguousChatIDs.add(chatID);
    for (const chatID of restored?.uniqueResolutionChatIDs ?? []) state.uniqueResolutionChatIDs.add(chatID);
    for (const message of restored?.messageIDs ?? []) state.messageIDs.set(message.id, message);

    state.budget = new SendBudget(undefined, undefined, undefined, now);
    try {
      const records = options.auditRecords ?? await readAuditRecords(options.auditPath);
      state.budget.restore(records, state.sessionID);
    } catch (error) {
      state.auditLoadError = redactTokenText(describe(error), token);
      ctx.ui.notify(
        "pi-beeper cannot read its send audit log. Sending is disabled until the audit path is readable.",
        "error",
      );
    }
  });

  pi.on("turn_start", async () => {
    state.readChatIDsThisTurn.clear();
    state.readAllThisTurn = false;
  });

  pi.on("tool_call", async (event) => {
    const toolName = String(event.toolName);
    const input = event.input as Record<string, unknown>;
    recordReadPreflight(state, toolName, input);
    if (childEnvironment && isWriteTool(toolName)) {
      return {
        block: true,
        reason: "pi-beeper write tools are disabled in spawned subagents and deferred child sessions.",
      };
    }
    return undefined;
  });

  pi.on("context", async (event) => ({
    messages: dropHistoricalBeeperResults(event.messages),
  }));

  pi.on("session_before_compact", async (event) => {
    const messages = [
      ...event.preparation.messagesToSummarize,
      ...event.preparation.turnPrefixMessages,
    ];
    if (!hasBeeperToolResults(messages)) return undefined;
    return {
      compaction: {
        summary: buildBeeperCompactionSummary(messages, event.reason),
        firstKeptEntryId: event.preparation.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore,
        details: { beeperPayloadsDropped: true },
      },
    };
  });

  pi.on("session_before_tree", async (event) => {
    if (!event.preparation.userWantsSummary || !hasBeeperToolResults(event.preparation.entriesToSummarize)) {
      return undefined;
    }
    return {
      summary: {
        summary: buildBeeperCompactionSummary(event.preparation.entriesToSummarize, "branch"),
        details: { beeperPayloadsDropped: true },
      },
    };
  });

  pi.on("session_shutdown", async () => {
    state.readChatIDsThisTurn.clear();
    state.readAllThisTurn = false;
    await activeSetup?.close();
    activeSetup = undefined;
    setupInProgress = false;
  });

  pi.registerCommand("beeper-setup", {
    description: "Register a public PKCE client, open Beeper's one-time consent page, and store the token in Keychain",
    handler: async (_args, ctx) => {
      if (childEnvironment) {
        throw new Error("pi-beeper setup is disabled in spawned subagents");
      }
      if (!ctx.hasUI) {
        throw new Error("Run /beeper-setup in interactive or RPC Pi mode so a human can approve consent");
      }
      if (setupInProgress) {
        throw new Error("A pi-beeper OAuth setup flow is already waiting for consent");
      }
      setupInProgress = true;
      let setup: Awaited<ReturnType<typeof startOAuthSetup>> | undefined;
      try {
        setup = await startOAuthSetup({ api, tokenStore });
        activeSetup = setup;
        ctx.ui.notify(
          `Beeper consent requires a human click. Open this URL if it did not open automatically:\n${setup.url}`,
          "warning",
        );
        await setup.waitForCompletion;
        ctx.ui.notify("Beeper authorization completed. Pi will reload and read the new Keychain token.", "info");
        await ctx.reload();
        return;
      } finally {
        setupInProgress = false;
        if (activeSetup === setup) activeSetup = undefined;
        await setup?.close();
      }
    },
  });

  pi.registerCommand("beeper-kill-switch", {
    description: "Disable all pi-beeper sends and reactions immediately",
    handler: async (_args, ctx) => {
      await killSwitch.disable();
      ctx.ui.notify("pi-beeper writes disabled. Use /beeper-send-enable after reviewing the audit log.", "warning");
    },
  });

  pi.registerCommand("beeper-send-enable", {
    description: "Remove the pi-beeper write kill switch",
    handler: async (_args, ctx) => {
      await killSwitch.enable();
      ctx.ui.notify("pi-beeper writes enabled, subject to confirmation, budget, rate, and account checks.", "info");
    },
  });

  pi.registerCommand("beeper-status", {
    description: "Show pi-beeper token, kill switch, and session write status without revealing the token",
    handler: async (_args, ctx) => {
      const budget = state.budget.snapshot();
      const status = [
        `token: ${credentials.status === "available" && api.hasToken() ? "available" : "missing or rejected"}`,
        `writes: ${budget.sendCount}/12 across ${budget.distinctChatCount}/5 chats`,
        `kill switch: ${killSwitch.isDisabled() ? "enabled, writes blocked" : "off"}`,
      ].join("\n");
      ctx.ui.notify(status, "info");
    },
  });

  pi.registerTool({
    name: "beeper_list_accounts",
    label: "Beeper List Accounts",
    description:
      "List connected Beeper accounts and their connection status. Returns JSON only. A logged-out or not-ready account is reported with an actionable diagnostic; reading does not mark chats read.",
    promptSnippet: "List Beeper accounts and connection status",
    parameters: Type.Object({}),
    async execute(_id, _params, signal) {
      return safeExecute(token, async () => {
        const accounts = await api.listAccounts(signal);
        rememberAccounts(state, accounts);
        return formatAccounts(accounts, { token });
      });
    },
  });

  pi.registerTool({
    name: "beeper_list_chats",
    label: "Beeper List Chats",
    description:
      "List recent Beeper chats across accounts. Results are JSON only, bounded to 20 chats by default, and do not mark anything read. Chat ids returned here may be used by a later send in this same session.",
    promptSnippet: "List recent Beeper chats",
    parameters: Type.Object({
      cursor: Type.Optional(Type.String()),
      direction: Type.Optional(Type.Union([Type.Literal("before"), Type.Literal("after")])),
      accountIDs: Type.Optional(Type.Array(Type.String())),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_READ_LIMIT })),
    }),
    async execute(_id, params, signal) {
      return safeExecute(token, async () => {
        const result = await api.listChats({
          cursor: params.cursor,
          direction: params.direction,
          accountIDs: params.accountIDs,
          signal,
        });
        rememberRawChats(state, result.items, "list");
        return formatChats(result, params.limit ?? DEFAULT_READ_LIMIT, { token });
      });
    },
  });

  pi.registerTool({
    name: "beeper_search_chats",
    label: "Beeper Search Chats",
    description:
      "Search Beeper chats by literal title, network, or participant words. Returns JSON only, with network, account, chat type, and participant count. Chat ids returned here may be used by a later send in this same session.",
    promptSnippet: "Search Beeper chats by title or participant",
    parameters: Type.Object({
      query: Type.Optional(Type.String()),
      scope: Type.Optional(Type.Union([Type.Literal("titles"), Type.Literal("participants")])),
      type: Type.Optional(Type.Union([Type.Literal("single"), Type.Literal("group"), Type.Literal("any")])),
      inbox: Type.Optional(Type.Union([Type.Literal("primary"), Type.Literal("low-priority"), Type.Literal("archive")])),
      unreadOnly: Type.Optional(Type.Boolean()),
      includeMuted: Type.Optional(Type.Boolean()),
      accountIDs: Type.Optional(Type.Array(Type.String())),
      cursor: Type.Optional(Type.String()),
      direction: Type.Optional(Type.Union([Type.Literal("before"), Type.Literal("after")])),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_READ_LIMIT })),
    }),
    async execute(_id, params, signal) {
      return safeExecute(token, async () => {
        const result = await api.searchChats({
          query: params.query,
          scope: params.scope,
          type: params.type,
          inbox: params.inbox,
          unreadOnly: params.unreadOnly,
          includeMuted: params.includeMuted,
          accountIDs: params.accountIDs,
          cursor: params.cursor,
          direction: params.direction,
          limit: params.limit,
          signal,
        });
        rememberRawChats(state, result.items, "search");
        return formatChats(result, params.limit ?? DEFAULT_READ_LIMIT, { token });
      });
    },
  });

  pi.registerTool({
    name: "beeper_resolve_chat",
    label: "Beeper Resolve Chat",
    description:
      "Resolve a user-typed literal chat search into candidates. Every candidate includes network, account, chat type, and participant count. Ambiguous resolution refuses sending until a single candidate is resolved.",
    promptSnippet: "Resolve a Beeper chat name into safe candidates",
    parameters: Type.Object({
      query: Type.String({ minLength: 1 }),
      scope: Type.Optional(Type.Union([Type.Literal("titles"), Type.Literal("participants")])),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_READ_LIMIT })),
    }),
    async execute(_id, params, signal) {
      return safeExecute(token, async () => {
        const result = await api.searchChats({
          query: params.query,
          scope: params.scope,
          type: "any",
          limit: params.limit ?? DEFAULT_READ_LIMIT,
          signal,
        });
        rememberRawChats(state, result.items, result.items.length === 1 ? "resolve-unique" : "resolve-ambiguous");
        return formatResolveResult(params.query, result.items.slice(0, params.limit ?? DEFAULT_READ_LIMIT), { token });
      });
    },
  });

  pi.registerTool({
    name: "beeper_read_conversation",
    label: "Beeper Read Conversation",
    description:
      "Read a bounded page of a Beeper conversation without marking it read. Returns JSON only. Message text is nonce-fenced third-party data with provenance, secret redaction, per-message 2,000 character limits, and explicit truncation markers. Use a chat id seen earlier in this session.",
    promptSnippet: "Read a bounded Beeper conversation page",
    parameters: Type.Object({
      chatID: Type.String(),
      cursor: Type.Optional(Type.String()),
      direction: Type.Optional(Type.Union([Type.Literal("before"), Type.Literal("after")])),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_READ_LIMIT })),
    }),
    async execute(_id, params, signal) {
      return safeExecute(token, async () => {
        const chat = requireKnownChat(state, params.chatID, false);
        recordReadChat(state, params.chatID);
        const result = await api.listMessages({
          chatID: params.chatID,
          cursor: params.cursor,
          direction: params.direction,
          signal,
        });
        rememberMessageIDs(state, result.items);
        const nonce = nonceFactory();
        return formatMessages(
          result,
          { chat: state.rawChats.get(params.chatID) ?? rawChatFromSeen(chat) },
          params.limit ?? DEFAULT_READ_LIMIT,
          state.accounts,
          {
            token,
            nonce,
            redactSecrets: !Boolean(pi.getFlag("beeper-no-redaction")),
          },
          "beeper_conversation",
        );
      });
    },
  });

  pi.registerTool({
    name: "beeper_search_messages",
    label: "Beeper Search Messages",
    description:
      "Search Beeper message history with literal words and optional filters. Returns JSON only with nonce-fenced third-party message text, sender provenance, secret redaction, and bounded output. This read never marks chats read.",
    promptSnippet: "Search bounded Beeper message history",
    parameters: Type.Object({
      query: Type.Optional(Type.String()),
      chatIDs: Type.Optional(Type.Array(Type.String())),
      accountIDs: Type.Optional(Type.Array(Type.String())),
      chatType: Type.Optional(Type.Union([Type.Literal("group"), Type.Literal("single")])),
      sender: Type.Optional(Type.String()),
      dateAfter: Type.Optional(Type.String()),
      dateBefore: Type.Optional(Type.String()),
      cursor: Type.Optional(Type.String()),
      direction: Type.Optional(Type.Union([Type.Literal("before"), Type.Literal("after")])),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
      includeMuted: Type.Optional(Type.Boolean()),
      excludeLowPriority: Type.Optional(Type.Boolean()),
    }),
    async execute(_id, params, signal) {
      return safeExecute(token, async () => {
        if (params.chatIDs && params.chatIDs.length > 0) {
          for (const chatID of params.chatIDs) recordReadChat(state, chatID);
        } else {
          state.readAllThisTurn = true;
        }
        const result = await api.searchMessages({
          query: params.query,
          chatIDs: params.chatIDs,
          accountIDs: params.accountIDs,
          chatType: params.chatType,
          sender: params.sender,
          dateAfter: params.dateAfter,
          dateBefore: params.dateBefore,
          cursor: params.cursor,
          direction: params.direction,
          limit: params.limit,
          includeMuted: params.includeMuted,
          excludeLowPriority: params.excludeLowPriority,
          signal,
        });
        rememberRawChats(state, Object.values(result.chats), "search");
        rememberMessageIDs(state, result.items);
        const nonce = nonceFactory();
        return formatMessages(
          result,
          { chatsByID: new Map(Object.entries(result.chats)) },
          params.limit ?? 20,
          state.accounts,
          {
            token,
            nonce,
            redactSecrets: !Boolean(pi.getFlag("beeper-no-redaction")),
          },
          "beeper_message_search",
        );
      });
    },
  });

  if (childEnvironment) return;

  pi.registerTool({
    name: "beeper_send_message",
    label: "Beeper Send Message",
    description:
      "Send exactly one text message after a non-bypassable human confirmation dialog. The dialog shows the body verbatim, resolved chat, network, participant count, account identity, and louder warning for read-then-send exfiltration. Chat ids must come from an earlier list, search, or unique resolve call in this same session. Sending is refused in no-UI modes, under the kill switch, over the session budget, or when audit logging fails. A successful result means accepted as pending, never delivered.",
    promptSnippet: "Send one confirmed Beeper message",
    promptGuidelines: [
      "Never put beeper_send_message on an auto-approve allowlist; it always requires its own confirmation dialog.",
      "Use beeper_resolve_chat or a prior beeper_list_chats/beeper_search_chats result before beeper_send_message.",
    ],
    executionMode: "sequential",
    parameters: Type.Object({
      chatID: Type.String(),
      text: Type.String({ minLength: 1 }),
      replyToMessageID: Type.Optional(Type.String()),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      return safeExecute(token, async () => {
        const chat = requireKnownChat(state, params.chatID, true);
        const account = requireWritableAccount(state, chat.accountID);
        if (chat.isReadOnly) throw new Error(`Chat ${chat.id} is read-only; no message was sent.`);
        if (params.replyToMessageID) requireKnownMessage(state, params.replyToMessageID, params.chatID);
        await confirmWrite(ctx, {
          kind: "message",
          chat,
          account,
          body: params.text,
          louder: isExfiltrationShape(state, params.chatID),
        });
        assertWriteStillAllowed(killSwitch, state);
        const reservation = state.budget.reserve(params.chatID);
        await auditWriter.append({
          timestamp: new Date(now()).toISOString(),
          sessionID: state.sessionID,
          action: "send",
          status: "attempted",
          chatID: chat.id,
          chatTitle: chat.title,
          network: chat.network,
          accountID: chat.accountID,
          body: params.text,
        });
        const result = await api.sendMessage({
          chatID: params.chatID,
          text: params.text,
          replyToMessageID: params.replyToMessageID,
          signal,
        });
        const output = {
          kind: "beeper_send_message",
          chatID: result.chatID,
          pendingMessageID: result.pendingMessageID,
          deliveryStatus: "accepted_pending",
          confirmedDelivery: false,
          sessionWrites: reservation,
        };
        return {
          content: [{ type: "text", text: redactTokenText(JSON.stringify(output), token) }],
          details: { beeper: true, sessionWrites: reservation },
        };
      });
    },
  });

  pi.registerTool({
    name: "beeper_react",
    label: "Beeper React",
    description:
      "Add one reaction after a human confirmation dialog. This is a write, is rate-limited and audited, and is unavailable to spawned subagents. The chat and message must have been returned by an earlier Beeper list, search, or read call in this session.",
    promptSnippet: "Add one confirmed Beeper reaction",
    promptGuidelines: ["Never auto-approve beeper_react; reactions are external writes and require confirmation."],
    executionMode: "sequential",
    parameters: Type.Object({
      chatID: Type.String(),
      messageID: Type.String(),
      reactionKey: Type.String({ minLength: 1 }),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      return safeExecute(token, async () => {
        const chat = requireKnownChat(state, params.chatID, true);
        const account = requireWritableAccount(state, chat.accountID);
        requireKnownMessage(state, params.messageID, params.chatID);
        await confirmWrite(ctx, {
          kind: "reaction",
          chat,
          account,
          body: params.reactionKey,
          louder: isExfiltrationShape(state, params.chatID),
        });
        assertWriteStillAllowed(killSwitch, state);
        const reservation = state.budget.reserve(params.chatID);
        await auditWriter.append({
          timestamp: new Date(now()).toISOString(),
          sessionID: state.sessionID,
          action: "reaction",
          status: "attempted",
          chatID: chat.id,
          chatTitle: chat.title,
          network: chat.network,
          accountID: chat.accountID,
          body: params.reactionKey,
        });
        await api.addReaction({
          chatID: params.chatID,
          messageID: params.messageID,
          reactionKey: params.reactionKey,
          transactionID: randomUUID(),
          signal,
        });
        const output = {
          kind: "beeper_react",
          chatID: params.chatID,
          messageID: params.messageID,
          reactionKey: params.reactionKey,
          accepted: true,
          sessionWrites: reservation,
        };
        return {
          content: [{ type: "text", text: redactTokenText(JSON.stringify(output), token) }],
          details: { beeper: true, sessionWrites: reservation },
        };
      });
    },
  });
}

function isCodriveChildEnvironment(): boolean {
  return Boolean(
    process.env[CHILD_MARKER_ENV] ||
      process.env.PI_CODRIVE_CHILD_ID ||
      process.env.PI_CODRIVE_SOCKET ||
      process.env.PI_CODRIVE_SESSION_ID ||
      process.env.PI_SPAWN_NOTIFY_FILE ||
      process.env.PI_SPAWN_AGENT_REPORT_FILE,
  );
}

function isWriteTool(toolName: string): boolean {
  return toolName === "beeper_send_message" || toolName === "beeper_react";
}

function rememberAccounts(state: BleeperSessionState, accounts: BeeperAccount[]): void {
  for (const account of accounts) {
    state.rawAccounts.set(account.accountID, account);
    state.accounts.set(account.accountID, projectAccount(account));
  }
}

function rememberRawChats(
  state: BleeperSessionState,
  chats: readonly BeeperChat[],
  source: "list" | "search" | "resolve-unique" | "resolve-ambiguous",
): void {
  for (const chat of chats) {
    state.rawChats.set(chat.id, chat);
    state.chats.set(chat.id, projectChat(chat));
    if (source === "resolve-unique") {
      state.uniqueResolutionChatIDs.add(chat.id);
      state.ambiguousChatIDs.delete(chat.id);
    }
    if (source === "resolve-ambiguous") state.ambiguousChatIDs.add(chat.id);
  }
}

function rememberMessageIDs(state: BleeperSessionState, messages: readonly BeeperMessage[]): void {
  for (const message of messages) {
    state.messageIDs.set(message.id, { id: message.id, chatID: message.chatID });
  }
}

function recordReadPreflight(state: BleeperSessionState, toolName: string, input: Record<string, unknown>): void {
  if (toolName === "beeper_read_conversation" && typeof input.chatID === "string") {
    recordReadChat(state, input.chatID);
  }
  if (toolName === "beeper_search_messages") {
    const chatIDs = input.chatIDs;
    if (Array.isArray(chatIDs) && chatIDs.every((value) => typeof value === "string") && chatIDs.length > 0) {
      for (const chatID of chatIDs) recordReadChat(state, chatID);
    } else {
      state.readAllThisTurn = true;
    }
  }
}

function recordReadChat(state: BleeperSessionState, chatID: string): void {
  state.readChatIDsThisTurn.add(chatID);
}

function isExfiltrationShape(state: BleeperSessionState, targetChatID: string): boolean {
  return state.readAllThisTurn || [...state.readChatIDsThisTurn].some((chatID) => chatID !== targetChatID);
}

function requireKnownChat(state: BleeperSessionState, chatID: string, forWrite: boolean): SeenChat {
  const chat = state.chats.get(chatID);
  if (!chat) {
    throw new Error(
      `Unknown Beeper chat id. Use beeper_list_chats, beeper_search_chats, or beeper_resolve_chat first in this session; model-authored chat ids are not accepted for ${forWrite ? "writes" : "reads"}.`,
    );
  }
  if (forWrite && state.ambiguousChatIDs.has(chatID) && !state.uniqueResolutionChatIDs.has(chatID)) {
    throw new Error(
      `Refusing to write to ambiguous Beeper chat ${chatID}. Use beeper_resolve_chat with a narrower literal query until exactly one candidate is returned.`,
    );
  }
  return chat;
}

function requireKnownMessage(state: BleeperSessionState, messageID: string, chatID: string): void {
  const message = state.messageIDs.get(messageID);
  if (!message || message.chatID !== chatID) {
    throw new Error(
      `Unknown message ${messageID} for chat ${chatID}. Read or search that conversation first; model-authored message ids are not accepted.`,
    );
  }
}

function requireWritableAccount(state: BleeperSessionState, accountID: string): SeenAccount {
  const account = state.accounts.get(accountID);
  if (!account) {
    throw new Error(`Account ${accountID} is not known in this session. Call beeper_list_accounts before writing.`);
  }
  const raw = state.rawAccounts.get(accountID);
  const diagnostic = raw ? accountDiagnostic(raw) : undefined;
  if (diagnostic) throw diagnostic;
  return account;
}

async function confirmWrite(
  ctx: ExtensionContext,
  input: {
    kind: "message" | "reaction";
    chat: SeenChat;
    account: SeenAccount;
    body: string;
    louder: boolean;
  },
): Promise<void> {
  if (!ctx.hasUI || (ctx.mode !== "tui" && ctx.mode !== "rpc")) {
    throw new Error(
      "Beeper external writes require an interactive or RPC human confirmation dialog. This Pi mode has no confirmation UI, so nothing was written.",
    );
  }
  const title = input.louder ? "CONFIRM BEEPER WRITE: READ-THEN-SEND" : "Confirm Beeper external write";
  const message = [
    input.louder
      ? "A read from another chat occurred in this turn. Check that no third-party content is being exfiltrated to this target."
      : "This is a real external Beeper write.",
    `Action: ${input.kind === "message" ? "send message" : "add reaction"}`,
    `Body or reaction, verbatim:\n${input.body}`,
    `Chat: ${input.chat.title}`,
    `Network: ${input.chat.network}`,
    `Participants: ${input.chat.participantCount}${input.chat.participantCountIsComplete ? "" : " or more"}`,
    `Account: ${input.account.accountID} on ${input.account.network}, as ${input.account.userName} (${input.account.userHandle})`,
  ].join("\n\n");
  const confirmed = await ctx.ui.confirm(title, message, { signal: ctx.signal });
  if (!confirmed) throw new Error("Beeper write cancelled by the human confirmation dialog.");
}

function assertWriteStillAllowed(killSwitch: KillSwitch, state: BleeperSessionState): void {
  if (state.auditLoadError) throw new Error(`Beeper audit log unavailable: ${state.auditLoadError}`);
  if (killSwitch.isDisabled()) {
    throw new Error("Beeper writes are disabled by the kill switch. Use /beeper-send-enable after review.");
  }
}

function safeExecute<T>(token: string | undefined, operation: () => Promise<T>): Promise<T> {
  return operation().catch((error: unknown) => {
    if (error instanceof BeeperDiagnosticError) throw error;
    throw new Error(redactTokenText(describe(error), token));
  });
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function rawAccountFromSeen(account: SeenAccount): BeeperAccount {
  return {
    accountID: account.accountID,
    bridge: { id: account.accountID, type: account.network, provider: "local" },
    network: account.network,
    user: { id: account.userID, username: account.userHandle, fullName: account.userName, isSelf: true },
    status: account.status,
    ...(account.statusText ? { statusText: account.statusText } : {}),
  };
}

function rawChatFromSeen(chat: SeenChat): BeeperChat {
  return {
    id: chat.id,
    accountID: chat.accountID,
    network: chat.network,
    title: chat.title,
    type: chat.type,
    participants: {
      items: [],
      hasMore: !chat.participantCountIsComplete,
      total: chat.participantCount,
    },
    unreadCount: 0,
    isReadOnly: chat.isReadOnly,
  };
}
