import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  MAX_ARGS_BYTES,
  MAX_FULL_BYTES,
  MISSING_CALL_ID,
  REDACTED,
  aggregate,
  buildRecord,
  dailyFilePath,
  formatAgent,
  formatCall,
  formatCalls,
  fullArgs,
  fullResult,
  parseJsonl,
  readAllRecords,
  redactSecrets,
  resultPreview,
  shortAgentId,
  shortCallId,
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

test("shortCallId hashes to a stable 8-char id and distinguishes shared prefixes", () => {
  const a = shortCallId("call_abcdef_0001");
  const b = shortCallId("call_abcdef_0002");
  assert.equal(a.length, 8);
  assert.equal(a, shortCallId("call_abcdef_0001"));
  assert.notEqual(a, b);
  assert.equal(shortCallId(""), "");
  assert.equal(shortCallId("  "), "");
});

test("buildRecord derives callId from the toolCallId and omits it when absent", () => {
  const withId = buildRecord({
    sessionId: "s",
    toolCallId: "call_xyz",
    cwd: "/x",
    tool: "bash",
    args: { command: "ls" },
    isError: false,
    endedAt: 0,
  });
  assert.equal(withId.callId, shortCallId("call_xyz"));

  const withoutId = buildRecord({
    sessionId: "s",
    cwd: "/x",
    tool: "bash",
    args: {},
    isError: false,
    endedAt: 0,
  });
  assert.equal(withoutId.callId, undefined);
});

test("buildRecord stores full args and result, redacted, capped at MAX_FULL_BYTES", () => {
  const bigArg = "a".repeat(MAX_ARGS_BYTES * 4);
  const bigResult = "r".repeat(MAX_FULL_BYTES + 5000);
  const record = buildRecord({
    sessionId: "s",
    toolCallId: "c",
    cwd: "/x",
    tool: "bash",
    args: { command: bigArg, token: "sk-secret" },
    result: bigResult,
    isError: false,
    endedAt: 0,
  });

  // Compact fields stay tiny, full fields carry much more.
  assert.ok(Buffer.byteLength(record.args, "utf8") <= MAX_ARGS_BYTES + 32);
  assert.ok(record.argsFull !== undefined);
  assert.ok(Buffer.byteLength(record.argsFull!, "utf8") > MAX_ARGS_BYTES);
  assert.ok(!fullArgs(record).includes("sk-secret"));
  assert.ok(fullArgs(record).includes(REDACTED));

  // Full result is capped, not unbounded.
  assert.ok(record.resultFull !== undefined);
  assert.ok(Buffer.byteLength(fullResult(record), "utf8") <= MAX_FULL_BYTES + 32);
  assert.ok(fullResult(record).endsWith("B]"));
});

test("buildRecord omits full fields when they equal the compact fields", () => {
  const record = buildRecord({
    sessionId: "s",
    toolCallId: "c",
    cwd: "/x",
    tool: "read",
    args: { path: "a.txt" },
    result: "short result",
    isError: false,
    endedAt: 0,
  });
  assert.equal(record.argsFull, undefined);
  assert.equal(record.resultFull, undefined);
  assert.equal(fullArgs(record), record.args);
  assert.equal(fullResult(record), record.preview);
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

test("formatCalls lists newest first with callId and honors the limit", () => {
  const records: AuditRecord[] = [
    rec({ callId: "aaaaaaaa", tool: "bash", ts: new Date(1).toISOString() }),
    rec({ callId: "bbbbbbbb", tool: "read", ts: new Date(2).toISOString() }),
    rec({ callId: "cccccccc", tool: "write", ts: new Date(3).toISOString() }),
  ];
  const out = formatCalls(records, 2);
  const lines = out.split("\n");
  // Header + blank + 2 rows.
  assert.ok(lines[0].includes("showing 2"));
  assert.ok(lines[2].includes("cccccccc"));
  assert.ok(lines[3].includes("bbbbbbbb"));
  assert.ok(!out.includes("aaaaaaaa"));
  assert.equal(formatCalls([]), "tool-audit: no records yet");
});

test("formatCalls shows a placeholder for old records without a callId", () => {
  const out = formatCalls([rec({ tool: "bash" })]);
  assert.ok(out.includes(MISSING_CALL_ID));
});

test("formatCall prints full detail with pretty args and complete result", () => {
  const records: AuditRecord[] = [
    rec({
      callId: "deadbeef",
      tool: "bash",
      args: JSON.stringify({ command: "echo hi" }),
      argsFull: JSON.stringify({ command: "echo hi", note: "full" }),
      preview: "hi",
      resultFull: "hi there in full",
      durationMs: 12,
    }),
  ];
  const out = formatCall(records, "deadbeef");
  assert.ok(out.includes("tool-audit call deadbeef"));
  assert.ok(out.includes("duration:  12ms"));
  // Pretty-printed JSON from the full args, not the compact one.
  assert.ok(out.includes('"note": "full"'));
  assert.ok(out.includes("hi there in full"));
  assert.equal(formatCall(records, "nope1234"), "tool-audit: no call nope1234");
});

test("formatCall falls back to compact fields for old records", () => {
  const records: AuditRecord[] = [
    rec({ callId: "feedface", args: '{"path":"a.txt"}', preview: "ok" }),
  ];
  const out = formatCall(records, "feedface");
  assert.ok(out.includes('"path": "a.txt"'));
  assert.ok(out.includes("result:"));
});

test("old records without callId still parse and read back", () => {
  const legacy = parseJsonl(
    '{"ts":"1970-01-01T00:00:00.000Z","sessionId":"s","agentId":"aaa","cwd":"/p","tool":"bash","args":"{}","outcome":"ok","preview":""}',
  );
  assert.equal(legacy.length, 1);
  assert.equal(legacy[0].callId, undefined);
  assert.equal(fullArgs(legacy[0]), "{}");
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
