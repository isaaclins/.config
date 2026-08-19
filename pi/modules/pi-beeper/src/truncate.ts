export const MAX_OUTPUT_BYTES = 50 * 1024;
export const MAX_OUTPUT_LINES = 2000;
export const MAX_MESSAGE_CHARS = 2000;

const TRUNCATION_MARKER = "Output truncated to Pi's 50 KB / 2,000-line limit.";

export interface TruncatedText {
  content: string;
  truncated: boolean;
}

/**
 * Copy the sibling module's byte and line cap without cutting a UTF-8 code
 * point. This helper is for plain reports. JSON tool output uses the
 * collection helper below so it remains valid JSON after truncation.
 */
export function truncateReportText(
  content: string,
  maxBytes = MAX_OUTPUT_BYTES,
  maxLines = MAX_OUTPUT_LINES,
): TruncatedText {
  const lines = content.split("\n");
  const marker = `\n\n[${TRUNCATION_MARKER}]`;
  let body = lines.slice(0, Math.max(0, maxLines - 2)).join("\n");
  let truncated = lines.length > maxLines;
  const maxBodyBytes = Math.max(0, maxBytes - Buffer.byteLength(marker));

  if (Buffer.byteLength(body) > maxBodyBytes) {
    const bytes = Buffer.from(body);
    let end = maxBodyBytes;
    body = bytes.subarray(0, end).toString("utf8");
    while (Buffer.byteLength(body) > maxBodyBytes || body.endsWith("\uFFFD")) {
      end -= 1;
      body = bytes.subarray(0, Math.max(0, end)).toString("utf8");
    }
    truncated = true;
  }

  return {
    content: truncated ? `${body}${marker}` : body,
    truncated,
  };
}

export interface JsonCapResult<T> {
  value: T;
  text: string;
  truncated: boolean;
}

/**
 * Serialize a result whose primary volume is an array. When the JSON would
 * exceed Pi's output limits, remove items from the end and add a structured
 * truncation marker. The returned text is always parseable JSON.
 */
export function serializeCappedCollection<T extends Record<string, unknown>>(
  value: T,
  collectionKey: string,
  maxBytes = MAX_OUTPUT_BYTES,
  maxLines = MAX_OUTPUT_LINES,
): JsonCapResult<T> {
  const initialText = JSON.stringify(value);
  if (fitsOutputLimits(initialText, maxBytes, maxLines)) {
    return { value, text: initialText, truncated: false };
  }

  const originalItems = Array.isArray(value[collectionKey]) ? value[collectionKey] : [];
  const items = [...originalItems];
  const candidate = {
    ...value,
    [collectionKey]: items,
    truncated: true,
    truncation: {
      reason: TRUNCATION_MARKER,
      itemsOmitted: originalItems.length,
    },
  } as T;

  while (!fitsOutputLimits(JSON.stringify(candidate), maxBytes, maxLines) && items.length > 0) {
    items.pop();
    const truncation = (candidate as Record<string, unknown>).truncation as {
      reason: string;
      itemsOmitted: number;
    };
    truncation.itemsOmitted = originalItems.length - items.length;
  }

  let text = JSON.stringify(candidate);
  if (!fitsOutputLimits(text, maxBytes, maxLines)) {
    const minimal = {
      kind: typeof value.kind === "string" ? value.kind : "beeper_result",
      truncated: true,
      truncation: {
        reason: TRUNCATION_MARKER,
        itemsOmitted: originalItems.length,
      },
    } as unknown as T;
    text = JSON.stringify(minimal);
    return { value: minimal, text, truncated: true };
  }

  return { value: candidate, text, truncated: true };
}

export function fitsOutputLimits(text: string, maxBytes = MAX_OUTPUT_BYTES, maxLines = MAX_OUTPUT_LINES): boolean {
  return Buffer.byteLength(text, "utf8") <= maxBytes && text.split("\n").length <= maxLines;
}

export function truncateMessageText(text: string, maxChars = MAX_MESSAGE_CHARS): {
  text: string;
  truncated: boolean;
} {
  const characters = Array.from(text);
  if (characters.length <= maxChars) return { text, truncated: false };
  const marker = ` [message truncated to ${maxChars.toLocaleString("en-US")} characters]`;
  const available = Math.max(0, maxChars - Array.from(marker).length);
  return {
    text: `${characters.slice(0, available).join("")}${marker}`,
    truncated: true,
  };
}
