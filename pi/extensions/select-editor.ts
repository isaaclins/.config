import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  sliceByColumn,
  visibleWidth,
  type EditorTheme,
  type KeybindingsManager,
  type TUI,
} from "@earendil-works/pi-tui";
import { spawn } from "node:child_process";

/**
 * Shift+arrow text selection for pi's prompt editor.
 *
 * pi's stock Editor (from pi-tui) has no selection concept at all: no
 * anchor, no highlighted range, no selection-aware backspace/copy. This
 * extension adds it by wrapping CustomEditor (the same base class pi's own
 * interactive mode uses, so app keybindings like escape-to-abort and
 * ctrl+d-to-exit keep working via `super.handleInput`).
 *
 * IMPORTANT CAVEAT: `Editor`'s cursor/line state (`state.lines`,
 * `state.cursorLine`, `state.cursorCol`) is declared `private` in the
 * pi-tui type definitions, and there is no public API to move the cursor
 * to an arbitrary position (only `getLines()`, `getCursor()`, and
 * `setText()`, which always places the cursor at the end of the new text).
 * There is also no exported way to re-synthesize "unshifted" terminal key
 * bytes to replay through `super.handleInput` for movement. So this
 * extension reads and writes `(this as any).state` directly for cursor
 * movement and edits, mirroring the exact grapheme/word/line movement
 * semantics of the private methods in pi-tui's editor.js (verified against
 * the installed pi-coding-agent 0.80.3 source). This is inherently
 * version-coupled: if a future pi-tui release renames or restructures
 * `state`, selection support degrades (see try/catch below) but the base
 * editor keeps working normally.
 *
 * SECOND CAVEAT: pi-tui's word-wrapping helper (`wordWrapLine`, used
 * internally by Editor.render() via layoutText()) is not part of the
 * package's public export surface (verified against the installed
 * pi-tui's dist/index.js), so this extension cannot reuse it exactly for
 * mapping logical selection positions onto rendered visual rows. It uses
 * its own greedy word-wrap approximation (buildVisualLines below) that
 * matches common cases but can drift from the real wrapping in edge cases
 * (very long unbroken tokens, unusual whitespace). Any drift only affects
 * *where the highlight lands visually*, never the underlying text or
 * cursor/selection correctness.
 *
 * Everything else (rendering, submit, non-selection editing) is delegated
 * to `super`, so this extension only adds behavior on top.
 */

// =============================================================================
// Pure selection helpers (unit-testable, no editor/state dependency)
// =============================================================================

export interface CursorPos {
  line: number;
  col: number;
}

export interface SelectionRange {
  start: CursorPos;
  end: CursorPos;
}

/** Compare two positions: negative if a < b, positive if a > b, 0 if equal. */
export function comparePos(a: CursorPos, b: CursorPos): number {
  if (a.line !== b.line) return a.line - b.line;
  return a.col - b.col;
}

/** Normalize an anchor/cursor pair into an ordered {start, end} range. */
export function normalizeRange(anchor: CursorPos, cursor: CursorPos): SelectionRange {
  return comparePos(anchor, cursor) <= 0 ? { start: anchor, end: cursor } : { start: cursor, end: anchor };
}

/** True if the range spans at least one character. */
export function isRangeEmpty(range: SelectionRange): boolean {
  return comparePos(range.start, range.end) === 0;
}

/** Extract the text covered by a normalized range from logical lines. */
export function extractRangeText(lines: string[], range: SelectionRange): string {
  const { start, end } = range;
  if (start.line === end.line) {
    return (lines[start.line] ?? "").slice(start.col, end.col);
  }
  const parts: string[] = [];
  parts.push((lines[start.line] ?? "").slice(start.col));
  for (let i = start.line + 1; i < end.line; i++) {
    parts.push(lines[i] ?? "");
  }
  parts.push((lines[end.line] ?? "").slice(0, end.col));
  return parts.join("\n");
}

/**
 * Delete a normalized range from logical lines. Returns the new lines and
 * the cursor position left behind (always range.start, collapsed).
 */
