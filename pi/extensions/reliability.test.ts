import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listMemoryFiles, MAX_OUTPUT_BYTES, MAX_OUTPUT_LINES, readMemoryFile, truncateMemoryOutput } from "./aside-memory-helpers.ts";
import { NotifyEventCursor, OwnedPaneRegistry } from "./spawn-agent-state.ts";
import { SessionPoller } from "./usage-lifecycle.ts";

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
