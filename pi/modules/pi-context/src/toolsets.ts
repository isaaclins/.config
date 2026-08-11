/**
 * Lazy tool families.
 *
 * Heavy tool families (desktop/browser control, diagramming) cost thousands of
 * tokens of JSON schema in every request, even in sessions that never touch a
 * GUI. Deleting them would cost autonomy: the agent must still be able to reach
 * for computer use on its own when a task needs it.
 *
 * Instead the families stay registered but inactive, and a single small gateway
 * tool advertises them in one line each. The agent activates a family itself;
 * schemas arrive on the next provider request. Families that go unused for a
 * while are released again so long autonomous sessions stay lean.
 */

export interface ToolFamily {
  /** Family id used by the gateway tool. */
  id: string;
  /** One-line capability pitch shown in the gateway description. */
  summary: string;
  /** Tool names belonging to this family. */
  tools: string[];
}

export const DEFAULT_FAMILIES: ToolFamily[] = [
  {
    id: "desktop_ui",
    summary:
      "Control this Mac and CDP browsers: find windows, observe UI trees, click/type, read on-screen text, navigate and evaluate JS in pages. Activate whenever a task needs to see or drive a GUI, verify an app visually, or automate a browser.",
    tools: [
      "find_roots",
      "list_contexts",
      "observe_ui",
      "search_ui",
      "expand_ui",
      "inspect_ui",
      "act_ui",
      "read_text",
      "wait_for",
      "launch_browser_context",
      "navigate_browser",
      "evaluate_browser",
    ],
  },
  {
    id: "diagram",
    summary:
      "Draw on the home Excalidraw boards: create/attach a board, add shapes and bound arrows, read a board back, share preview links. Activate when a diagram beats prose or the user sends a home Excalidraw link.",
    tools: [
      "excalidraw_create_board",
      "excalidraw_attach_board",
      "excalidraw_add_elements",
      "excalidraw_describe_board",
      "excalidraw_clear_board",
      "excalidraw_board_url",
      "excalidraw_list_boards",
    ],
  },
];

/** Turns a family may sit unused before it is released again. */
export const DEFAULT_IDLE_RELEASE_TURNS = 12;

export function buildGatewayDescription(families: ToolFamily[]): string {
  const lines = families.map((family) => `- ${family.id}: ${family.summary}`);
  return [
    "Activate an inactive tool family for this session. These tools exist and work; their schemas are simply not loaded yet to keep the context small.",
    "Do this yourself, without asking the user, as soon as a task would benefit. Never conclude a task is impossible because a tool is missing until you have checked this list.",
    "",
    "Families:",
    ...lines,
    "",
    'Call with action "release" to unload a family you are done with.',
  ].join("\n");
}

export function resolveFamily(
  families: ToolFamily[],
  id: string,
): ToolFamily | undefined {
  return families.find((family) => family.id === id);
}

/** All tool names owned by any family. */
export function familyToolNames(families: ToolFamily[]): Set<string> {
  return new Set(families.flatMap((family) => family.tools));
}

/**
 * Names that stay active at session start: everything currently active that is
 * not owned by a lazy family, plus the gateway itself.
 */
export function baseToolNames(
  activeNames: string[],
  families: ToolFamily[],
  gatewayName: string,
): string[] {
  const owned = familyToolNames(families);
  const base = activeNames.filter((name) => !owned.has(name));
  if (!base.includes(gatewayName)) base.push(gatewayName);
  return base;
}

/** Active set after activating a family (order preserved, no duplicates). */
export function withFamily(
  activeNames: string[],
  family: ToolFamily,
  registeredNames: Set<string>,
): string[] {
  const next = [...activeNames];
  for (const name of family.tools) {
    if (registeredNames.has(name) && !next.includes(name)) next.push(name);
  }
  return next;
}

/** Active set after releasing a family. */
export function withoutFamily(
  activeNames: string[],
  family: ToolFamily,
): string[] {
  const drop = new Set(family.tools);
  return activeNames.filter((name) => !drop.has(name));
}

/** Families whose tools have not been called for at least idleTurns. */
export function staleFamilies(
  activeFamilies: Map<string, number>,
  currentTurn: number,
  idleTurns: number,
): string[] {
  const stale: string[] = [];
  for (const [id, lastUsedTurn] of activeFamilies) {
    if (currentTurn - lastUsedTurn >= idleTurns) stale.push(id);
  }
  return stale;
}
