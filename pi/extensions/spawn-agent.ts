import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { NotifyEventCursor, OwnedPaneRegistry } from "../lib/spawn-agent-state.ts";

/**
 * Shared-control live pi sessions.
 *
 * Goal: let a spawned pi session be a REAL, human-visible terminal session
 * that both the user and the orchestrating agent can watch and type into,
 * instead of a hidden background subagent. This is for cases where the
 * user explicitly wants to co-drive a second agent (correcting it live,
 * answering its prompts, watching it work) rather than delegating blindly.
 *
 * Two environments:
 *
 * - Inside tmux (process.env.TMUX set): spawns a real tmux pane running
 *   `pi` (optionally pre-seeded with an initial prompt as its argv). The
 *   pane id (e.g. "%3") is returned/reported, and can be used afterwards
 *   with agent_pane to send keystrokes into that same pane (as if typing
 *   in it) or to read back what is currently on screen. Because it's a
 *   real pane, the user can also click into it and type directly; both
 *   sides are interacting with the exact same terminal buffer, so nothing
 *   is hidden and either side can correct the other in real time.
 *
 * - Outside tmux: there is no scriptable "pane" to send keys into or read
 *   from afterwards, so we fall back to opening a new Ghostty window
 *   running pi in the target directory. The user can watch/drive it, but
 *   the orchestrating agent cannot steer or inspect it afterwards; the
 *   command and tool both say so explicitly.
 *
 * Commands:
 * - /spawn <optional initial prompt>: spawn a live pi session as above.
 *
 * Tools:
 * - spawn_agent { prompt? }: same behavior, callable by the LLM.
 * - agent_pane { action: "send" | "read", pane, text? }: steer or inspect a
 *   previously spawned tmux pane. tmux-only; throws a clear error otherwise.
 *
 * Done-notification (tmux only):
 * The spawned child runs with PI_SPAWN_NOTIFY_FILE set to a unique temp
 * file. This same extension, when loaded in the child session, sees that
 * env var and appends a JSON line to the file on every agent_end (i.e.
 * whenever the child agent loop finishes and the session goes idle). The
 * parent session polls the file (fs.watchFile) and, on each new line,
 * injects a custom message with triggerTurn: true, waking the orchestrator
 * so it can read the pane and verify the result. The parent shows a compact
 * animated cat until every newly spawned pane reports its first idle turn.
 * Note "done" means "went idle after a turn": co-driving the child pane by hand fires one wake-up
 * per completed turn, not one single task-complete signal. Ghostty mode
 * has no notification (no env control over `open`, and no pane to read).
 */

const PANE_ID_RE = /^%\d+$/;

const NOTIFY_DIR = path.join(os.tmpdir(), "pi-spawn-agent-notify");
const NOTIFY_POLL_MS = 1000;
const PANE_HEALTHCHECK_MS = 5000;
const CAT_FRAME_MS = 600;
const WAITING_CAT_WIDGET = "spawn-agent-waiting-cat";

interface ParentWatcher {
  pane: string;
  waitingForFirstTurn: boolean;
  healthcheckTimer?: ReturnType<typeof setInterval>;
}

/** Active parent-side watchers, keyed by notify file path, for cleanup. */
const activeWatchers = new Map<string, ParentWatcher>();

