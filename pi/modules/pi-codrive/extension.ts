import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { platform } from "node:os";
import { randomUUID } from "node:crypto";
import { DEFAULT_MODEL, loadCodriveConfig } from "./src/config.ts";
import {
  captureChildIpcEnvironment,
  createHarnessSession,
  assertCanDelegate,
  buildChildReport,
  CHILD_ID_ENV,
  CodriveController,
  defaultRuntimeRoot,
  isCodriveChildEnvironment,
  NONCE_ENV,
  PaneHealthMonitor,
  RuntimeStore,
  ReportServer,
  sendReport,
  SESSION_ID_ENV,
  SOCKET_ENV,
  TmuxBackend,
  type CodriveReport,
  type HarnessSession,
  type ReportServerHandle,
  type SpawnedChild,
} from "./src/index.ts";

const HEALTH_INTERVAL_MS = 5000;

interface ExitRecord {
  status: "exited-without-report";
  assistantText: string;
}

type HistoryRecord = CodriveReport | ExitRecord;

const PANE = /^%\d+$/;
const REPORT_MESSAGE = "pi-codrive-report";
const MAX_REPORT_TEXT = 50 * 1024;
const MAX_REPORT_LINES = 2000;

function findPaneForChild(store: RuntimeStore, sessionId: string, childId: string): string | undefined {
  return store.load(sessionId).children.find((child) => child.childId === childId)?.paneId;
}

function truncateReport(text: string): { content: string; truncated: boolean } {
  const lines = text.split("\n");
  if (lines.length > MAX_REPORT_LINES) {
    return { content: lines.slice(0, MAX_REPORT_LINES).join("\n"), truncated: true };
  }
  if (Buffer.byteLength(text) > MAX_REPORT_TEXT) {
    let result = "";
    for (const line of lines) {
      const next = result ? result + "\n" + line : line;
      if (Buffer.byteLength(next) > MAX_REPORT_TEXT) break;
      result = next;
    }
    return { content: result, truncated: true };
  }
  return { content: text, truncated: false };
}

