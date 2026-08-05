import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  aggregate,
  auditDir,
  buildNoteRecord,
  buildRecord,
  formatAgent,
  formatCall,
  formatCalls,
  formatErrors,
  formatNotes,
  formatSummary,
  isPapercutOwner,
  PAPERCUT_FILED_EVENT,
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
 * /toolaudit notes (filed papercuts), /toolaudit <agent-id> (that agent's
 * calls). The same views are available outside the TUI via lib/tool-audit-cli.ts.
 *
 * Papercuts: the `papercut` tool writes a repro-shaped note record (tool
 * "note") through the same redaction and truncation path, then announces it on
 * the shared event bus as PAPERCUT_FILED_EVENT. This extension owns filing and
 * viewing only. Whoever wants to act on a papercut subscribes to that event;
 * nothing here dispatches, spawns, or repairs anything.
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

  pi.registerTool({
    name: "papercut",
    label: "File Papercut",
    description:
      "File a papercut: a short, repro-shaped note about harness friction you personally just hit. " +
      "Describe only what you actually observed in this session, never a hypothetical. " +
      "The note is stored with the tool audit log and announced to whoever handles repairs; " +
      "filing one never interrupts the user and never changes anything by itself.",
    promptGuidelines: [
      "File a papercut when you retried a command after a shell-level miss (wrong flag name, missing binary, quoting that only works one way).",
      "File a papercut when a tool returned wrong or unusable results and you routed around it.",
      "File a papercut when you invented a workaround to keep going, for example converting a PNG to JPEG because reading the PNG failed.",
      "File a papercut when a capability that used to work stopped working.",
      "Set owner to 'config' only for problems in this dotfiles repository, 'pi' for the Pi harness itself, 'model' for your own behavior, 'env' for the machine or an external service.",
      "Keep tried/got concrete and verbatim, and give a repro command that starts from a clean shell whenever you can.",
      "Do not file duplicates of a papercut you already filed this session, and do not file one for a mistake you simply made and corrected.",
    ],
    parameters: Type.Object({
      tried: Type.String({ description: "What you were trying to do." }),
      got: Type.String({ description: "What actually happened, verbatim where possible." }),
      workaround: Type.Optional(Type.String({ description: "The workaround you used to keep going." })),
      expected: Type.Optional(Type.String({ description: "What should have happened instead." })),
      repro: Type.Optional(Type.String({ description: "A command that reproduces this from a clean shell." })),
      owner: Type.Optional(
        Type.Union([
          Type.Literal("config"),
          Type.Literal("pi"),
          Type.Literal("model"),
          Type.Literal("env"),
        ]),
      ),
      refCallId: Type.Optional(
        Type.String({ description: "The audit call id this is about, from /toolaudit calls." }),
      ),
      suspects: Type.Optional(
        Type.Array(Type.String(), { description: "Repo-relative paths you suspect." }),
      ),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const record = buildNoteRecord({
        sessionId: resolveSessionId(ctx),
        toolCallId,
        cwd: ctx.cwd,
        fields: {
          tried: params.tried,
          got: params.got,
          workaround: params.workaround,
          expected: params.expected,
          repro: params.repro,
        },
        owner: isPapercutOwner(params.owner) ? params.owner : undefined,
        refCallId: params.refCallId,
        suspects: params.suspects,
      });

      writeRecord(dir, record);
      pi.events.emit(PAPERCUT_FILED_EVENT, record);

      return {
        content: [
          {
            type: "text",
            text:
              `Filed papercut ${record.callId} (owner ${record.owner ?? "unassigned"}). ` +
              "Nothing was changed and nobody was interrupted. Continue with your task.",
          },
        ],
        details: { callId: record.callId, owner: record.owner },
      };
    },
  });

  pi.registerCommand("toolaudit", {
    description: "Tool-call audit: summary, `errors`, `calls`, `notes`, `last <n>`, `show <call-id>`, or an <agent-id>",
    getArgumentCompletions(prefix) {
      const options = ["calls", "last", "show", "errors", "notes"];
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
      if (cmd === "notes") {
        ctx.ui.notify(formatNotes(records), "info");
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
