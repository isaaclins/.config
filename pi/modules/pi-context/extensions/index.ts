import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  buildHandoverSummary,
  buildNudgeContent,
  computeFileLists,
  DEFAULT_CONFIG,
  shouldNudge,
  type HandoverConfig,
} from "../src/handover.ts";
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
  GRID_COLUMNS,
  GRID_ROWS,
  type ContextBreakdown,
} from "../src/usage-viz.ts";
import { createInterruptSubmitHandler } from "../src/interrupt-submit.ts";

const NUDGE_MESSAGE_TYPE = "context-handover-nudge";
const VIZ_MESSAGE_TYPE = "context-viz";

interface ContextVizDetails {
  breakdown: ContextBreakdown;
  modelLine: string;
  providerLine: string;
  skillCount: number;
  contextFileCount: number;
  activeToolCount: number;
}

export default function piContext(pi: ExtensionAPI) {
  // --- Session-scoped state (one instance per extension call = per session) ---
  let lastNudgedPercent: number | null = null;
  let pendingHandover: string | null = null;
  let compactRequested = false;

  // Configurable nudge thresholds: read from pi settings or use defaults.
  const config: HandoverConfig = {
    nudgeThresholdPercent:
      (pi as unknown as { getSetting?: (key: string) => unknown }).getSetting?.("context.nudgeThresholdPercent") as number
      ?? DEFAULT_CONFIG.nudgeThresholdPercent,
    nudgeRepeatStepPercent:
      (pi as unknown as { getSetting?: (key: string) => unknown }).getSetting?.("context.nudgeRepeatStepPercent") as number
      ?? DEFAULT_CONFIG.nudgeRepeatStepPercent,
  };

  const resetAfterCompaction = () => {
    lastNudgedPercent = null;
    pendingHandover = null;
    compactRequested = false;
  };

  const usagePercent = (ctx: ExtensionContext): number | null => {
    const usage = ctx.getContextUsage();
    if (!usage || usage.tokens === null || !usage.contextWindow) return null;
    return (usage.tokens / usage.contextWindow) * 100;
  };

  // --- Handover tool ---
  pi.registerTool({
    name: "compact_context",
    label: "Compact context",
    description:
      "Hand over and compact the conversation context. Call this at a good stopping point when context usage is high. Pass a complete inline handover document (goal, current state, decisions made, next steps, gotchas); it becomes the compaction summary, recent messages are kept automatically, and you continue working with a fresh context.",
    parameters: Type.Object({
      handover: Type.String({
        description:
          "Full handover document in markdown: goal, current state, decisions, next steps, gotchas. Written for your future self with no other memory of this session.",
      }),
    }),
    async execute(_id, params) {
      pendingHandover = params.handover;
      return {
        content: [
          {
            type: "text",
            text: "Handover recorded. Compaction will run at the next turn boundary; keep working normally.",
          },
        ],
        details: {},
      };
    },
  });

  // --- Turn-end: nudge or compact ---
  pi.on("turn_end", async (_event, ctx) => {
    if (pendingHandover !== null) {
      if (compactRequested) return;
      compactRequested = true;
      ctx.compact({
        onError: (error: Error) => {
          compactRequested = false;
          if (ctx.hasUI) {
            ctx.ui.notify(
              `Handover compaction failed: ${error.message}`,
              "error",
            );
          }
        },
      });
      return;
    }

    const percent = usagePercent(ctx);
    if (percent === null) return;
    if (!shouldNudge(percent, lastNudgedPercent, config)) return;
    lastNudgedPercent = percent;
    pi.sendMessage({
      customType: NUDGE_MESSAGE_TYPE,
      content: buildNudgeContent(percent),
      display: true,
    });
  });

  // --- Compaction preparation: inject handover summary ---
  pi.on("session_before_compact", async (event) => {
    if (pendingHandover === null) return undefined;
    const { preparation } = event;
    const fileLists = computeFileLists(
      preparation.fileOps as
        | { read?: Set<string>; written?: Set<string>; edited?: Set<string> }
        | undefined,
    );
    return {
      compaction: {
        summary: buildHandoverSummary(pendingHandover),
        firstKeptEntryId: preparation.firstKeptEntryId,
        tokensBefore: preparation.tokensBefore,
        details: { source: "handover", ...fileLists },
      },
    };
  });

  // --- Post-compaction: reset state and resume ---
  pi.on("session_compact", async (_event, ctx) => {
    const hadHandover = pendingHandover !== null;
    resetAfterCompaction();
    if (hadHandover) {
      if (ctx.hasUI) {
        ctx.ui.notify("Compacted with agent handover document", "info");
      }
      pi.sendMessage(
        {
          customType: "context-handover-resume",
          content:
            "Context compaction complete. Continue exactly where your handover document left off.",
          display: true,
        },
        { triggerTurn: true },
      );
    }
  });

  // --- Context viz: /context command and renderer ---
  pi.registerMessageRenderer(VIZ_MESSAGE_TYPE, (message, _options, theme) => {
    const details = message.details as ContextVizDetails | undefined;
    if (!details) return undefined;
    const { breakdown } = details;
    const contextWindow = breakdown.contextWindow;

    const paintCell = (cell: string): string => {
      if (cell === CELL_FULL) return theme.fg("accent", cell);
      if (cell === CELL_PARTIAL) return theme.fg("warning", cell);
      return theme.fg("dim", cell);
    };
    const cells = buildGridCells(breakdown.usedTokens, contextWindow);
    const gridRows: string[] = [];
    for (let row = 0; row < GRID_ROWS; row++) {
      const slice = cells.slice(row * GRID_COLUMNS, (row + 1) * GRID_COLUMNS);
      gridRows.push(slice.map(paintCell).join(" "));
    }

    const headline = `${formatTokens(breakdown.usedTokens)}/${formatTokens(contextWindow)} tokens (${Math.round(
      contextWindow > 0 ? (breakdown.usedTokens / contextWindow) * 100 : 0,
    )}%)`;
    const legend: string[] = [
      theme.fg("text", details.modelLine),
      theme.fg("muted", details.providerLine),
      theme.fg("text", headline),
      "",
      theme.fg("muted", "Estimated usage by category"),
      ...breakdown.categories.map(
        (category) =>
          theme.fg("accent", CELL_FULL) +
          theme.fg(
            "text",
            ` ${category.label}: ${formatTokens(category.tokens)} tokens (${formatPercent(category.tokens, contextWindow)})`,
          ),
      ),
      theme.fg("dim", CELL_FREE) +
        theme.fg(
          "muted",
          ` Free space: ${formatTokens(breakdown.freeTokens)} (${formatPercent(breakdown.freeTokens, contextWindow)})`,
        ),
    ];

    const gridWidth = GRID_COLUMNS * 2 - 1;
    const lines: string[] = [theme.fg("accent", theme.bold("Context Usage")), ""];
    const rowCount = Math.max(gridRows.length, legend.length);
    for (let index = 0; index < rowCount; index++) {
      const grid = gridRows[index] ?? " ".repeat(gridWidth);
      const info = legend[index] ?? "";
      lines.push(`${grid}   ${info}`);
    }
    lines.push("");
    lines.push(
      theme.fg(
        "muted",
        `Skills: ${details.skillCount} loaded | Context files: ${details.contextFileCount} | Active tools: ${details.activeToolCount}`,
      ),
    );

    return {
      render: (width: number) =>
        lines.map((line) => line.slice(0, width)),
      invalidate() {},
    };
  });

  pi.registerCommand("context", {
    description: "Print context usage by category into the output",
    handler: async (_args, ctx) => {
      const usage = ctx.getContextUsage();
      const contextWindow = usage?.contextWindow ?? 0;
      const options = ctx.getSystemPromptOptions();

      const contextFiles = options.contextFiles ?? [];
      const contextFileTokens = contextFiles.reduce(
        (sum: number, file: { content?: string }) =>
          sum + estimateTokens(file.content ?? ""),
        0,
      );
      const skills = options.skills ?? [];
      const skillTokens = skills.reduce(
        (sum: number, skill: { name?: string; description?: string }) =>
          sum + estimateTokens(`${skill.name ?? ""} ${skill.description ?? ""}`),
        0,
      );

      const activeNames = new Set(pi.getActiveTools());
      const activeTools = pi
        .getAllTools()
        .filter((tool) => activeNames.has(tool.name));
      const toolTokens = activeTools.reduce(
        (sum, tool) =>
          sum +
          estimateTokens(
            `${tool.name} ${tool.description} ${JSON.stringify(tool.parameters ?? {})}`,
          ),
        0,
      );

      const breakdown = buildBreakdown({
        contextWindow,
        reportedTokens: usage?.tokens ?? null,
        systemPromptTokens: estimateTokens(ctx.getSystemPrompt()),
        contextFileTokens,
        skillTokens,
        toolTokens,
        estimatedMessageTokens: estimateTokens(
          JSON.stringify(ctx.sessionManager.getBranch()),
        ),
      });

      const model = ctx.model;
      const details: ContextVizDetails = {
        breakdown,
        modelLine: model
          ? `${model.name ?? model.id} (${formatTokens(contextWindow)} context)`
          : "no model selected",
        providerLine: model ? `${model.provider}/${model.id}` : "",
        skillCount: skills.length,
        contextFileCount: contextFiles.length,
        activeToolCount: activeTools.length,
      };

      pi.sendMessage({
        customType: VIZ_MESSAGE_TYPE,
        content: buildSummaryText(breakdown),
        display: true,
        details,
      });
    },
  });

  // --- Interrupt-and-submit: ctrl+enter ---
  const handleInterruptSubmit = createInterruptSubmitHandler(pi);

  pi.registerShortcut("ctrl+enter", {
    description: "Stop the active agent and send the current prompt immediately",
    handler: handleInterruptSubmit as unknown as (ctx: ExtensionContext) => Promise<void>,
  });
}
