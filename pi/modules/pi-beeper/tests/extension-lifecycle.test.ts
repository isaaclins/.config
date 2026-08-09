import test from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerPiBeeper } from "../extension.ts";
import type { FetchLike } from "../src/index.ts";

interface Harness {
  tools: Map<string, any>;
  handlers: Map<string, Array<(...args: any[]) => unknown>>;
  commands: Map<string, any>;
  flags: Map<string, unknown>;
}

function makeHarness(flag = false): Harness & { pi: ExtensionAPI } {
  const harness: Harness = {
    tools: new Map(),
    handlers: new Map(),
    commands: new Map(),
    flags: new Map([["beeper-no-redaction", flag]]),
  };
  const pi = {
    on(event: string, handler: (...args: any[]) => unknown) {
      const list = harness.handlers.get(event) ?? [];
      list.push(handler);
      harness.handlers.set(event, list);
    },
    registerTool(tool: any) {
      harness.tools.set(tool.name, tool);
    },
    registerCommand(name: string, command: any) {
      harness.commands.set(name, command);
    },
    registerFlag(name: string) {
      if (!harness.flags.has(name)) harness.flags.set(name, false);
    },
    getFlag(name: string) {
      return harness.flags.get(name);
    },
  } as unknown as ExtensionAPI;
  return { ...harness, pi };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function infoResponse(): Response {
  return jsonResponse({
    app: { name: "Beeper", version: "4.3.20", bundle_id: "com.automattic.beeper.desktop" },
    platform: { os: "darwin", arch: "arm64" },
    server: {
      status: "running",
      base_url: "http://127.0.0.1:23373",
      port: 23373,
      hostname: "127.0.0.1",
      remote_access: false,
      mcp_enabled: true,
    },
    endpoints: {
      oauth: {
        authorization_endpoint: "http://127.0.0.1:23373/oauth/authorize",
        token_endpoint: "http://127.0.0.1:23373/oauth/token",
        introspection_endpoint: "http://127.0.0.1:23373/oauth/introspect",
        userinfo_endpoint: "http://127.0.0.1:23373/oauth/userinfo",
        revocation_endpoint: "http://127.0.0.1:23373/oauth/revoke",
        registration_endpoint: "http://127.0.0.1:23373/oauth/register",
      },
      spec: "http://127.0.0.1:23373/v1/spec",
      mcp: "http://127.0.0.1:23373/v0/mcp",
      ws_events: "http://127.0.0.1:23373/v1/ws",
    },
  });
}

function context(overrides: Record<string, unknown> = {}): any {
  const entries: unknown[] = [];
  return {
    mode: "tui",
    hasUI: true,
    signal: undefined,
    ui: {
      confirm: async () => true,
      notify: () => {},
    },
    sessionManager: {
      getSessionId: () => "session-test",
      getBranch: () => entries,
    },
    ...overrides,
  };
}

test("lifecycle registers the expected prefixed tools and keeps writes out of codrive children", () => {
  const parent = makeHarness();
  registerPiBeeper(parent.pi, { token: "synthetic-token", childEnvironment: false });
  const names = [...parent.tools.keys()];
  assert.deepEqual(names, [
    "beeper_list_accounts",
    "beeper_list_chats",
    "beeper_search_chats",
    "beeper_resolve_chat",
    "beeper_read_conversation",
    "beeper_search_messages",
    "beeper_send_message",
    "beeper_react",
  ]);
  assert.equal(parent.tools.get("beeper_send_message").executionMode, "sequential");
  assert.match(parent.tools.get("beeper_send_message").description, /human confirmation/);

  const child = makeHarness();
  registerPiBeeper(child.pi, { token: "synthetic-token", childEnvironment: true });
  assert.equal(child.tools.has("beeper_send_message"), false);
  assert.equal(child.tools.has("beeper_react"), false);
  assert.ok([...child.tools.keys()].every((name) => name.startsWith("beeper_")));
});

test("black-box extension read and confirmed send never expose the token and report pending delivery", async () => {
  const harness = makeHarness();
  const audit: unknown[] = [];
  let confirmation = "";
  const killSwitch = {
    isDisabled: () => false,
    disable: async () => {},
    enable: async () => {},
  };
  const responses = [
    infoResponse(),
    jsonResponse([{
      accountID: "account-1",
      bridge: { id: "signal", type: "signal", provider: "local" },
      network: "Signal",
      user: { id: "self", username: "me", fullName: "Me", isSelf: true },
      status: "connected",
    }]),
    infoResponse(),
    jsonResponse({
      items: [{
        id: "chat-1",
        accountID: "account-1",
        network: "Signal",
        title: "Alice",
        type: "single",
        participants: { items: [], hasMore: false, total: 2 },
        unreadCount: 0,
      }],
      hasMore: false,
      oldestCursor: null,
      newestCursor: null,
    }),
    infoResponse(),
    jsonResponse({ chatID: "chat-1", pendingMessageID: "pending-1" }),
  ];
  const fetchImpl: FetchLike = async () => {
    const response = responses.shift();
    if (!response) throw new Error("unexpected fetch");
    return response;
  };
  registerPiBeeper(harness.pi, {
    token: "synthetic-token",
    fetchImpl,
    processProbe: async () => true,
    auditWriter: { append: async (record) => { audit.push(record); } },
    killSwitch,
    now: () => 10_000,
    nonce: () => "nonce-test",
  });

  const ctx = context({
    ui: {
      confirm: async (_title: string, message: string) => {
        confirmation = message;
        return true;
      },
      notify: () => {},
    },
  });
  const sessionStart = harness.handlers.get("session_start")![0];
  await sessionStart({ reason: "startup" }, ctx);

  const accounts = await harness.tools.get("beeper_list_accounts").execute("1", {}, undefined, undefined, ctx);
  assert.equal(accounts.content[0].text.includes("synthetic-token"), false);
  await harness.tools.get("beeper_search_chats").execute("2", { query: "Alice" }, undefined, undefined, ctx);
  const sent = await harness.tools.get("beeper_send_message").execute(
    "3",
    { chatID: "chat-1", text: "Hello Alice" },
    undefined,
    undefined,
    ctx,
  );
  const parsed = JSON.parse(sent.content[0].text);
  assert.equal(parsed.pendingMessageID, "pending-1");
  assert.equal(parsed.confirmedDelivery, false);
  assert.equal(sent.content[0].text.includes("synthetic-token"), false);
  assert.match(confirmation, /Hello Alice/);
  assert.match(confirmation, /Network: Signal/);
  assert.match(confirmation, /Participants: 2/);
  assert.match(confirmation, /Account: account-1/);
  assert.equal(audit.length, 1);
  assert.equal((audit[0] as any).body, "Hello Alice");

  await assert.rejects(
    harness.tools.get("beeper_send_message").execute(
      "4",
      { chatID: "chat-1", text: "No UI must refuse" },
      undefined,
      undefined,
      context({ mode: "json", hasUI: false }),
    ),
    /require an interactive or RPC human confirmation/,
  );
});

test("R0 refuses a candidate from an ambiguous resolution", async () => {
  const harness = makeHarness();
  const responses = [
    infoResponse(),
    jsonResponse({
      items: [
        {
          id: "chat-a",
          accountID: "account-1",
          network: "Signal",
          title: "Alex",
          type: "single",
          participants: { items: [], hasMore: false, total: 2 },
          unreadCount: 0,
        },
        {
          id: "chat-b",
          accountID: "account-2",
          network: "WhatsApp",
          title: "Alex",
          type: "single",
          participants: { items: [], hasMore: false, total: 2 },
          unreadCount: 0,
        },
      ],
      hasMore: false,
      oldestCursor: null,
      newestCursor: null,
    }),
  ];
  registerPiBeeper(harness.pi, {
    token: "synthetic-token",
    fetchImpl: async () => responses.shift() ?? jsonResponse({}),
    processProbe: async () => true,
  });
  const ctx = context();
  const resolved = await harness.tools.get("beeper_resolve_chat").execute(
    "1",
    { query: "Alex" },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(JSON.parse(resolved.content[0].text).status, "ambiguous");
  await assert.rejects(
    harness.tools.get("beeper_send_message").execute(
      "2",
      { chatID: "chat-a", text: "Do not send" },
      undefined,
      undefined,
      ctx,
    ),
    /ambiguous Beeper chat/,
  );
});

test("R4 context filtering and supported compaction hook drop old Beeper payloads", async () => {
  const harness = makeHarness();
  registerPiBeeper(harness.pi, { token: "synthetic-token", childEnvironment: false });
  const contextHandler = harness.handlers.get("context")![0];
  const oldAssistant = {
    role: "assistant",
    content: [{ type: "toolCall", name: "beeper_read_conversation", arguments: { chatID: "old" } }],
  };
  const oldResult = { role: "toolResult", toolName: "beeper_read_conversation", content: "untrusted old payload" };
  const currentUser = { role: "user", content: "continue" };
  const currentResult = { role: "toolResult", toolName: "beeper_read_conversation", content: "current payload" };
  const filtered = await contextHandler({ messages: [oldAssistant, oldResult, currentUser, currentResult] }, context()) as { messages: unknown[] };
  assert.deepEqual(filtered.messages, [currentUser, currentResult]);

  const compactHandler = harness.handlers.get("session_before_compact")![0];
  const result = await compactHandler({
    reason: "manual",
    preparation: {
      messagesToSummarize: [{ role: "toolResult", toolName: "beeper_read_conversation", content: "SECRET_IN_CHAT" }],
      turnPrefixMessages: [],
      firstKeptEntryId: "entry-1",
      tokensBefore: 10,
    },
  }, context()) as { compaction: { details: { beeperPayloadsDropped: boolean }; summary: string } };
  assert.equal(result.compaction.details.beeperPayloadsDropped, true);
  assert.equal(result.compaction.summary.includes("SECRET_IN_CHAT"), false);
});
