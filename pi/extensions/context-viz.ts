import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import {
  buildBreakdown,
  buildGridCells,
  CELL_FREE,
  CELL_FULL,
  CELL_PARTIAL,
  estimateTokens,
  formatPercent,
  formatTokens,
  GRID_COLUMNS,
  GRID_ROWS,
} from "../lib/context-viz.ts";

/**
 * /context: Claude-Code-style context usage visualization.
 *
 * Renders an overlay with a block grid of the context window plus an
 * estimated per-category breakdown. Overlay only: nothing is written to the
 * session, so inspecting context never costs context.
 */

export default function contextViz(pi: ExtensionAPI) {
  pi.registerCommand("context", {
    description: "Visualize context usage by category",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/context requires the interactive TUI", "warning");
        return;
      }

      const usage = ctx.getContextUsage();
      const contextWindow = usage?.contextWindow ?? 0;
      const options = ctx.getSystemPromptOptions();

      const contextFileTokens = (options.contextFiles ?? []).reduce(
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

      const estimatedMessageTokens = estimateTokens(
        JSON.stringify(ctx.sessionManager.getBranch()),
      );
      const breakdown = buildBreakdown({
        contextWindow,
        reportedTokens: usage?.tokens ?? null,
        systemPromptTokens: estimateTokens(ctx.getSystemPrompt()),
        contextFileTokens,
        skillTokens,
        toolTokens,
        estimatedMessageTokens,
      });

      const model = ctx.model;
      const modelLine = model
        ? `${model.name ?? model.id} (${formatTokens(contextWindow)} context)`
        : "no model selected";
      const headline = `${formatTokens(breakdown.usedTokens)}/${formatTokens(contextWindow)} tokens (${Math.round(
        contextWindow > 0 ? (breakdown.usedTokens / contextWindow) * 100 : 0,
      )}%)`;

      await ctx.ui.custom<void>(
        (tui, theme, _keybindings, done) => {
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

          const legend: string[] = [
            theme.fg("text", modelLine),
            theme.fg("muted", model ? `${model.provider}/${model.id}` : ""),
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
          const lines: string[] = [
            theme.fg("accent", theme.bold(" Context Usage")),
            "",
          ];
          const rowCount = Math.max(gridRows.length, legend.length);
          for (let index = 0; index < rowCount; index++) {
            const grid = gridRows[index] ?? " ".repeat(gridWidth);
            const info = legend[index] ?? "";
            lines.push(` ${grid}   ${info}`);
          }
          lines.push("");
          lines.push(
            theme.fg(
              "muted",
              ` Skills: ${skills.length} loaded · Context files: ${(options.contextFiles ?? []).length} · Active tools: ${activeTools.length}`,
            ),
          );
          lines.push(theme.fg("dim", " press any key to close"));

          return {
            render: (width: number) =>
              lines.map((line) => truncateToWidth(line, width, "…")),
            invalidate() {},
            handleInput() {
              done();
              tui.requestRender();
            },
          };
        },
        { overlay: true, overlayOptions: { anchor: "center", minWidth: 100 } },
      );
    },
  });
}