export default function piCodrive(pi: ExtensionAPI): void {
  // Computed synchronously, once, at extension load time (matching the
  // proven-working reference implementation). Registering pi.on("agent_end",
  // ...) from inside an async session_start callback is NOT equivalent to
  // registering it here: a child's own first turn can reach agent_end before
  // (or racing with) an async session_start body finishing, silently
  // dropping the report. Compute child-mode and scrub credentials up front,
  // then register every listener unconditionally at the top level.
  const isChild = isCodriveChildEnvironment();
  const childIpcEnv: NodeJS.ProcessEnv = isChild ? captureChildIpcEnvironment() : {};

  const histories = new Map<string, HistoryRecord[]>();
  const live = new Set<string>();
  const waiting = new Set<string>();
  let ipc: ReportServerHandle | undefined;
  let store: RuntimeStore | undefined;
  let session: HarnessSession | undefined;
  let controller: CodriveController | undefined;
  let monitor: PaneHealthMonitor | undefined;

  if (isChild) {
    const socketPath = childIpcEnv[SOCKET_ENV];
    const nonce = childIpcEnv[NONCE_ENV];
    const sessionId = childIpcEnv[SESSION_ID_ENV];
    const childId = childIpcEnv[CHILD_ID_ENV];
    if (socketPath && nonce && sessionId && childId) {
      pi.on("agent_end", async (event) => {
        try {
          const report = buildChildReport(event.messages, {
            sessionId,
            childId,
            paneId: process.env.TMUX_PANE,
            eventId: randomUUID(),
          });
          await sendReport(socketPath, nonce, report);
        } catch {
          // Reporting is best-effort and must never break the child session.
        }
      });
    }
  }

  const handleExitWithoutReport = (pane: string): void => {
    live.delete(pane);
    waiting.delete(pane);
    const history = histories.get(pane) ?? [];
    history.push({ status: "exited-without-report", assistantText: "" });
    histories.set(pane, history);
    pi.sendMessage(
      {
        customType: REPORT_MESSAGE,
        content: `SUBAGENT ${pane} exited before delivering a report. Report history remains available if a delayed authenticated report arrives.`,
        display: true,
        details: { pane, role: "subagent", status: "exited-without-report" },
      },
      { triggerTurn: true, deliverAs: "followUp" },
    );
  };

  pi.on("session_start", async (_event, ctx) => {
    if (isChild) return;

    if (platform() !== "darwin" && platform() !== "linux") return;

    const runtimeRoot = defaultRuntimeRoot();
    store = new RuntimeStore(runtimeRoot);

    session = createHarnessSession({
      projectRoot: ctx.cwd,
      role: "orchestrator",
      delegationDepth: 0,
      trust: "trusted",
    });
    store.saveSession(session);

    const backend = new TmuxBackend({ piCommand: "pi" });

    let defaultModel = DEFAULT_MODEL;
    try {
      defaultModel = loadCodriveConfig().model ?? DEFAULT_MODEL;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      ctx.ui?.notify(`pi-codrive: ${reason}. Falling back to ${DEFAULT_MODEL}.`, "warning");
    }

    // ReportServer must start before the controller exists: every spawned
    // child needs this exact server's socketPath/nonce to report home, and
    // the controller is what threads those credentials into each launch.
    ipc = await ReportServer.start({
      runtimeRoot,
      sessionId: session.sessionId,
      store,
      onReport: (report) => {
        const pane = report.paneId ?? findPaneForChild(store!, session!.sessionId, report.childId);
        if (!pane) return;
        monitor?.markReported(pane);
        waiting.delete(pane);
        const history = histories.get(pane) ?? [];
        history.push(report);
        histories.set(pane, history);
        const output = truncateReport(
          `SUBAGENT ${pane} completed with status ${report.status}.\n\n${report.assistantText}`,
        );
        pi.sendMessage(
          {
            customType: REPORT_MESSAGE,
            content: output.content,
            display: true,
            details: { pane, report, role: "subagent" },
          },
          { triggerTurn: true, deliverAs: "followUp" },
        );
      },
    });

    controller = new CodriveController({
      session,
      backend,
      policy: {
        defaultModel,
        account() {},
      },
      reportSocket: ipc.socketPath,
      reportNonce: ipc.nonce,
    });

    const healthBackend = new TmuxBackend();
    monitor = new PaneHealthMonitor({
      intervalMs: HEALTH_INTERVAL_MS,
      isAlive: (pane) => healthBackend.isAlive(pane),
      onExitedWithoutReport: handleExitWithoutReport,
    });
    monitor.start();
  });

  pi.on("session_shutdown", async () => {
    monitor?.stop();
    monitor = undefined;
    await ipc?.close();
    ipc = undefined;
    store = undefined;
    session = undefined;
    controller = undefined;
    live.clear();
    waiting.clear();
    histories.clear();
  });

  pi.registerTool({
    name: "spawn_agent",
    label: "Spawn Subagent",
    description:
      "Spawn a live Pi subagent in a shared tmux pane. The authenticated completion report is delivered directly as a compact custom message. Set context to 'fork' to give the child a branched copy of this conversation so the prompt does not need to restate prior context; default 'fresh' starts blank and requires a self-contained prompt. Use agent_report only for history and agent_pane for live inspection or steering. One delegation level only.",
    parameters: Type.Object({
      prompt: Type.Optional(Type.String()),
      model: Type.Optional(Type.String()),
      context: Type.Optional(Type.Union([Type.Literal("fresh"), Type.Literal("fork")])),
    }),
    async execute(_id, params) {
      if (isChild) throw new Error("Delegation is limited to one level");
      if (!controller || !ipc || !session || !store) {
        throw new Error("Codrive session not initialized");
      }
      assertCanDelegate(session);

      const spawned: SpawnedChild = await controller.spawn({
        prompt: params.prompt,
        model: params.model,
        context: params.context,
      });

      store.registerChild(session.sessionId, {
        childId: spawned.childId,
        paneId: spawned.paneId,
        model: spawned.model,
        createdAt: new Date().toISOString(),
      });

      live.add(spawned.paneId);
      waiting.add(spawned.paneId);
      histories.set(spawned.paneId, []);
      monitor?.track(spawned.paneId);

      return {
        content: [
          {
            type: "text",
            text: `Spawned shared SUBAGENT tmux pane ${spawned.paneId}. Completion reports arrive automatically.`,
          },
        ],
        details: { pane: spawned.paneId },
      };
    },
  });

  pi.registerTool({
    name: "agent_report",
    label: "Subagent Report",
    description:
      "Read in-memory report history for a subagent pane. This is a recovery/history API, not the normal completion path. Output is capped at 50 KB or 2,000 lines.",
    parameters: Type.Object({
      pane: Type.String(),
      turn: Type.Optional(Type.String()),
    }),
    async execute(_id, params) {
      const all = histories.get(params.pane);
      if (!all) throw new Error("Unknown or unowned pane");
      const selector = params.turn ?? "latest";
      let selected: HistoryRecord[];
      if (selector === "all") selected = all;
      else if (selector === "latest") selected = all.slice(-1);
      else if (/^\d+$/.test(selector) && Number(selector) > 0) {
        selected = all.slice(Number(selector) - 1, Number(selector));
      } else {
        throw new Error("turn must be latest, all, or a positive integer");
      }
      const text = selected.map((r) => `[${r.status}] ${r.assistantText}`).join("\n---\n");
      const output = truncateReport(text);
      return {
        content: [{ type: "text", text: output.content || "(no reports)" }],
        details: { count: selected.length, truncated: output.truncated },
      };
    },
  });

  pi.registerTool({
    name: "agent_pane",
    label: "Subagent Pane",
    description:
      "Read or send text to a live subagent pane owned by this orchestrator. Captured output is capped by configuration.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("read"), Type.Literal("send")]),
      pane: Type.String(),
      text: Type.Optional(Type.String()),
    }),
    async execute(_id, params) {
      if (isChild) throw new Error("Subagent sessions cannot control panes");
      if (!PANE.test(params.pane) || !histories.has(params.pane)) {
        throw new Error("Unknown or unowned pane");
      }
      if (!live.has(params.pane)) {
        throw new Error("Pane is not live; use agent_report for history");
      }
      if (!controller) throw new Error("Codrive session not initialized");

      const backend = new TmuxBackend();

      if (params.action === "read") {
        const text = await backend.read(params.pane, 500);
        const output = truncateReport(text);
        return {
          content: [{ type: "text", text: output.content || "(empty pane)" }],
          details: { truncated: output.truncated },
        };
      }

      if (!params.text) throw new Error("text is required for send");
      await backend.send(params.pane, params.text);
      return {
        content: [{ type: "text", text: `Sent text to ${params.pane}` }],
        details: undefined,
      };
    },
  });
}
