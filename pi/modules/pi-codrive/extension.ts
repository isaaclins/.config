import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { platform } from "node:os";
import { DEFAULT_MODEL, DEFAULT_THINKING, loadCodriveConfig } from "./src/config.ts";
import {
  captureChildIpcEnvironment,
  createHarnessSession,
  assertCanDelegate,
  ChildReporter,
  CHILD_ID_ENV,
  CodriveController,
  DelegationSupervisor,
  defaultRuntimeRoot,
  isCodriveChildEnvironment,
  NONCE_ENV,
  PaneHealthMonitor,
  RuntimeStore,
  ReportServer,
  sendEnvelope,
  SESSION_ID_ENV,
  SOCKET_ENV,
  TmuxBackend,
  truncateReportText,
  type HarnessSession,
  type OutgoingEnvelope,
  type ReportServerHandle,
  type SpawnedChild,
} from "./src/index.ts";

const HEALTH_INTERVAL_MS = 5000;
const PANE = /^%\d+$/;
const REPORT_MESSAGE = "pi-codrive-report";

export default function piCodrive(pi: ExtensionAPI): void {
  // Every listener is registered synchronously at top level. A child's own
  // first turn can reach agent_end before an async session_start body would
  // finish, silently dropping the report, so child-mode detection and
  // credential scrubbing happen up front and handlers are registered
  // unconditionally. This invariant must be preserved.
  const isChild = isCodriveChildEnvironment();
  const childIpcEnv: NodeJS.ProcessEnv = isChild ? captureChildIpcEnvironment() : {};

  // --- Child side: report lifecycle home over the authenticated channel. ---
  if (isChild) {
    const socketPath = childIpcEnv[SOCKET_ENV];
    const nonce = childIpcEnv[NONCE_ENV];
    const sessionId = childIpcEnv[SESSION_ID_ENV];
    const childId = childIpcEnv[CHILD_ID_ENV];
    if (socketPath && nonce && sessionId && childId) {
      let idle = true;
      let pending = false;
      const send = (envelope: OutgoingEnvelope): void => {
        void sendEnvelope(socketPath, nonce, envelope).catch(() => {
          // Reporting is best-effort and must never break the child session.
        });
      };
      const reporter = new ChildReporter({
        sessionId,
        childId,
        paneId: process.env.TMUX_PANE,
        send,
        isIdle: () => idle,
        hasPendingMessages: () => pending,
      });

      pi.on("session_start", async (_event, ctx) => {
        idle = ctx.isIdle();
        pending = ctx.hasPendingMessages();
        reporter.announce({
          piSessionFile: ctx.sessionManager.getSessionFile(),
          piSessionId: ctx.sessionManager.getSessionId(),
          cwd: ctx.cwd,
          model: ctx.model?.id,
        });
      });
      pi.on("after_provider_response", async (event) => {
        reporter.recordProviderResponse(event.status, event.headers ?? {});
      });
      pi.on("agent_start", async (_event, ctx) => {
        idle = ctx.isIdle();
        pending = ctx.hasPendingMessages();
        reporter.onAgentStart();
      });
      pi.on("turn_start", async (_event, ctx) => {
        idle = ctx.isIdle();
        pending = ctx.hasPendingMessages();
        reporter.heartbeat();
      });
      pi.on("tool_execution_start", async (_event, ctx) => {
        idle = ctx.isIdle();
        pending = ctx.hasPendingMessages();
        reporter.heartbeat();
      });
      pi.on("agent_end", async (event, ctx) => {
        idle = ctx.isIdle();
        pending = ctx.hasPendingMessages();
        reporter.onAgentEnd(event.messages);
      });
      pi.on("session_shutdown", async (event) => {
        reporter.onShutdown(event.reason);
      });
    }
    return;
  }

  // --- Parent side: supervise spawned children through the state machine. ---
  let ipc: ReportServerHandle | undefined;
  let store: RuntimeStore | undefined;
  let session: HarnessSession | undefined;
  let controller: CodriveController | undefined;
  let monitor: PaneHealthMonitor | undefined;
  let supervisor: DelegationSupervisor | undefined;

  pi.on("session_start", async (_event, ctx) => {
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
    let defaultThinking = DEFAULT_THINKING;
    try {
      const config = loadCodriveConfig();
      defaultModel = config.model ?? DEFAULT_MODEL;
      defaultThinking = config.thinking ?? DEFAULT_THINKING;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      ctx.ui?.notify(
        `pi-codrive: ${reason}. Falling back to ${DEFAULT_MODEL}:${DEFAULT_THINKING}.`,
        "warning",
      );
    }

    // ReportServer must start before the controller: every spawned child needs
    // this exact server's socketPath/nonce to report home, and the controller
    // threads those credentials into each launch.
    ipc = await ReportServer.start({
      runtimeRoot,
      sessionId: session.sessionId,
      store,
      onEnvelope: (envelope) => supervisor?.onEnvelope(envelope),
    });

    controller = new CodriveController({
      session,
      backend,
      policy: { defaultModel, defaultThinking, account() {} },
      reportSocket: ipc.socketPath,
      reportNonce: ipc.nonce,
    });

    const healthBackend = new TmuxBackend();
    monitor = new PaneHealthMonitor({
      intervalMs: HEALTH_INTERVAL_MS,
      isAlive: (pane) => healthBackend.isAlive(pane),
      onExitedWithoutReport: (pane) => supervisor?.onPaneDeath(pane),
    });

    supervisor = new DelegationSupervisor({
      sessionId: session.sessionId,
      store,
      controller,
      backend,
      monitor,
      wake: ({ pane, content, details }) => {
        const output = truncateReportText(content);
        pi.sendMessage(
          { customType: REPORT_MESSAGE, content: output.content, display: true, details },
          { triggerTurn: true, deliverAs: "followUp" },
        );
        void pane;
      },
    });

    monitor.start();
  });

  pi.on("session_shutdown", async () => {
    monitor?.stop();
    monitor = undefined;
    supervisor?.teardown();
    supervisor = undefined;
    await ipc?.close();
    ipc = undefined;
    store = undefined;
    session = undefined;
    controller = undefined;
  });

  pi.registerTool({
    name: "spawn_agent",
    label: "Spawn Subagent",
    description:
      "Spawn a live Pi subagent in a shared tmux pane. The authenticated completion report is delivered directly as a compact custom message. Set context to 'fork' to give the child a branched copy of this conversation so the prompt does not need to restate prior context; default 'fresh' starts blank and requires a self-contained prompt. A transient provider or stream error no longer looks like completion: the pane stays tracked and the orchestrator is only woken on real completion or when a child needs recovery. Use agent_report for history, agent_pane for live inspection or steering, and agent_resume to relaunch a dead or stuck child. One delegation level only.",
    promptGuidelines: [
      "When using spawn_agent, omit model to honor the configured delegation default. Pass model only when the user explicitly requests a different model for that delegation.",
    ],
    parameters: Type.Object({
      prompt: Type.Optional(Type.String()),
      model: Type.Optional(Type.String()),
      context: Type.Optional(Type.Union([Type.Literal("fresh"), Type.Literal("fork")])),
    }),
    async execute(_id, params) {
      if (!controller || !ipc || !session || !store || !supervisor) {
        throw new Error("Codrive session not initialized");
      }
      assertCanDelegate(session);

      const spawned: SpawnedChild = await controller.spawn({
        prompt: params.prompt,
        model: params.model,
        context: params.context,
      });

      supervisor.registerSpawn({
        childId: spawned.childId,
        paneId: spawned.paneId,
        model: spawned.model,
        piSessionId: spawned.piSessionId,
        piSessionFile: spawned.piSessionFile,
        projectRoot: session.projectRoot,
      });

      return {
        content: [
          {
            type: "text",
            text: `Spawned shared SUBAGENT tmux pane ${spawned.paneId}. Completion reports arrive automatically; recover it with agent_resume if it dies.`,
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
      "Read in-memory lifecycle history for a subagent pane, including interruptions and farewells as well as terminal reports. This is a recovery/history API, not the normal completion path. Historical pane ids from before an agent_resume still resolve. Output is capped at 50 KB or 2,000 lines.",
    parameters: Type.Object({
      pane: Type.String(),
      turn: Type.Optional(Type.String()),
    }),
    async execute(_id, params) {
      if (!supervisor) throw new Error("Codrive session not initialized");
      const { entries } = supervisor.getHistory(params.pane, params.turn ?? "latest");
      const text = entries.map((entry) => `[${entry.status}] ${entry.text}`).join("\n---\n");
      const output = truncateReportText(text || "(no reports)");
      return {
        content: [{ type: "text", text: output.content }],
        details: { count: entries.length, truncated: output.truncated },
      };
    },
  });

  pi.registerTool({
    name: "agent_pane",
    label: "Subagent Pane",
    description:
      "Read or send text to a live subagent pane owned by this orchestrator. After an agent_resume the current pane is used automatically even if you pass a historical pane id. Captured output is capped by configuration.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("read"), Type.Literal("send")]),
      pane: Type.String(),
      text: Type.Optional(Type.String()),
    }),
    async execute(_id, params) {
      if (!supervisor) throw new Error("Codrive session not initialized");
      if (!PANE.test(params.pane)) throw new Error("Unknown or unowned pane");

      if (params.action === "read") {
        const text = await supervisor.readPane(params.pane, 500);
        const output = truncateReportText(text || "(empty pane)");
        return {
          content: [{ type: "text", text: output.content }],
          details: { truncated: output.truncated },
        };
      }

      if (!params.text) throw new Error("text is required for send");
      const pane = await supervisor.sendPane(params.pane, params.text);
      return {
        content: [{ type: "text", text: `Sent text to ${pane}` }],
        details: undefined,
      };
    },
  });

  pi.registerTool({
    name: "agent_resume",
    label: "Resume Subagent",
    description:
      "Relaunch a dead or stuck subagent into a fresh tmux pane, resuming its own recorded pi session non-interactively (never the orchestrator's session). Reuses the same childId, carries report history forward, re-tracks health, and keeps both the new and old pane ids resolvable. Refuses a live healthy child unless force is set. One delegation level only.",
    parameters: Type.Object({
      pane: Type.String(),
      prompt: Type.Optional(Type.String()),
      force: Type.Optional(Type.Boolean()),
    }),
    async execute(_id, params) {
      if (!supervisor) throw new Error("Codrive session not initialized");
      if (!PANE.test(params.pane)) throw new Error("Unknown or unowned pane");
      const result = await supervisor.resume(params.pane, {
        prompt: params.prompt,
        force: params.force,
      });
      return {
        content: [
          {
            type: "text",
            text: `Resumed SUBAGENT ${result.childId} into pane ${result.newPane} (was ${result.oldPane}, resume #${result.resumeCount}).`,
          },
        ],
        details: {
          pane: result.newPane,
          oldPane: result.oldPane,
          childId: result.childId,
          resumeCount: result.resumeCount,
        },
      };
    },
  });
}
