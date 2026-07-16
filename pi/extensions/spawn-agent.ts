import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import {
  assertPrivateArtifact,
  cleanupPrivateArtifacts,
  createSpawnReport,
  formatReports,
  JsonlCursor,
  OwnedPaneRegistry,
  ReportStore,
  truncateReportOutput,
} from "../lib/spawn-agent-state.ts";

/**
 * Shared-control live pi sessions with structured turn reporting.
 *
 * tmux children remain real, human-visible panes that the user and parent can
 * co-drive. Each child writes structured agent_end reports before signaling a
 * lightweight notify file. The parent wakes and uses agent_report for durable
 * completion retrieval; agent_pane remains restricted to live pane inspection
 * and steering. Ghostty is user-driven and cannot report or be controlled.
 */

const PANE_ID_RE = /^%\d+$/;
const REPORT_ENV = "PI_SPAWN_AGENT_REPORT_FILE";
const NOTIFY_ENV = "PI_SPAWN_NOTIFY_FILE";
const NOTIFY_POLL_MS = 1000;
const PANE_HEALTHCHECK_MS = 5000;
const CAT_FRAME_MS = 600;
const WAITING_CAT_WIDGET = "spawn-agent-waiting-cat";
const DEFAULT_SPAWN_MODEL = "anthropic/claude-haiku-4-5";
const DEFAULT_SPAWN_THINKING = "low";

interface ParentWatcher {
  pane: string;
  waitingForFirstTurn: boolean;
  healthcheckTimer?: ReturnType<typeof setInterval>;
  cursor: JsonlCursor;
  pendingNotifications: Set<string>;
  seenNotifications: Set<string>;
}

interface SpawnResult {
  message: string;
  pane?: string;
  mode: "tmux" | "ghostty";
  notifyFile?: string;
  reportFile?: string;
}

