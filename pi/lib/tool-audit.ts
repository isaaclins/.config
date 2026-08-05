import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Core logic for the tool-call audit tracker.
 *
 * Kept free of extension wiring so it stays unit-testable: shaping a record
 * (redaction + truncation), aggregating counts, and formatting reports are all
 * pure functions. The extension (extensions/tool-audit.ts) and the standalone
 * CLI (lib/tool-audit-cli.ts) both build on these.
 */

/** Keys whose values are secrets and must never be written to disk. */
export const SENSITIVE_KEY_PATTERN = /token|secret|password|api[_-]?key/i;
export const REDACTED = "[redacted]";

/** Compact field caps (~2KB each). These drive list views and stay tiny. */
export const MAX_ARGS_BYTES = 2048;
export const MAX_PREVIEW_BYTES = 2048;

/** Full field cap (256KB). Big enough for real calls, bounded so a
 * context-dumping tool cannot blow up the log. */
export const MAX_FULL_BYTES = 256 * 1024;

const AGENT_ID_LENGTH = 8;
const CALL_ID_LENGTH = 8;

/** Placeholder shown for old records that predate the callId field. */
export const MISSING_CALL_ID = "--------";

export type Outcome = "ok" | "error";

/**
 * Who owns the fix for a papercut:
 *   config -> this dotfiles repo (the only owner eligible for auto-dispatch)
 *   pi     -> the upstream Pi harness
 *   model  -> the model's own behavior
 *   env    -> the machine, network, or an external tool
 */
export type PapercutOwner = "config" | "pi" | "model" | "env";

export const PAPERCUT_OWNERS: readonly PapercutOwner[] = ["config", "pi", "model", "env"];

/** Tool name reserved for papercut notes, so they are filterable. */
export const NOTE_TOOL = "note";

/**
 * Shared event-bus channel announcing a freshly filed papercut. The payload is
 * the AuditRecord. This module owns filing; subscribers own what happens next.
 */
export const PAPERCUT_FILED_EVENT = "papercut:filed";

/** Note text cap. Papercuts are repro-shaped and short by construction. */
export const MAX_NOTE_BYTES = MAX_PREVIEW_BYTES;

export function isPapercutOwner(value: unknown): value is PapercutOwner {
  return typeof value === "string" && (PAPERCUT_OWNERS as readonly string[]).includes(value);
}

/** One appended JSONL line. */
export interface AuditRecord {
  ts: string;
  sessionId: string;
  agentId: string;
  /** Short, stable id for this exact call; absent on pre-callId records. */
  callId?: string;
  cwd: string;
  tool: string;
  /** Redacted args serialized to JSON, truncated to MAX_ARGS_BYTES. */
  args: string;
  /** Full redacted args (up to MAX_FULL_BYTES); omitted when equal to args. */
  argsFull?: string;
  outcome: Outcome;
  /** Result or error text, truncated to MAX_PREVIEW_BYTES. */
  preview: string;
  /** Full result text (up to MAX_FULL_BYTES); omitted when equal to preview. */
  resultFull?: string;
  durationMs?: number;
  /**
   * Papercut body: the repro-shaped note. Present only on records whose tool
   * is NOTE_TOOL. `callId` still identifies this record (so `/toolaudit show`
   * keeps working); `refCallId` is the call the note is about.
   */
  note?: string;
  /** Who owns the fix. Absent means unattributed, which never auto-dispatches. */
  owner?: PapercutOwner;
  /** The audit callId this note refers to, when the author knew it. */
  refCallId?: string;
  /** Repo-relative paths the author suspects. Drives the dispatch safety gate. */
  suspects?: string[];
}

