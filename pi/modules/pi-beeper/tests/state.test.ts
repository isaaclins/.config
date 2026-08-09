import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FileAuditWriter,
  FileKillSwitch,
  SendBudget,
  restoreSafeDetails,
  type SendAuditRecord,
} from "../src/index.ts";

function record(sessionID: string, chatID: string, timestamp: string): SendAuditRecord {
  return {
    timestamp,
    sessionID,
    action: "send",
    status: "attempted",
    chatID,
    chatTitle: chatID,
    network: "Signal",
    accountID: "account",
    body: "hello",
  };
}

test("send budget hard-stops at twelve writes and five distinct chats", () => {
  let now = 1000;
  const budget = new SendBudget(12, 5, 5000, () => now);
  for (let index = 0; index < 12; index += 1) {
    budget.reserve(`chat-${index % 5}`);
    now += 5000;
  }
  assert.deepEqual(budget.snapshot(), { sendCount: 12, distinctChatCount: 5 });
  assert.throws(() => budget.reserve("chat-0"), /twelve writes|12 writes/);

  const distinct = new SendBudget(12, 5, 5000, () => now);
  for (let index = 0; index < 5; index += 1) {
    distinct.reserve(`chat-${index}`);
    now += 5000;
  }
  assert.throws(() => distinct.reserve("chat-5"), /five distinct chats|5 distinct chats/);
});

test("send budget restores only this session's append-only audit records", () => {
  let now = 1000;
  const budget = new SendBudget(12, 5, 5000, () => now);
  budget.restore(
    [record("session-a", "chat-a", new Date(1000).toISOString()), record("session-b", "chat-b", new Date(1000).toISOString())],
    "session-a",
  );
  now += 5000;
  budget.reserve("chat-a");
  assert.deepEqual(budget.snapshot(), { sendCount: 2, distinctChatCount: 1 });
});

test("audit writer is outside the repository and append-only", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-beeper-audit-"));
  const path = join(directory, "send-audit.jsonl");
  const writer = new FileAuditWriter(path);
  await writer.append(record("session", "chat", new Date().toISOString()));
  await writer.append({ ...record("session", "chat-2", new Date().toISOString()), body: "second" });
  const lines = (await readFile(path, "utf8")).trim().split("\n");
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]).body, "hello");
  assert.equal(JSON.parse(lines[1]).body, "second");
  const mode = (await stat(path)).mode & 0o777;
  assert.equal(mode, 0o600);
});

test("kill switch creates a file checked independently on every write", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-beeper-kill-"));
  const killSwitch = new FileKillSwitch(join(directory, "send.disabled"));
  assert.equal(killSwitch.isDisabled(), false);
  await killSwitch.disable();
  assert.equal(killSwitch.isDisabled(), true);
  await killSwitch.enable();
  assert.equal(killSwitch.isDisabled(), false);
});

test("session details restore only safe chat, account, and message identity", () => {
  const restored = restoreSafeDetails([
    {
      type: "message",
      message: {
        role: "toolResult",
        details: {
          beeper: true,
          seenAccounts: [{
            accountID: "account",
            network: "Signal",
            status: "connected",
            userID: "self",
            userHandle: "me",
            userName: "Me",
          }],
          seenChats: [{
            id: "chat",
            title: "Alice",
            network: "Signal",
            accountID: "account",
            type: "single",
            participantCount: 2,
            participantCountIsComplete: true,
            isReadOnly: false,
          }],
          messageIDs: [{ id: "message", chatID: "chat" }],
        },
      },
    },
  ]);
  assert.equal(restored.accounts[0].accountID, "account");
  assert.equal(restored.chats[0].id, "chat");
  assert.deepEqual(restored.messageIDs, [{ id: "message", chatID: "chat" }]);
});