export function deleteRange(
  lines: string[],
  range: SelectionRange,
): { lines: string[]; cursor: CursorPos } {
  const { start, end } = range;
  const before = (lines[start.line] ?? "").slice(0, start.col);
  const after = (lines[end.line] ?? "").slice(end.col);
  const merged = before + after;
  const newLines = [...lines.slice(0, start.line), merged, ...lines.slice(end.line + 1)];
  return { lines: newLines.length === 0 ? [""] : newLines, cursor: { line: start.line, col: start.col } };
}

/**
 * ANSI-aware visible-column range walker: given a rendered (possibly
 * styled) line and a [startCol, endCol) range of *visible* columns, wrap
 * that span in inverse video without corrupting existing ANSI sequences.
 * Delegates the actual ANSI-safe slicing to pi-tui's own `sliceWithWidth`,
 * which already skips escape codes and handles wide characters correctly.
 */
/**
 * Escape-sequence token at the start of the given string, or undefined.
 * Recognizes CSI (\x1b[...X), OSC (\x1b]...BEL or ST) and APC (\x1b_...BEL
 * or ST) sequences. pi renders its cursor as an APC marker (\x1b_pi:c\x07)
 * embedded in the row, so decoration must pass these through untouched or
 * the TUI loses the cursor entirely.
 */
function leadingEscapeSequence(text: string): string | undefined {
  if (!text.startsWith("\x1b")) return undefined;
  const csi = /^\x1b\[[0-9;:?<=>]*[@-~]/.exec(text);
  if (csi) return csi[0];
  const oscOrApc = /^\x1b[\]_][^\x07\x1b]*(?:\x07|\x1b\\)/.exec(text);
  if (oscOrApc) return oscOrApc[0];
  return undefined;
}

/** Strip all escape sequences, leaving only visible characters. */
export function stripEscapes(line: string): string {
  let out = "";
  let i = 0;
  while (i < line.length) {
    const esc = leadingEscapeSequence(line.slice(i));
    if (esc) {
      i += esc.length;
      continue;
    }
    out += line[i];
    i += 1;
  }
  return out;
}

/**
 * Wrap the visible-column range [startCol, endCol) in inverse video while
 * preserving every embedded escape sequence (colors, cursor APC marker).
 * Columns are counted per visible character (width 1 approximation).
 */
export function invertColumnRange(line: string, startCol: number, endCol: number): string {
  if (endCol <= startCol) return line;
  let out = "";
  let col = 0;
  let i = 0;
  let inverted = false;
  while (i < line.length) {
    const esc = leadingEscapeSequence(line.slice(i));
    if (esc) {
      const isCursorMarker = esc.startsWith("\x1b_");
      if (isCursorMarker) {
        // The TUI replaces the APC marker plus the following character with
        // its own styled cursor cell ending in a full attribute reset. Keep
        // marker + char atomic (nothing injected between them), close our
        // inversion beforehand, and re-open it after the cursor cell so the
        // reset does not wipe the rest of the selection highlight.
        if (inverted) {
          out += "\x1b[27m";
          inverted = false;
        }
        out += esc;
        i += esc.length;
        if (i < line.length && !line.startsWith("\x1b", i)) {
          out += line[i];
          col += 1;
          i += 1;
        }
        continue;
      }
      out += esc;
      i += esc.length;
      // The base render carries its own SGR sequences inside the row (the
      // software cursor is [7m<char>[0m, colors reset with [0m). Any of
      // them can cancel our inversion mid-span, so re-assert it after
      // every SGR while the span is open.
      if (inverted && /m$/.test(esc) && esc.startsWith("\x1b[")) {
        out += "\x1b[7m";
      }
      continue;
    }
    if (!inverted && col >= startCol && col < endCol) {
      out += "\x1b[7m";
      inverted = true;
    }
    if (inverted && col >= endCol) {
      out += "\x1b[27m";
      inverted = false;
    }
    out += line[i];
    col += 1;
    i += 1;
  }
  if (inverted) out += "\x1b[27m";
  return out;
}

// =============================================================================
// Visual line map (mirrors editor.js layoutText, using the exported
// wordWrapLine so wrapping matches what the base editor actually renders)
// =============================================================================

