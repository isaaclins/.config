import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  buildHandoverSummary,
  buildNudgeContent,
  computeFileLists,
  shouldNudge,
} from "../lib/context-handover.ts";

/**
 * Context-hygiene handover flow:
 *
 * 1. When context usage crosses 45% (and every further 10 points), an inline
 *    message is injected: "want a fresh memory? use /compact". The model sees
 *    it too, and decides when the moment is right.
 * 2. The agent calls the compact_context tool with an inline handover
 *    document (goal, state, decisions, next steps, gotchas). Nothing is
 *    written to disk.
 * 3. Compaction runs at the next turn boundary. The handover document itself
 *    becomes the compaction summary, replacing the generic LLM summary, and
 *    recent messages are kept as usual. The agent continues working fresh.
 *
 * A manual /compact without a pending handover keeps Pi's default behavior.
 */

const NUDGE_MESSAGE_TYPE = "context-handover-nudge";

export default function contextHandover(pi: ExtensionAPI) {
  let lastNudgedPercent: number | null = null;
  let pendingHandover: string | null = null;
  let compactRequested = false;

  const resetAfterCompaction = () => {
    lastNudgedPercent = null;
    pendingHandover = null;
    compactRequested = false;
  };

  const usagePercent = (ctx: ExtensionContext): number | null => {
    const usage = ctx.getContextUsage();
    if (!usage || usage.tokens === null || !usage.contextWindow) return null;
    return (usage.tokens / usage.contextWindow) * 100;
  };

  pi.registerTool({
    name: "compact_context",
    label: "Compact context",
    description:
      "Hand over and compact the conversation context. Call this at a good stopping point when context usage is high. Pass a complete inline handover document (goal, current state, decisions made, next steps, gotchas); it becomes the compaction summary, recent messages are kept automatically, and you continue working with a fresh context.",
    parameters: Type.Object({
      handover: Type.String({
        description:
          "Full handover document in markdown: goal, current state, decisions, next steps, gotchas. Written for your future self with no other memory of this session.",
      }),
    }),
    async execute(_id, params) {
      pendingHandover = params.handover;
      return {
        content: [
          {
            type: "text",
            text: "Handover recorded. Compaction will run at the next turn boundary; keep working normally.",
          },
        ],
      };
    },
  });

  pi.on("turn_end", async (_event, ctx) => {
    if (pendingHandover !== null) {
      if (compactRequested) return;
      compactRequested = true;
      ctx.compact({
        onError: (error) => {
          compactRequested = false;
          if (ctx.hasUI) {
            ctx.ui.notify(`Handover compaction failed: ${error.message}`, "error");
          }
        },
      });
      return;
    }

    const percent = usagePercent(ctx);
    if (percent === null) return;
    if (!shouldNudge(percent, lastNudgedPercent)) return;
    lastNudgedPercent = percent;
    pi.sendMessage({
      customType: NUDGE_MESSAGE_TYPE,
      content: buildNudgeContent(percent),
      display: true,
    });
  });

  pi.on("session_before_compact", async (event) => {
    if (pendingHandover === null) return undefined;
    const { preparation } = event;
    const fileLists = computeFileLists(
      preparation.fileOps as
        | { read?: Set<string>; written?: Set<string>; edited?: Set<string> }
        | undefined,
    );
    return {
      compaction: {
        summary: buildHandoverSummary(pendingHandover),
        firstKeptEntryId: preparation.firstKeptEntryId,
        tokensBefore: preparation.tokensBefore,
        details: { source: "handover", ...fileLists },
      },
    };
  });

  pi.on("session_compact", async (_event, ctx) => {
    const hadHandover = pendingHandover !== null;
    resetAfterCompaction();
    if (hadHandover && ctx.hasUI) {
      ctx.ui.notify("Compacted with agent handover document", "info");
    }
  });
}
