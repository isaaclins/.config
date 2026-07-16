import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
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
} from "../lib/context-viz.ts";

/**
 * /context: Claude-Code-style context usage printed into the pi output.
 *
 * The usage report is a session message, not an overlay, on purpose: the
 * model sees its own context stats, so an agent can notice bloat, write an
 * inline handover with the task state, and continue after clearing. The
 * LLM-visible content is a compact summary line; the rendered view shows the
 * full grid.
 */

const MESSAGE_TYPE = "context-viz";

interface ContextVizDetails {
  breakdown: ContextBreakdown;
  modelLine: string;
  providerLine: string;
  skillCount: number;
  contextFileCount: number;
  activeToolCount: number;
}

export default function contextViz(pi: ExtensionAPI) {
  pi.registerMessageRenderer(MESSAGE_TYPE, (message, _options, theme) => {
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
        `Skills: ${details.skillCount} loaded · Context files: ${details.contextFileCount} · Active tools: ${details.activeToolCount}`,
      ),
    );

    return {
      render: (width: number) =>
        lines.map((line) => truncateToWidth(line, width, "…")),
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
        customType: MESSAGE_TYPE,
        content: buildSummaryText(breakdown),
        display: true,
        details,
      });
    },
  });
}
