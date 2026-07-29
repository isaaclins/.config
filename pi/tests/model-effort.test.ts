import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import modelEffortExtension from "../extensions/model-effort.ts";
import {
  availableThinkingLevels,
  cycleEffort,
  levelForModelSwitch,
  supportedEfforts,
  type EffortModel,
  type PiThinkingLevel,
} from "../lib/model-effort.ts";

const config = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "models.json"), "utf8"),
) as {
  providers: Record<
    string,
    {
      models?: EffortModel[];
      modelOverrides?: Record<string, Partial<EffortModel>>;
    }
  >;
};

function configuredModels(): { fable: EffortModel; sol: EffortModel } {
  const fableOverride = config.providers.anthropic.modelOverrides?.["claude-fable-5"];
  const solDefinition = config.providers["openai-codex"].models?.find(
    (model) => model.id === "gpt-5.6-sol",
  );
  assert.ok(fableOverride?.thinkingLevelMap);
  assert.ok(solDefinition?.thinkingLevelMap);
  return {
    fable: {
      id: "claude-fable-5",
      provider: "anthropic",
      reasoning: true,
      ...fableOverride,
    },
    sol: { ...solDefinition, provider: "openai-codex" },
  };
}

test("models.json exposes the requested model-specific effort sets", () => {
  const { fable, sol } = configuredModels();
  assert.deepEqual(supportedEfforts(sol), [
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
    "ultra",
  ]);
  assert.deepEqual(supportedEfforts(fable), [
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);

  const openAiSol = config.providers.openai.models?.find(
    (model) => model.id === "gpt-5.6-sol",
  );
  assert.deepEqual(openAiSol?.thinkingLevelMap, sol.thinkingLevelMap);
});

test("Shift+Tab order follows each model's thinkingLevelMap and wraps", () => {
  const { fable, sol } = configuredModels();

  function cycleAll(model: EffortModel): string[] {
    const levels = availableThinkingLevels(model);
    let level = levels.at(-1) as PiThinkingLevel;
    return levels.map(() => {
      const next = cycleEffort(model, level);
      level = next.level;
      return next.effort;
    });
  }

  assert.deepEqual(cycleAll(sol), [
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
    "ultra",
  ]);
  assert.deepEqual(cycleAll(fable), [
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);
});

test("model switches preserve semantic effort and clamp unsupported ultra to max", () => {
  const { fable, sol } = configuredModels();
  assert.deepEqual(levelForModelSwitch(sol, "max", fable), {
    effort: "max",
    level: "max",
  });
  assert.deepEqual(levelForModelSwitch(fable, "max", sol), {
    effort: "max",
    level: "xhigh",
  });
});

test("/effort and thinking_level_select use model-aware names", async () => {
  const { fable, sol } = configuredModels();
  const commands = new Map<string, any>();
  const handlers = new Map<string, Array<(event: any, ctx: any) => Promise<void>>>();
  const setLevels: PiThinkingLevel[] = [];
  const statuses: Array<string | undefined> = [];
  const notifications: string[] = [];
  let currentLevel: PiThinkingLevel = "medium";

  const pi = {
    registerCommand(name: string, command: any) {
      commands.set(name, command);
    },
    on(name: string, handler: (event: any, ctx: any) => Promise<void>) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    getThinkingLevel() {
      return currentLevel;
    },
    setThinkingLevel(level: PiThinkingLevel) {
      currentLevel = level;
      setLevels.push(level);
    },
  };
  modelEffortExtension(pi as any);

  function context(model: EffortModel) {
    return {
      model,
      ui: {
        theme: { fg: (_color: string, value: string) => value },
        setStatus: (_key: string, value: string | undefined) => statuses.push(value),
        notify: (message: string) => notifications.push(message),
      },
    };
  }

  await handlers.get("session_start")?.[0]({}, context(sol));
  await commands.get("effort").handler("ultra", context(sol));
  assert.deepEqual(setLevels, ["max"]);
  assert.equal(statuses.at(-1), "effort:ultra");

  currentLevel = "xhigh";
  await handlers.get("thinking_level_select")?.[0]
    ({ level: "xhigh", previousLevel: "high" }, context(sol));
  assert.equal(statuses.at(-1), "effort:max");

  currentLevel = "max";
  await commands.get("effort").handler("ultra", context(fable));
  assert.match(notifications.at(-1) ?? "", /Unsupported effort/);
});

test("model_select clamps a remembered ultra effort to Fable max", async () => {
  const { fable, sol } = configuredModels();
  const handlers = new Map<string, Array<(event: any, ctx: any) => Promise<void>>>();
  const statuses: Array<string | undefined> = [];
  const notifications: string[] = [];
  let currentLevel: PiThinkingLevel = "max";

  const pi = {
    registerCommand() {},
    on(name: string, handler: (event: any, ctx: any) => Promise<void>) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    getThinkingLevel: () => currentLevel,
    setThinkingLevel(level: PiThinkingLevel) {
      currentLevel = level;
    },
  };
  modelEffortExtension(pi as any);

  const context = (model: EffortModel) => ({
    model,
    ui: {
      theme: { fg: (_color: string, value: string) => value },
      setStatus: (_key: string, value: string | undefined) => statuses.push(value),
      notify: (message: string) => notifications.push(message),
    },
  });

  await handlers.get("session_start")?.[0]({}, context(sol));
  await handlers.get("model_select")?.[0]
    (
      { model: fable, previousModel: sol, source: "set" },
      context(fable),
    );

  assert.equal(currentLevel, "max");
  assert.equal(statuses.at(-1), "effort:max");
  assert.match(notifications.at(-1) ?? "", /ultra to max/);
});
