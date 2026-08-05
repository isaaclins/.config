import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { writeFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  createNotificationQueue,
  type NotificationPayload,
} from "../lib/notify-queue.ts";

/**
 * Native macOS notification when the agent finishes a prompt:
 * Claude icon, Glass sound, and a one-line TLDR of the reply.
 *
 * The icon comes from the app that posts the notification, so posting goes
 * through a tiny AppleScript applet bundle carrying the Claude mark as its
 * icon (~/.config/pi/assets/Pi Notifier.app, generated from
 * assets/claude-icon.svg). `open` cannot pass argv to an applet, so the
 * payload is handed over in a file the applet reads.
 *
 * Posts are serialized and launched with `open -n -W`: an applet is a
 * single-instance app sharing one payload file, so an overlapping launch
 * reopens the running instance, which then shows a blocking "Press Run to run
 * this script" dialog instead of a notification. A new instance per post plus
 * waiting for it to exit keeps launches and payload writes from overlapping,
 * which matters on interrupts, where two turns end back to back.
 *
 * terminal-notifier (the previous mechanism) is dead on macOS 26+: it exits
 * 0 and posts nothing. If the applet ever fails the same way, we fall back
 * to plain osascript, which loses the icon but keeps the notification, and
 * a failure of both is reported instead of swallowed.
 */

const APPLET = join(homedir(), ".config/pi/assets/Pi Notifier.app");
const PAYLOAD = join(homedir(), ".cache/pi-notify.txt");
const SOUND = "Glass";
/** Upper bound on one post, so a stuck launch cannot wedge the queue. */
const POST_TIMEOUT_MS = 15_000;

export default function (pi: ExtensionAPI) {
  let promptStartedAt = 0;
  let reportFailure: (error: string) => void = () => {};

  const queue = createNotificationQueue({
    post: postNotification,
    onError: (error) => reportFailure(error),
  });

  pi.on("agent_start", async () => {
    promptStartedAt = Date.now();
  });

  pi.on("agent_end", async (event, ctx) => {
    reportFailure = (error) => {
      ctx?.ui?.notify(`Desktop notification failed: ${error}`, "warning");
    };
    queue.enqueue({
      title: `pi · ${basename(process.cwd())}`,
      subtitle: `Finished in ${formatDuration(Date.now() - promptStartedAt)}`,
      message: cleanForToast(extractLastAssistantText(event.messages)) || "Done.",
    });
  });
}

/** Post via the iconned applet, falling back to osascript. Throws if both fail. */
async function postNotification(payload: NotificationPayload): Promise<void> {
  if (existsSync(APPLET)) {
    try {
      writePayload(payload);
      await run("open", ["-n", "-W", "-a", APPLET]);
      return;
    } catch (error) {
      // Fall through to osascript rather than losing the notification.
      void error;
    }
  }
  const { title, subtitle, message } = payload;
  await run("osascript", [
    "-e",
    `display notification ${quote(message)} with title ${quote(title)}` +
      ` subtitle ${quote(subtitle)} sound name ${quote(SOUND)}`,
  ]);
}

/** Written whole then renamed, so the applet never reads a half-written payload. */
function writePayload({ title, subtitle, message }: NotificationPayload): void {
  mkdirSync(dirname(PAYLOAD), { recursive: true });
  const staging = `${PAYLOAD}.staging`;
  writeFileSync(staging, `${oneLine(title)}\n${oneLine(subtitle)}\n${oneLine(message)}\n`);
  renameSync(staging, PAYLOAD);
}

/** A timeout means the notification is slow, not lost, so it resolves quietly. */
function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: POST_TIMEOUT_MS }, (error) => {
      if (!error || (error as { killed?: boolean }).killed) resolve();
      else reject(error);
    });
  });
}

function quote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** The applet payload is line-delimited, so fields must stay single-line. */
function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function extractLastAssistantText(messages: unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as {
      role?: string;
      content?: Array<{ type?: string; text?: string }> | string;
    };
    if (message?.role !== "assistant") continue;
    if (typeof message.content === "string") return message.content;
    const textBlock = message.content?.filter((b) => b.type === "text").pop();
    if (textBlock?.text) return textBlock.text;
  }
  return "";
}

/** Strip markdown down to readable plain sentences, sized for a toast. */
function cleanForToast(markdown: string): string {
  const plain = markdown
    .replace(/```[\s\S]*?```/g, " ")        // code blocks
    .replace(/^#+\s*/gm, "")                 // headings
    .replace(/^\s*[-*+]\s+/gm, "")           // bullets
    .replace(/^\s*\d+\.\s+/gm, "")           // numbered lists
    .replace(/^\s*\|.*\|\s*$/gm, " ")        // tables
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // links -> text
    .replace(/[*_`>#]+/g, "")                // emphasis, quotes, stray md
    .replace(/\s+/g, " ")
    .trim();

  // First sentences up to ~200 chars, cut at a sentence boundary when possible.
  if (plain.length <= 200) return plain;
  const cut = plain.slice(0, 200);
  const lastStop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  return lastStop > 80 ? cut.slice(0, lastStop + 1) : cut.trimEnd() + "…";
}

function formatDuration(ms: number): string {
  if (ms < 1000 || ms > 6 * 3600_000) return "a moment";
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${seconds}s`;
}