interface VisualLine {
  logicalLine: number;
  startCol: number;
  text: string;
}

/**
 * Greedy word-wrap approximation of pi-tui's internal (unexported)
 * wordWrapLine. Wraps at the last whitespace boundary that fits, falling
 * back to a hard break when a single token exceeds contentWidth. See the
 * "SECOND CAVEAT" in the file header for the fidelity trade-off.
 */
function buildVisualLines(lines: string[], contentWidth: number): VisualLine[] {
  const result: VisualLine[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (visibleWidth(line) <= contentWidth) {
      result.push({ logicalLine: i, startCol: 0, text: line });
      continue;
    }
    let start = 0;
    while (start < line.length) {
      let end = start;
      let width = 0;
      let lastBreak = -1;
      while (end < line.length) {
        const ch = line[end] ?? "";
        const chWidth = visibleWidth(ch);
        if (width + chWidth > contentWidth) break;
        width += chWidth;
        if (ch === " ") lastBreak = end;
        end += 1;
      }
      if (end >= line.length) {
        result.push({ logicalLine: i, startCol: start, text: line.slice(start, end) });
        start = end;
        break;
      }
      const breakAt = lastBreak > start ? lastBreak + 1 : end;
      result.push({ logicalLine: i, startCol: start, text: line.slice(start, breakAt) });
      start = breakAt;
    }
    if (line.length === 0) {
      result.push({ logicalLine: i, startCol: 0, text: "" });
    }
  }
  return result;
}

// =============================================================================
// Grapheme-safe movement helpers (mirror editor.js private moveCursor logic)
// =============================================================================

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const wordSegmenter = new Intl.Segmenter(undefined, { granularity: "word" });

function graphemesOf(text: string): string[] {
  return [...graphemeSegmenter.segment(text)].map((s) => s.segment);
}

function stepColRight(line: string, col: number): number {
  if (col >= line.length) return col;
  const after = line.slice(col);
  const first = graphemesOf(after)[0] ?? after[0] ?? "";
  return col + (first.length || 1);
}

function stepColLeft(line: string, col: number): number {
  if (col <= 0) return 0;
  const before = line.slice(0, col);
  const graphemes = graphemesOf(before);
  const last = graphemes[graphemes.length - 1] ?? "";
  return col - (last.length || 1);
}

/** Word-left, matching editor.js moveWordBackwards' word-boundary semantics closely enough for selection extension. */
function wordLeft(lines: string[], pos: CursorPos): CursorPos {
  let { line, col } = pos;
  if (col === 0) {
    if (line === 0) return pos;
    line -= 1;
    col = (lines[line] ?? "").length;
    return { line, col };
  }
  const text = lines[line] ?? "";
  const words = [...wordSegmenter.segment(text)];
  let target = 0;
  for (const w of words) {
    if (w.index >= col) break;
    if (w.isWordLike) target = w.index;
  }
  return { line, col: target };
}

/** Word-right, matching editor.js moveWordForwards' word-boundary semantics closely enough for selection extension. */
function wordRight(lines: string[], pos: CursorPos): CursorPos {
  let { line, col } = pos;
  const text = lines[line] ?? "";
  if (col >= text.length) {
    if (line >= lines.length - 1) return pos;
    return { line: line + 1, col: 0 };
  }
  const words = [...wordSegmenter.segment(text)];
  for (const w of words) {
    if (w.index > col && w.isWordLike) return { line, col: w.index };
  }
  return { line, col: text.length };
}

// =============================================================================
// Extension
// =============================================================================

const SELECTION_SHIFT_KEYS = [
  "shift+left",
  "shift+right",
  "shift+up",
  "shift+down",
  "shift+home",
  "shift+end",
  "alt+shift+left",
  "alt+shift+right",
] as const;

/**
 * Structural view of the editor instance we graft onto. Any pi-tui Editor
 * subclass satisfies this, including pi-powerline-footer's BashModeEditor.
 */
interface GraftableEditor {
  getCursor(): { line: number; col: number };
  getLines(): string[];
  setText(text: string): void;
  getPaddingX(): number;
  handleInput(data: string): void;
  render(width: number): string[];
}

