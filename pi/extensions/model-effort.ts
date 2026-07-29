import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  clampEffort,
  effortForLevel,
  effortStatusLabel,
  levelForEffort,
  modelKey,
  supportedEfforts,
  type EffortModel,
  type PiThinkingLevel,
} from "../lib/model-effort.ts";

const RAINBOW_COLORS = [
  "#b281d6",
  "#d787af",
  "#febc38",
  "#e4c00f",
  "#89d281",
  "#00afaf",
  "#178fb9",
] as const;

function ansiColor(hex: string): string {
  const value = hex.slice(1);
  const red = Number.parseInt(value.slice(0, 2), 16);
  const green = Number.parseInt(value.slice(2, 4), 16);
  const blue = Number.parseInt(value.slice(4, 6), 16);
  return `\x1b[38;2;${red};${green};${blue}m`;
}

function rainbow(text: string): string {
  let result = "";
  let colorIndex = 0;
  for (const character of text) {
    result += `${ansiColor(RAINBOW_COLORS[colorIndex % RAINBOW_COLORS.length])}${character}`;
    colorIndex += 1;
  }
  return `${result}\x1b[0m`;
}

function setEffortStatus(
  ctx: ExtensionContext,
  model: EffortModel | undefined,
  effort: string | undefined,
): void {
  if (!model || !effort) {
    ctx.ui.setStatus("effort", undefined);
    return;
  }

  const status = effortStatusLabel(model, effort);
  ctx.ui.setStatus(
    "effort",
    status.isMaximum
      ? rainbow(status.label)
      : ctx.ui.theme.fg("accent", status.label),
  );
}

export default function modelEffort(pi: ExtensionAPI): void {
  let activeModel: EffortModel | undefined;
  let selectedEffort: string | undefined;

  pi.registerCommand("effort", {
    description: "Show or set the current model's reasoning effort",
    getArgumentCompletions(prefix) {
      if (!activeModel) return null;
      const matches = supportedEfforts(activeModel)
        .filter((effort) => effort.startsWith(prefix.toLowerCase()))
        .map((effort) => ({ value: effort, label: effort }));
      return matches.length > 0 ? matches : null;
    },
    handler: async (args, ctx) => {
      const model = ctx.model as EffortModel | undefined;
      if (!model) {
        ctx.ui.notify("No model selected", "warning");
        return;
      }

      const available = supportedEfforts(model);
      const requested = args.trim().toLowerCase();
      if (!requested) {
        const current = effortForLevel(model, pi.getThinkingLevel()) ?? "unknown";
        ctx.ui.notify(
          `Effort: ${current}. Available: ${available.join(", ")}`,
          "info",
        );
        return;
      }

      const level = levelForEffort(model, requested);
      if (!level) {
        ctx.ui.notify(
          `Unsupported effort "${requested}" for ${model.id}. Available: ${available.join(", ")}`,
          "error",
        );
        return;
      }

      activeModel = model;
      selectedEffort = requested;
      pi.setThinkingLevel(level);
      setEffortStatus(ctx, model, requested);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    activeModel = ctx.model as EffortModel | undefined;
    selectedEffort = activeModel
      ? effortForLevel(activeModel, pi.getThinkingLevel())
      : undefined;
    setEffortStatus(ctx, activeModel, selectedEffort);
  });

  pi.on("thinking_level_select", async (event, ctx) => {
    const eventModel = ctx.model as EffortModel | undefined;
    if (!eventModel) return;

    // Pi clamps before model_select. Preserve the old semantic effort until
    // model_select can map it onto the new model.
    if (activeModel && modelKey(activeModel) !== modelKey(eventModel)) return;

    activeModel = eventModel;
    selectedEffort = effortForLevel(
      eventModel,
      event.level as PiThinkingLevel,
    );
    setEffortStatus(ctx, eventModel, selectedEffort);
  });

  pi.on("model_select", async (event, ctx) => {
    const nextModel = event.model as EffortModel;
    const previousEffort =
      selectedEffort ??
      (event.previousModel
        ? effortForLevel(
            event.previousModel as EffortModel,
            pi.getThinkingLevel(),
          )
        : undefined);

    activeModel = nextModel;
    if (!previousEffort) {
      selectedEffort = effortForLevel(nextModel, pi.getThinkingLevel());
      setEffortStatus(ctx, nextModel, selectedEffort);
      return;
    }

    const nextEffort = clampEffort(nextModel, previousEffort);
    const nextLevel = levelForEffort(nextModel, nextEffort);
    selectedEffort = nextEffort;
    if (nextLevel && pi.getThinkingLevel() !== nextLevel) {
      pi.setThinkingLevel(nextLevel);
    }
    setEffortStatus(ctx, nextModel, nextEffort);

    if (nextEffort !== previousEffort && event.source !== "restore") {
      ctx.ui.notify(
        `Effort clamped from ${previousEffort} to ${nextEffort} for ${nextModel.id}`,
        "info",
      );
    }
  });
}
