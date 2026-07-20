/**
 * Token estimation, formatting, grid rendering, and breakdown logic
 * for context usage visualization.
 */

export const GRID_COLUMNS = 20;
export const GRID_ROWS = 10;
export const CELL_FULL = "\u26C1";
export const CELL_PARTIAL = "\u26C0";
export const CELL_FREE = "\u26F6";

export interface ContextCategory {
  label: string;
  tokens: number;
}

export interface ContextBreakdown {
  usedTokens: number;
  contextWindow: number;
  categories: ContextCategory[];
  freeTokens: number;
}

/** Rough token estimate matching Pi's own chars/4 heuristic. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.round(text.length / 4);
}

export function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  if (tokens < 1_000_000) {
    const thousands = (tokens / 1000).toFixed(1).replace(/\.0$/, "");
    return `${thousands}k`;
  }
  const millions = (tokens / 1_000_000).toFixed(1).replace(/\.0$/, "");
  return `${millions}m`;
}

export function formatPercent(tokens: number, contextWindow: number): string {
  if (contextWindow <= 0) return "0.0%";
  return `${((tokens / contextWindow) * 100).toFixed(1)}%`;
}

/**
 * Grid cells for the usage chart: filled, then an optional partial cell,
 * then free cells. Any nonzero usage renders at least one partial cell.
 */
export function buildGridCells(
  usedTokens: number,
  contextWindow: number,
  totalCells = GRID_COLUMNS * GRID_ROWS,
): string[] {
  const fraction =
    contextWindow > 0 ? Math.min(1, Math.max(0, usedTokens / contextWindow)) : 0;
  const exactCells = fraction * totalCells;
  let full = Math.floor(exactCells);
  let partial = exactCells - full >= 0.25 ? 1 : 0;
  if (usedTokens > 0 && full === 0 && partial === 0) partial = 1;
  if (full + partial > totalCells) {
    full = totalCells;
    partial = 0;
  }
  const cells: string[] = [];
  for (let index = 0; index < totalCells; index++) {
    if (index < full) cells.push(CELL_FULL);
    else if (index < full + partial) cells.push(CELL_PARTIAL);
    else cells.push(CELL_FREE);
  }
  return cells;
}

export interface BreakdownInput {
  contextWindow: number;
  reportedTokens: number | null;
  systemPromptTokens: number;
  contextFileTokens: number;
  skillTokens: number;
  toolTokens: number;
  estimatedMessageTokens: number;
}

/**
 * Category math with no double counting: context files and skills are carved
 * out of the system prompt they are embedded in, and messages absorb the
 * remainder of the reported total when Pi knows real usage.
 */
export function buildBreakdown(input: BreakdownInput): ContextBreakdown {
  const carvedOut = input.contextFileTokens + input.skillTokens;
  const basePrompt = Math.max(0, input.systemPromptTokens - carvedOut);
  const fixedTokens =
    basePrompt + input.contextFileTokens + input.skillTokens + input.toolTokens;
  const messages =
    input.reportedTokens !== null
      ? Math.max(0, input.reportedTokens - fixedTokens)
      : Math.max(0, input.estimatedMessageTokens);
  const usedTokens =
    input.reportedTokens !== null ? input.reportedTokens : fixedTokens + messages;
  const categories: ContextCategory[] = [
    { label: "System prompt", tokens: basePrompt },
    { label: "System tools", tokens: input.toolTokens },
    { label: "Context files", tokens: input.contextFileTokens },
    { label: "Skills", tokens: input.skillTokens },
    { label: "Messages", tokens: messages },
  ];
  return {
    usedTokens,
    contextWindow: input.contextWindow,
    categories,
    freeTokens: Math.max(0, input.contextWindow - usedTokens),
  };
}

/** Compact LLM-visible summary so printing usage stays cheap in context. */
export function buildSummaryText(breakdown: ContextBreakdown): string {
  const parts = breakdown.categories
    .map(
      (category) =>
        `${category.label} ${formatTokens(category.tokens)} (${formatPercent(category.tokens, breakdown.contextWindow)})`,
    )
    .join(", ");
  return (
    `Context usage: ${formatTokens(breakdown.usedTokens)}/${formatTokens(breakdown.contextWindow)} tokens ` +
    `(${formatPercent(breakdown.usedTokens, breakdown.contextWindow)}). ${parts}. ` +
    `Free ${formatTokens(breakdown.freeTokens)} (${formatPercent(breakdown.freeTokens, breakdown.contextWindow)}).`
  );
}
