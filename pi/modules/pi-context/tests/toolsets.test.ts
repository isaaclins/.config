import assert from "node:assert/strict";
import { test } from "node:test";
import {
  baseToolNames,
  buildGatewayDescription,
  DEFAULT_FAMILIES,
  familyToolNames,
  resolveFamily,
  staleFamilies,
  withFamily,
  withoutFamily,
} from "../src/toolsets.ts";

const families = DEFAULT_FAMILIES;

test("base set drops family tools and keeps the gateway", () => {
  const active = ["read", "bash", "observe_ui", "act_ui", "excalidraw_create_board"];
  const base = baseToolNames(active, families, "use_toolset");
  assert.deepEqual(base, ["read", "bash", "use_toolset"]);
});

test("gateway stays present when already active", () => {
  const base = baseToolNames(["read", "use_toolset"], families, "use_toolset");
  assert.deepEqual(base, ["read", "use_toolset"]);
});

test("activate adds only registered family tools, without duplicates", () => {
  const family = resolveFamily(families, "desktop_ui");
  assert.ok(family);
  const known = new Set(["observe_ui", "act_ui"]);
  const next = withFamily(["read", "observe_ui"], family, known);
  assert.deepEqual(next, ["read", "observe_ui", "act_ui"]);
});

test("release removes the whole family and nothing else", () => {
  const family = resolveFamily(families, "diagram");
  assert.ok(family);
  const next = withoutFamily(["read", "excalidraw_create_board", "act_ui"], family);
  assert.deepEqual(next, ["read", "act_ui"]);
});

test("families idle past the threshold are reported stale", () => {
  const active = new Map([
    ["desktop_ui", 2],
    ["diagram", 14],
  ]);
  assert.deepEqual(staleFamilies(active, 15, 12), ["desktop_ui"]);
});

test("gateway description names every family", () => {
  const description = buildGatewayDescription(families);
  for (const family of families) assert.ok(description.includes(family.id));
});

test("family tool names are disjoint", () => {
  const total = families.reduce((sum, family) => sum + family.tools.length, 0);
  assert.equal(familyToolNames(families).size, total);
});
