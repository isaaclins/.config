import assert from "node:assert/strict";
import test from "node:test";
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, renameSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listMemoryFiles, MAX_OUTPUT_BYTES, MAX_OUTPUT_LINES, readMemoryFile, truncateMemoryOutput } from "../lib/aside-memory-helpers.ts";
import {
  assertPrivateArtifact,
  cleanupPrivateArtifacts,
  createSpawnReport,
  formatReports,
  JsonlCursor,
  MAX_REPORT_BYTES,
  NotifyEventCursor,
  OwnedPaneRegistry,
  ReportStore,
  truncateReportOutput,
} from "../lib/spawn-agent-state.ts";
import { SessionPoller } from "../lib/usage-lifecycle.ts";

function memoryFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "pi-memory-"));
  mkdirSync(join(root, "people"));
  writeFileSync(join(root, "people", "alice.md"), "Alice");
  return root;
}

test("memory paths reject sibling-prefix traversal and dot-dot traversal", () => {
  const root = memoryFixture();
  const sibling = `${root}-sibling`;
  mkdirSync(sibling);
  writeFileSync(join(sibling, "secret.md"), "secret");
  assert.throws(() => readMemoryFile(root, "../" + sibling.split("/").pop() + "/secret.md"), /escapes/);
  assert.throws(() => readMemoryFile(root, "../secret.md"), /escapes/);
});

test("memory files reject symlink escapes and list ignores symlinks", () => {
  const root = memoryFixture();
  const outside = mkdtempSync(join(tmpdir(), "pi-outside-"));
  writeFileSync(join(outside, "secret.md"), "secret");
  symlinkSync(join(outside, "secret.md"), join(root, "escape.md"));
  assert.throws(() => readMemoryFile(root, "escape.md"), /symlinked paths/);
  assert.deepEqual(listMemoryFiles(root), ["people/alice.md"]);
});

test("memory output truncation stays within both Pi limits and marks truncation", () => {
  const manyLines = Array.from({ length: MAX_OUTPUT_LINES + 50 }, (_, index) => `line ${index}`).join("\n");
  const truncatedLines = truncateMemoryOutput(manyLines);
  assert.ok(truncatedLines.split("\n").length <= MAX_OUTPUT_LINES);
  assert.match(truncatedLines, /Output truncated/);
  const truncatedBytes = truncateMemoryOutput("x".repeat(MAX_OUTPUT_BYTES + 1));
  assert.ok(Buffer.byteLength(truncatedBytes) <= MAX_OUTPUT_BYTES);
  assert.match(truncatedBytes, /Output truncated/);
});

test("notification cursor processes pre-existing and later appended events once", () => {
  const cursor = new NotifyEventCursor();
  const first = '{"event":"agent_end","ts":1}\n';
  assert.deepEqual(cursor.ingest(first), ['{"event":"agent_end","ts":1}']);
  assert.deepEqual(cursor.ingest(first), []);
  const second = first + '{"event":"agent_end","ts":2}\n';
  assert.deepEqual(cursor.ingest(second), ['{"event":"agent_end","ts":2}']);
});

test("notification cursors keep concurrent children independent", () => {
  const firstChild = new NotifyEventCursor();
  const secondChild = new NotifyEventCursor();
  assert.equal(firstChild.ingest('{"event":"agent_end"}\n').length, 1);
  assert.equal(secondChild.ingest('{"event":"agent_end"}\n').length, 1);
});

test("usage poller cleanup clears its interval and prevents duplicate pollers", () => {
  let created = 0;
  let cleared = 0;
  const timer = { unref() {} } as unknown as ReturnType<typeof setInterval>;
  const poller = new SessionPoller({
    setInterval: () => { created++; return timer; },
    clearInterval: () => { cleared++; },
  }, 1);
  poller.start(() => {});
  poller.start(() => {});
  assert.equal(created, 1);
  assert.equal(poller.running, true);
  poller.stop();
  assert.equal(cleared, 1);
  assert.equal(poller.running, false);
});

test("owned pane registry rejects foreign panes and removes dead panes", () => {
  const panes = new OwnedPaneRegistry();
  panes.add("%10");
  assert.equal(panes.has("%10"), true);
  assert.equal(panes.has("%11"), false);
  panes.delete("%10");
  assert.equal(panes.has("%10"), false);
});

test("structured reports extract the latest assistant text array and statuses", () => {
  const messages = [
    { role: "assistant", content: [{ type: "text", text: "old" }], stopReason: "stop" },
    { role: "toolResult", content: [] },
    { role: "assistant", content: [{ type: "thinking", thinking: "hidden" }, { type: "text", text: "final" }, { type: "text", text: "line" }], stopReason: "error", errorMessage: "token=super-secret-value" },
  ];
  const error = createSpawnReport(messages, "event-error", "%1", new Date("2026-01-01T00:00:00Z"));
  assert.equal(error.assistantText, "final\nline");
  assert.equal(error.status, "error");
  assert.doesNotMatch(error.errorSummary ?? "", /super-secret/);
  assert.equal(createSpawnReport([{ role: "assistant", content: "done", stopReason: "stop" }], "ok").status, "completed");
  assert.equal(createSpawnReport([{ role: "assistant", content: [], stopReason: "aborted" }], "abort").status, "aborted");
});

