import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

export const READ_ONLY_TOOL_NAMES = ["read", "grep", "find", "ls"] as const;
const READ_ONLY_TOOL_SET = new Set<string>(READ_ONLY_TOOL_NAMES);
const STATE_ENTRY = "readonly-state";

export interface ReadonlyState {
  enabled: boolean;
  toolsBeforeReadonly?: string[];
}

function lastBranchState(ctx: ExtensionContext): ReadonlyState | undefined {
  let current: ReadonlyState | undefined;
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "custom" || entry.customType !== STATE_ENTRY) continue;
    const state = entry.data as ReadonlyState | undefined;
    if (typeof state?.enabled === "boolean") current = state;
  }
  return current;
}

export function registerReadonlyMode(pi: ExtensionAPI): void {
  let enabled = false;
  let toolsBeforeReadonly: string[] | undefined;

  function applyRestriction(): void {
    pi.setActiveTools(
      pi.getActiveTools().filter((name) => READ_ONLY_TOOL_SET.has(name)),
    );
  }

  function updateStatus(ctx: ExtensionContext): void {
    ctx.ui.setStatus(
      "readonly",
      enabled ? ctx.ui.theme.fg("warning", "readonly") : undefined,
    );
  }

  function persist(): void {
    pi.appendEntry<ReadonlyState>(
      STATE_ENTRY,
      enabled
        ? { enabled: true, toolsBeforeReadonly }
        : { enabled: false },
    );
  }

  async function enable(ctx: ExtensionCommandContext): Promise<void> {
    if (!ctx.isIdle()) {
      ctx.abort();
      await ctx.waitForIdle();
    }
    if (!enabled) toolsBeforeReadonly = pi.getActiveTools();
    enabled = true;
    applyRestriction();
    persist();
    updateStatus(ctx);
    ctx.ui.notify(
      "Read-only mode enabled. Mutation-capable agent tools are disabled.",
      "info",
    );
  }

  function disable(ctx: ExtensionContext): void {
    enabled = false;
    if (toolsBeforeReadonly) pi.setActiveTools(toolsBeforeReadonly);
    toolsBeforeReadonly = undefined;
    persist();
    updateStatus(ctx);
    ctx.ui.notify(
      "Read-only mode disabled. Previous tool access restored.",
      "info",
    );
  }

  function restoreFromBranch(ctx: ExtensionContext): void {
    const state = lastBranchState(ctx);
    const shouldEnable = pi.getFlag("readonly") === true || state?.enabled === true;

    if (shouldEnable) {
      enabled = true;
      toolsBeforeReadonly =
        state?.toolsBeforeReadonly ?? toolsBeforeReadonly ?? pi.getActiveTools();
      applyRestriction();
    } else {
      if (enabled && toolsBeforeReadonly) pi.setActiveTools(toolsBeforeReadonly);
      enabled = false;
      toolsBeforeReadonly = undefined;
    }
    updateStatus(ctx);
  }

  pi.registerFlag("readonly", {
    description: "Start with mutation-capable agent tools disabled",
    type: "boolean",
    default: false,
  });

  pi.registerCommand("readonly", {
    description: "Toggle strict read-only mode for the current agent session",
    getArgumentCompletions(prefix) {
      const options = ["on", "off", "toggle", "status"];
      const matches = options
        .filter((option) => option.startsWith(prefix.toLowerCase()))
        .map((option) => ({ value: option, label: option }));
      return matches.length > 0 ? matches : null;
    },
    handler: async (args, ctx) => {
      const action = (args ?? "").trim().toLowerCase() || "toggle";
      if (["on", "enable", "enabled"].includes(action)) {
        await enable(ctx);
        return;
      }
      if (["off", "disable", "disabled"].includes(action)) {
        disable(ctx);
        return;
      }
      if (action === "toggle") {
        if (enabled) disable(ctx);
        else await enable(ctx);
        return;
      }
      if (action === "status") {
        ctx.ui.notify(
          `Read-only mode is ${enabled ? "enabled" : "disabled"}.`,
          "info",
        );
        return;
      }
      ctx.ui.notify("Usage: /readonly [on | off | toggle | status]", "warning");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    enabled = false;
    toolsBeforeReadonly = undefined;
    restoreFromBranch(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    restoreFromBranch(ctx);
  });

  pi.on("before_agent_start", async (event) => {
    if (!enabled) return;
    applyRestriction();
    return {
      systemPrompt: `${event.systemPrompt}\n\n[READ-ONLY MODE ACTIVE]\nThe user has disabled every mutation-capable agent tool. You can inspect and explain, but you cannot modify files, execute shell commands, change external state, or delegate work. Do not claim to have made changes. Only the user can restore those capabilities with /readonly off.`,
    };
  });

  pi.on("tool_call", async (event) => {
    if (!enabled || READ_ONLY_TOOL_SET.has(event.toolName)) return;
    return {
      block: true,
      reason: `Read-only mode blocked ${event.toolName}. Run /readonly off to restore mutation tools.`,
    };
  });
}
