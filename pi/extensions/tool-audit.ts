import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  aggregate,
  auditDir,
  buildRecord,
  formatAgent,
  formatCall,
  formatCalls,
  formatErrors,
  formatSummary,
  readAllRecords,
  writeRecord,
} from "../lib/tool-audit.ts";

/**
 * Tool-call audit tracker.
 *
 * Every tool call is logged as one JSONL line under
 * ~/.local/share/pi/tool-audit/YYYY-MM-DD.jsonl (outside the git repo, so
 * logs are never committed). Each record carries the session id, a short
 * agent id, the cwd, the tool name, redacted+truncated args, the outcome,
 * a truncated result/error preview, and the duration.
 *
 * Correlation: tool_execution_end does not carry args, so args and the start
 * time are captured on tool_execution_start and matched back by toolCallId.
 *
 * Reporting: /toolaudit (summary), /toolaudit errors (recent failures),
 * /toolaudit calls (one line per call), /toolaudit last <n> (n most recent),
 * /toolaudit show <call-id> (full detail with complete args and result),
 * /toolaudit <agent-id> (that agent's calls). The same views are available
 * outside the TUI via lib/tool-audit-cli.ts.
 *
 * Writes must never break a session: a failed append warns at most once.
 */

interface PendingCall {
  startedAt: number;
  args: unknown;
}

export default function (pi: ExtensionAPI) {
  const pending = new Map<string, PendingCall>();
  const dir = auditDir();
  let warnedOnce = false;

  function resolveSessionId(ctx: ExtensionContext): string {
    try {
      return ctx.sessionManager.getSessionId() || ctx.sessionManager.getSessionFile() || "ephemeral";
    } catch {
      return "ephemeral";
    }
  }

  pi.on("session_start", async () => {
    pending.clear();
  });

  pi.on("tool_execution_start", async (event) => {
    pending.set(event.toolCallId, { startedAt: Date.now(), args: event.args });
  });

  pi.on("tool_execution_end", async (event, ctx) => {
    const started = pending.get(event.toolCallId);
    pending.delete(event.toolCallId);

    const record = buildRecord({
      sessionId: resolveSessionId(ctx),
      toolCallId: event.toolCallId,
      cwd: ctx.cwd,
      tool: event.toolName,
      args: started?.args,
      result: event.result,
      isError: event.isError,
      startedAt: started?.startedAt,
      endedAt: Date.now(),
    });

    try {
      writeRecord(dir, record);
    } catch (error) {
      if (warnedOnce) return;
      warnedOnce = true;
      ctx.ui.notify(`tool-audit: could not write log (${(error as Error).message})`, "warning");
    }
  });

  pi.registerCommand("toolaudit", {
    description: "Tool-call audit: summary, `errors`, `calls`, `last <n>`, `show <call-id>`, or an <agent-id>",
    getArgumentCompletions(prefix) {
      const options = ["calls", "last", "show", "errors"];
      const matches = options
        .filter((option) => option.startsWith(prefix.toLowerCase()))
        .map((option) => ({ value: option, label: option }));
      return matches.length > 0 ? matches : null;
    },
    handler: async (args, ctx) => {
      const records = readAllRecords(dir);
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const first = parts[0] ?? "";
      const cmd = first.toLowerCase();

      if (!first) {
        ctx.ui.notify(formatSummary(aggregate(records)), "info");
        return;
      }
      if (cmd === "errors") {
        ctx.ui.notify(formatErrors(records), "info");
        return;
      }
      if (cmd === "calls") {
        ctx.ui.notify(formatCalls(records), "info");
        return;
      }
      if (cmd === "last") {
        const n = Number.parseInt(parts[1] ?? "", 10);
        ctx.ui.notify(formatCalls(records, Number.isFinite(n) && n > 0 ? n : 30), "info");
        return;
      }
      if (cmd === "show") {
        const id = parts[1] ?? "";
        if (!id) {
          ctx.ui.notify("tool-audit: usage: /toolaudit show <call-id>", "warning");
          return;
        }
        ctx.ui.notify(formatCall(records, id), "info");
        return;
      }
      ctx.ui.notify(formatAgent(records, first), "info");
    },
  });
}
