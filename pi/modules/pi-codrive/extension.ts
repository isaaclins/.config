import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync, statSync } from "node:fs";
import { platform } from "node:os";
import { resolve } from "node:path";
import {
  DEFAULT_FIXER_MODEL,
  DEFAULT_MODEL,
  DEFAULT_THINKING,
  loadCodriveConfig,
} from "./src/config.ts";
import {
  captureChildIpcEnvironment,
  createHarnessSession,
  assertCanDelegate,
  ChildReporter,
  CHILD_ID_ENV,
  CodriveController,
  createTriggerWake,
  DeferredTriggerRegistry,
  DelegationSupervisor,
  defaultRuntimeRoot,
  formatJobs,
  formatTriggerLine,
  GitWorktrees,
  isCodriveChildEnvironment,
  isGitRepository,
  NONCE_ENV,
  PaneHealthMonitor,
  PAPERCUT_FILED_EVENT,
  PapercutDispatcher,
  parsePapercutEvent,
  RuntimeStore,
  ReportServer,
  sendEnvelope,
  SESSION_ID_ENV,
  SOCKET_ENV,
  TmuxBackend,
  truncateReportText,
  type CodriveReport,
  type DeferDelivery,
  type DeferKind,
  type HarnessSession,
  type OutgoingEnvelope,
  type PapercutJob,
  type ReportServerHandle,
  type SpawnedChild,
} from "./src/index.ts";