export default function (pi: ExtensionAPI) {
  registerChildReporter(pi);

  let catTimer: ReturnType<typeof setInterval> | undefined;
  let parentContext: ExtensionContext | undefined;
  let catFrame = 0;
  let artifactRoot: string | undefined;
  const livePanes = new OwnedPaneRegistry();
  const reportStore = new ReportStore();
  const watchers = new Map<string, ParentWatcher>();

  const ensureArtifactRoot = () => {
    if (artifactRoot) return artifactRoot;
    artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-spawn-agent-parent-"));
    fs.chmodSync(artifactRoot, 0o700);
    return artifactRoot;
  };

  const createArtifact = (suffix: string) => {
    const root = ensureArtifactRoot();
    const file = path.join(root, `${randomBytes(12).toString("hex")}.${suffix}.jsonl`);
    const descriptor = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
    fs.closeSync(descriptor);
    fs.chmodSync(file, 0o600);
    assertPrivateArtifact(file, root);
    return file;
  };

  const renderWaitingCat = () => {
    const ctx = parentContext;
    if (!ctx || ctx.mode !== "tui") return;
    const panes = [...watchers.values()].filter((watcher) => watcher.waitingForFirstTurn).map((watcher) => watcher.pane);
    if (panes.length === 0) { ctx.ui.setWidget(WAITING_CAT_WIDGET, undefined); return; }
    const frames = ["ᓚᘏᗢ", "ᓚᘏᗢ", "ᓚᵕᗢ", "ᓚᘏᗢ"];
    const paneText = panes.length <= 3 ? panes.join(", ") : `${panes.slice(0, 3).join(", ")} +${panes.length - 3}`;
    const noun = panes.length === 1 ? "agent" : "agents";
    ctx.ui.setWidget(WAITING_CAT_WIDGET, [ctx.ui.theme.fg("accent", frames[catFrame % frames.length]!) + ctx.ui.theme.fg("muted", ` waiting for ${panes.length} ${noun} (${paneText})`)]);
  };

  const startWaitingCat = (ctx: ExtensionContext) => {
    parentContext = ctx;
    renderWaitingCat();
    if (catTimer || ctx.mode !== "tui") return;
    catTimer = setInterval(() => { catFrame++; renderWaitingCat(); }, CAT_FRAME_MS);
    catTimer.unref();
  };

  const stopWaitingCatIfIdle = () => {
    if ([...watchers.values()].some((watcher) => watcher.waitingForFirstTurn)) return;
    if (catTimer) clearInterval(catTimer);
    catTimer = undefined;
    renderWaitingCat();
  };

  const removeLivePane = (pane: string) => {
    for (const [notifyFile, watcher] of watchers) {
      if (watcher.pane !== pane) continue;
      if (watcher.healthcheckTimer) clearInterval(watcher.healthcheckTimer);
      fs.unwatchFile(notifyFile);
      watchers.delete(notifyFile);
    }
    livePanes.delete(pane);
    stopWaitingCatIfIdle();
  };

  const watchForChildReports = (notifyFile: string, pane: string) => {
    let processing = Promise.resolve();
    const watcher: ParentWatcher = { pane, waitingForFirstTurn: true, cursor: new JsonlCursor(), pendingNotifications: new Set(), seenNotifications: new Set() };
    watchers.set(notifyFile, watcher);

    const processEvents = () => {
      processing = processing.then(async () => {
        let content: string;
        try {
          if (!artifactRoot) return;
          assertPrivateArtifact(notifyFile, artifactRoot);
          content = fs.readFileSync(notifyFile, "utf8");
        } catch { return; }
        for (const line of watcher.cursor.ingest(content)) {
          let notification: { event?: unknown; eventId?: unknown };
          try { notification = JSON.parse(line); } catch { continue; }
          if (notification.event !== "agent_end" || typeof notification.eventId !== "string" || watcher.seenNotifications.has(notification.eventId)) continue;
          watcher.pendingNotifications.add(notification.eventId);
        }
        reportStore.refresh(pane);
        for (const eventId of [...watcher.pendingNotifications]) {
          const report = reportStore.get(pane, "all").find((record) => record.eventId === eventId);
          if (!report) continue;
          watcher.pendingNotifications.delete(eventId);
          watcher.seenNotifications.add(eventId);
          if (watcher.waitingForFirstTurn) {
            watcher.waitingForFirstTurn = false;
            renderWaitingCat();
            stopWaitingCatIfIdle();
          }
          const turnIndex = reportStore.get(pane, "all").findIndex((record) => record.eventId === report.eventId) + 1;
          pi.sendMessage({
            customType: "spawn-agent-done",
            content: `Spawned agent ${pane} finished turn ${turnIndex} (${report.status}). Use agent_report { pane: "${pane}", turn: "latest" } first. Use agent_pane only for live terminal inspection or steering.`,
            display: true,
            details: { pane, eventId: report.eventId, turn: turnIndex, status: report.status, stopReason: report.stopReason, reportAvailable: true },
          }, { triggerTurn: true, deliverAs: "followUp" });
        }
      }).catch(() => { /* Reporting must never break Pi. */ });
    };

    const healthcheckTimer = setInterval(() => {
      processing = processing.then(async () => {
        const status = await pi.exec("tmux", ["display-message", "-p", "-t", pane, "#{pane_id}:#{pane_dead}"], { timeout: 5_000 });
        if (status.code !== 0 || status.stdout.trim() !== `${pane}:0`) removeLivePane(pane);
      }).catch(() => { /* Pane cleanup must never break Pi. */ });
    }, PANE_HEALTHCHECK_MS);
    healthcheckTimer.unref();
    watcher.healthcheckTimer = healthcheckTimer;
    fs.watchFile(notifyFile, { interval: NOTIFY_POLL_MS }, processEvents);
    processEvents();
  };

  const registerSpawn = (result: SpawnResult, ctx: ExtensionContext) => {
    if (!result.pane || !result.notifyFile || !result.reportFile) return;
    livePanes.add(result.pane);
    reportStore.add(result.pane, result.reportFile, artifactRoot!);
    watchForChildReports(result.notifyFile, result.pane);
    startWaitingCat(ctx);
  };

  pi.on("session_shutdown", async () => {
    if (catTimer) clearInterval(catTimer);
    for (const [notifyFile, watcher] of watchers) {
      if (watcher.healthcheckTimer) clearInterval(watcher.healthcheckTimer);
      fs.unwatchFile(notifyFile);
    }
    watchers.clear(); livePanes.clear(); reportStore.clear();
    if (artifactRoot) cleanupPrivateArtifacts(artifactRoot);
    artifactRoot = undefined; catTimer = undefined; parentContext = undefined;
  });

  pi.registerCommand("spawn", {
    description: "Spawn a live pi session with durable structured reports in tmux, or a user-driven Ghostty window",
    handler: async (args, ctx) => {
      try {
        const result = await spawnLiveAgent(pi, ctx.cwd, args?.trim() || undefined, undefined, createArtifact);
        registerSpawn(result, ctx);
        ctx.ui.notify(result.message, "info");
      } catch (error) { ctx.ui.notify(`Failed to spawn agent: ${(error as Error).message}`, "error"); }
    },
  });

  pi.registerTool({
    name: "spawn_agent",
    label: "Spawn Agent",
    description: "Spawn a NEW live, human-visible pi session. In tmux, the child emits durable structured reports on every completed turn; use agent_report first for results and agent_pane only to inspect or steer the live terminal. Reports survive pane exit until parent shutdown. Outside tmux, Ghostty fallback is user-driven and cannot report, steer, or notify. Delegation is one level deep. Never delegate interactive privileged input.",
    parameters: Type.Object({
      prompt: Type.Optional(Type.String({ description: "Optional initial prompt" })),
      model: Type.Optional(Type.String({ description: "Defaults to anthropic/claude-haiku-4-5. Use a stronger model only when needed." })),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const result = await spawnLiveAgent(pi, process.cwd(), params.prompt, params.model, createArtifact);
      registerSpawn(result, ctx);
      return { content: [{ type: "text", text: result.message }], details: { pane: result.pane ?? null, mode: result.mode, structuredReports: result.mode === "tmux" } };
    },
  });

  pi.registerTool({
    name: "agent_report",
    label: "Agent Report",
    description: "Retrieve durable structured assistant reports for a tmux pane spawned by this parent. Reports remain available after pane exit until parent shutdown. turn defaults to latest and accepts latest, all, or a 1-based numeric turn. Output is capped at 50 KB or 2,000 lines.",
    parameters: Type.Object({
      pane: Type.String({ description: "tmux pane id returned by spawn_agent, e.g. '%3'" }),
      turn: Type.Optional(Type.String({ description: "latest, all, or a 1-based numeric turn; defaults to latest" })),
    }),
    prepareArguments(args) {
      if (!args || typeof args !== "object") return args;
      const input = args as { turn?: unknown };
      return typeof input.turn === "number" && Number.isInteger(input.turn) ? { ...input, turn: String(input.turn) } : args;
    },
    async execute(_id, params) {
      if (!PANE_ID_RE.test(params.pane)) throw new Error(`Invalid tmux pane id "${params.pane}".`);
      const rawSelector = params.turn ?? "latest";
      const selector = rawSelector === "latest" || rawSelector === "all" ? rawSelector : /^\d+$/.test(rawSelector) ? Number(rawSelector) : undefined;
      if (selector === undefined || selector === 0) throw new Error("turn must be latest, all, or a positive 1-based integer.");
      const records = reportStore.get(params.pane, selector);
      const output = truncateReportOutput(formatReports(records));
      return { content: [{ type: "text", text: output.content }], details: { pane: params.pane, selector: rawSelector, reportCount: records.length, truncated: output.truncated } };
    },
  });

  pi.registerTool({
    name: "agent_pane",
    label: "Agent Pane",
    description: "Send input to or inspect the current screen of a LIVE tmux pane created by spawn_agent. Use agent_report, not screen scraping, to retrieve completed-turn results. Dead panes are rejected here even though their reports remain available through agent_report.",
    parameters: Type.Object({
      action: StringEnum(["send", "read"] as const),
      pane: Type.String({ description: "tmux pane id returned by spawn_agent" }),
      text: Type.Optional(Type.String({ description: "Required for send" })),
    }),
    async execute(_id, params) {
      if (isSpawnedChild()) throw new Error("Spawned agents cannot steer other panes. Delegation is one level deep.");
      if (!process.env.TMUX) throw new Error("agent_pane only works inside tmux.");
      if (!PANE_ID_RE.test(params.pane)) throw new Error(`Invalid tmux pane id "${params.pane}".`);
      if (!livePanes.has(params.pane)) throw new Error("agent_pane can only control live panes spawned by this parent session.");
      const paneStatus = await pi.exec("tmux", ["display-message", "-p", "-t", params.pane, "#{pane_id}:#{pane_dead}"], { timeout: 5_000 });
      if (paneStatus.code !== 0 || paneStatus.stdout.trim() !== `${params.pane}:0`) {
        removeLivePane(params.pane);
        throw new Error("agent_pane can only control live panes. This pane has exited; use agent_report for its durable reports.");
      }
      if (params.action === "read") {
        const result = await pi.exec("tmux", ["capture-pane", "-t", params.pane, "-p", "-S", "-100"], { timeout: 10_000 });
        if (result.code !== 0) { removeLivePane(params.pane); throw new Error(`tmux capture-pane failed: ${result.stderr || result.stdout}`); }
        return { content: [{ type: "text", text: result.stdout || "(pane is empty)" }], details: { pane: params.pane } };
      }
      if (!params.text) throw new Error("action 'send' requires 'text'.");
      const textResult = await pi.exec("tmux", ["send-keys", "-t", params.pane, "-l", params.text], { timeout: 10_000 });
      if (textResult.code !== 0) { removeLivePane(params.pane); throw new Error(`tmux send-keys failed: ${textResult.stderr || textResult.stdout}`); }
      const enterResult = await pi.exec("tmux", ["send-keys", "-t", params.pane, "Enter"], { timeout: 10_000 });
      if (enterResult.code !== 0) { removeLivePane(params.pane); throw new Error(`tmux send-keys (Enter) failed: ${enterResult.stderr || enterResult.stdout}`); }
      return { content: [{ type: "text", text: `Sent to pane ${params.pane}: ${params.text}` }], details: { pane: params.pane } };
    },
  });
}

/** Child side: write a structured report before the compatibility notification. */
function registerChildReporter(pi: ExtensionAPI) {
  const notifyFile = process.env[NOTIFY_ENV];
  const reportFile = process.env[REPORT_ENV];
  if (!notifyFile || !reportFile) return;
  pi.on("agent_end", async (event) => {
    const eventId = randomUUID();
    try {
      appendPrivateLine(reportFile, JSON.stringify(createSpawnReport(event.messages, eventId, process.env.TMUX_PANE)) + "\n");
      appendPrivateLine(notifyFile, JSON.stringify({ event: "agent_end", eventId, ts: Date.now() }) + "\n");
    } catch { /* Child reporting must never break Pi. */ }
  });
}

function appendPrivateLine(file: string, content: string): void {
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  const descriptor = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | noFollow);
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) throw new Error("Unsafe spawn artifact");
    const buffer = Buffer.from(content);
    let offset = 0;
    while (offset < buffer.length) {
      offset += fs.writeSync(descriptor, buffer, offset, buffer.length - offset);
    }
    fs.fsyncSync(descriptor);
  } finally { fs.closeSync(descriptor); }
}

