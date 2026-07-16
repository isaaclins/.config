import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    const theme = ctx.ui.theme;
    ctx.ui.setWorkingIndicator({
      frames: ["·", theme.fg("muted", "•"), theme.fg("accent", "●"), theme.fg("muted", "•")],
      intervalMs: 160,
    });
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    ctx.ui.setWorkingIndicator();
  });

  pi.registerMessageRenderer("spawn-agent-done", (message, _options, theme) => {
    const pane = typeof message.details?.pane === "string" ? message.details.pane : "child";
    return new Text(
      theme.fg("success", "●") + " " + theme.fg("muted", `spawn ${pane} idle`),
      0,
      0,
    );
  });
}

export function promptStashWidget(text: string) {
  return (_tui: unknown, theme: { fg: (color: string, value: string) => string }) => ({
    render(width: number): string[] {
      const label = theme.fg("accent", "stash ");
      const preview = text.replace(/\s+/g, " ").trim();
      return [truncateToWidth(`${label}${theme.fg("muted", preview)}`, Math.max(0, width), "…")];
    },
    invalidate() {},
  });
}
