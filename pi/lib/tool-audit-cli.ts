#!/usr/bin/env -S node --experimental-strip-types
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  aggregate,
  auditDir,
  buildNoteRecord,
  formatAgent,
  formatCall,
  formatCalls,
  formatErrors,
  formatNotes,
  formatSummary,
  isPapercutOwner,
  pruneAuditDir,
  readAllRecords,
  writeRecord,
  type PapercutOwner,
} from "./tool-audit.ts";

/**
 * Standalone, dependency-free audit reporter, usable outside the TUI:
 *
 *   node --experimental-strip-types ~/.config/pi/lib/tool-audit-cli.ts
 *   node --experimental-strip-types ~/.config/pi/lib/tool-audit-cli.ts errors
 *   node --experimental-strip-types ~/.config/pi/lib/tool-audit-cli.ts calls
 *   node --experimental-strip-types ~/.config/pi/lib/tool-audit-cli.ts last 10
 *   node --experimental-strip-types ~/.config/pi/lib/tool-audit-cli.ts show <call-id>
 *   node --experimental-strip-types ~/.config/pi/lib/tool-audit-cli.ts notes
 *   node --experimental-strip-types ~/.config/pi/lib/tool-audit-cli.ts note --tried ... --got ...
 *   node --experimental-strip-types ~/.config/pi/lib/tool-audit-cli.ts prune [days]
 *   node --experimental-strip-types ~/.config/pi/lib/tool-audit-cli.ts <agent-id>
 *
 * Reads and writes the same JSONL files the extension uses, so an agent that
 * is not running inside Pi can still file a papercut.
 */

/** Parse `--flag value` pairs; repeated flags collect into a list. */
function parseFlags(argv: string[]): Map<string, string[]> {
  const flags = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) continue;
    flags.set(key, [...(flags.get(key) ?? []), value]);
    i += 1;
  }
  return flags;
}

function runNote(argv: string[], dir: string): string {
  const flags = parseFlags(argv);
  const one = (key: string): string | undefined => flags.get(key)?.[0];
  const tried = one("tried");
  const got = one("got");
  if (!tried || !got) {
    return "tool-audit: note requires --tried and --got (see --help)";
  }
  const ownerFlag = one("owner");
  if (ownerFlag !== undefined && !isPapercutOwner(ownerFlag)) {
    return "tool-audit: --owner must be config, pi, model, or env";
  }
  const record = buildNoteRecord({
    sessionId: one("session") || `cli-${process.pid}`,
    cwd: one("cwd") || process.cwd(),
    fields: {
      tried,
      got,
      workaround: one("workaround"),
      expected: one("expected"),
      repro: one("repro"),
    },
    owner: ownerFlag as PapercutOwner | undefined,
    refCallId: one("ref"),
    suspects: flags.get("suspect") ?? [],
  });
  writeRecord(dir, record);
  return `tool-audit: filed papercut ${record.callId} (owner ${record.owner ?? "unassigned"})`;
}

export function runCli(argv: string[], dir: string = auditDir()): string {
  const first = (argv[0] ?? "").trim();
  const cmd = first.toLowerCase();

  // Write commands must not pay for reading the whole log first.
  if (cmd === "note") return runNote(argv.slice(1), dir);
  if (cmd === "prune") {
    const days = Number.parseInt(argv[1] ?? "", 10);
    const result = pruneAuditDir(
      dir,
      Number.isFinite(days) && days > 0 ? { retentionDays: days } : {},
    );
    return `tool-audit: pruned ${result.files} files, kept ${result.kept}, dropped ${result.dropped} (papercuts are never dropped)`;
  }

  const records = readAllRecords(dir);

  if (!first) return formatSummary(aggregate(records));
  if (cmd === "notes") return formatNotes(records);
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
      "Usage: tool-audit-cli [errors | calls | notes | note ... | last <n> | show <call-id> | prune [days] | <agent-id>]",
      "  (no args)      summary of counts per directory and per agent, plus top tools",
      "  errors         recent failures with args and response previews",
      "  calls          one line per call, newest first (default 30)",
      "  notes          papercuts filed so far, newest first",
      "  note ...       file a papercut: --tried T --got G [--workaround W] [--expected E]",
      "                 [--repro CMD] [--owner config|pi|model|env] [--ref <call-id>]",
      "                 [--suspect PATH ...] [--cwd DIR] [--session ID]",
      "  last <n>       the n most recent calls, one line each",
      "  show <call-id> full detail for one call: complete args and result",
      "  prune [days]   drop non-note records older than `days` (default 30)",
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
