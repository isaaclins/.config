import assert from "node:assert/strict";
import test from "node:test";
import {
  buildStickyLine,
  clampOffset,
  formatCharCount,
  summarizePrompt,
  wrapPlainText,
} from "../lib/sticky-prompt.ts";

test("short prompt passes through untouched", () => {
  const summary = summarizePrompt("fix the failing test in auth.ts");
  assert.equal(summary.line, "fix the failing test in auth.ts");
  assert.equal(summary.truncated, false);
  assert.equal(summary.hiddenChars, 0);
});

test("massive prompt keeps only the first sentence", () => {
  const raw = "Refactor the auth module so tokens rotate. " + "x".repeat(5000);
  const summary = summarizePrompt(raw);
  assert.equal(summary.line, "Refactor the auth module so tokens rotate.");
  assert.equal(summary.truncated, true);
  assert.ok(summary.hiddenChars > 4000);
});

test("single huge line gets word-boundary cut with ellipsis", () => {
  const raw = "please look at " + "wordy ".repeat(100);
  const summary = summarizePrompt(raw, 40);
  assert.ok(summary.line.length <= 40);
  assert.ok(summary.line.endsWith("\u2026"));
  assert.equal(summary.truncated, true);
});

test("paste markers are stripped and counted", () => {
  const raw = "explain this log [pasted #1 +450 lines] and this one [pasted #2 +12 lines]";
  const summary = summarizePrompt(raw);
  assert.equal(summary.pasteCount, 2);
  assert.ok(!summary.line.includes("[pasted"));
});

test("buildStickyLine adds badges only when needed", () => {
  assert.equal(buildStickyLine("hello there"), "\u25c6 hello there");
  const long = buildStickyLine("first part. " + "y".repeat(3000));
  assert.match(long, /\(\+\d+(\.\d+)?k? chars\)$/);
});

test("formatCharCount", () => {
  assert.equal(formatCharCount(999), "999");
  assert.equal(formatCharCount(2400), "2.4k");
  assert.equal(formatCharCount(15000), "15k");
});

test("clampOffset stays within bounds", () => {
  assert.equal(clampOffset(-5, 100, 20), 0);
  assert.equal(clampOffset(500, 100, 20), 80);
  assert.equal(clampOffset(10, 15, 20), 0);
});

test("wrapPlainText respects width and blank lines", () => {
  const lines = wrapPlainText("a".repeat(25) + "\n\nshort", 10);
  assert.ok(lines.every((line) => line.length <= 10));
  assert.ok(lines.includes(""));
  assert.ok(lines.includes("short"));
});
