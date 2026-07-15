import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { basename } from "node:path";
import { join } from "node:path";

/**
 * Native macOS notification when the agent finishes a prompt.
 * Uses a user-owned copy of terminal-notifier re-branded with the Claude
 * icon (~/.pi/agent/assets/Claude Notifier.app), because osascript can
 * neither set icons nor render clean text.
 */

const NOTIFIER = join(
  homedir(),
  ".pi/agent/assets/Claude Notifier.app/Contents/MacOS/terminal-notifier",
);

export default function (pi: ExtensionAPI) {
  let promptStartedAt = 0;

  pi.on("agent_start", async () => {
    promptStartedAt = Date.now();
  });

  pi.on("agent_end", async (event) => {
    const project = basename(process.cwd());
    const duration = formatDuration(Date.now() - promptStartedAt);
    const summary = cleanForToast(extractLastAssistantText(event.messages));

    execFile(NOTIFIER, [
      "-title", `pi · ${project}`,
      "-subtitle", `Finished in ${duration}`,
      "-message", summary || "Done.",
      "-sound", "Glass",
    ]);
  });
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
