export const REPORT_SCHEMA_VERSION = 1;
export const MAX_REPORT_BYTES = 50 * 1024;
export const MAX_REPORT_LINES = 2000;
const REPORT_TRUNCATION_MARKER =
  "\n\n[Report truncated to Pi's 50 KB / 2,000-line limit.]";

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
}

export function extractAssistantText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (block): block is { type: "text"; text: string } =>
        Boolean(block) &&
        typeof block === "object" &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string",
    )
    .map((block) => block.text)
    .join("\n");
}

function safeErrorSummary(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  return value
    .replace(
      /(?:api[_-]?key|token|password|secret)\s*[:=]\s*\S+/gi,
      "credential=[redacted]",
    )
    .replace(
      /(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{12,}/g,
      "[redacted]",
    )
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .slice(0, 1000);
}

export function createSpawnReport(
  messages: unknown,
  eventId: string,
  pane?: string,
  now = new Date(),
): SpawnReportRecord {
  const assistantMessages = Array.isArray(messages)
    ? messages.filter(
        (message): message is AssistantLike =>
          Boolean(message) &&
          typeof message === "object" &&
          (message as AssistantLike).role === "assistant",
      )
    : [];
  const assistant = assistantMessages.at(-1);
  const stopReason =
    typeof assistant?.stopReason === "string"
      ? assistant.stopReason
      : undefined;
  const status: SpawnReportStatus =
    stopReason === "error"
      ? "error"
      : stopReason === "aborted"
        ? "aborted"
        : "completed";
  const record: SpawnReportRecord = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    eventId,
    timestamp: now.toISOString(),
    status,
    assistantText: truncateText(
      extractAssistantText(assistant?.content),
      MAX_REPORT_BYTES - 2048,
      MAX_REPORT_LINES,
    ).content,
  };
  if (pane) record.pane = pane;
  if (stopReason) record.stopReason = stopReason;
  const errorSummary = safeErrorSummary(assistant?.errorMessage);
  if (errorSummary) record.errorSummary = errorSummary;
  return record;
}

export function isSpawnReportRecord(
  value: unknown,
): value is SpawnReportRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<SpawnReportRecord>;
  return (
    record.schemaVersion === REPORT_SCHEMA_VERSION &&
    typeof record.eventId === "string" &&
    typeof record.timestamp === "string" &&
    ["completed", "error", "aborted"].includes(record.status ?? "") &&
    typeof record.assistantText === "string" &&
    (record.pane === undefined || typeof record.pane === "string")
  );
}

export function truncateText(
  content: string,
  maxBytes = MAX_REPORT_BYTES,
  maxLines = MAX_REPORT_LINES,
  marker = REPORT_TRUNCATION_MARKER,
): { content: string; truncated: boolean } {
  const lines = content.split("\n");
  let body = lines.slice(0, Math.max(0, maxLines - 2)).join("\n");
  let truncated = lines.length > maxLines;
  const maxBodyBytes = Math.max(0, maxBytes - Buffer.byteLength(marker));
  if (Buffer.byteLength(body) > maxBodyBytes) {
    let end = maxBodyBytes;
    const bytes = Buffer.from(body);
    body = bytes.subarray(0, end).toString("utf8");
    while (Buffer.byteLength(body) > maxBodyBytes || body.endsWith("�")) {
      end--;
      body = bytes.subarray(0, Math.max(0, end)).toString("utf8");
    }
    truncated = true;
  }
  return { content: truncated ? body + marker : body, truncated };
}

export function formatReports(records: SpawnReportRecord[]): string {
  if (records.length === 0)
    return "No completed child turns have been reported yet.";
  return records
    .map((record, index) => {
      const heading = records.length > 1 ? `Report ${index + 1}\n` : "";
      const metadata = [
        `status: ${record.status}`,
        `timestamp: ${record.timestamp}`,
        `eventId: ${record.eventId}`,
      ];
      if (record.stopReason) metadata.push(`stopReason: ${record.stopReason}`);
      if (record.errorSummary) metadata.push(`error: ${record.errorSummary}`);
      return `${heading}${metadata.join("\n")}\n\n${record.assistantText || "(assistant returned no text)"}`;
    })
    .join("\n\n---\n\n");
}

export function truncateReportOutput(content: string): {
  content: string;
  truncated: boolean;
} {
  return truncateText(
    content,
    MAX_REPORT_BYTES,
    MAX_REPORT_LINES,
    "\n\n[Output truncated to Pi's 50 KB / 2,000-line tool limit. Request a specific numeric turn to retrieve it separately.]",
  );
}
