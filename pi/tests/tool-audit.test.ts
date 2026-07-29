import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  MAX_ARGS_BYTES,
  REDACTED,
  aggregate,
  buildRecord,
  dailyFilePath,
  formatAgent,
  parseJsonl,
  readAllRecords,
  redactSecrets,
  resultPreview,
  shortAgentId,
  truncateBytes,
  writeRecord,
  type AuditRecord,
} from "../lib/tool-audit.ts";

test("buildRecord shapes a bounded record with agent id, outcome, and duration (shared by tool-audit.ts)", () => {
  const record = buildRecord({
    sessionId: "abcdef1234567890",
    cwd: "/home/isaac/project",
    tool: "bash",
    args: { command: "ls" },
    result: { content: [{ type: "text", text: "file.txt" }] },
    isError: false,
    startedAt: 1000,
    endedAt: 1350,
  });

  assert.equal(record.agentId, "abcdef12");
  assert.equal(record.tool, "bash");
  assert.equal(record.cwd, "/home/isaac/project");
  assert.equal(record.outcome, "ok");
  assert.equal(record.durationMs, 350);
  assert.equal(record.ts, new Date(1350).toISOString());
  assert.equal(record.args, JSON.stringify({ command: "ls" }));
  assert.equal(record.preview, "file.txt");
});

test("buildRecord marks errors and omits duration when no start time is known", () => {
  const record = buildRecord({
    sessionId: "short",
    cwd: "/tmp",
    tool: "edit",
    args: {},
    result: { content: [{ type: "text", text: "boom" }] },
    isError: true,
    endedAt: 42,
  });
  assert.equal(record.outcome, "error");
  assert.equal(record.agentId, "short");
  assert.equal(record.durationMs, undefined);
});

test("shortAgentId takes the first 8 chars and falls back to a placeholder", () => {
  assert.equal(shortAgentId("0123456789"), "01234567");
  assert.equal(shortAgentId(""), "unknown");
  assert.equal(shortAgentId("  "), "unknown");
});

test("redactSecrets replaces values whose keys look sensitive, at any depth", () => {
  const redacted = redactSecrets({
    command: "curl",
    token: "sk-live-123",
    nested: { api_key: "abc", apiKey: "def", ok: "keep" },
    headers: { Authorization: "Bearer x", "x-secret-value": "hide" },
    list: [{ password: "pw", safe: "ok" }],
  }) as Record<string, any>;

  assert.equal(redacted.command, "curl");
  assert.equal(redacted.token, REDACTED);
  assert.equal(redacted.nested.api_key, REDACTED);
  assert.equal(redacted.nested.apiKey, REDACTED);
  assert.equal(redacted.nested.ok, "keep");
  assert.equal(redacted.headers["x-secret-value"], REDACTED);
  assert.equal(redacted.list[0].password, REDACTED);
  assert.equal(redacted.list[0].safe, "ok");
});

test("secrets are redacted before truncation in the stored args string", () => {
  const record = buildRecord({
    sessionId: "s",
    cwd: "/x",
    tool: "bash",
    args: { password: "hunter2", command: "echo hi" },
    isError: false,
    endedAt: 0,
  });
  assert.ok(!record.args.includes("hunter2"));
  assert.ok(record.args.includes(REDACTED));
});

test("truncateBytes caps to the byte budget and tags the dropped size", () => {
  const short = "hello";
  assert.equal(truncateBytes(short, 100), short);

  const long = "a".repeat(5000);
  const cut = truncateBytes(long, MAX_ARGS_BYTES);
  assert.ok(Buffer.byteLength(cut, "utf8") <= MAX_ARGS_BYTES + 32);
  assert.ok(cut.endsWith("B]"));
  assert.ok(cut.includes("…[+"));
});

test("resultPreview extracts text content, output, or JSON", () => {
  assert.equal(resultPreview({ content: [{ type: "text", text: "one" }, { type: "text", text: "two" }] }), "one\ntwo");
  assert.equal(resultPreview({ output: "raw" }), "raw");
  assert.equal(resultPreview("plain"), "plain");
  assert.equal(resultPreview({ code: 1 }), JSON.stringify({ code: 1 }));
  assert.equal(resultPreview(null), "");
});

test("aggregate counts per directory, per agent, per tool with error rate", () => {
  const records: AuditRecord[] = [
    rec({ agentId: "aaa", cwd: "/p1", tool: "bash", outcome: "ok" }),
    rec({ agentId: "aaa", cwd: "/p1", tool: "bash", outcome: "error" }),
    rec({ agentId: "bbb", cwd: "/p2", tool: "read", outcome: "ok" }),
    rec({ agentId: "aaa", cwd: "/p1", tool: "read", outcome: "ok" }),
  ];
  const summary = aggregate(records);

  assert.equal(summary.total, 4);
  assert.equal(summary.errors, 1);
  assert.equal(summary.errorRate, 0.25);

  assert.equal(summary.byDir[0].key, "/p1");
  assert.equal(summary.byDir[0].total, 3);
  assert.equal(summary.byDir[0].errors, 1);

  assert.equal(summary.byAgent[0].key, "aaa");
  assert.equal(summary.byAgent[0].total, 3);

  assert.equal(summary.byTool[0].key, "bash");
  assert.equal(summary.byTool[0].total, 2);
});

test("formatAgent reports only the requested agent's calls", () => {
  const records: AuditRecord[] = [
    rec({ agentId: "aaa", tool: "bash", outcome: "ok" }),
    rec({ agentId: "bbb", tool: "read", outcome: "error" }),
  ];
  const out = formatAgent(records, "bbb");
  assert.ok(out.includes("agent bbb"));
  assert.ok(out.includes("read"));
  assert.ok(!out.includes("bash"));
  assert.equal(formatAgent(records, "zzz"), "tool-audit: no calls for agent zzz");
});

test("writeRecord + readAllRecords round-trips JSONL across the daily file, skipping bad lines", () => {
  const dir = mkdtempSync(join(tmpdir(), "tool-audit-"));
  try {
    const record = buildRecord({
      sessionId: "roundtrip123",
      cwd: "/r",
      tool: "write",
      args: { path: "a.txt" },
      isError: false,
      endedAt: Date.now(),
    });
    writeRecord(dir, record);
    const read = readAllRecords(dir);
    assert.equal(read.length, 1);
    assert.deepEqual(read[0], record);
    assert.ok(dailyFilePath(dir).endsWith(".jsonl"));

    assert.deepEqual(parseJsonl('{"tool":"a"}\nnot json\n\n{"tool":"b"}'), [{ tool: "a" }, { tool: "b" }] as any);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function rec(partial: Partial<AuditRecord>): AuditRecord {
  return {
    ts: new Date(0).toISOString(),
    sessionId: "session",
    agentId: "aaa",
    cwd: "/p1",
    tool: "bash",
    args: "{}",
    outcome: "ok",
    preview: "",
    ...partial,
  };
}
