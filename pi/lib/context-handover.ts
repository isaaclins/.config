export const NUDGE_THRESHOLD_PERCENT = 45;
export const NUDGE_REPEAT_STEP_PERCENT = 10;

/**
 * Nudge once when usage crosses the threshold, then again only after every
 * additional step, so a long session is reminded without being spammed.
 */
export function shouldNudge(
  percent: number,
  lastNudgedPercent: number | null,
  threshold = NUDGE_THRESHOLD_PERCENT,
  step = NUDGE_REPEAT_STEP_PERCENT,
): boolean {
  if (percent < threshold) return false;
  if (lastNudgedPercent === null) return true;
  return percent >= lastNudgedPercent + step;
}

export function buildNudgeContent(percent: number): string {
  return (
    `want a fresh memory? use /compact\n\n` +
    `Context is at ${percent.toFixed(1)}%. Agent: you decide when the moment is right. ` +
    `At the next good stopping point (not mid-edit, not mid-verification), call the ` +
    `compact_context tool with a complete inline handover document covering: the goal, ` +
    `current state, decisions made, next steps, and gotchas. The handover becomes the ` +
    `compaction summary and recent messages are kept automatically, so you continue ` +
    `working with a fresh context instead of a bloated one.`
  );
}

export function buildHandoverSummary(handover: string): string {
  return `## Handover document (written by the agent before compaction)\n\n${handover.trim()}`;
}

interface FileOperationSets {
  read?: Iterable<string>;
  written?: Iterable<string>;
  edited?: Iterable<string>;
}

/**
 * Mirror Pi's computeFileLists: modified = written + edited, and readFiles
 * only lists files that were read but never modified.
 */
export function computeFileLists(fileOps: FileOperationSets | undefined): {
  readFiles: string[];
  modifiedFiles: string[];
} {
  const modified = new Set<string>([
    ...(fileOps?.written ?? []),
    ...(fileOps?.edited ?? []),
  ]);
  const readOnly = [...(fileOps?.read ?? [])].filter((path) => !modified.has(path));
  return { readFiles: readOnly.sort(), modifiedFiles: [...modified].sort() };
}
