import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CompactionTracker, PendingReload } from "../lib/reload-when-idle.ts";

/**
 * /reload-when-idle: reload now if the session is settled, otherwise reload as
 * soon as it is.
 *
 * The builtin /reload refuses while the agent is streaming or compacting, and
 * the user is left with a warning and no reload. This cannot be fixed by
 * overriding /reload: interactive-mode matches that literal string on the
 * editor submit path before extension commands are dispatched, so the builtin
 * always wins. Hence a second name.
 *
 * Extension commands are dispatched with streaming behavior "steer" and run on
 * the TUI input path rather than inside the agent run loop, so awaiting here
 * does not stall the turn we are waiting for.
 *
 * The reload itself goes through the ordinary `ctx.reload()`, i.e. the same
 * guarded builtin path, so everything that depends on a normal reload keeps
 * working: session_start still reports reason "reload" (prompt-stash), and
 * pi-codrive still restores its persisted deferred triggers.
 */

export default function (pi: ExtensionAPI) {
  const compaction = new CompactionTracker();
  const reload = new PendingReload();

  // Extensions see a compaction start and a compaction success. The signal on
  // the start event covers cancellation; a compaction that fails some other way
  // reports nothing, which the tracker's staleness expiry absorbs.
  pi.on("session_before_compact", async (event) => {
    compaction.begin(event.signal);
  });
  pi.on("session_compact", async () => {
    compaction.end();
  });

  // Quit, reload, or session replacement: the session a pending reload is
  // waiting for is gone, so drop it instead of firing against a dead one.
  pi.on("session_shutdown", async () => {
    reload.cancel();
  });

  pi.registerCommand("reload-when-idle", {
    description: "Reload extensions and config now, or as soon as the agent finishes",
    handler: async (_args, ctx) => {
      await reload.request({
        isIdle: () => ctx.isIdle(),
        isCompacting: () => compaction.isCompacting(),
        waitForIdle: () => ctx.waitForIdle(),
        notify: (message, level) => {
          if (ctx.hasUI) ctx.ui.notify(message, level);
        },
        // Last call in the handler: ctx is stale once the runtime is rebound.
        reload: () => ctx.reload(),
      });
    },
  });
}