function isSpawnedChild(): boolean { return Boolean(process.env[NOTIFY_ENV] || process.env[REPORT_ENV]); }

async function spawnLiveAgent(
  pi: ExtensionAPI,
  cwd: string,
  prompt: string | undefined,
  model: string | undefined,
  createArtifact: (suffix: string) => string,
): Promise<SpawnResult> {
  if (isSpawnedChild()) throw new Error("This session is a spawned agent. Delegation is one level deep; do the work yourself or ask the user if blocked.");
  if (!process.env.TMUX) return spawnInGhostty(pi, cwd, prompt, model);
  const notifyFile = createArtifact("notify");
  const reportFile = createArtifact("report");
  const command = `tmux set-option -p remain-on-exit on; ${NOTIFY_ENV}=${shellQuoteSingle(notifyFile)} ${REPORT_ENV}=${shellQuoteSingle(reportFile)} ${buildPiLaunch(prompt, model)}`;
  const result = await pi.exec("tmux", ["split-window", "-h", "-c", cwd, "-P", "-F", "#{pane_id}", command], { timeout: 10_000 });
  if (result.code !== 0) throw new Error(`tmux split-window failed: ${result.stderr || result.stdout}`);
  const pane = result.stdout.trim();
  if (!PANE_ID_RE.test(pane)) throw new Error(`tmux returned an invalid pane id: "${pane}"`);
  return {
    message: `Spawned live pi session in tmux pane ${pane}. Use agent_report for completed-turn output and agent_pane only for live steering or inspection. The parent wakes automatically after each reported turn.`,
    pane, mode: "tmux", notifyFile, reportFile,
  };
}

async function spawnInGhostty(pi: ExtensionAPI, cwd: string, prompt?: string, model?: string): Promise<SpawnResult> {
  const args = ["-na", "Ghostty", "--args", `--working-directory=${cwd}`, "-e", "pi", "--model", model ?? DEFAULT_SPAWN_MODEL, "--thinking", DEFAULT_SPAWN_THINKING];
  if (prompt) args.push(prompt);
  const result = await pi.exec("open", args, { timeout: 10_000 });
  if (result.code !== 0) throw new Error(`Failed to open Ghostty: ${result.stderr || result.stdout}`);
  return { message: "Spawned a live pi session in Ghostty. Ghostty fallback is fully user-driven and cannot send structured reports, completion notifications, terminal output, or steering back to this parent.", mode: "ghostty" };
}

function buildPiLaunch(prompt?: string, model?: string): string {
  const parts = ["pi", "--model", shellQuoteSingle(model ?? DEFAULT_SPAWN_MODEL), "--thinking", DEFAULT_SPAWN_THINKING];
  if (prompt) parts.push(shellQuoteSingle(prompt));
  return parts.join(" ");
}

function shellQuoteSingle(value: string): string { return `'${value.replace(/'/g, `'\\''`)}'`; }
