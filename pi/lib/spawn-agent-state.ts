import * as fs from "node:fs";
import * as path from "node:path";

export const REPORT_SCHEMA_VERSION = 1;
export const MAX_REPORT_BYTES = 50 * 1024;
export const MAX_REPORT_LINES = 2000;

export type SpawnReportStatus = "completed" | "error" | "aborted";

export interface SpawnReportRecord {
  schemaVersion: 1;
  eventId: string;
  pane?: string;
  timestamp: string;
  status: SpawnReportStatus;
  stopReason?: string;
  errorSummary?: string;
  assistantText: string;
}

interface AssistantLike {
  role?: unknown;
  content?: unknown;
  stopReason?: unknown;
  errorMessage?: unknown;
  timestamp?: unknown;
}

export function extractAssistantText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: "text"; text: string } =>
      Boolean(block && typeof block === "object" && (block as { type?: unknown }).type === "text" && typeof (block as { text?: unknown }).text === "string"))
    .map((block) => block.text)
    .join("\n");
}

function safeErrorSummary(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  return value
    .replace(/(?:api[_-]?key|token|password|secret)\s*[:=]\s*\S+/gi, "credential=[redacted]")
    .replace(/(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{12,}/g, "[redacted]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .slice(0, 1000);
}

export function createSpawnReport(messages: unknown, eventId: string, pane?: string, now = new Date()): SpawnReportRecord {
  const assistantMessages = Array.isArray(messages)
    ? messages.filter((message): message is AssistantLike => Boolean(message && typeof message === "object" && (message as AssistantLike).role === "assistant"))
    : [];
  const assistant = assistantMessages.at(-1);
  const stopReason = typeof assistant?.stopReason === "string" ? assistant.stopReason : undefined;
  const status: SpawnReportStatus = stopReason === "error" ? "error" : stopReason === "aborted" ? "aborted" : "completed";
  const record: SpawnReportRecord = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    eventId,
    timestamp: now.toISOString(),
    status,
    assistantText: extractAssistantText(assistant?.content),
  };
  if (pane) record.pane = pane;
  if (stopReason) record.stopReason = stopReason;
  const errorSummary = safeErrorSummary(assistant?.errorMessage);
  if (errorSummary) record.errorSummary = errorSummary;
  return record;
}

export function isSpawnReportRecord(value: unknown): value is SpawnReportRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<SpawnReportRecord>;
  return record.schemaVersion === REPORT_SCHEMA_VERSION && typeof record.eventId === "string" &&
    typeof record.timestamp === "string" && ["completed", "error", "aborted"].includes(record.status ?? "") &&
    typeof record.assistantText === "string" && (record.pane === undefined || typeof record.pane === "string");
}

/** Incrementally consumes JSONL while tolerating partial writes, truncation, and rotation. */
export class JsonlCursor {
  private snapshot = "";
  private pending = "";

  ingest(content: string): string[] {
    let addition: string;
    if (content.startsWith(this.snapshot)) {
      addition = content.slice(this.snapshot.length);
    } else {
      this.pending = "";
      addition = content;
    }
    this.snapshot = content;
    this.pending += addition;
    const lines = this.pending.split("\n");
    this.pending = lines.pop() ?? "";
    return lines.filter((line) => line.trim() !== "");
  }

  reset(): void {
    this.snapshot = "";
    this.pending = "";
  }
}

/** Compatibility name for existing notification tests and callers. */
export class NotifyEventCursor extends JsonlCursor {}

export class ReportStore {
  private readonly files = new Map<string, string>();
  private readonly cursors = new Map<string, JsonlCursor>();
  private readonly roots = new Map<string, string>();
  private readonly reports = new Map<string, SpawnReportRecord[]>();
  private readonly seen = new Set<string>();

  add(pane: string, file: string, root = path.dirname(file)): void {
    assertPrivateArtifact(file, root);
    this.files.set(pane, file);
    this.roots.set(pane, root);
    this.cursors.set(pane, new JsonlCursor());
    this.reports.set(pane, []);
  }

