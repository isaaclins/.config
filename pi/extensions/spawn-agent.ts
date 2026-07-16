import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { randomUUID } from "node:crypto";
import { platform } from "node:os";
import { loadConfig, type CodriveConfig } from "../lib/codrive-config.ts";
import {
  NONCE_ENV,
  SOCKET_ENV,
  sendReport,
  startIpcServer,
  type IpcServer,
} from "../lib/codrive-ipc.ts";
import { ReportRouter } from "../lib/codrive-router.ts";
import {
  buildLaunch,
  buildPiArguments,
  checkedPaneExec,
  markPaneDead,
  paneRoleArgs,
  shellQuote,
} from "../lib/codrive-pane.ts";
import {
  createSpawnReport,
  formatReports,
  truncateReportOutput,
  type SpawnReportRecord,
} from "../lib/codrive-state.ts";

const PANE = /^%\d+$/;
const WAITING_WIDGET = "pi-codrive-waiting";
const REPORT_MESSAGE = "pi-codrive-report";
const CHILD_ENV = Boolean(process.env[SOCKET_ENV] || process.env[NONCE_ENV]);

export default function piCodrive(pi: ExtensionAPI): void {
  const histories = new Map<string, SpawnReportRecord[]>();
  const live = new Set<string>();
  const waiting = new Set<string>();
  const healthTimers = new Map<string, ReturnType<typeof setInterval>>();
  let ipc: IpcServer | undefined;
  let config: CodriveConfig | undefined;
  let parentContext: ExtensionContext | undefined;
  let catTimer: ReturnType<typeof setInterval> | undefined;

  const renderWaiting = (): void => {
    if (
      !parentContext ||
      parentContext.mode !== "tui" ||
      !config?.waitingWidget.enabled
    )
      return;
    if (!waiting.size) {
      parentContext.ui.setWidget(WAITING_WIDGET, undefined);
      if (catTimer) clearInterval(catTimer);
      catTimer = undefined;
      return;
    }
    parentContext.ui.setWidget(WAITING_WIDGET, [
      parentContext.ui.theme.fg("accent", "ᓚᘏᗢ") +
        parentContext.ui.theme.fg(
          "muted",
          ` orchestrator waiting for ${[...waiting].join(", ")}`,
        ),
    ]);
  };

  const acceptReport = (report: SpawnReportRecord): void => {
    const pane = report.pane;
    if (!pane) return;
    const history = histories.get(pane) ?? [];
    history.push(report);
    histories.set(pane, history);
    waiting.delete(pane);
    renderWaiting();
    const injected = truncateReportOutput(
      `SUBAGENT ${pane} completed with status ${report.status}.\n\n${report.assistantText}`,
    ).content;
    pi.sendMessage(
      {
        customType: REPORT_MESSAGE,
        content: injected,
        display: true,
        details: { pane, report, role: "subagent" },
      },
      { triggerTurn: true, deliverAs: "followUp" },
    );
  };
  const router = new ReportRouter(acceptReport);

  const setPaneRole = async (
    role: "orchestrator" | "subagent" | null,
  ): Promise<void> => {
    if (!process.env.TMUX || !process.env.TMUX_PANE || !config) return;
    await pi.exec(
      "tmux",
      paneRoleArgs(process.env.TMUX_PANE, config.tmux.roleOption, role),
      { timeout: 5000 },
    );
  };

  if (CHILD_ENV) {
    pi.on("agent_end", async (event) => {
      try {
        const childConfig = loadConfig();
        const report = createSpawnReport(
          event.messages,
          randomUUID(),
          process.env.TMUX_PANE,
        );
        await sendReport(report, childConfig);
      } catch {
        // Reporting is best-effort and must never break child Pi.
      }
    });
  } else {
    config = loadConfig();
  }

  pi.registerMessageRenderer(REPORT_MESSAGE, (message, _options, theme) => {
    const details = message.details as
      | { pane?: string; report?: SpawnReportRecord; status?: string }
      | undefined;
    const report = details?.report;
    const status = report?.status ?? details?.status ?? "finished";
    const label = theme.fg(
      status === "completed" ? "success" : "warning",
      `SUBAGENT ${details?.pane ?? "child"} ${status}`,
    );
    const preview =
      report?.assistantText.replace(/\s+/g, " ").trim() ||
      (status === "exited-without-report"
        ? "no report received"
        : "no assistant text");
    return {
      render: (width: number) => [
        truncateToWidth(`${label} ${theme.fg("muted", preview)}`, width, "…"),
      ],
      invalidate() {},
    };
  });

  pi.on("session_start", async (_event, ctx) => {
    parentContext = ctx;
    if (CHILD_ENV) return;
    if (platform() !== "darwin" && platform() !== "linux") return;
    await ipc?.close();
    ipc = undefined;
    await setPaneRole("orchestrator");
    ipc = await startIpcServer(config!, (report) => router.receive(report));
  });

  pi.on("session_shutdown", async () => {
    if (catTimer) clearInterval(catTimer);
    catTimer = undefined;
    for (const timer of healthTimers.values()) clearInterval(timer);
    healthTimers.clear();
    parentContext?.ui.setWidget(WAITING_WIDGET, undefined);
    if (!CHILD_ENV) await setPaneRole(null);
    await ipc?.close();
    ipc = undefined;
    parentContext = undefined;
    waiting.clear();
    live.clear();
    router.clear();
    histories.clear();
  });

  const stopLivePane = (pane: string) => {
    const timer = healthTimers.get(pane);
    if (timer) clearInterval(timer);
    healthTimers.delete(pane);
    const dead = markPaneDead(pane, live, waiting, histories);
    renderWaiting();
    return dead;
  };

  const registerSpawnedPane = (pane: string): void => {
    histories.set(pane, []);
    live.add(pane);
    waiting.add(pane);
    router.registerPane(pane);
    renderWaiting();
    if (config!.waitingWidget.enabled && !catTimer) {
      catTimer = setInterval(renderWaiting, config!.waitingWidget.intervalMs);
      catTimer.unref();
    }
    const healthTimer = setInterval(async () => {
      try {
        const status = await pi.exec(
          "tmux",
          ["display-message", "-p", "-t", pane, "#{pane_dead}"],
          { timeout: 5000 },
        );
        if (status.code === 0 && status.stdout.trim() === "0") return;
      } catch {
        // A failed health probe means the pane can no longer be trusted as live.
      }
      const dead = stopLivePane(pane);
      if (dead.wasWaiting && !dead.hasReports) {
        pi.sendMessage(
          {
            customType: REPORT_MESSAGE,
            content: `SUBAGENT ${pane} exited before delivering a report. Report history remains available if a delayed authenticated report arrives.`,
            display: true,
            details: {
              pane,
              role: "subagent",
              status: "exited-without-report",
            },
          },
          { triggerTurn: true, deliverAs: "followUp" },
        );
      }
    }, 5000);
    healthTimer.unref();
    healthTimers.set(pane, healthTimer);
  };

  const spawnAndRegister = async (
    cwd: string,
    prompt?: string,
    model?: string,
  ): Promise<string> => {
    if (CHILD_ENV) throw new Error("Delegation is limited to one level");
    if (!process.env.TMUX)
      throw new Error(
        "tmux is required. On macOS, use the documented Ghostty fallback manually.",
      );
    if (!ipc || !config) throw new Error("IPC server is not ready");
    const launch = buildLaunch(
      config.piCommand,
      buildPiArguments(prompt, config.model, config.thinking, model),
    );
    const command = `tmux set-option -p remain-on-exit on; tmux set-option -p ${shellQuote(config.tmux.roleOption)} subagent; ${SOCKET_ENV}=${shellQuote(ipc.path)} ${NONCE_ENV}=${shellQuote(ipc.nonce)} exec ${launch}`;
    const args = [
      "split-window",
      config.tmux.split === "horizontal" ? "-h" : "-v",
      "-c",
      cwd,
      "-P",
      "-F",
      "#{pane_id}",
    ];
    if (config.tmux.size) args.push("-l", String(config.tmux.size));
    args.push(command);
    const result = await pi.exec("tmux", args, { timeout: 10000 });
    if (result.code !== 0)
      throw new Error(
        `tmux split-window failed: ${result.stderr || result.stdout || `exit ${result.code}`}`,
      );
    const pane = result.stdout.trim();
    if (!PANE.test(pane)) throw new Error("tmux returned an invalid pane ID");
    registerSpawnedPane(pane);
    return pane;
  };

  pi.registerCommand("spawn", {
    description:
      "Spawn a shared live subagent pane with an optional initial prompt",
    handler: async (args, ctx) => {
      try {
        const pane = await spawnAndRegister(ctx.cwd, args.trim() || undefined);
        ctx.ui.notify(`Spawned shared SUBAGENT tmux pane ${pane}.`, "info");
      } catch (error) {
        ctx.ui.notify(
          `Failed to spawn subagent: ${(error as Error).message}`,
          "error",
        );
      }
    },
  });

  pi.registerTool({
    name: "spawn_agent",
    label: "Spawn Subagent",
    description:
      "Spawn a live Pi subagent in a shared tmux pane. The authenticated completion report is delivered directly as a compact custom message. Use agent_report only for history and agent_pane for live inspection or steering. One delegation level only.",
    parameters: Type.Object({
      prompt: Type.Optional(Type.String()),
      model: Type.Optional(Type.String()),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const pane = await spawnAndRegister(ctx.cwd, params.prompt, params.model);
      return {
        content: [
          {
            type: "text",
            text: `Spawned shared SUBAGENT tmux pane ${pane}. Completion reports arrive automatically.`,
          },
        ],
        details: { pane },
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
      if (!router.owns(params.pane)) throw new Error("Unknown or unowned pane");
      const all = histories.get(params.pane) ?? [];
      const selector = params.turn ?? "latest";
      const selected =
        selector === "all"
          ? all
          : selector === "latest"
            ? all.slice(-1)
            : /^\d+$/.test(selector) && Number(selector) > 0
              ? all.slice(Number(selector) - 1, Number(selector))
              : (() => {
                  throw new Error(
                    "turn must be latest, all, or a positive integer",
                  );
                })();
      const output = truncateReportOutput(formatReports(selected));
      return {
        content: [{ type: "text", text: output.content }],
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
      action: StringEnum(["read", "send"] as const),
      pane: Type.String(),
      text: Type.Optional(Type.String()),
    }),
    async execute(_id, params) {
      if (CHILD_ENV) throw new Error("Subagent sessions cannot control panes");
      if (!PANE.test(params.pane) || !router.owns(params.pane))
        throw new Error("Unknown or unowned pane");
      if (!live.has(params.pane))
        throw new Error("Pane is not live; use agent_report for history");
      let alive;
      try {
        alive = await pi.exec("tmux", [
          "display-message",
          "-p",
          "-t",
          params.pane,
          "#{pane_dead}",
        ]);
      } catch (error) {
        stopLivePane(params.pane);
        throw new Error(
          `Failed to check pane ${params.pane}: ${(error as Error).message}. Report history is preserved.`,
        );
      }
      if (alive.code !== 0 || alive.stdout.trim() !== "0") {
        stopLivePane(params.pane);
        throw new Error(
          `Pane ${params.pane} is not live; use agent_report for preserved history.`,
        );
      }
      const executePaneCommand = (operation: string, args: string[]) =>
        checkedPaneExec(
          params.pane,
          operation,
          args,
          (tmuxArgs) => pi.exec("tmux", tmuxArgs, { timeout: 10000 }),
          () => stopLivePane(params.pane),
        );
      if (params.action === "read") {
        const result = await executePaneCommand("capture-pane", [
          "capture-pane",
          "-p",
          "-t",
          params.pane,
          "-S",
          `-${config!.tmux.captureLines}`,
        ]);
        const output = truncateReportOutput(result.stdout);
        return {
          content: [{ type: "text", text: output.content || "(empty pane)" }],
          details: { truncated: output.truncated },
        };
      }
      if (!params.text) throw new Error("text is required for send");
      await executePaneCommand("send text", [
        "send-keys",
        "-t",
        params.pane,
        "-l",
        params.text,
      ]);
      await executePaneCommand("send Enter", [
        "send-keys",
        "-t",
        params.pane,
        "Enter",
      ]);
      return {
        content: [{ type: "text", text: `Sent text to ${params.pane}` }],
        details: undefined,
      };
    },
  });
}