const HEALTH_INTERVAL_MS = 5000;
const PANE = /^%\d+$/;
const REPORT_MESSAGE = "pi-codrive-report";
const PAPERCUT_MESSAGE = "pi-codrive-papercut";

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Full detail for one papercut, including both agents' reports. */
function formatJobDetail(job: PapercutJob): string {
  const lines = [
    `papercut ${job.note.id}`,
    `phase:    ${job.phase}`,
    `owner:    ${job.note.owner ?? "unassigned"}`,
    `branch:   ${job.branch}`,
    `worktree: ${job.worktreePath ?? "(none)"}`,
    `attempts: ${job.attempts}`,
  ];
  if (job.reason) lines.push(`reason:   ${job.reason}`);
  if (job.diffStat) lines.push(`diff:     ${job.diffStat}`);
  if (job.note.refCallId) lines.push(`about:    call ${job.note.refCallId}`);
  if (job.note.suspects.length > 0) lines.push(`suspects: ${job.note.suspects.join(", ")}`);
  lines.push("", "note:", job.note.note);
  if (job.lastFixerReport) lines.push("", "fixer report:", job.lastFixerReport);
  if (job.lastVerifierReport) lines.push("", "verifier report:", job.lastVerifierReport);
  return lines.join("\n");
}

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
  let orchestratorPaneId: string | undefined;
  let tmuxBackend: TmuxBackend | undefined;
  let dispatcher: PapercutDispatcher | undefined;
  let deferred: DeferredTriggerRegistry | undefined;
  let unsubscribePapercut: (() => void) | undefined;

  /** Queue a papercut summary. It must never take over the user's view. */
  function queuePapercutSummary(summary: string): void {
    const output = truncateReportText(summary);
    pi.sendMessage(
      { customType: PAPERCUT_MESSAGE, content: output.content, display: true },
      { triggerTurn: false, deliverAs: "nextTurn" },
    );
  }

  pi.on("session_start", async (_event, ctx) => {
    if (platform() !== "darwin" && platform() !== "linux") return;

    const backend = new TmuxBackend({ piCommand: "pi" });
    tmuxBackend = backend;
    orchestratorPaneId = undefined;
    const paneId = process.env.TMUX_PANE;
    if (paneId && PANE.test(paneId)) {
      orchestratorPaneId = paneId;
      await backend.setPaneRole(paneId, "orchestrator");
    }

    const runtimeRoot = defaultRuntimeRoot();
    store = new RuntimeStore(runtimeRoot);

    session = createHarnessSession({
      projectRoot: ctx.cwd,
      role: "orchestrator",
      delegationDepth: 0,
      trust: "trusted",
    });
    store.saveSession(session);

    let defaultModel = DEFAULT_MODEL;
    let defaultThinking = DEFAULT_THINKING;
    let fixerModel = DEFAULT_FIXER_MODEL;
    try {
      const config = loadCodriveConfig();
      defaultModel = config.model ?? DEFAULT_MODEL;
      defaultThinking = config.thinking ?? DEFAULT_THINKING;
      fixerModel = config.fixerModel ?? DEFAULT_FIXER_MODEL;
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
      wake: ({ pane, content, details, quiet }) => {
        // A papercut fixer or verifier is the dispatcher's business, not the
        // user's: consume it here so the loop stays invisible end to end.
        const info = details as
          | { childId?: string; report?: CodriveReport; status?: string }
          | undefined;
        const childId = info?.childId;
        if (childId && dispatcher?.ownsChild(childId)) {
          void dispatcher
            .handleChildOutcome({
              childId,
              status: info?.report?.status ?? "error",
              text: info?.report?.assistantText ?? content,
            })
            .catch((error: unknown) => {
              queuePapercutSummary(
                `Papercut dispatch failed while handling child ${childId}: ${describe(error)}`,
              );
            });
          return;
        }

        const output = truncateReportText(content);
        // A quiet result belongs to an invisible background child: queue it for
        // the orchestrator's next turn instead of yanking the user's view.
        pi.sendMessage(
          { customType: REPORT_MESSAGE, content: output.content, display: true, details },
          quiet
            ? { triggerTurn: false, deliverAs: "nextTurn" }
            : { triggerTurn: true, deliverAs: "followUp" },
        );
        void pane;
      },
    });

    monitor.start();

    // --- Deferred triggers ------------------------------------------------
    // Same wake port as a delegation result, without the delegation: a trigger
    // reaches the agent through pi.sendMessage and costs no pane and no child.
    // Restore runs before the git check below so a pending trigger survives a
    // restart even in a directory the papercut loop skips.
    deferred = new DeferredTriggerRegistry({
      sessionId: session.sessionId,
      projectRoot: session.projectRoot,
      store,
      fire: createTriggerWake((message, options) => pi.sendMessage(message, options)),
    });
    deferred.restore();

    // --- Papercut self-repair loop ---------------------------------------
    // A reload runs session_start again, so drop any earlier subscription
    // before making a new one; two dispatchers would double-spawn fixers.
    unsubscribePapercut?.();
    unsubscribePapercut = undefined;
    dispatcher = undefined;

    const activeController = controller;
    const activeSupervisor = supervisor;
    const repoRoot = session.projectRoot;
    if (!(await isGitRepository(repoRoot))) return;

    dispatcher = new PapercutDispatcher({
      port: {
        repoRoot,
        worktrees: new GitWorktrees({ repoRoot }),
        async spawn({ cwd, prompt }) {
          const child = await activeController.spawn({
            prompt,
            model: fixerModel,
            context: "fresh",
            cwd,
            background: true,
          });
          activeSupervisor.registerSpawn({
            childId: child.childId,
            paneId: child.paneId,
            model: child.model,
            piSessionId: child.piSessionId,
            piSessionFile: child.piSessionFile,
            projectRoot: child.cwd,
            background: true,
          });
          return child.childId;
        },
        notify: queuePapercutSummary,
      },
    });

    unsubscribePapercut = pi.events.on(PAPERCUT_FILED_EVENT, (data) => {
      const note = parsePapercutEvent(data);
      if (!note) return;
      void dispatcher?.file(note).catch((error: unknown) => {
        queuePapercutSummary(`Papercut ${note.id} could not be dispatched: ${describe(error)}`);
      });
    });
  });

  pi.on("session_shutdown", async () => {
    unsubscribePapercut?.();
    unsubscribePapercut = undefined;
    dispatcher = undefined;

    if (tmuxBackend && orchestratorPaneId) {
      await tmuxBackend.unsetPaneRole(orchestratorPaneId);
    }
    orchestratorPaneId = undefined;
    tmuxBackend = undefined;

    // Timers go, records stay: shutdown is not cancellation, so whatever is
    // still pending is restored by the next session.
    deferred?.stop();
    deferred = undefined;

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
      "Pass cwd with a worktree path from worktree_create for any child that writes files, so its edits cannot collide with your own working directory. Omit cwd for read-only investigation.",
    ],
    parameters: Type.Object({
      prompt: Type.Optional(Type.String()),
      model: Type.Optional(Type.String()),
      context: Type.Optional(Type.Union([Type.Literal("fresh"), Type.Literal("fork")])),
      cwd: Type.Optional(Type.String()),
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
        cwd: resolveSpawnCwd(params.cwd),
      });

      supervisor.registerSpawn({
        childId: spawned.childId,
        paneId: spawned.paneId,
        model: spawned.model,
        piSessionId: spawned.piSessionId,
        piSessionFile: spawned.piSessionFile,
        projectRoot: spawned.cwd,
        background: spawned.background,
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

  pi.registerCommand("papercuts", {
    description:
      "Papercut self-repair: list jobs, `show <id>`, `dispatch <id>` to force one, `cleanup` to remove merged worktrees",
    getArgumentCompletions(prefix) {
      const options = ["show", "dispatch", "cleanup"];
      const matches = options
        .filter((option) => option.startsWith(prefix.toLowerCase()))
        .map((option) => ({ value: option, label: option }));
      return matches.length > 0 ? matches : null;
    },
    handler: async (args, ctx) => {
      if (!dispatcher) {
        ctx.ui.notify("papercuts: not active (no git repository, or session not initialized)", "warning");
        return;
      }
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const cmd = (parts[0] ?? "").toLowerCase();

      if (!cmd) {
        ctx.ui.notify(formatJobs(dispatcher.list()), "info");
        return;
      }
      if (cmd === "show") {
        const job = dispatcher.get(parts[1] ?? "");
        if (!job) {
          ctx.ui.notify(`papercuts: no papercut ${parts[1] ?? ""} in this session`, "warning");
          return;
        }
        ctx.ui.notify(formatJobDetail(job), "info");
        return;
      }
      if (cmd === "dispatch") {
        const id = parts[1] ?? "";
        if (!id) {
          ctx.ui.notify("papercuts: usage: /papercuts dispatch <id>", "warning");
          return;
        }
        const decision = await dispatcher.dispatchById(id);
        ctx.ui.notify(
          decision.dispatch
            ? `papercuts: dispatched ${id} (${decision.reason})`
            : `papercuts: refused ${id} (${decision.reason})`,
          decision.dispatch ? "info" : "warning",
        );
        return;
      }
      if (cmd === "cleanup") {
        const removed = await dispatcher.cleanupMerged();
        ctx.ui.notify(
          removed.length === 0
            ? "papercuts: nothing to clean up (unmerged branches are never removed)"
            : `papercuts: removed ${removed.length} merged worktree(s): ${removed.join(", ")}`,
          "info",
        );
        return;
      }
      ctx.ui.notify("papercuts: usage: /papercuts [show <id> | dispatch <id> | cleanup]", "warning");
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

  pi.registerTool({
    name: "defer",
    label: "Deferred Trigger",
    description:
      "Come back to something later without blocking and without delegating. action 'create' arms one trigger: pass delayMs to be reminded after that much wall clock, or check (a shell command, exit 0 means true) to be told as soon as a condition holds, polled every pollMs until timeoutMs. A condition that never comes true still fires, with a timeout outcome, so nothing is silently dropped. note is the text delivered back to you. delivery 'interrupt' (default) reaches you at the next tool call boundary and starts a turn even if you are idle; 'quiet' waits for the next natural turn and never interrupts. A trigger costs no model context, no tmux pane, and no delegation slot, and it survives turn end, going idle, compaction, and a restart. Use 'list' to see pending triggers and 'cancel' with an id to drop one.",
    promptGuidelines: [
      "To check back on something later (a long install, a deploy, a file that should appear), use defer instead of spawn_agent: spawn_agent spends a model context, a tmux pane, and the single delegation slot just to wait, while defer costs nothing while it waits.",
      "Never sleep or poll in a bash command to wait for something slow. Arm a defer trigger with a check command and keep working; it wakes you when the condition holds or when it times out.",
    ],
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("create"),
        Type.Literal("list"),
        Type.Literal("cancel"),
      ]),
      note: Type.Optional(Type.String()),
      delayMs: Type.Optional(Type.Number()),
      check: Type.Optional(Type.String()),
      pollMs: Type.Optional(Type.Number()),
      timeoutMs: Type.Optional(Type.Number()),
      delivery: Type.Optional(
        Type.Union([Type.Literal("interrupt"), Type.Literal("quiet")]),
      ),
      id: Type.Optional(Type.String()),
    }),
    async execute(_id, params) {
      if (!deferred) throw new Error("Codrive session not initialized");

      if (params.action === "list") {
        const triggers = deferred.list();
        const text =
          triggers.length === 0
            ? "(no pending deferred triggers)"
            : triggers.map(formatTriggerLine).join("\n");
        const details: DeferToolDetails = { action: "list", count: triggers.length };
        return { content: [{ type: "text", text }], details };
      }

      if (params.action === "cancel") {
        const id = params.id?.trim();
        if (!id) throw new Error("id is required for cancel");
        const cancelled = deferred.cancel(id);
        if (!cancelled) {
          throw new Error(
            `No pending deferred trigger ${id}: it already fired, was cancelled, or never existed. Use action "list" to see what is pending.`,
          );
        }
        const details: DeferToolDetails = { action: "cancel", id, kind: cancelled.kind };
        return {
          content: [
            { type: "text", text: `Cancelled deferred trigger ${id}; it will not fire.` },
          ],
          details,
        };
      }

      const trigger = deferred.create({
        note: params.note ?? "",
        delayMs: params.delayMs,
        check: params.check,
        pollMs: params.pollMs,
        timeoutMs: params.timeoutMs,
        delivery: params.delivery,
      });
      const due = new Date(trigger.dueAt).toISOString();
      const text =
        trigger.kind === "after"
          ? `Armed deferred trigger ${trigger.id}: it fires at ${due} and is delivered as ${trigger.delivery}.`
          : `Armed deferred trigger ${trigger.id}: it polls \`${trigger.check}\` every ${trigger.pollMs} ms and fires as soon as that succeeds, or with a timeout outcome at ${due}. Delivered as ${trigger.delivery}.`;
      const details: DeferToolDetails = {
        action: "create",
        id: trigger.id,
        kind: trigger.kind,
        dueAt: due,
        delivery: trigger.delivery,
      };
      return { content: [{ type: "text", text }], details };
    },
  });
}

/** One details shape for every defer action, so the tool has one result type. */
interface DeferToolDetails {
  action: "create" | "list" | "cancel";
  id?: string;
  kind?: DeferKind;
  dueAt?: string;
  delivery?: DeferDelivery;
  count?: number;
}

/**
 * Validate a caller-supplied spawn cwd.
 *
 * A bad path would otherwise surface as an opaque tmux failure, and silently
 * falling back to the orchestrator's own directory is worse than refusing:
 * the caller asked for isolation precisely so the child could not write here.
 */
function resolveSpawnCwd(cwd: string | undefined): string | undefined {
  if (cwd === undefined) return undefined;
  const trimmed = cwd.trim();
  if (!trimmed) return undefined;
  const resolved = resolve(trimmed);
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
    throw new Error(`spawn_agent cwd is not a directory: ${resolved}`);
  }
  return resolved;
}