export interface RecordInput {
  sessionId: string;
  /** Pi's toolCallId; hashed into a stable short callId. */
  toolCallId?: string;
  cwd: string;
  tool: string;
  args: unknown;
  result?: unknown;
  isError: boolean;
  /** Epoch ms when the tool started, from tool_execution_start. */
  startedAt?: number;
  /** Epoch ms when the tool finished; defaults to now. */
  endedAt?: number;
  /** Papercut body; see AuditRecord.note. */
  note?: string;
  owner?: PapercutOwner;
  refCallId?: string;
  suspects?: string[];
}

/** Short, stable agent id: first 8 chars of the session id. */
export function shortAgentId(sessionId: string): string {
  const id = (sessionId || "unknown").trim() || "unknown";
  return id.slice(0, AGENT_ID_LENGTH);
}

/** Short, stable call id: a hash of Pi's toolCallId, so distinct calls that
 * share a prefix never collide. Empty input yields an empty id. */
export function shortCallId(toolCallId: string): string {
  const id = (toolCallId || "").trim();
  if (!id) return "";
  return createHash("sha1").update(id).digest("hex").slice(0, CALL_ID_LENGTH);
}

/** Full redacted args of a record, falling back to the compact field. */
export function fullArgs(record: AuditRecord): string {
  return record.argsFull ?? record.args;
}

/** Full result text of a record, falling back to the compact preview. */
export function fullResult(record: AuditRecord): string {
  return record.resultFull ?? record.preview;
}

/** Deep-copy a value, replacing any value whose key looks sensitive. */
export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY_PATTERN.test(key) ? REDACTED : redactSecrets(val);
    }
    return out;
  }
  return value;
}

/**
 * Scrub obvious inline credentials from free text.
 *
 * redactSecrets() is key-driven and therefore blind to a secret pasted into a
 * prose field, which is exactly what a papercut note is. This is the text-side
 * counterpart and is applied to every note before it is written.
 */
const INLINE_SECRET_PATTERN = /((?:token|secret|password|api[_-]?key)["']?\s*[:=]\s*["']?)([^\s"',}]+)/gi;
const BEARER_PATTERN = /\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi;
/**
 * Vendor credentials carry their own prefix, so a key pasted bare into prose
 * ("got: 401 for sk-ant-...") has no assignment for the pattern above to
 * anchor on. Matched by shape instead, with a length floor that ordinary
 * words cannot reach.
 */
const RAW_CREDENTIAL_PATTERN =
  /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[A-Za-z0-9_-]{30,})\b/g;

export function redactInlineSecrets(text: string): string {
  return text
    .replace(INLINE_SECRET_PATTERN, (_match, prefix: string) => `${prefix}${REDACTED}`)
    .replace(BEARER_PATTERN, (_match, prefix: string) => `${prefix}${REDACTED}`)
    .replace(RAW_CREDENTIAL_PATTERN, REDACTED);
}

/** Truncate to a UTF-8 byte budget, tagging how many bytes were dropped. */
export function truncateBytes(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  const dropped = buf.length - maxBytes;
  const head = buf.subarray(0, maxBytes).toString("utf8").replace(/\uFFFD+$/, "");
  return `${head}…[+${dropped}B]`;
}

function safeStringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Extract a human-readable preview from an arbitrary tool result. */
export function resultPreview(result: unknown): string {
  if (result === null || result === undefined) return "";
  if (typeof result === "string") return result;
  if (typeof result === "object") {
    const content = (result as { content?: unknown }).content;
    if (Array.isArray(content)) {
      const text = content
        .filter((part) => part && typeof part === "object" && (part as { type?: string }).type === "text")
        .map((part) => (part as { text?: string }).text ?? "")
        .join("\n")
        .trim();
      if (text) return text;
    }
    const output = (result as { output?: unknown }).output;
    if (typeof output === "string") return output;
    const message = (result as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return safeStringify(result);
}

/** Shape one input into a bounded, redacted record. */
export function buildRecord(input: RecordInput): AuditRecord {
  const endedAt = input.endedAt ?? Date.now();
  const argsText = safeStringify(redactSecrets(input.args));
  const resultText = resultPreview(input.result);
  const record: AuditRecord = {
    ts: new Date(endedAt).toISOString(),
    sessionId: input.sessionId,
    agentId: shortAgentId(input.sessionId),
    cwd: input.cwd,
    tool: input.tool,
    args: truncateBytes(argsText, MAX_ARGS_BYTES),
    outcome: input.isError ? "error" : "ok",
    preview: truncateBytes(resultText, MAX_PREVIEW_BYTES),
  };
  const callId = shortCallId(input.toolCallId ?? "");
  if (callId) record.callId = callId;
  const argsFull = truncateBytes(argsText, MAX_FULL_BYTES);
  if (argsFull !== record.args) record.argsFull = argsFull;
  const resultFull = truncateBytes(resultText, MAX_FULL_BYTES);
  if (resultFull !== record.preview) record.resultFull = resultFull;
  if (typeof input.startedAt === "number") {
    record.durationMs = Math.max(0, endedAt - input.startedAt);
  }
  const note = (input.note ?? "").trim();
  if (note) record.note = truncateBytes(redactInlineSecrets(note), MAX_NOTE_BYTES);
  if (input.owner) record.owner = input.owner;
  const refCallId = (input.refCallId ?? "").trim();
  if (refCallId) record.refCallId = refCallId;
  const suspects = normalizeSuspects(input.suspects);
  if (suspects.length > 0) record.suspects = suspects;
  return record;
}

// ============================================================================
// Papercuts
// ============================================================================

/**
 * Repro-shaped note fields. Keeping the shape fixed is the whole point: a
 * fixer agent can only reproduce a papercut it can read mechanically.
 */
export interface PapercutFields {
  /** What the agent was trying to do. */
  tried: string;
  /** What actually happened, verbatim where possible. */
  got: string;
  /** The workaround the agent invented to keep going, if any. */
  workaround?: string;
  /** What should have happened instead. */
  expected?: string;
  /** A command that reproduces it from a clean shell. */
  repro?: string;
}

const NOTE_FIELD_ORDER: ReadonlyArray<readonly [keyof PapercutFields, string]> = [
  ["tried", "tried"],
  ["got", "got"],
  ["workaround", "workaround"],
  ["expected", "expected"],
  ["repro", "repro"],
];

/** Render the repro-shaped fields into the canonical note string. */
export function formatPapercutNote(fields: PapercutFields): string {
  const lines: string[] = [];
  for (const [key, label] of NOTE_FIELD_ORDER) {
    const value = (fields[key] ?? "").trim();
    if (!value) continue;
    lines.push(`${label}: ${value}`);
  }
  return lines.join("\n");
}

function normalizeSuspects(suspects: unknown): string[] {
  if (!Array.isArray(suspects)) return [];
  const seen = new Set<string>();
  for (const entry of suspects) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (trimmed) seen.add(trimmed);
  }
  return [...seen];
}

export interface NoteRecordInput {
  sessionId: string;
  /** Pi's toolCallId when a tool filed it; synthesized for CLI callers. */
  toolCallId?: string;
  cwd: string;
  fields: PapercutFields;
  owner?: PapercutOwner;
  refCallId?: string;
  suspects?: string[];
  endedAt?: number;
}

/**
 * Build one papercut record. It reuses buildRecord so redaction, truncation,
 * and id derivation stay in exactly one place.
 *
 * A note always carries a callId: it is the note's identity, used to name the
 * repair branch and to dispatch it manually later.
 */
export function buildNoteRecord(input: NoteRecordInput): AuditRecord {
  const note = formatPapercutNote(input.fields);
  return buildRecord({
    sessionId: input.sessionId,
    toolCallId: input.toolCallId || `papercut:${randomUUID()}`,
    cwd: input.cwd,
    tool: NOTE_TOOL,
    args: input.fields,
    result: note,
    isError: false,
    endedAt: input.endedAt,
    note,
    owner: input.owner,
    refCallId: input.refCallId,
    suspects: input.suspects,
  });
}

export function isPapercut(record: AuditRecord): boolean {
  return record.tool === NOTE_TOOL && typeof record.note === "string" && record.note.length > 0;
}

export function papercutRecords(records: AuditRecord[]): AuditRecord[] {
  return records.filter(isPapercut);
}

// ============================================================================
// Aggregation
// ============================================================================

export interface CountEntry {
  key: string;
  total: number;
  errors: number;
}

export interface AuditSummary {
  total: number;
  errors: number;
  errorRate: number;
  byDir: CountEntry[];
  byAgent: CountEntry[];
  byTool: CountEntry[];
}

function tally(map: Map<string, CountEntry>, key: string, isError: boolean): void {
  const entry = map.get(key) ?? { key, total: 0, errors: 0 };
  entry.total += 1;
  if (isError) entry.errors += 1;
  map.set(key, entry);
}

function sortedEntries(map: Map<string, CountEntry>): CountEntry[] {
  return [...map.values()].sort((a, b) => b.total - a.total || a.key.localeCompare(b.key));
}

export function aggregate(records: AuditRecord[]): AuditSummary {
  const byDir = new Map<string, CountEntry>();
  const byAgent = new Map<string, CountEntry>();
  const byTool = new Map<string, CountEntry>();
  let errors = 0;

  for (const record of records) {
    const isError = record.outcome === "error";
    if (isError) errors += 1;
    tally(byDir, record.cwd || "(unknown)", isError);
    tally(byAgent, record.agentId || "(unknown)", isError);
    tally(byTool, record.tool || "(unknown)", isError);
  }

  const total = records.length;
  return {
    total,
    errors,
    errorRate: total === 0 ? 0 : errors / total,
    byDir: sortedEntries(byDir),
    byAgent: sortedEntries(byAgent),
    byTool: sortedEntries(byTool),
  };
}

// ============================================================================
// Formatting
// ============================================================================

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function countLine(entry: CountEntry): string {
  const errorPart = entry.errors > 0 ? ` (${entry.errors} err)` : "";
  return `  ${String(entry.total).padStart(5)}  ${entry.key}${errorPart}`;
}

export function formatSummary(summary: AuditSummary, topN = 10): string {
  if (summary.total === 0) return "tool-audit: no records yet";
  const lines: string[] = [];
  lines.push(`tool-audit: ${summary.total} calls, ${summary.errors} errors (${pct(summary.errorRate)})`);
  lines.push("");
  lines.push("Per directory:");
  for (const entry of summary.byDir.slice(0, topN)) lines.push(countLine(entry));
  lines.push("");
  lines.push("Per agent:");
  for (const entry of summary.byAgent.slice(0, topN)) lines.push(countLine(entry));
  lines.push("");
  lines.push("Top tools:");
  for (const entry of summary.byTool.slice(0, topN)) lines.push(countLine(entry));
  return lines.join("\n");
}

function oneLine(text: string, max = 200): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? `${collapsed.slice(0, max)}…` : collapsed;
}