test("JSONL cursor handles partial, duplicate callbacks, truncation, and rotation", () => {
  const cursor = new JsonlCursor();
  assert.deepEqual(cursor.ingest('{"a":1'), []);
  assert.deepEqual(cursor.ingest('{"a":1}\n'), ['{"a":1}']);
  assert.deepEqual(cursor.ingest('{"a":1}\n'), []);
  assert.deepEqual(cursor.ingest('{"b":2}\n'), ['{"b":2}']);
  assert.deepEqual(cursor.ingest(""), []);
  assert.deepEqual(cursor.ingest('{"c":3}\n'), ['{"c":3}']);
});

function reportFixture(pane = "%20") {
  const root = mkdtempSync(join(tmpdir(), "pi-reports-"));
  const file = join(root, "report.jsonl");
  writeFileSync(file, "", { mode: 0o600 });
  const store = new ReportStore();
  store.add(pane, file);
  return { root, file, pane, store };
}

function record(eventId: string, text: string, pane = "%20") {
  return createSpawnReport([{ role: "assistant", content: [{ type: "text", text }], stopReason: "stop" }], eventId, pane);
}

test("report store reads pre-existing multiple turns with latest, all, malformed, partial, and duplicate records", () => {
  const fixture = reportFixture();
  const first = JSON.stringify(record("one", "first"));
  const second = JSON.stringify(record("two", "second"));
  writeFileSync(fixture.file, `${first}\nmalformed\n${second.slice(0, 20)}`);
  assert.equal(fixture.store.get(fixture.pane, "latest")[0]?.assistantText, "first");
  writeFileSync(fixture.file, `${first}\nmalformed\n${second}\n${second}\n`);
  assert.deepEqual(fixture.store.get(fixture.pane, "all").map((item) => item.assistantText), ["first", "second"]);
  assert.equal(fixture.store.get(fixture.pane, 1)[0]?.eventId, "one");
  assert.deepEqual(fixture.store.get(fixture.pane, 99), []);
});

test("report stores keep concurrent panes independent and persist after live ownership removal", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-concurrent-reports-"));
  const firstFile = join(root, "first.jsonl");
  const secondFile = join(root, "second.jsonl");
  writeFileSync(firstFile, JSON.stringify(record("first", "pane one", "%31")) + "\n");
  writeFileSync(secondFile, JSON.stringify(record("second", "pane two", "%32")) + "\n");
  const store = new ReportStore();
  store.add("%31", firstFile); store.add("%32", secondFile);
  const live = new OwnedPaneRegistry(); live.add("%31"); live.delete("%31");
  assert.equal(store.get("%31")[0]?.assistantText, "pane one");
  assert.equal(store.get("%32")[0]?.assistantText, "pane two");
  assert.throws(() => store.get("%99"), /spawned by this parent/);
});

test("report store tolerates file truncation and rotation without duplicate reports", () => {
  const fixture = reportFixture();
  writeFileSync(fixture.file, JSON.stringify(record("one", "first")) + "\n");
  assert.equal(fixture.store.get(fixture.pane, "all").length, 1);
  writeFileSync(fixture.file, JSON.stringify(record("two", "rotated")) + "\n");
  assert.deepEqual(fixture.store.get(fixture.pane, "all").map((item) => item.eventId), ["one", "two"]);
  writeFileSync(fixture.file, JSON.stringify(record("one", "duplicate old")) + "\n");
  assert.equal(fixture.store.get(fixture.pane, "all").length, 2);
});

test("report formatting truncates at Pi output limits with a clear marker", () => {
  const output = truncateReportOutput(formatReports([record("large", "x".repeat(MAX_REPORT_BYTES * 2))]));
  assert.equal(output.truncated, true);
  assert.ok(Buffer.byteLength(output.content) <= MAX_REPORT_BYTES);
  assert.match(output.content, /Output truncated/);
});

test("private artifact validation enforces direct regular files and portable permissions", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-private-"));
  chmodSync(root, 0o700);
  const file = join(root, "report.jsonl");
  const descriptor = openSync(file, "wx", 0o600); closeSync(descriptor);
  assert.doesNotThrow(() => assertPrivateArtifact(file, root));
  if (process.platform !== "win32") {
    assert.equal(statSync(root).mode & 0o777, 0o700);
    assert.equal(statSync(file).mode & 0o777, 0o600);
  }
  const outside = join(mkdtempSync(join(tmpdir(), "pi-private-outside-")), "outside.jsonl");
  writeFileSync(outside, "");
  symlinkSync(outside, join(root, "link.jsonl"));
  assert.throws(() => assertPrivateArtifact(join(root, "link.jsonl"), root), /unsafe/);
  assert.throws(() => assertPrivateArtifact(outside, root), /escapes/);
  cleanupPrivateArtifacts(root);
  assert.equal(existsSync(root), false);
});

test("report store rejects a report file replaced by a symlink", () => {
  const fixture = reportFixture();
  const outside = join(mkdtempSync(join(tmpdir(), "pi-report-attack-")), "outside.jsonl");
  writeFileSync(outside, JSON.stringify(record("stolen", "outside")) + "\n");
  const replacement = `${fixture.file}.replacement`;
  symlinkSync(outside, replacement);
  unlinkSync(fixture.file);
  renameSync(replacement, fixture.file);
  assert.throws(() => fixture.store.get(fixture.pane), /unsafe/);
});