class SelectionBehavior {
  private anchor: CursorPos | undefined;

  constructor(
    private readonly editor: GraftableEditor,
    private readonly originalHandleInput: (data: string) => void,
    private readonly originalRender: (width: number) => string[],
  ) {}

  private get rawState(): { lines: string[]; cursorLine: number; cursorCol: number } {
    // See file header: Editor.state is private in pi-tui's type declarations.
    return (this.editor as unknown as { state: { lines: string[]; cursorLine: number; cursorCol: number } }).state;
  }

  private requestRender(): void {
    try {
      (this.editor as unknown as { tui?: { requestRender?: () => void } }).tui?.requestRender?.();
    } catch {
      // Rendering refresh is best-effort; the next keystroke repaints anyway.
    }
  }

  private currentPos(): CursorPos {
    const cursor = this.editor.getCursor();
    return { line: cursor.line, col: cursor.col };
  }

  private hasSelection(): boolean {
    return this.anchor !== undefined;
  }

  private clearSelection(): void {
    if (this.anchor === undefined) return;
    this.anchor = undefined;
    this.requestRender();
  }

  private currentRange(): SelectionRange | undefined {
    if (!this.anchor) return undefined;
    const range = normalizeRange(this.anchor, this.currentPos());
    return isRangeEmpty(range) ? undefined : range;
  }

  private setCursorTo(pos: CursorPos): void {
    try {
      const state = this.rawState;
      state.cursorLine = pos.line;
      state.cursorCol = pos.col;
    } catch {
      // Fall through silently: base editor still functions, just without
      // this specific cursor placement.
    }
  }

  private extendSelection(mover: (lines: string[], pos: CursorPos) => CursorPos): void {
    if (this.anchor === undefined) {
      this.anchor = this.currentPos();
    }
    const lines = this.editor.getLines();
    const next = mover(lines, this.currentPos());
    this.setCursorTo(next);
    this.requestRender();
  }

  private extendSelectionSimple(deltaLine: number, deltaCol: number, toLineEdge?: "start" | "end"): void {
    this.extendSelection((lines, pos) => {
      if (toLineEdge === "start") return { line: pos.line, col: 0 };
      if (toLineEdge === "end") return { line: pos.line, col: (lines[pos.line] ?? "").length };
      if (deltaCol > 0) return { line: pos.line, col: stepColRight(lines[pos.line] ?? "", pos.col) };
      if (deltaCol < 0) return { line: pos.line, col: stepColLeft(lines[pos.line] ?? "", pos.col) };
      if (deltaLine !== 0) {
        const targetLine = Math.max(0, Math.min(lines.length - 1, pos.line + deltaLine));
        const targetCol = Math.min(pos.col, (lines[targetLine] ?? "").length);
        return { line: targetLine, col: targetCol };
      }
      return pos;
    });
  }

  private deleteSelection(): boolean {
    const range = this.currentRange();
    if (!range) return false;
    const lines = this.editor.getLines();
    const { lines: newLines, cursor } = deleteRange(lines, range);
    this.anchor = undefined;
    this.editor.setText(newLines.join("\n"));
    // setText() always parks the cursor at the end of the new text; walk
    // it back to where the deletion actually left it via the same public
    // grapheme-safe movement used for shift+arrow (left-only backtrack is
    // sufficient since setText places the cursor after all new content).
    this.setCursorTo(cursor);
    this.requestRender();
    return true;
  }

  private copySelectionToClipboard(): void {
    const range = this.currentRange();
    if (!range) return;
    const text = extractRangeText(this.editor.getLines(), range);
    try {
      const proc = spawn("pbcopy");
      proc.stdin.write(text);
      proc.stdin.end();
      proc.on("error", () => {
        // No clipboard available (non-macOS, sandboxed, etc.) - selection
        // stays intact, just nothing is copied.
      });
    } catch {
      // Never let clipboard failure break the editor.
    }
    this.anchor = undefined;
    this.requestRender();
  }