export function formatErrors(records: AuditRecord[], limit = 20): string {
  const failures = records.filter((record) => record.outcome === "error");
  if (failures.length === 0) return "tool-audit: no errors recorded";
  const recent = failures.slice(-limit).reverse();
  const lines: string[] = [`tool-audit: ${failures.length} errors (showing ${recent.length})`, ""];
  for (const record of recent) {
    lines.push(`${record.ts}  ${record.agentId}  ${record.tool}  ${record.cwd}`);
    lines.push(`  args: ${oneLine(record.args)}`);
    lines.push(`  resp: ${oneLine(record.preview)}`);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

export function formatAgent(records: AuditRecord[], agentId: string, limit = 50): string {
  const matches = records.filter((record) => record.agentId === agentId);
  if (matches.length === 0) return `tool-audit: no calls for agent ${agentId}`;
  const summary = aggregate(matches);
  const recent = matches.slice(-limit);
  const lines: string[] = [];
  lines.push(`tool-audit agent ${agentId}: ${summary.total} calls, ${summary.errors} errors (${pct(summary.errorRate)})`);
  const dirs = summary.byDir.map((entry) => entry.key).join(", ");
  lines.push(`directories: ${dirs}`);
  lines.push("");
  for (const record of recent) {
    const duration = record.durationMs === undefined ? "" : ` ${record.durationMs}ms`;
    const mark = record.outcome === "error" ? "ERR" : "ok ";
    lines.push(`${record.ts}  ${mark}  ${record.tool}${duration}`);
    lines.push(`  args: ${oneLine(record.args)}`);
    lines.push(`  resp: ${oneLine(record.preview)}`);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

/** Compact one-line summary of a single call for list views. */
function callLine(record: AuditRecord): string {
  const id = record.callId ?? MISSING_CALL_ID;
  const mark = record.outcome === "error" ? "ERR" : "ok ";
  const duration = record.durationMs === undefined ? "" : ` ${record.durationMs}ms`;
  return `${id}  ${record.ts}  ${record.agentId}  ${mark}  ${record.tool}${duration}  ${oneLine(record.args, 80)}`;
}

/** One line per call, newest first, capped to `limit`. */
export function formatCalls(records: AuditRecord[], limit = 30): string {
  if (records.length === 0) return "tool-audit: no records yet";
  const recent = records.slice(-limit).reverse();
  const lines: string[] = [`tool-audit: ${records.length} calls (showing ${recent.length}, newest first)`, ""];
  for (const record of recent) lines.push(callLine(record));
  return lines.join("\n");
}

/** Papercut list view, newest first. */
export function formatNotes(records: AuditRecord[], limit = 20): string {
  const notes = papercutRecords(records);
  if (notes.length === 0) return "tool-audit: no papercuts filed";
  const recent = notes.slice(-limit).reverse();
  const lines: string[] = [
    `tool-audit: ${notes.length} papercuts (showing ${recent.length}, newest first)`,
    "",
  ];
  for (const record of recent) {
    const owner = record.owner ?? "unassigned";
    lines.push(`${record.callId ?? MISSING_CALL_ID}  ${record.ts}  owner=${owner}  ${record.cwd}`);
    if (record.refCallId) lines.push(`  about call: ${record.refCallId}`);
    for (const line of (record.note ?? "").split("\n")) lines.push(`  ${line}`);
    if (record.suspects?.length) lines.push(`  suspects: ${record.suspects.join(", ")}`);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

/** Newest-first lookup of one call by its exact callId. */
function findCall(records: AuditRecord[], callId: string): AuditRecord | undefined {
  for (let i = records.length - 1; i >= 0; i -= 1) {
    if (records[i].callId === callId) return records[i];
  }
  return undefined;
}

/** Pretty-print a stored args string as JSON, or return it as-is if it is
 * not parseable (e.g. truncated at the byte cap). */
function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/** Full detail for one call: every stored field, complete redacted args
 * pretty-printed, and the complete result text. */
export function formatCall(records: AuditRecord[], callId: string): string {
  const match = findCall(records, callId);
  if (!match) return `tool-audit: no call ${callId}`;
  const lines: string[] = [];
  lines.push(`tool-audit call ${match.callId ?? MISSING_CALL_ID}`);
  lines.push(`ts:        ${match.ts}`);
  lines.push(`agent:     ${match.agentId}`);
  lines.push(`session:   ${match.sessionId}`);
  lines.push(`cwd:       ${match.cwd}`);
  lines.push(`tool:      ${match.tool}`);
  lines.push(`outcome:   ${match.outcome}`);
  if (match.durationMs !== undefined) lines.push(`duration:  ${match.durationMs}ms`);
  lines.push("");
  lines.push("args:");
  lines.push(prettyJson(fullArgs(match)));
  lines.push("");
  lines.push("result:");
  lines.push(fullResult(match) || "(empty)");
  return lines.join("\n");
}

// ============================================================================
// Storage (JSONL, one file per day, outside the git repo)
// ============================================================================

/** Default audit directory: ~/.local/share/pi/tool-audit. */
export function auditDir(): string {
  const base = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(base, "pi", "tool-audit");
}

function dayStamp(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Path of the JSONL file for a given day. */
export function dailyFilePath(dir: string, date: Date = new Date()): string {
  return join(dir, `${dayStamp(date)}.jsonl`);
}

/** Append one record as a JSONL line. Throws on failure; callers must guard. */
export function writeRecord(dir: string, record: AuditRecord, date: Date = new Date()): void {
  mkdirSync(dir, { recursive: true });
  appendFileSync(dailyFilePath(dir, date), `${JSON.stringify(record)}\n`);
}

/** Parse JSONL text into records, skipping malformed lines. */
export function parseJsonl(text: string): AuditRecord[] {
  const records: AuditRecord[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed) as AuditRecord);
    } catch {
      // A partially written line must never break reporting.
    }
  }
  return records;
}

/**
 * Split records into what retention keeps and what it may delete.
 *
 * Papercuts are never dropped. They are the input queue of the self-repair
 * loop, so age is not evidence that they stopped mattering; only an explicit
 * human action retires one.
 */
export function retainRecords(
  records: AuditRecord[],
  cutoffMs: number,
): { keep: AuditRecord[]; dropped: AuditRecord[] } {
  const keep: AuditRecord[] = [];
  const dropped: AuditRecord[] = [];
  for (const record of records) {
    if (isPapercut(record)) {
      keep.push(record);
      continue;
    }
    const ts = Date.parse(record.ts);
    if (!Number.isFinite(ts) || ts >= cutoffMs) {
      keep.push(record);
      continue;
    }
    dropped.push(record);
  }
  return { keep, dropped };
}

export const DEFAULT_RETENTION_DAYS = 30;

export interface PruneResult {
  files: number;
  kept: number;
  dropped: number;
}

/**
 * Rewrite every daily file, dropping aged-out non-note records. This is the
 * single owner of audit retention; nothing else deletes audit rows.
 */
export function pruneAuditDir(
  dir: string,
  options: { retentionDays?: number; now?: number } = {},
): PruneResult {
  const retentionDays = options.retentionDays ?? DEFAULT_RETENTION_DAYS;
  const cutoff = (options.now ?? Date.now()) - retentionDays * 24 * 60 * 60 * 1000;
  let files: string[];
  try {
    files = readdirSync(dir).filter((name) => name.endsWith(".jsonl")).sort();
  } catch {
    return { files: 0, kept: 0, dropped: 0 };
  }
  const result: PruneResult = { files: 0, kept: 0, dropped: 0 };
  for (const name of files) {
    const path = join(dir, name);
    let records: AuditRecord[];
    try {
      records = parseJsonl(readFileSync(path, "utf8"));
    } catch {
      continue;
    }
    const { keep, dropped } = retainRecords(records, cutoff);
    result.files += 1;
    result.kept += keep.length;
    result.dropped += dropped.length;
    if (dropped.length === 0) continue;
    writeFileSync(path, keep.map((record) => `${JSON.stringify(record)}\n`).join(""));
  }
  return result;
}

/** Read every record from all daily files, oldest first. */
export function readAllRecords(dir: string): AuditRecord[] {
  let files: string[];
  try {
    files = readdirSync(dir).filter((name) => name.endsWith(".jsonl")).sort();
  } catch {
    return [];
  }
  const records: AuditRecord[] = [];
  for (const name of files) {
    try {
      records.push(...parseJsonl(readFileSync(join(dir, name), "utf8")));
    } catch {
      // Skip an unreadable file rather than failing the whole report.
    }
  }
  return records;
}
