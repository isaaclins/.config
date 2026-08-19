import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { BeeperApiClient, type BeeperInfo } from "../src/index.ts";

function info(port: number): BeeperInfo {
  const base = `http://127.0.0.1:${port}`;
  return {
    app: { name: "Beeper", version: "4.3.20", bundle_id: "com.automattic.beeper.desktop" },
    platform: { os: "darwin", arch: "arm64" },
    server: { status: "running", base_url: base, port, hostname: "127.0.0.1", remote_access: false, mcp_enabled: true },
    endpoints: {
      oauth: {
        authorization_endpoint: `${base}/oauth/authorize`,
        token_endpoint: `${base}/oauth/token`,
        introspection_endpoint: `${base}/oauth/introspect`,
        userinfo_endpoint: `${base}/oauth/userinfo`,
        revocation_endpoint: `${base}/oauth/revoke`,
        registration_endpoint: `${base}/oauth/register`,
      },
      spec: `${base}/v1/spec`,
      mcp: `${base}/v0/mcp`,
      ws_events: `${base}/v1/ws`,
    },
  };
}

function sendJSON(response: ServerResponse, value: unknown, status = 200): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(value));
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

test("black-box conformance uses the published Beeper field names and HTTP routes", async () => {
  const requests: Array<{ method: string; path: string; body: string }> = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const body = await readBody(request);
    requests.push({ method: request.method ?? "", path: `${url.pathname}${url.search}`, body });
    const port = (server.address() as { port: number }).port;

    if (url.pathname === "/v1/info") {
      sendJSON(response, info(port));
      return;
    }
    if (url.pathname === "/v1/accounts") {
      assert.equal(request.headers.authorization, "Bearer black-box-token");
      sendJSON(response, [{
        accountID: "account-1",
        bridge: { id: "signal", type: "signal", provider: "local" },
        network: "Signal",
        user: { id: "self", username: "me", fullName: "Me", isSelf: true },
        status: "connected",
      }]);
      return;
    }
    if (url.pathname === "/v1/chats/search") {
      assert.equal(url.searchParams.get("query"), "Alice");
      assert.equal(url.searchParams.get("scope"), "titles");
      sendJSON(response, {
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
      });
      return;
    }
    if (url.pathname === "/v1/chats/chat-1/messages" && request.method === "GET") {
      assert.equal(url.searchParams.get("direction"), "before");
      sendJSON(response, {
        items: [{
          id: "message-1",
          chatID: "chat-1",
          accountID: "account-1",
          senderID: "@alice:signal",
          senderName: "Alice",
          timestamp: "2026-08-09T10:00:00Z",
          sortKey: "1",
          type: "TEXT",
          text: "hello",
          isSender: false,
        }],
        hasMore: false,
        oldestCursor: null,
        newestCursor: null,
      });
      return;
    }
    if (url.pathname === "/v1/chats/chat-1/messages" && request.method === "POST") {
      assert.deepEqual(JSON.parse(body), { text: "hello" });
      sendJSON(response, { chatID: "chat-1", pendingMessageID: "pending-1" });
      return;
    }
    if (url.pathname === "/v1/chats/chat-1/messages/message-1/reactions") {
      assert.deepEqual(JSON.parse(body), { reactionKey: "👍", transactionID: "tx-1" });
      sendJSON(response, { success: true });
      return;
    }
    sendJSON(response, { code: "not_found", message: "not found" }, 404);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const client = new BeeperApiClient({
    baseUrl: `http://127.0.0.1:${port}`,
    token: "black-box-token",
    processProbe: async () => true,
  });

  try {
    const accounts = await client.listAccounts();
    assert.equal(accounts[0].accountID, "account-1");
    const chats = await client.searchChats({ query: "Alice", scope: "titles", limit: 20 });
    assert.equal(chats.items[0].id, "chat-1");
    const messages = await client.listMessages({ chatID: "chat-1", direction: "before" });
    assert.equal(messages.items[0].text, "hello");
    const sent = await client.sendMessage({ chatID: "chat-1", text: "hello" });
    assert.equal(sent.pendingMessageID, "pending-1");
    const reaction = await client.addReaction({
      chatID: "chat-1",
      messageID: "message-1",
      reactionKey: "👍",
      transactionID: "tx-1",
    });
    assert.equal(reaction.success, true);
    assert.ok(requests.some((request) => request.path.startsWith("/v1/chats/search?")));
    assert.ok(requests.some((request) => request.path === "/v1/chats/chat-1/messages" && request.method === "POST"));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
