import type { CodriveReport, ReportStatus } from "./runtime-store.ts";

export const MAX_REPORT_BYTES = 50 * 1024;
export const MAX_REPORT_LINES = 2000;
const REPORT_TRUNCATION_MARKER = "\n\n[Report truncated to Pi's 50 KB / 2,000-line limit.]";

interface AssistantLike {
  role?: unknown;
  content?: unknown;
  stopReason?: unknown;
  errorMessage?: unknown;
}

/**
 * Extract plain text from an assistant message's content, which may be a
 * plain string or a list of content blocks (only text blocks contribute).
 */
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

/**
 * Redact common credential shapes from an error message before it ever
 * leaves the child process.
 */
export function safeErrorSummary(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  return value
    .replace(/(?:api[_-]?key|token|password|secret)\s*[:=]\s*\S+/gi, "credential=[redacted]")
    .replace(/(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{12,}/g, "[redacted]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .slice(0, 1000);
}

export function truncateReportText(
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
    while (Buffer.byteLength(body) > maxBodyBytes || body.endsWith("\uFFFD")) {
      end--;
      body = bytes.subarray(0, Math.max(0, end)).toString("utf8");
    }
    truncated = true;
  }
  return { content: truncated ? body + marker : body, truncated };
}

export interface BuildChildReportOptions {
  sessionId: string;
  childId: string;
  paneId?: string;
  eventId: string;
  now?: Date;
}

/**
 * Build the CodriveReport a child sends home from its own `agent_end`
 * message list. The last assistant message's stop reason determines
 * status; text is extracted from content blocks and truncated to Pi's
 * report size limits before it ever reaches the wire.
 */
export function buildChildReport(messages: unknown, options: BuildChildReportOptions): CodriveReport {
  const assistantMessages = Array.isArray(messages)
    ? messages.filter(
        (message): message is AssistantLike =>
          Boolean(message) && typeof message === "object" && (message as AssistantLike).role === "assistant",
      )
    : [];
  const assistant = assistantMessages.at(-1);
  const stopReason = typeof assistant?.stopReason === "string" ? assistant.stopReason : undefined;
  const status: ReportStatus = stopReason === "error" ? "error" : stopReason === "aborted" ? "aborted" : "completed";

  const report: CodriveReport = {
    version: 1,
    eventId: options.eventId,
    sessionId: options.sessionId,
    childId: options.childId,
    status,
    assistantText: truncateReportText(extractAssistantText(assistant?.content), MAX_REPORT_BYTES - 2048, MAX_REPORT_LINES)
      .content,
    timestamp: (options.now ?? new Date()).toISOString(),
  };
  if (options.paneId) report.paneId = options.paneId;
  const errorSummary = safeErrorSummary(assistant?.errorMessage);
  if (errorSummary) report.errorSummary = errorSummary;
  return report;
}
