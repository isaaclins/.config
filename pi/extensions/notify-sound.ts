import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

/**
 * Native macOS notification when the agent finishes a prompt:
 * Claude icon, Glass sound, and a one-line TLDR of the reply.
 *
 * The icon comes from the app that posts the notification, so posting goes
 * through a tiny AppleScript applet bundle carrying claude.png as its icon
 * (~/.config/pi/assets/Pi Notifier.app). `open` cannot pass argv to an
 * applet, so the payload is handed over in a file the applet reads.
 *
 * terminal-notifier (the previous mechanism) is dead on macOS 26+: it exits
 * 0 and posts nothing. If the applet ever fails the same way, we fall back
 * to plain osascript, which loses the icon but keeps the notification, and
 * a failure of both is reported instead of swallowed.
 */

const APPLET = join(homedir(), ".config/pi/assets/Pi Notifier.app");
const PAYLOAD = join(homedir(), ".cache/pi-notify.txt");
const SOUND = "Glass";

export default function (pi: ExtensionAPI) {
  let promptStartedAt = 0;

  pi.on("agent_start", async () => {
    promptStartedAt = Date.now();
  });

  pi.on("agent_end", async (event, ctx) => {
    const title = `pi · ${basename(process.cwd())}`;
    const subtitle = `Finished in ${formatDuration(Date.now() - promptStartedAt)}`;
    const message = cleanForToast(extractLastAssistantText(event.messages)) || "Done.";

    notify(title, subtitle, message, (error) => {
      ctx?.ui?.notify(`Desktop notification failed: ${error}`, "warning");
    });
  });
}

/** Post via the iconned applet, falling back to osascript, then reporting. */
function notify(
  title: string,
  subtitle: string,
  message: string,
  onFailure: (error: string) => void,
): void {
  if (existsSync(APPLET)) {
    try {
      mkdirSync(dirname(PAYLOAD), { recursive: true });
      writeFileSync(PAYLOAD, `${oneLine(title)}\n${oneLine(subtitle)}\n${oneLine(message)}\n`);
      execFile("open", ["-a", APPLET], (error) => {
        if (error) fallback(title, subtitle, message, onFailure);
      });
      return;
    } catch (error) {
      // Fall through to osascript rather than losing the notification.
      void error;
    }
  }
  fallback(title, subtitle, message, onFailure);
}

function fallback(
  title: string,
  subtitle: string,
  message: string,
  onFailure: (error: string) => void,
): void {
  const script =
    `display notification ${quote(message)} with title ${quote(title)}` +
    ` subtitle ${quote(subtitle)} sound name ${quote(SOUND)}`;
  execFile("osascript", ["-e", script], (error) => {
    if (error) onFailure(error.message);
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
