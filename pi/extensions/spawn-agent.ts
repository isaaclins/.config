import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";

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
 * so it can read the pane and verify the result. Note "done" means "went
 * idle after a turn": co-driving the child pane by hand fires one wake-up
 * per completed turn, not one single task-complete signal. Ghostty mode
 * has no notification (no env control over `open`, and no pane to read).
 */

const PANE_ID_RE = /^%\d+$/;

const NOTIFY_DIR = path.join(os.tmpdir(), "pi-spawn-agent-notify");
const NOTIFY_POLL_MS = 1000;

/** Active parent-side watchers, keyed by notify file path, for cleanup. */
const activeWatchers = new Map<string, { pane: string }>();

export default function (pi: ExtensionAPI) {
  registerChildDoneReporter(pi);

  pi.on("session_shutdown", async () => {
    for (const file of activeWatchers.keys()) {
      fs.unwatchFile(file);
      fs.rmSync(file, { force: true });
    }
    activeWatchers.clear();
  });

  pi.registerCommand("spawn", {
    description: "Spawn a live, human-visible pi session (tmux split or new Ghostty window)",
    handler: async (args, ctx) => {
      const prompt = args?.trim() || undefined;
      try {
        const result = await spawnLiveAgent(pi, ctx.cwd, prompt);
        if (result.pane && result.notifyFile) {
          watchForChildDone(pi, result.notifyFile, result.pane);
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
      "Spawn a NEW live, human-visible pi session in a terminal the user can see and type into directly (a tmux split when running inside tmux, otherwise a new Ghostty window). This is not a hidden background subagent: the user is watching and can interact with it too. In tmux, the returned pane id can be passed to agent_pane afterwards to send it more input or read its current screen output, and this session is automatically woken with a notification message each time the spawned agent finishes a turn and goes idle, so there is no need to poll: wait for the wake-up, then read the pane to verify the result. Outside tmux (Ghostty window) there is no steering and no done-notification; the window is fully user-driven.",
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
    async execute(_toolCallId, params) {
      const result = await spawnLiveAgent(pi, process.cwd(), params.prompt, params.model);
      if (result.pane && result.notifyFile) {
        watchForChildDone(pi, result.notifyFile, result.pane);
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
      if (!process.env.TMUX) {
        throw new Error(
          "agent_pane only works inside tmux. This session is not running in tmux, so there is no pane to steer.",
        );
      }
      if (!PANE_ID_RE.test(params.pane)) {
        throw new Error(`Invalid tmux pane id "${params.pane}". Expected a format like "%3".`);
      }

      if (params.action === "read") {
        const result = await pi.exec("tmux", ["capture-pane", "-t", params.pane, "-p", "-S", "-100"], {
          timeout: 10_000,
        });
        if (result.code !== 0) {
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
        throw new Error(`tmux send-keys failed: ${sendText.stderr || sendText.stdout}`);
      }
      const sendEnter = await pi.exec("tmux", ["send-keys", "-t", params.pane, "Enter"], {
        timeout: 10_000,
      });
      if (sendEnter.code !== 0) {
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
function watchForChildDone(pi: ExtensionAPI, notifyFile: string, pane: string) {
  let processedSize = 0;
  activeWatchers.set(notifyFile, { pane });

  fs.watchFile(notifyFile, { interval: NOTIFY_POLL_MS }, (curr) => {
    if (curr.size <= processedSize) return;
    processedSize = curr.size;
    pi.sendMessage(
      {
        customType: "spawn-agent-done",
        content:
          `The spawned agent in tmux pane ${pane} finished a turn and went idle. ` +
          `Use agent_pane { action: "read", pane: "${pane}" } to review its output and verify the result.`,
        display: true,
        details: { pane, notifyFile },
      },
      { triggerTurn: true, deliverAs: "followUp" },
    );
  });
}

async function spawnLiveAgent(
  pi: ExtensionAPI,
  cwd: string,
  prompt: string | undefined,
  model?: string,
): Promise<SpawnResult> {
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
  const paneCommand = `PI_SPAWN_NOTIFY_FILE=${shellQuoteSingle(notifyFile)} ${buildPiLaunch(prompt, model)}`;

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