  handleInput(data: string): void {
    try {
      for (const key of SELECTION_SHIFT_KEYS) {
        if (!matchesKey(data, key)) continue;
        switch (key) {
          case "shift+left":
            this.extendSelectionSimple(0, -1);
            return;
          case "shift+right":
            this.extendSelectionSimple(0, 1);
            return;
          case "shift+up":
            this.extendSelectionSimple(-1, 0);
            return;
          case "shift+down":
            this.extendSelectionSimple(1, 0);
            return;
          case "shift+home":
            this.extendSelectionSimple(0, 0, "start");
            return;
          case "shift+end":
            this.extendSelectionSimple(0, 0, "end");
            return;
          case "alt+shift+left":
            this.extendSelection(wordLeft);
            return;
          case "alt+shift+right":
            this.extendSelection(wordRight);
            return;
        }
      }

      // Copy: with a selection, copy it and keep the text (do not fall
      // through to super, whose ctrl+c clears the whole editor).
      if (this.hasSelection() && matchesKey(data, "ctrl+c")) {
        this.copySelectionToClipboard();
        return;
      }

      // Backspace/delete with an active selection removes the selection
      // instead of a single character.
      if (this.hasSelection() && (matchesKey(data, "backspace") || matchesKey(data, "delete") || matchesKey(data, "ctrl+d"))) {
        this.deleteSelection();
        return;
      }

      // Escape clears the selection first; only aborts on the next press.
      if (this.hasSelection() && matchesKey(data, "escape")) {
        this.clearSelection();
        return;
      }

      // Any other input with an active selection: if it looks like a
      // printable insert or paste, replace the selection first, then let
      // super perform the actual insertion at the now-collapsed cursor.
      if (this.hasSelection() && this.looksLikeReplacingInput(data)) {
        this.deleteSelection();
        this.originalHandleInput(data);
        return;
      }

      // Any unshifted cursor movement (or anything else) clears a
      // dangling selection so it never goes stale.
      if (this.hasSelection() && this.looksLikeUnshiftedMovement(data)) {
        this.clearSelection();
      }

      this.originalHandleInput(data);
    } catch {
      // Selection handling must never break the editor: fall back to
      // stock behavior for this keystroke.
      try {
        this.anchor = undefined;
      } catch {
        // ignore
      }
      this.originalHandleInput(data);
    }
  }

  private looksLikeUnshiftedMovement(data: string): boolean {
    return (
      matchesKey(data, "left") ||
      matchesKey(data, "right") ||
      matchesKey(data, "up") ||
      matchesKey(data, "down") ||
      matchesKey(data, "home") ||
      matchesKey(data, "end") ||
      matchesKey(data, "alt+left") ||
      matchesKey(data, "alt+right") ||
      matchesKey(data, "ctrl+left") ||
      matchesKey(data, "ctrl+right") ||
      matchesKey(data, "pageUp") ||
      matchesKey(data, "pageDown") ||
      matchesKey(data, "enter") ||
      matchesKey(data, "return")
    );
  }

  private looksLikeReplacingInput(data: string): boolean {
    // Bracketed paste start, or a plain printable/control-free byte
    // sequence (not an escape/CSI movement or function sequence).
    if (data.includes("\x1b[200~")) return true;
    if (data.startsWith("\x1b")) return false;
    if (data.length === 0) return false;
    const code = data.charCodeAt(0);
    // Exclude other control characters (tab, ctrl+*, etc.); allow normal
    // printable text and newlines from paste.
    if (code < 32 && code !== 10 && code !== 13) return false;
    return true;
  }

  render(width: number): string[] {
    const base = this.originalRender(width);
    try {
      const range = this.currentRange();
      if (!range) return base;
      return this.highlightRange(base, width, range);
    } catch {
      return base;
    }
  }

