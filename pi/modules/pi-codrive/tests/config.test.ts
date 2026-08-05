import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DEFAULT_FIXER_MODEL,
  DEFAULT_MODEL,
  DEFAULT_THINKING,
  loadCodriveConfig,
} from "../src/config.ts";

test("built-in delegation defaults are Luna Max", () => {
  assert.equal(DEFAULT_MODEL, "openai-codex/gpt-5.6-luna");
  assert.equal(DEFAULT_THINKING, "max");
});

test("papercut repair defaults to a cheap model, separate from the delegation default", () => {
  assert.equal(DEFAULT_FIXER_MODEL, "anthropic/claude-haiku-4-5");
  assert.notEqual(DEFAULT_FIXER_MODEL, DEFAULT_MODEL);
});

test("loadCodriveConfig returns the file's model and thinking when present and valid", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-codrive-config-"));
  const configPath = join(directory, "config.json");
  writeFileSync(configPath, JSON.stringify({ model: "anthropic/claude-opus-4-8", thinking: "high" }));

  const config = loadCodriveConfig(configPath);

  assert.deepEqual(config, {
    model: "anthropic/claude-opus-4-8",
    thinking: "high",
    fixerModel: DEFAULT_FIXER_MODEL,
  });
});

test("loadCodriveConfig honors an explicit fixerModel and ignores a blank one", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-codrive-config-fixer-"));
  const configPath = join(directory, "config.json");

  writeFileSync(configPath, JSON.stringify({ fixerModel: "anthropic/claude-haiku-9" }));
  assert.equal(loadCodriveConfig(configPath).fixerModel, "anthropic/claude-haiku-9");

  writeFileSync(configPath, JSON.stringify({ fixerModel: "   " }));
  assert.equal(loadCodriveConfig(configPath).fixerModel, DEFAULT_FIXER_MODEL);
});

test("loadCodriveConfig returns the default model when the file does not exist", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-codrive-config-"));
  const configPath = join(directory, "missing.json");

  const config = loadCodriveConfig(configPath);

  assert.deepEqual(config, {
    model: DEFAULT_MODEL,
    thinking: DEFAULT_THINKING,
    fixerModel: DEFAULT_FIXER_MODEL,
  });
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

test("loadCodriveConfig falls back to defaults for missing model or thinking fields", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-codrive-config-"));
  const configPath = join(directory, "config.json");
  writeFileSync(configPath, JSON.stringify({ thinking: "low" }));

  assert.deepEqual(loadCodriveConfig(configPath), {
    model: DEFAULT_MODEL,
    thinking: "low",
    fixerModel: DEFAULT_FIXER_MODEL,
  });

  writeFileSync(configPath, JSON.stringify({ model: "anthropic/claude-opus-4-8" }));
  assert.deepEqual(loadCodriveConfig(configPath), {
    model: "anthropic/claude-opus-4-8",
    thinking: DEFAULT_THINKING,
    fixerModel: DEFAULT_FIXER_MODEL,
  });

  writeFileSync(configPath, JSON.stringify({ model: "   ", thinking: "   " }));
  assert.deepEqual(loadCodriveConfig(configPath), {
    model: DEFAULT_MODEL,
    thinking: DEFAULT_THINKING,
    fixerModel: DEFAULT_FIXER_MODEL,
  });
});