export default function (pi: ExtensionAPI) {
  registerChildDoneReporter(pi);

  let catTimer: ReturnType<typeof setInterval> | undefined;
  let parentContext: ExtensionContext | undefined;
  let catFrame = 0;
  const ownedPanes = new OwnedPaneRegistry();

  const renderWaitingCat = () => {
    const ctx = parentContext;
    if (!ctx || ctx.mode !== "tui") return;
    const panes = [...activeWatchers.values()].filter((watcher) => watcher.waitingForFirstTurn).map((watcher) => watcher.pane);
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
    if ([...activeWatchers.values()].some((watcher) => watcher.waitingForFirstTurn)) return;
    if (catTimer) clearInterval(catTimer);
    catTimer = undefined;
    renderWaitingCat();
  };

  const removeOwnedPane = (pane: string) => {
    for (const [notifyFile, watcher] of activeWatchers) {
      if (watcher.pane !== pane) continue;
      if (watcher.healthcheckTimer) clearInterval(watcher.healthcheckTimer);
      fs.unwatchFile(notifyFile);
      fs.rmSync(notifyFile, { force: true });
      activeWatchers.delete(notifyFile);
    }
    ownedPanes.delete(pane);
    stopWaitingCatIfIdle();
  };

  pi.on("session_shutdown", async () => {
    if (catTimer) clearInterval(catTimer);
    catTimer = undefined;
    for (const [file, watcher] of activeWatchers) {
      if (watcher.healthcheckTimer) clearInterval(watcher.healthcheckTimer);
      fs.unwatchFile(file);
      fs.rmSync(file, { force: true });
    }
    activeWatchers.clear();
    ownedPanes.clear();
    parentContext = undefined;
  });

  pi.registerCommand("spawn", {
    description: "Spawn a live, human-visible pi session (tmux split or new Ghostty window)",
    handler: async (args, ctx) => {
      const prompt = args?.trim() || undefined;
      try {
        const result = await spawnLiveAgent(pi, ctx.cwd, prompt);
        if (result.pane && result.notifyFile) {
          ownedPanes.add(result.pane);
          watchForChildDone(pi, result.notifyFile, result.pane, ownedPanes, renderWaitingCat, stopWaitingCatIfIdle);
          startWaitingCat(ctx);
        }
        ctx.ui.notify(result.message, "info");
      } catch (err) {
        ctx.ui.notify(`Failed to spawn agent: ${(err as Error).message}`, "error");
      }
    },
  });

  pi.registerTool({
    name: "spawn_agent",
    label: "Spawn Agent",
    description:
      "Spawn a NEW live, human-visible pi session in a terminal the user can see and type into directly (a tmux split when running inside tmux, otherwise a new Ghostty window). In tmux, the parent shows a compact animated cat with pane IDs until every newly spawned pane reports its first idle turn, then wakes automatically on every completed child turn. Outside tmux there is no steering or done-notification. Delegation is strictly one level deep: spawned agents cannot spawn or steer further agents. Never delegate interactive privileged input such as sudo passwords.",
    parameters: Type.Object({
      prompt: Type.Optional(
        Type.String({ description: "Optional initial prompt to launch the new pi session with" }),
      ),
      model: Type.Optional(
        Type.String({
          description:
            "Model for the spawned session. Defaults to the cheap anthropic/claude-haiku-4-5. Only pass a stronger model when the task truly needs it.",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await spawnLiveAgent(pi, process.cwd(), params.prompt, params.model);
      if (result.pane && result.notifyFile) {
        ownedPanes.add(result.pane);
        watchForChildDone(pi, result.notifyFile, result.pane, ownedPanes, renderWaitingCat, stopWaitingCatIfIdle);
        startWaitingCat(ctx);
      }
      return {
        content: [{ type: "text", text: result.message }],
        details: { pane: result.pane ?? null, mode: result.mode },
      };
    },
  });

  pi.registerTool({
    name: "agent_pane",
    label: "Agent Pane",
    description:
      "Send input to or read the screen contents of a tmux pane previously created by spawn_agent, so the orchestrating agent can steer or check on a live pi session the user is also watching. Only works when the current session is itself running inside tmux (spawn_agent must have returned a tmux pane id, not a Ghostty window). action 'send' types the given text into the pane and presses Enter, exactly as if the user had typed it. action 'read' returns the last lines currently visible in that pane.",
    parameters: Type.Object({
      action: StringEnum(["send", "read"] as const),
      pane: Type.String({ description: "tmux pane id returned by spawn_agent, e.g. '%3'" }),
      text: Type.Optional(Type.String({ description: "Text to send. Required for action 'send'." })),
    }),
    async execute(_toolCallId, params) {
      if (isSpawnedChild()) {
        throw new Error(
          "This session is itself a spawned agent and must not steer other panes. Do your own task; " +
            "if blocked, stop and ask the user directly.",
        );
      }
      if (!process.env.TMUX) {
        throw new Error(
          "agent_pane only works inside tmux. This session is not running in tmux, so there is no pane to steer.",
        );
      }
      if (!PANE_ID_RE.test(params.pane)) {
        throw new Error(`Invalid tmux pane id "${params.pane}". Expected a format like "%3".`);
      }
      if (!ownedPanes.has(params.pane)) {
        throw new Error("agent_pane can only control panes spawned by this parent session. Arbitrary tmux panes cannot be controlled.");
      }

      if (params.action === "read") {
        const result = await pi.exec("tmux", ["capture-pane", "-t", params.pane, "-p", "-S", "-100"], {
          timeout: 10_000,
        });
        if (result.code !== 0) {
          removeOwnedPane(params.pane);
          throw new Error(`tmux capture-pane failed: ${result.stderr || result.stdout}`);
        }
        return {
          content: [{ type: "text", text: result.stdout || "(pane is empty)" }],
          details: { pane: params.pane },
        };
      }

      // action === "send"
      if (!params.text) {
        throw new Error("action 'send' requires 'text'.");
      }
      const sendText = await pi.exec("tmux", ["send-keys", "-t", params.pane, "-l", params.text], {
        timeout: 10_000,
      });
      if (sendText.code !== 0) {
        removeOwnedPane(params.pane);
        throw new Error(`tmux send-keys failed: ${sendText.stderr || sendText.stdout}`);
      }
      const sendEnter = await pi.exec("tmux", ["send-keys", "-t", params.pane, "Enter"], {
        timeout: 10_000,
      });
      if (sendEnter.code !== 0) {
        removeOwnedPane(params.pane);
        throw new Error(`tmux send-keys (Enter) failed: ${sendEnter.stderr || sendEnter.stdout}`);
      }
      return {
        content: [{ type: "text", text: `Sent to pane ${params.pane}: ${params.text}` }],
        details: { pane: params.pane },
      };
    },
  });
}

interface SpawnResult {
  message: string;
  pane?: string;
  mode: "tmux" | "ghostty";
  notifyFile?: string;
}

/**
 * Child side: if this session was spawned with PI_SPAWN_NOTIFY_FILE, report
 * every agent_end (session went idle) by appending a JSON line to that file.
 */
function registerChildDoneReporter(pi: ExtensionAPI) {
  const notifyFile = process.env.PI_SPAWN_NOTIFY_FILE;
  if (!notifyFile) return;

  pi.on("agent_end", async () => {
    try {
      fs.mkdirSync(path.dirname(notifyFile), { recursive: true });
      fs.appendFileSync(notifyFile, JSON.stringify({ event: "agent_end", ts: Date.now() }) + "\n");
    } catch {
      // Never let notification plumbing break the child session.
    }
  });
}

/**
 * Parent side: poll the child's notify file and wake this session with a
 * turn-triggering message whenever the child reports a finished turn.
 */
function watchForChildDone(
  pi: ExtensionAPI,
  notifyFile: string,
  pane: string,
  ownedPanes: OwnedPaneRegistry,
  renderWaitingCat: () => void,
  stopWaitingCatIfIdle: () => void,
) {
  const cursor = new NotifyEventCursor();
  let processing = Promise.resolve();
  activeWatchers.set(notifyFile, { pane, waitingForFirstTurn: true });

  const removeWatcher = () => {
    const watcher = activeWatchers.get(notifyFile);
    if (watcher?.healthcheckTimer) clearInterval(watcher.healthcheckTimer);
    fs.unwatchFile(notifyFile);
    fs.rmSync(notifyFile, { force: true });
    activeWatchers.delete(notifyFile);
    ownedPanes.delete(pane);
    stopWaitingCatIfIdle();
  };

  const processEvents = () => {
    processing = processing.then(async () => {
      let content: string;
      try {
        content = fs.readFileSync(notifyFile, "utf8");
      } catch {
        return;
      }
      const events = cursor.ingest(content);
      if (events.length === 0) return;
      const paneStatus = await pi.exec("tmux", ["display-message", "-p", "-t", pane, "#{pane_id}"], { timeout: 5_000 });
      if (paneStatus.code !== 0 || paneStatus.stdout.trim() !== pane) {
        removeWatcher();
        return;
      }
      for (const event of events) {
        try {
          if (JSON.parse(event).event !== "agent_end") continue;
        } catch {
          continue;
        }
        const watcher = activeWatchers.get(notifyFile);
        if (watcher?.waitingForFirstTurn) {
          watcher.waitingForFirstTurn = false;
          renderWaitingCat();
          stopWaitingCatIfIdle();
        }
        pi.sendMessage({
          customType: "spawn-agent-done",
          content: `The spawned agent in tmux pane ${pane} finished a turn and went idle. Use agent_pane { action: "read", pane: "${pane}" } to review its output and verify the result.`,
          display: true,
          details: { pane, notifyFile },
        }, { triggerTurn: true, deliverAs: "followUp" });
      }
    }).catch(() => { /* notification plumbing must never break Pi */ });
  };

  const healthcheckTimer = setInterval(() => {
    processing = processing.then(async () => {
      const paneStatus = await pi.exec("tmux", ["display-message", "-p", "-t", pane, "#{pane_id}"], { timeout: 5_000 });
      if (paneStatus.code !== 0 || paneStatus.stdout.trim() !== pane) removeWatcher();
    }).catch(() => { /* notification plumbing must never break Pi */ });
  }, PANE_HEALTHCHECK_MS);
  healthcheckTimer.unref();
  const watcher = activeWatchers.get(notifyFile);
  if (watcher) watcher.healthcheckTimer = healthcheckTimer;
  fs.watchFile(notifyFile, { interval: NOTIFY_POLL_MS }, processEvents);
  processEvents();
}

/** True when this session was itself spawned by spawn_agent (child marker). */
function isSpawnedChild(): boolean {
  return Boolean(process.env.PI_SPAWN_NOTIFY_FILE);
}

async function spawnLiveAgent(
  pi: ExtensionAPI,
  cwd: string,
  prompt: string | undefined,
  model?: string,
): Promise<SpawnResult> {
  if (isSpawnedChild()) {
    throw new Error(
      "This session is itself a spawned agent. Spawned agents must not spawn or steer further agents " +
        "(delegation is one level deep by design). Do the work yourself; if you are blocked on something " +
        "you cannot do (e.g. an interactive sudo password prompt), stop and ask the user directly instead.",
    );
  }
  if (process.env.TMUX) {
    return spawnInTmux(pi, cwd, prompt, model);
  }
  return spawnInGhostty(pi, cwd, prompt, model);
}

// Cost guardrail: spawned helper sessions default to the cheapest capable
// model at low thinking. Big default models burn subscription quota fast.
const DEFAULT_SPAWN_MODEL = "anthropic/claude-haiku-4-5";
const DEFAULT_SPAWN_THINKING = "low";

function buildPiLaunch(prompt: string | undefined, model?: string): string {
  const parts = [
    "pi",
    "--model",
    shellQuoteSingle(model ?? DEFAULT_SPAWN_MODEL),
    "--thinking",
    DEFAULT_SPAWN_THINKING,
  ];
  if (prompt) parts.push(shellQuoteSingle(prompt));
  return parts.join(" ");
}

async function spawnInTmux(
  pi: ExtensionAPI,
  cwd: string,
  prompt: string | undefined,
  model?: string,
): Promise<SpawnResult> {
  // Build the command to run inside the new pane. Launching `pi` directly
  // with the prompt as its argv (rather than launching `pi` then sending
  // the prompt via a follow-up send-keys) avoids a race against pi's own
  // startup time, which is unreliable to pad with a fixed delay.
  // PI_SPAWN_NOTIFY_FILE makes the child report agent_end back to us.
  const notifyFile = path.join(NOTIFY_DIR, `${randomBytes(8).toString("hex")}.jsonl`);
  fs.mkdirSync(NOTIFY_DIR, { recursive: true });
  // Keep a failed child pane visible so startup errors can be inspected instead
  // of disappearing before the user or parent can read them.
  const paneCommand =
    `tmux set-option -p remain-on-exit on; ` +
    `PI_SPAWN_NOTIFY_FILE=${shellQuoteSingle(notifyFile)} ${buildPiLaunch(prompt, model)}`;

  const result = await pi.exec(
    "tmux",
    ["split-window", "-h", "-c", cwd, "-P", "-F", "#{pane_id}", paneCommand],
    { timeout: 10_000 },
  );

  if (result.code !== 0) {
    throw new Error(`tmux split-window failed: ${result.stderr || result.stdout}`);
  }

  const pane = result.stdout.trim();
  if (!PANE_ID_RE.test(pane)) {
    throw new Error(`tmux did not return a recognizable pane id (got "${pane}")`);
  }

  return {
    message:
      `Spawned live pi session in tmux pane ${pane}. Steer it with agent_pane { pane: "${pane}" }. ` +
      `This session will be woken automatically when the spawned agent finishes a turn and goes idle; no need to poll.`,
    pane,
    mode: "tmux",
    notifyFile,
  };
}

async function spawnInGhostty(
  pi: ExtensionAPI,
  cwd: string,
  prompt: string | undefined,
  model?: string,
): Promise<SpawnResult> {
  const args = [
    "-na", "Ghostty", "--args", `--working-directory=${cwd}`,
    "-e", "pi", "--model", model ?? DEFAULT_SPAWN_MODEL, "--thinking", DEFAULT_SPAWN_THINKING,
  ];
  if (prompt) args.push(prompt);

  const result = await pi.exec("open", args, { timeout: 10_000 });
  if (result.code !== 0) {
    throw new Error(`Failed to open Ghostty: ${result.stderr || result.stdout}`);
  }

  return {
    message:
      "Spawned a live pi session in a new Ghostty window. This session is not running in tmux, " +
      "so the new window cannot be steered or read back afterwards; it is fully user-driven.",
    mode: "ghostty",
  };
}

/** Single-quote-escape a string for safe embedding in a shell command string. */
function shellQuoteSingle(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
