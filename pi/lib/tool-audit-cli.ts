#!/usr/bin/env -S node --experimental-strip-types
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  aggregate,
  auditDir,
  formatAgent,
  formatCall,
  formatCalls,
  formatErrors,
  formatSummary,
  readAllRecords,
} from "./tool-audit.ts";

/**
 * Standalone, dependency-free audit reporter, usable outside the TUI:
 *
 *   node --experimental-strip-types ~/.config/pi/lib/tool-audit-cli.ts
 *   node --experimental-strip-types ~/.config/pi/lib/tool-audit-cli.ts errors
 *   node --experimental-strip-types ~/.config/pi/lib/tool-audit-cli.ts calls
 *   node --experimental-strip-types ~/.config/pi/lib/tool-audit-cli.ts last 10
 *   node --experimental-strip-types ~/.config/pi/lib/tool-audit-cli.ts show <call-id>
 *   node --experimental-strip-types ~/.config/pi/lib/tool-audit-cli.ts <agent-id>
 *
 * Reads the same JSONL files the extension writes.
 */

export function runCli(argv: string[], dir: string = auditDir()): string {
  const first = (argv[0] ?? "").trim();
  const cmd = first.toLowerCase();
  const records = readAllRecords(dir);

  if (!first) return formatSummary(aggregate(records));
  if (cmd === "errors") return formatErrors(records);
  if (cmd === "calls") return formatCalls(records);
  if (cmd === "last") {
    const n = Number.parseInt(argv[1] ?? "", 10);
    return formatCalls(records, Number.isFinite(n) && n > 0 ? n : 30);
  }
  if (cmd === "show") {
    const id = (argv[1] ?? "").trim();
    if (!id) return "tool-audit: usage: tool-audit-cli show <call-id>";
    return formatCall(records, id);
  }
  if (cmd === "--help" || cmd === "-h") {
    return [
      "Usage: tool-audit-cli [errors | calls | last <n> | show <call-id> | <agent-id>]",
      "  (no args)      summary of counts per directory and per agent, plus top tools",
      "  errors         recent failures with args and response previews",
      "  calls          one line per call, newest first (default 30)",
      "  last <n>       the n most recent calls, one line each",
      "  show <call-id> full detail for one call: complete args and result",
      "  <agent-id>     that agent's calls in detail",
    ].join("\n");
  }
  return formatAgent(records, first);
}

function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  process.stdout.write(`${runCli(process.argv.slice(2))}\n`);
}
