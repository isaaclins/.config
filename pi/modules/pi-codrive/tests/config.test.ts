import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DEFAULT_MODEL, loadCodriveConfig } from "../src/config.ts";

test("loadCodriveConfig returns the file's model and thinking when present and valid", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-codrive-config-"));
  const configPath = join(directory, "config.json");
  writeFileSync(configPath, JSON.stringify({ model: "anthropic/claude-opus-4-8", thinking: "high" }));

  const config = loadCodriveConfig(configPath);

  assert.deepEqual(config, { model: "anthropic/claude-opus-4-8", thinking: "high" });
});

test("loadCodriveConfig returns the default model when the file does not exist", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-codrive-config-"));
  const configPath = join(directory, "missing.json");

  const config = loadCodriveConfig(configPath);

  assert.deepEqual(config, { model: DEFAULT_MODEL });
});

test("loadCodriveConfig throws an actionable error when the file is malformed JSON", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-codrive-config-"));
  const configPath = join(directory, "config.json");
  writeFileSync(configPath, "{ not valid json");

  assert.throws(() => loadCodriveConfig(configPath), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /Invalid pi-codrive config/);
    assert.match(error.message, new RegExp(configPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    return true;
  });
});

test("loadCodriveConfig falls back to the default model when the model field is missing or empty", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-codrive-config-"));
  const configPath = join(directory, "config.json");
  writeFileSync(configPath, JSON.stringify({ thinking: "low" }));

  const config = loadCodriveConfig(configPath);

  assert.deepEqual(config, { model: DEFAULT_MODEL, thinking: "low" });
});
