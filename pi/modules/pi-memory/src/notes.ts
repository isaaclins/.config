import type { MemoryAuthority, MemoryRecord, MemoryScope } from "./memory-authority.ts";

/**
 * Plain, host-independent handler logic for the notes UX (remember tool,
 * /remember, /memory, /forget, and the session-end nudge). These functions
 * take a MemoryAuthority so node:test can drive them without a real Pi host.
 *
 * Notes are stored via MemoryAuthority.appendNote (append-only, unique key
 * per call), never upsert. Global notes are kind 'preference' and project
 * notes are kind 'fact', matching buildInjection eligibility.
 */

export const NUDGE_MIN_TURNS = 10;
export const NUDGE_MIN_MS = 15 * 60 * 1000;
export const NUDGE_MESSAGE = "Anything worth remembering? /remember [-g] <note>";

export interface RememberInput {
  note: string;
  scope: MemoryScope;
}

export interface DisplayNote {
  index: string;
  record: MemoryRecord;
}

export type ForgetStatus = "retired" | "ambiguous" | "none";

export interface ForgetResult {
  status: ForgetStatus;
  message: string;
}

export interface NudgeState {
  turnCount: number;
  elapsedMs: number;
  rememberUsed: boolean;
  nudgeShown: boolean;
}

function kindForScope(scope: MemoryScope): "preference" | "fact" {
  return scope === "global" ? "preference" : "fact";
}

/**
 * Mirror repo-memory.ts argument parsing: a leading -g or --global flag
 * selects global scope, everything else is the note text.
 */
export function parseRememberArgs(args: string | undefined): { scope: MemoryScope; note: string } {
  let text = (args ?? "").trim();
  const isGlobal = /^(-g|--global)(\s+|$)/.test(text);
  if (isGlobal) text = text.replace(/^(-g|--global)\s*/, "");
  return { scope: isGlobal ? "global" : "project", note: text.trim() };
}

export function rememberNote(authority: MemoryAuthority, input: RememberInput): MemoryRecord {
  return authority.appendNote({
    scope: input.scope,
    kind: kindForScope(input.scope),
    value: input.note,
  });
}

/** Active records for both scopes with fresh, stable display indices. */
export function buildIndexedNotes(authority: MemoryAuthority): {
  global: DisplayNote[];
  project: DisplayNote[];
} {
  const global = authority
    .listActive("global")
    .map((record, position) => ({ index: `g${position + 1}`, record }));
  const project = authority
    .listActive("project")
    .map((record, position) => ({ index: `p${position + 1}`, record }));
  return { global, project };
}

function formatNote(note: DisplayNote): string {
  return `${note.index}: [${note.record.createdAt.slice(0, 10)}] ${note.record.value}`;
}

export function buildMemoryListing(authority: MemoryAuthority): string {
  const { global, project } = buildIndexedNotes(authority);
  const lines: string[] = [];
  lines.push("## Global notes");
  lines.push(...(global.length ? global.map(formatNote) : ["(none)"]));
  lines.push("");
  lines.push("## Project notes");
  lines.push(...(project.length ? project.map(formatNote) : ["(none)"]));
  return lines.join("\n");
}

export function forgetNote(authority: MemoryAuthority, query: string | undefined): ForgetResult {
  const trimmed = (query ?? "").trim();
  if (!trimmed) {
    return { status: "none", message: "Usage: /forget <g2|p3> or /forget <search text>" };
  }

  const { global, project } = buildIndexedNotes(authority);
  const all = [...global, ...project];

  const indexMatch = /^([gp])(\d+)$/i.exec(trimmed);
  if (indexMatch) {
    const index = `${indexMatch[1].toLowerCase()}${indexMatch[2]}`;
    const note = all.find((candidate) => candidate.index === index);
    if (!note) return { status: "none", message: `No note with index ${index}` };
    authority.retire(note.record.scope, note.record.key);
    return { status: "retired", message: `Forgot ${note.index}: ${note.record.value}` };
  }

  const needle = trimmed.toLowerCase();
  const matches = all.filter((candidate) => candidate.record.value.toLowerCase().includes(needle));
  if (matches.length === 0) {
    return { status: "none", message: `No note matches "${trimmed}"` };
  }
  if (matches.length > 1) {
    const list = matches.map(formatNote).join("\n");
    return {
      status: "ambiguous",
      message: `${matches.length} notes match "${trimmed}", nothing retired. Use /forget <index>:\n${list}`,
    };
  }

  const note = matches[0];
  authority.retire(note.record.scope, note.record.key);
  return { status: "retired", message: `Forgot ${note.index}: ${note.record.value}` };
}

export function shouldShowNudge(state: NudgeState): boolean {
  if (state.nudgeShown || state.rememberUsed) return false;
  return state.turnCount >= NUDGE_MIN_TURNS || state.elapsedMs >= NUDGE_MIN_MS;
}
