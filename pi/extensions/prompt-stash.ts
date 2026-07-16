import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { promptStashWidget } from "./ui-polish.ts";

/**
 * Prompt stash (Claude-Code-style ctrl+s).
 *
 * Single slot, module-level state:
 * - ctrl+s with text in the editor: stash it, clear the editor, show a
 *   persistent widget so the stash is visible while held.
 * - ctrl+s with an empty editor and a stash present: pop the stash back
 *   into the editor (manual restore), clearing the stash and the widget.
 * - ctrl+s with text in the editor while a stash already exists: swap
 *   (current text becomes the new stash, old stash goes into the editor)
 *   and notify, since neither slot nor editor should be silently dropped.
 * - On agent_start (prompt just submitted, editor already cleared): if a
 *   stash exists, put it back into the editor and clear the stash and
 *   widget. This reproduces "stashed prompt reappears after submit".
 *
 * Caveat: ctrl+s is pi's default keybinding for
 * app.session.toggleSort inside the session picker context, not the main
 * editor. This extension's shortcut only fires while the main editor has
 * focus, so it does not fight the picker's own ctrl+s.
 */

export default function (pi: ExtensionAPI) {
  let stash: string | undefined;

  pi.on("session_start", async () => {
    stash = undefined;
  });

  pi.on("agent_start", async (_event, ctx) => {
    if (stash === undefined) return;
    const restored = stash;
    stash = undefined;
    if (!ctx.hasUI) return;
    ctx.ui.setEditorText(restored);
    ctx.ui.setWidget("prompt-stash", undefined);
  });

  pi.registerShortcut("ctrl+s", {
    description: "Stash the current prompt, or restore/swap the stashed one",
    handler: async (ctx) => {
      if (!ctx.hasUI) return;
      const current = ctx.ui.getEditorText();

      if (!current.trim()) {
        if (stash === undefined) {
          ctx.ui.notify("Nothing to stash", "info");
          return;
        }
        const restored = stash;
        stash = undefined;
        ctx.ui.setEditorText(restored);
        ctx.ui.setWidget("prompt-stash", undefined);
        return;
      }

      const previousStash = stash;
      stash = current;

      if (previousStash === undefined) {
        ctx.ui.setEditorText("");
        ctx.ui.setWidget("prompt-stash", promptStashWidget(current));
        return;
      }

      ctx.ui.setEditorText(previousStash);
      ctx.ui.setWidget("prompt-stash", promptStashWidget(current));
      ctx.ui.notify("Stash swapped", "info");
    },
  });
}
