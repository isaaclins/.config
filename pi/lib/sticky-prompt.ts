/**
 * Pure logic for the sticky-prompt extension: summarize a (possibly massive)
 * user prompt into a single border-friendly line, and scroll-state math for
 * the full-prompt viewer overlay. No pi imports so it stays unit-testable.
 */

export interface PromptSummary {
  /** Single-line summary, already capped to maxChars (without badge). */
  line: string;
  /** Whether anything was cut away. */
  truncated: boolean;
  /** How many characters of the original prompt are not shown. */
  hiddenChars: number;
  /** Number of collapsed paste markers found in the prompt. */
  pasteCount: number;
}

const PASTE_MARKER = /\[pasted[^\]]*\]/gi;
const ELLIPSIS = "\u2026";

/**
 * Reduce a raw prompt to one line:
 * 1. strip collapsed-paste markers (counted separately)
 * 2. take the first non-empty line
 * 3. within it, prefer the first sentence boundary
 * 4. hard-cap at maxChars with an ellipsis
 */
export function summarizePrompt(raw: string, maxChars = 120): PromptSummary {
  const pasteCount = (raw.match(PASTE_MARKER) ?? []).length;
  const withoutPastes = raw.replace(PASTE_MARKER, " ");

  const firstLine =
    withoutPastes
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "";

  const normalized = firstLine.replace(/\s+/g, " ").trim();

  // Prefer a sentence boundary if one exists reasonably early.
  const sentenceMatch = normalized.match(/^(.{8,}?[.?!])(?:\s|$)/);
  let candidate = sentenceMatch ? sentenceMatch[1]! : normalized;

  if (candidate.length > maxChars) {
    // Cut at the last word boundary that fits, fall back to a hard cut.
    const hardCut = candidate.slice(0, maxChars - 1);
    const lastSpace = hardCut.lastIndexOf(" ");
    const wordCut = lastSpace > maxChars * 0.6 ? hardCut.slice(0, lastSpace) : hardCut;
    candidate = wordCut.trimEnd() + ELLIPSIS;
  }

  const meaningfulRawLength = withoutPastes.replace(/\s+/g, " ").trim().length;
  const shownLength = candidate.endsWith(ELLIPSIS) ? candidate.length - 1 : candidate.length;
  const hiddenChars = Math.max(0, meaningfulRawLength - shownLength);
  const truncated = hiddenChars > 0 || pasteCount > 0;

  return { line: candidate, truncated, hiddenChars, pasteCount };
}

/** Human-friendly char count: 2400 -> "2.4k". */
export function formatCharCount(count: number): string {
  if (count < 1000) return String(count);
  return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k`;
}

/** Build the visible sticky line including the honesty badge. */
export function buildStickyLine(raw: string, maxChars = 120): string {
  const summary = summarizePrompt(raw, maxChars);
  const parts = [`\u25c6 ${summary.line}`];
  if (summary.pasteCount > 0) {
    parts.push(`\u29c9${summary.pasteCount}`);
  }
  if (summary.hiddenChars > 0) {
    parts.push(`(+${formatCharCount(summary.hiddenChars)} chars)`);
  }
  return parts.join(" ");
}

/** Clamp a scroll offset for a viewer with totalLines content and viewport rows. */
export function clampOffset(offset: number, totalLines: number, viewport: number): number {
  const maxOffset = Math.max(0, totalLines - viewport);
  if (offset < 0) return 0;
  if (offset > maxOffset) return maxOffset;
  return offset;
}

/** Wrap plain text (no ANSI) to a given width, preserving blank lines. */
export function wrapPlainText(text: string, width: number): string[] {
  const safeWidth = Math.max(4, width);
  const out: string[] = [];
  for (const rawLine of text.split("\n")) {
    if (rawLine.trim().length === 0) {
      out.push("");
      continue;
    }
    let rest = rawLine;
    while (rest.length > safeWidth) {
      const slice = rest.slice(0, safeWidth);
      const lastSpace = slice.lastIndexOf(" ");
      const cut = lastSpace > safeWidth * 0.5 ? lastSpace : safeWidth;
      out.push(rest.slice(0, cut));
      rest = rest.slice(cut).trimStart();
    }
    out.push(rest);
  }
  return out;
}