  private highlightRange(rendered: string[], width: number, range: SelectionRange): string[] {
    const paddingX = this.editor.getPaddingX();
    const maxPadding = Math.max(0, Math.floor((width - 1) / 2));
    const effectivePaddingX = Math.min(paddingX, maxPadding);
    const contentWidth = Math.max(1, width - effectivePaddingX * 2);
    const layoutWidth = Math.max(1, contentWidth - (effectivePaddingX ? 0 : 1));

    const lines = this.editor.getLines();
    const visualLines = buildVisualLines(lines, layoutWidth);

    // rendered[] includes a top border row before the first content row
    // (see editor.js render(): border, then one row per visible layout
    // line, then border/autocomplete). We only ever decorate rows that
    // correspond 1:1 to visualLines, offset by the leading border row.
    const contentRowOffset = 1;

    const out = [...rendered];
    for (let vi = 0; vi < visualLines.length; vi++) {
      const rowIndex = vi + contentRowOffset;
      if (rowIndex < 0 || rowIndex >= out.length) continue;

      const vl = visualLines[vi];
      if (!vl) continue;
      const vlEndCol = vl.startCol + vl.text.length;

      // Does this visual row intersect the logical selection range?
      const rowStartPos: CursorPos = { line: vl.logicalLine, col: vl.startCol };
      const rowEndPos: CursorPos = { line: vl.logicalLine, col: vlEndCol };
      const intersectsStart = comparePos(rowEndPos, range.start) > 0;
      const intersectsEnd = comparePos(rowStartPos, range.end) < 0;
      if (!(intersectsStart && intersectsEnd)) continue;

      const selStartCol =
        range.start.line < vl.logicalLine || (range.start.line === vl.logicalLine && range.start.col <= vl.startCol)
          ? vl.startCol
          : Math.max(vl.startCol, range.start.col);
      const selEndCol =
        range.end.line > vl.logicalLine || (range.end.line === vl.logicalLine && range.end.col >= vlEndCol)
          ? vlEndCol
          : Math.min(vlEndCol, range.end.col);

      const visualStart = selStartCol - vl.startCol;
      const visualEnd = selEndCol - vl.startCol;
      if (visualEnd <= visualStart) continue;

      const row = out[rowIndex];
      if (row === undefined) continue;
      // Rows can carry a prompt prefix (e.g. "> ") and padding before the
      // content; locate the logical text inside the visible row to get the
      // real column offset instead of assuming the content starts at 0.
      const stripped = stripEscapes(row);
      if (vl.text.length === 0) continue;
      const offset = stripped.indexOf(vl.text);
      if (offset < 0) continue;
      out[rowIndex] = invertColumnRange(row, offset + visualStart, offset + visualEnd);
    }
    return out;
  }
}

const SELECTION_ATTACHED = Symbol.for("pi.select-editor.attached");
const COMPOSED_FACTORY = Symbol.for("pi.select-editor.composed");

/** Graft selection behavior onto an existing editor instance, idempotently. */
function attachSelection(editor: GraftableEditor): void {
  const anyEditor = editor as unknown as Record<PropertyKey, unknown>;
  if (anyEditor[SELECTION_ATTACHED]) return;
  anyEditor[SELECTION_ATTACHED] = true;
  const behavior = new SelectionBehavior(
    editor,
    editor.handleInput.bind(editor),
    editor.render.bind(editor),
  );
  anyEditor.handleInput = (data: string) => behavior.handleInput(data);
  anyEditor.render = (width: number) => behavior.render(width);
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    // pi-powerline-footer replaces the editor (BashModeEditor) in its own
    // session_start handler and would win a direct race: its factory only
    // reuses the previous editor's autocomplete, discarding the rest. So
    // defer, capture whatever factory won, and graft selection onto the
    // editor instance that factory actually produces.
    setTimeout(() => {
      try {
        const previousFactory = ctx.ui.getEditorComponent?.();
        if (previousFactory && (previousFactory as unknown as Record<PropertyKey, unknown>)[COMPOSED_FACTORY]) {
          return;
        }
        const composed = (tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => {
          const base = previousFactory
            ? previousFactory(tui, theme, keybindings)
            : new CustomEditor(tui, theme, keybindings);
          attachSelection(base as unknown as GraftableEditor);
          return base;
        };
        (composed as unknown as Record<PropertyKey, unknown>)[COMPOSED_FACTORY] = true;
        ctx.ui.setEditorComponent(composed);
      } catch {
        // If composition fails, leave the editor stock.
      }
    }, 150);
  });
}
