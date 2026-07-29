export const PI_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type PiThinkingLevel = (typeof PI_THINKING_LEVELS)[number];

export interface EffortModel {
  id: string;
  provider?: string;
  reasoning?: boolean;
  thinkingLevelMap?: Partial<Record<PiThinkingLevel, string | null>>;
}

const EFFORT_ORDER = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;

export function modelKey(model: EffortModel): string {
  return `${model.provider ?? "unknown"}/${model.id}`;
}

/** Mirrors Pi's documented thinkingLevelMap availability rules. */
export function availableThinkingLevels(model: EffortModel): PiThinkingLevel[] {
  if (!model.reasoning) return ["off"];

  return PI_THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
}

export function effortForLevel(
  model: EffortModel,
  level: PiThinkingLevel,
): string | undefined {
  if (!availableThinkingLevels(model).includes(level)) return undefined;
  return model.thinkingLevelMap?.[level] ?? level;
}

export function levelForEffort(
  model: EffortModel,
  effort: string,
): PiThinkingLevel | undefined {
  return availableThinkingLevels(model).find(
    (level) => effortForLevel(model, level) === effort,
  );
}

export function supportedEfforts(model: EffortModel): string[] {
  return availableThinkingLevels(model)
    .map((level) => effortForLevel(model, level))
    .filter((effort): effort is string => effort !== undefined)
    .filter((effort, index, all) => all.indexOf(effort) === index);
}

/** Uses Pi's upward-first, then downward clamping rule on semantic effort names. */
export function clampEffort(model: EffortModel, requested: string): string {
  const available = supportedEfforts(model);
  if (available.includes(requested)) return requested;

  const requestedIndex = EFFORT_ORDER.indexOf(
    requested as (typeof EFFORT_ORDER)[number],
  );
  if (requestedIndex === -1) return available[0] ?? "off";

  for (let index = requestedIndex; index < EFFORT_ORDER.length; index++) {
    const candidate = EFFORT_ORDER[index];
    if (available.includes(candidate)) return candidate;
  }
  for (let index = requestedIndex - 1; index >= 0; index--) {
    const candidate = EFFORT_ORDER[index];
    if (available.includes(candidate)) return candidate;
  }
  return available[0] ?? "off";
}

export function levelForModelSwitch(
  previousModel: EffortModel,
  previousLevel: PiThinkingLevel,
  nextModel: EffortModel,
): { effort: string; level: PiThinkingLevel } {
  const previousEffort = effortForLevel(previousModel, previousLevel) ?? previousLevel;
  const effort = clampEffort(nextModel, previousEffort);
  return {
    effort,
    level: levelForEffort(nextModel, effort) ?? availableThinkingLevels(nextModel)[0] ?? "off",
  };
}

/** Represents the order used by Pi's built-in Shift+Tab cycle. */
export function cycleEffort(
  model: EffortModel,
  currentLevel: PiThinkingLevel,
): { effort: string; level: PiThinkingLevel } {
  const levels = availableThinkingLevels(model);
  const currentIndex = levels.indexOf(currentLevel);
  const level = levels[(currentIndex + 1) % levels.length] ?? "off";
  return { level, effort: effortForLevel(model, level) ?? level };
}
