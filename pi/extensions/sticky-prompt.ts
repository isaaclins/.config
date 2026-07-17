/**
 * sticky-prompt: keep the last user prompt visible while output scrolls.
 *
 * - Inside tmux: writes a one-line summary of the last prompt into the tmux
 *   pane title and enables `pane-border-status top`, so the prompt stays
 *   pinned at the top of the pane even in copy-mode scrollback.
 * - Outside tmux: falls back to a one-line widget above the editor.
 * - ctrl+shift+l opens a scrollable overlay with the full prompt.
 *
 * Summarization strategy for massive prompts lives in ../lib/sticky-prompt.ts
 * (first line / first sentence, paste markers stripped, honesty badge).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import {
  buildStickyLine,
  clampOffset,
  formatCharCount,
  wrapPlainText,
} from "../lib/sticky-prompt.ts";

const WIDGET_KEY = "sticky-prompt";
const TITLE_MAX_CHARS = 120;
const VIEWER_ROWS = 20;

export default function (pi: ExtensionAPI) {
  const inTmux = Boolean(process.env.TMUX);
  let lastPrompt: string | undefined;
  let borderEnabled = false;
  let previousBorderStatus: string | undefined;

  async function tmux(args: string[]): Promise<string> {
    const result = await pi.exec("tmux", args, { timeout: 3000 });
    return result.stdout.trim();
  }

  async function enableBorderOnce(): Promise<void> {
    if (borderEnabled) return;
    borderEnabled = true;
    try {
      previousBorderStatus = await tmux(["show-options", "-wv", "pane-border-status"]);
      await tmux(["set-option", "-w", "pane-border-status", "top"]);
    } catch {
      // tmux too old or not reachable; the title alone is harmless.
    }
  }

  async function restoreBorder(): Promise<void> {
    if (!borderEnabled) return;
    borderEnabled = false;
    try {
      await tmux(["select-pane", "-T", ""]);
      if (previousBorderStatus) {
        await tmux(["set-option", "-w", "pane-border-status", previousBorderStatus]);
      } else {
        await tmux(["set-option", "-wu", "pane-border-status"]);
      }
    } catch {
      // Best effort cleanup.
    }
  }

  async function paneWidth(): Promise<number> {
    try {
      const width = Number.parseInt(await tmux(["display-message", "-p", "#{pane_width}"]), 10);
      return Number.isFinite(width) && width > 20 ? width : TITLE_MAX_CHARS;
    } catch {
      return TITLE_MAX_CHARS;
    }
  }

  async function apply(ctx: ExtensionContext): Promise<void> {
    if (ctx.mode !== "tui") return;
    if (!lastPrompt) return;

    if (inTmux) {
      const width = await paneWidth();
      const maxChars = Math.min(TITLE_MAX_CHARS, Math.max(30, width - 12));
      const line = buildStickyLine(lastPrompt, maxChars);
      await enableBorderOnce();
      try {
        await tmux(["select-pane", "-T", line]);
      } catch {
        // Pane may have closed mid-command; nothing to do.
      }
      return;
    }

    const prompt = lastPrompt;
    ctx.ui.setWidget(WIDGET_KEY, (_tui, theme) => ({
      render(width: number): string[] {
        const line = buildStickyLine(prompt, Math.max(30, width - 4));
        return [truncateToWidth(theme.fg("dim", line), Math.max(0, width), "\u2026")];
      },
      invalidate() {},
    }));
  }

  function restoreLastPromptFromSession(ctx: ExtensionContext): void {
    for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
      if (entry.type !== "message" || entry.message.role !== "user") continue;
      const content = entry.message.content;
      const text = Array.isArray(content)
        ? content
            .filter((item): item is { type: "text"; text: string } => item.type === "text")
            .map((item) => item.text)
            .join("\n")
        : typeof content === "string"
          ? content
          : "";
      if (text.trim()) {
        lastPrompt = text;
        return;
      }
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    restoreLastPromptFromSession(ctx);
    await apply(ctx);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (event.prompt?.trim()) {
      lastPrompt = event.prompt;
      await apply(ctx);
    }
  });

  // Pi or other tools may rewrite the terminal title during a turn, which tmux
  // mirrors into the pane title. Re-assert ours when the agent finishes.
  pi.on("agent_end", async (_event, ctx) => {
    await apply(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (inTmux) await restoreBorder();
    if (ctx.mode === "tui") ctx.ui.setWidget(WIDGET_KEY, undefined);
  });

  pi.registerShortcut("ctrl+shift+l", {
    description: "Show the full last prompt in a scrollable overlay",
    handler: async (ctx) => {
      if (ctx.mode !== "tui") return;
      if (!lastPrompt) {
        ctx.ui.notify("No prompt sent yet in this session", "info");
        return;
      }
      const prompt = lastPrompt;

      await ctx.ui.custom<void>(
        (tui, theme, _keybindings, done) => {
          let offset = 0;
          let cachedWidth: number | undefined;
          let cachedLines: string[] | undefined;

          const contentLines = (width: number): string[] => {
            if (cachedLines && cachedWidth === width) return cachedLines;
            cachedWidth = width;
            cachedLines = wrapPlainText(prompt, width - 4);
            return cachedLines;
          };

          return {
            render(width: number): string[] {
              const lines = contentLines(width);
              offset = clampOffset(offset, lines.length, VIEWER_ROWS);
              const visible = lines.slice(offset, offset + VIEWER_ROWS);
              const header = theme.fg(
                "accent",
                ` Last prompt (${formatCharCount(prompt.length)} chars) `,
              );
              const position =
                lines.length > VIEWER_ROWS
                  ? theme.fg("dim", ` ${offset + 1}-${offset + visible.length}/${lines.length}`)
                  : "";
              const footer = theme.fg(
                "dim",
                " \u2191\u2193 scroll \u00b7 pgup/pgdn \u00b7 esc close",
              );
              return [
                truncateToWidth(header + position, width, "\u2026"),
                "",
                ...visible.map((line) => truncateToWidth(`  ${line}`, width, "\u2026")),
                "",
                truncateToWidth(footer, width, "\u2026"),
              ];
            },
            invalidate() {
              cachedWidth = undefined;
              cachedLines = undefined;
            },
            handleInput(data: string): void {
              const total = cachedLines?.length ?? 0;
              if (matchesKey(data, "up")) offset = clampOffset(offset - 1, total, VIEWER_ROWS);
              else if (matchesKey(data, "down")) offset = clampOffset(offset + 1, total, VIEWER_ROWS);
              else if (matchesKey(data, "pageup"))
                offset = clampOffset(offset - VIEWER_ROWS, total, VIEWER_ROWS);
              else if (matchesKey(data, "pagedown"))
                offset = clampOffset(offset + VIEWER_ROWS, total, VIEWER_ROWS);
              else if (matchesKey(data, "home")) offset = 0;
              else if (matchesKey(data, "end")) offset = clampOffset(total, total, VIEWER_ROWS);
              else if (matchesKey(data, "escape") || matchesKey(data, "enter") || data === "q") {
                done(undefined);
                return;
              }
              tui.requestRender();
            },
          };
        },
        { overlay: true, overlayOptions: { anchor: "top-center", width: "80%", margin: 1 } },
      );
    },
  });
}
