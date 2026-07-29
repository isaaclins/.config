#!/usr/bin/env -S node --experimental-strip-types
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  aggregate,
  auditDir,
  formatAgent,
  formatErrors,
  formatSummary,
  readAllRecords,
} from "./tool-audit.ts";

/**
 * Standalone, dependency-free audit reporter, usable outside the TUI:
 *
 *   node --experimental-strip-types ~/.config/pi/lib/tool-audit-cli.ts
 *   node --experimental-strip-types ~/.config/pi/lib/tool-audit-cli.ts errors
 *   node --experimental-strip-types ~/.config/pi/lib/tool-audit-cli.ts <agent-id>
 *
 * Reads the same JSONL files the extension writes.
 */

export function runCli(argv: string[], dir: string = auditDir()): string {
  const query = (argv[0] ?? "").trim();
  const records = readAllRecords(dir);

  if (!query) return formatSummary(aggregate(records));
  if (query === "errors") return formatErrors(records);
  if (query === "--help" || query === "-h") {
    return [
      "Usage: tool-audit-cli [errors | <agent-id>]",
      "  (no args)   summary of counts per directory and per agent, plus top tools",
      "  errors      recent failures with args and response previews",
      "  <agent-id>  that agent's calls in detail",
    ].join("\n");
  }
  return formatAgent(records, query);
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