  has(pane: string): boolean { return this.files.has(pane); }

  refresh(pane: string): SpawnReportRecord[] {
    const file = this.files.get(pane);
    const cursor = this.cursors.get(pane);
    const root = this.roots.get(pane);
    if (!file || !cursor || !root) throw new Error("agent_report can only retrieve reports from panes spawned by this parent session.");
    assertPrivateArtifact(file, root);
    let content: string;
    try { content = fs.readFileSync(file, "utf8"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const added: SpawnReportRecord[] = [];
    for (const line of cursor.ingest(content)) {
      let parsed: unknown;
      try { parsed = JSON.parse(line); } catch { continue; }
      if (!isSpawnReportRecord(parsed) || this.seen.has(parsed.eventId)) continue;
      this.seen.add(parsed.eventId);
      this.reports.get(pane)!.push(parsed);
      added.push(parsed);
    }
    return added;
  }

  get(pane: string, selector: "latest" | "all" | number = "latest"): SpawnReportRecord[] {
    if (!this.files.has(pane)) throw new Error("agent_report can only retrieve reports from panes spawned by this parent session.");
    this.refresh(pane);
    const records = this.reports.get(pane) ?? [];
    if (selector === "all") return [...records];
    if (selector === "latest") return records.length ? [records.at(-1)!] : [];
    return selector >= 1 && Number.isInteger(selector) && selector <= records.length ? [records[selector - 1]!] : [];
  }

  clear(): void {
    this.files.clear(); this.roots.clear(); this.cursors.clear(); this.reports.clear(); this.seen.clear();
  }
}

export function formatReports(records: SpawnReportRecord[]): string {
  if (records.length === 0) return "No completed child turns have been reported yet.";
  return records.map((record, index) => {
    const heading = records.length > 1 ? `Report ${index + 1}\n` : "";
    const metadata = [`status: ${record.status}`, `timestamp: ${record.timestamp}`, `eventId: ${record.eventId}`];
    if (record.stopReason) metadata.push(`stopReason: ${record.stopReason}`);
    if (record.errorSummary) metadata.push(`error: ${record.errorSummary}`);
    return `${heading}${metadata.join("\n")}\n\n${record.assistantText || "(assistant returned no text)"}`;
  }).join("\n\n---\n\n");
}

export function truncateReportOutput(content: string): { content: string; truncated: boolean } {
  const marker = "\n\n[Output truncated to Pi's 50 KB / 2,000-line tool limit. Request a specific numeric turn to retrieve it separately.]";
  const lines = content.split("\n");
  let body = lines.slice(0, Math.max(0, MAX_REPORT_LINES - 2)).join("\n");
  let truncated = lines.length > MAX_REPORT_LINES;
  const maxBodyBytes = MAX_REPORT_BYTES - Buffer.byteLength(marker);
  if (Buffer.byteLength(body) > maxBodyBytes) {
    body = Buffer.from(body).subarray(0, maxBodyBytes).toString("utf8");
    truncated = true;
  }
  return { content: truncated ? body + marker : body, truncated };
}

export function cleanupPrivateArtifacts(root: string): void {
  try {
    const stat = fs.lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    fs.rmSync(root, { recursive: true, force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export class OwnedPaneRegistry {
  private readonly panes = new Set<string>();
  add(pane: string): void { this.panes.add(pane); }
  has(pane: string): boolean { return this.panes.has(pane); }
  delete(pane: string): void { this.panes.delete(pane); }
  clear(): void { this.panes.clear(); }
}

export function assertPrivateArtifact(file: string, root: string): void {
  const resolvedRoot = path.resolve(root);
  const resolvedFile = path.resolve(file);
  if (path.dirname(resolvedFile) !== resolvedRoot) throw new Error("Spawn artifact path escapes its private directory.");
  const rootStat = fs.lstatSync(resolvedRoot);
  const fileStat = fs.lstatSync(resolvedFile);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || !fileStat.isFile() || fileStat.isSymbolicLink()) {
    throw new Error("Spawn artifact was replaced by an unsafe filesystem object.");
  }
}
