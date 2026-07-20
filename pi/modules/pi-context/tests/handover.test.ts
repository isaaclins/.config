import assert from "node:assert/strict";
import test from "node:test";
import {
  buildHandoverSummary,
  buildNudgeContent,
  computeFileLists,
  DEFAULT_CONFIG,
  shouldNudge,
} from "../src/handover.ts";

test("nudge fires at the threshold and repeats only every step", () => {
  assert.equal(shouldNudge(44.9, null), false);
  assert.equal(shouldNudge(45, null), true);
  assert.equal(shouldNudge(46, 45), false);
  assert.equal(shouldNudge(54.9, 45), false);
  assert.equal(shouldNudge(55, 45), true);
  assert.equal(shouldNudge(80, 55), true);
  assert.equal(shouldNudge(30, 45), false);
});

test("nudge threshold is configurable, not hardcoded", () => {
  const config = { nudgeThresholdPercent: 60, nudgeRepeatStepPercent: 5 };
  assert.equal(shouldNudge(59, null, config), false);
  assert.equal(shouldNudge(60, null, config), true);
  assert.equal(shouldNudge(64, 60, config), false);
  assert.equal(shouldNudge(65, 60, config), true);
});

test("DEFAULT_CONFIG exposes the default values for external inspection", () => {
  assert.equal(DEFAULT_CONFIG.nudgeThresholdPercent, 45);
  assert.equal(DEFAULT_CONFIG.nudgeRepeatStepPercent, 10);
});

test("nudge content leads with the exact fresh-memory line and addresses the agent", () => {
  const content = buildNudgeContent(46.8);
  assert.ok(content.startsWith("want a fresh memory? use /compact"));
  assert.ok(content.includes("46.8%"));
  assert.ok(content.includes("compact_context"));
  assert.ok(content.includes("handover"));
});

test("handover summary is labeled and trimmed", () => {
  const summary = buildHandoverSummary("  ## Goal\nship it\n  ");
  assert.ok(summary.startsWith("## Handover document"));
  assert.ok(summary.endsWith("## Goal\nship it"));
});

test("file lists mirror Pi semantics: modified wins over read, sorted output", () => {
  const lists = computeFileLists({
    read: new Set(["b.ts", "a.ts", "c.ts"]),
    written: new Set(["c.ts"]),
    edited: new Set(["b.ts"]),
  });
  assert.deepEqual(lists.readFiles, ["a.ts"]);
  assert.deepEqual(lists.modifiedFiles, ["b.ts", "c.ts"]);
  assert.deepEqual(computeFileLists(undefined), { readFiles: [], modifiedFiles: [] });
});
