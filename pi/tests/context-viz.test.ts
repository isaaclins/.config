import assert from "node:assert/strict";
import test from "node:test";
import {
  buildBreakdown,
  buildGridCells,
  buildSummaryText,
  CELL_FREE,
  CELL_FULL,
  CELL_PARTIAL,
  estimateTokens,
  formatPercent,
  formatTokens,
} from "../lib/context-viz.ts";

test("token estimation and formatting match the chars/4 heuristic and k/m suffixes", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("abcd".repeat(100)), 100);
  assert.equal(formatTokens(114), "114");
  assert.equal(formatTokens(4200), "4.2k");
  assert.equal(formatTokens(13000), "13k");
  assert.equal(formatTokens(967_500), "967.5k");
  assert.equal(formatTokens(1_000_000), "1m");
  assert.equal(formatPercent(4200, 1_000_000), "0.4%");
  assert.equal(formatPercent(0, 0), "0.0%");
});

test("grid fills proportionally, marks partial cells, and never renders empty for nonzero usage", () => {
  const empty = buildGridCells(0, 200_000, 200);
  assert.equal(empty.filter((cell) => cell === CELL_FREE).length, 200);

  const three = buildGridCells(6000, 200_000, 200);
  assert.equal(three.filter((cell) => cell === CELL_FULL).length, 6);

  const tiny = buildGridCells(1, 1_000_000, 200);
  assert.equal(tiny.filter((cell) => cell === CELL_PARTIAL).length, 1);

  const overflow = buildGridCells(2_000_000, 1_000_000, 200);
  assert.equal(overflow.filter((cell) => cell === CELL_FULL).length, 200);
});

test("breakdown carves context files and skills from the prompt and derives messages from real usage", () => {
  const breakdown = buildBreakdown({
    contextWindow: 100_000,
    reportedTokens: 30_000,
    systemPromptTokens: 10_000,
    contextFileTokens: 3000,
    skillTokens: 2000,
    toolTokens: 5000,
    estimatedMessageTokens: 999_999,
  });
  const byLabel = Object.fromEntries(
    breakdown.categories.map((category) => [category.label, category.tokens]),
  );
  assert.equal(byLabel["System prompt"], 5000);
  assert.equal(byLabel["Context files"], 3000);
  assert.equal(byLabel["Skills"], 2000);
  assert.equal(byLabel["System tools"], 5000);
  assert.equal(byLabel["Messages"], 15_000);
  assert.equal(breakdown.usedTokens, 30_000);
  assert.equal(breakdown.freeTokens, 70_000);
});

test("breakdown clamps negative remainders and falls back to estimated messages without real usage", () => {
  const clamped = buildBreakdown({
    contextWindow: 50_000,
    reportedTokens: 1000,
    systemPromptTokens: 4000,
    contextFileTokens: 1000,
    skillTokens: 500,
    toolTokens: 2000,
    estimatedMessageTokens: 0,
  });
  const messages = clamped.categories.find((c) => c.label === "Messages");
  assert.equal(messages?.tokens, 0);

  const fallback = buildBreakdown({
    contextWindow: 50_000,
    reportedTokens: null,
    systemPromptTokens: 4000,
    contextFileTokens: 1000,
    skillTokens: 500,
    toolTokens: 2000,
    estimatedMessageTokens: 3000,
  });
  assert.equal(fallback.usedTokens, 9000);
  assert.equal(fallback.freeTokens, 41_000);
});

test("summary text stays compact and covers every category plus free space", () => {
  const breakdown = buildBreakdown({
    contextWindow: 1_000_000,
    reportedTokens: 32_500,
    systemPromptTokens: 10_000,
    contextFileTokens: 4000,
    skillTokens: 2000,
    toolTokens: 13_000,
    estimatedMessageTokens: 0,
  });
  const summary = buildSummaryText(breakdown);
  assert.match(summary, /^Context usage: 32\.5k\/1m tokens \(3\.3%\)\./);
  for (const label of [
    "System prompt",
    "System tools",
    "Context files",
    "Skills",
    "Messages",
    "Free",
  ]) {
    assert.ok(summary.includes(label), label);
  }
  assert.ok(summary.length < 400);
});
