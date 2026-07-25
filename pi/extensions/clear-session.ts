import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * /clear: start a brand-new session for this repo.
 *
 * Counterpart to the fish `pi` wrapper, which makes a bare `pi` always
 * continue the repo's last conversation (pi --continue). When the user
 * wants a clean slate instead, /clear creates a new session (equivalent
 * to the builtin /new, under the name the user reaches for).
 */

export default function (pi: ExtensionAPI) {
  pi.registerCommand("clear", {
    description: "Start a fresh session (clears the auto-continued conversation)",
    handler: async (_args, ctx) => {
      const result = await ctx.newSession({
        withSession: async (ctx) => {
          ctx.ui.notify("Fresh session started", "info");
        },
      });
      if (result.cancelled) {
        ctx.ui.notify("New session cancelled", "warning");
      }
    },
  });
}
