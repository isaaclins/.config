import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  clampEffort,
  effortForLevel,
  levelForEffort,
  modelKey,
  supportedEfforts,
  type EffortModel,
  type PiThinkingLevel,
} from "../lib/model-effort.ts";

function setEffortStatus(ctx: ExtensionContext, effort: string | undefined): void {
  ctx.ui.setStatus(
    "effort",
    effort ? ctx.ui.theme.fg("accent", `effort:${effort}`) : undefined,
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
      setEffortStatus(ctx, requested);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    activeModel = ctx.model as EffortModel | undefined;
    selectedEffort = activeModel
      ? effortForLevel(activeModel, pi.getThinkingLevel())
      : undefined;
    setEffortStatus(ctx, selectedEffort);
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
    setEffortStatus(ctx, selectedEffort);
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
      setEffortStatus(ctx, selectedEffort);
      return;
    }

    const nextEffort = clampEffort(nextModel, previousEffort);
    const nextLevel = levelForEffort(nextModel, nextEffort);
    selectedEffort = nextEffort;
    if (nextLevel && pi.getThinkingLevel() !== nextLevel) {
      pi.setThinkingLevel(nextLevel);
    }
    setEffortStatus(ctx, nextEffort);

    if (nextEffort !== previousEffort && event.source !== "restore") {
      ctx.ui.notify(
        `Effort clamped from ${previousEffort} to ${nextEffort} for ${nextModel.id}`,
        "info",
      );
    }
  });
}
