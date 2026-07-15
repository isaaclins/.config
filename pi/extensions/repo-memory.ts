import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Zero-LLM repo memory.
 *
 * Goal: never make the model re-scout a known repo. Two layers, both free:
 *
 * 1. Repo map (.pi/repo-map.local.md): a deterministic snapshot built by
 *    shell commands (file tree, manifests, scripts, README head). Cached and
 *    keyed by git HEAD + dirty signature, so it rebuilds only when the repo
 *    actually changes. Costs zero LLM output tokens; only a small amount of
 *    injected context.
 *
 * 2. Notes, two scopes:
 *    - Project (.pi/memory.local.md in the repo, git-excluded): facts about
 *      THIS repo (build/test commands, architecture gotchas).
 *    - Global (~/.config/pi/memory.md, dotfiles-tracked): facts about the
 *      user, their preferences, tools, and cross-repo habits.
 *    Recorded via the `remember` tool (scope param) or /remember command
 *    (-g/--global flag). No background summarizer fork, so no quota burn.
 *
 * All layers are injected into the system prompt on the first prompt of a
 * session; global notes are injected even outside git repos. Notes older
 * than NOTE_STALE_DAYS are flagged (in the injected copy only, files are
 * never rewritten by the aging check) so the model knows to double check
 * them instead of trusting them blindly.
 *
 * Commands:
 * - /remember [-g|--global] <note>: append a note (see above).
 * - /memory: list every note in both scopes with stable indices (g1, g2,
 *   ... for global, p1, p2, ... for project) so /forget has something to
 *   target.
 * - /forget <g2|p3>: delete that exact note by index.
 * - /forget <free text>: case-insensitive search across both scopes. Only
 *   deletes if exactly one note matches; otherwise nothing is deleted and
 *   the candidates are listed instead. This never multi-deletes.
 *
 * Session-end nudge: if a session runs long (10+ turns, or 15+ minutes as a
 * fallback) and never called the remember tool, a single reminder is shown
 * on agent_end. Zero LLM calls, zero network, fires at most once per
 * session.
 */

const MAX_TREE_LINES = 80;
const MAX_NOTE_LINES = 100;
const NOTE_STALE_DAYS = 90;
const NUDGE_MIN_TURNS = 10;
const NUDGE_MIN_MS = 15 * 60 * 1000;

export default function (pi: ExtensionAPI) {
  let injectedThisSession = false;
  let rememberCalledThisSession = false;
  let nudgeShownThisSession = false;
  let sessionStartedAt = 0;
  let turnCount = 0;

  pi.on("session_start", async () => {
    injectedThisSession = false;
    rememberCalledThisSession = false;
    nudgeShownThisSession = false;
    sessionStartedAt = Date.now();
    turnCount = 0;
  });

  pi.on("turn_end", async () => {
    turnCount += 1;
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (injectedThisSession) return;
    injectedThisSession = true;

    const cwd = process.cwd();
    const sections: string[] = [];

    const globalNotes = readNotesFile(globalNotesPath());
    if (globalNotes) {
      sections.push(
        "## Global memory notes (about the user and their environment, all projects)\n\n" +
          annotateStaleNotes(globalNotes),
      );
    }

    if (isGitRepo(cwd)) {
      ensureGitExcludes(cwd);
      const repoMap = getOrBuildRepoMap(cwd);
      const notes = readNotesFile(notesPath(cwd));
      if (repoMap) {
        sections.push(
          "## Repo map (auto-generated, trust it, do not re-scout the repo structure)\n\n" +
            repoMap,
        );
      }
      if (notes) {
        sections.push(
          "## Repo memory notes (learned in previous sessions)\n\n" + annotateStaleNotes(notes),
        );
      }
    }
    if (sections.length === 0) return;

    return {
      systemPrompt: event.systemPrompt + "\n\n" + sections.join("\n\n"),
    };
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (nudgeShownThisSession || rememberCalledThisSession) return;

    const elapsedMs = sessionStartedAt ? Date.now() - sessionStartedAt : 0;
    const isLongSession = turnCount >= NUDGE_MIN_TURNS || elapsedMs >= NUDGE_MIN_MS;
    if (!isLongSession) return;

    nudgeShownThisSession = true;
    ctx.ui.notify("Anything worth remembering? /remember [-g] <note>", "info");
  });

  pi.registerTool({
    name: "remember",
    label: "Remember",
    description:
      "Persist a durable fact for future sessions. scope='project' (default) for facts about THIS repo (build/test commands, architecture decisions, gotchas, file locations). scope='global' for facts about the user, their preferences, tools, or habits that apply across ALL projects. Keep each note to one concise line.",
    parameters: Type.Object({
      note: Type.String({ description: "One-line durable fact" }),
      scope: Type.Optional(
        Type.Union([Type.Literal("project"), Type.Literal("global")], {
          description:
            "'project' (default): about this repo only. 'global': about the user/environment, applies everywhere.",
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      const scope = params.scope === "global" ? "global" : "project";
      const path = scope === "global" ? globalNotesPath() : notesPath(process.cwd());
      appendNote(path, params.note);
      rememberCalledThisSession = true;
      return {
        content: [{ type: "text", text: `Remembered (${scope}): ${params.note}` }],
        details: {},
      };
    },
  });

  pi.registerCommand("remember", {
    description: "Save a memory note for future sessions (-g/--global for user-wide notes)",
    handler: async (args, ctx) => {
      let text = args?.trim() ?? "";
      const isGlobal = /^(-g|--global)\s+/.test(text);
      if (isGlobal) text = text.replace(/^(-g|--global)\s+/, "");
      if (!text) {
        ctx.ui.notify("Usage: /remember [-g|--global] <note>", "warning");
        return;
      }
      if (isGlobal) {
        appendNote(globalNotesPath(), text);
        ctx.ui.notify("Note saved to ~/.config/pi/memory.md (global)", "info");
      } else {
        appendNote(notesPath(process.cwd()), text);
        ctx.ui.notify("Note saved to .pi/memory.local.md", "info");
      }
      rememberCalledThisSession = true;
    },
  });

  pi.registerCommand("memory", {
    description: "List all memory notes from both scopes with their /forget indices",
    handler: async (_args, ctx) => {
      const cwd = process.cwd();
      const global = listNotes(globalNotesPath(), "g");
      const project = isGitRepo(cwd) ? listNotes(notesPath(cwd), "p") : [];

      const lines: string[] = [];
      lines.push("## Global notes (~/.config/pi/memory.md)");
      lines.push(...(global.length ? global.map(formatIndexedNote) : ["(none)"]));
      lines.push("");
      lines.push("## Project notes (.pi/memory.local.md)");
      lines.push(...(project.length ? project.map(formatIndexedNote) : ["(none, or not in a git repo)"]));

      const text = lines.join("\n");
      if (text.length <= 1500) {
        ctx.ui.notify(text, "info");
        return;
      }

      const tmpPath = join(tmpdir(), `pi-memory-${Date.now()}.md`);
      writeFileSync(tmpPath, text);
      ctx.ui.notify(`Memory list is long, written to ${tmpPath}`, "info");
    },
  });

  pi.registerCommand("forget", {
    description: "Delete a memory note by index (g2, p3) or by unique text match",
    handler: async (args, ctx) => {
      const query = args?.trim() ?? "";
      if (!query) {
        ctx.ui.notify("Usage: /forget <g2|p3> or /forget <search text>", "warning");
        return;
      }

      const cwd = process.cwd();
      const global = listNotes(globalNotesPath(), "g");
      const project = isGitRepo(cwd) ? listNotes(notesPath(cwd), "p") : [];
      const all = [...global, ...project];

      const indexMatch = /^([gp])(\d+)$/i.exec(query);
      if (indexMatch) {
        const index = `${indexMatch[1].toLowerCase()}${indexMatch[2]}`;
        const note = all.find((n) => n.index === index);
        if (!note) {
          ctx.ui.notify(`No note with index ${index}`, "warning");
          return;
        }
        deleteNote(note);
        ctx.ui.notify(`Forgot ${note.index}: ${note.text}`, "info");
        return;
      }

      const needle = query.toLowerCase();
      const matches = all.filter((n) => n.text.toLowerCase().includes(needle));
      if (matches.length === 0) {
        ctx.ui.notify(`No note matches "${query}"`, "warning");
        return;
      }
      if (matches.length > 1) {
        const list = matches.map(formatIndexedNote).join("\n");
        ctx.ui.notify(
          `${matches.length} notes match "${query}", nothing deleted. Use /forget <index>:\n${list}`,
          "warning",
        );
        return;
      }

      const note = matches[0];
      deleteNote(note);
      ctx.ui.notify(`Forgot ${note.index}: ${note.text}`, "info");
    },
  });
}

function sh(command: string, cwd: string): string {
  try {
    return execSync(command, { cwd, stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return "";
  }
}

function isGitRepo(cwd: string): boolean {
  return sh("git rev-parse --is-inside-work-tree", cwd) === "true";
}

function piDir(cwd: string): string {
  const dir = join(sh("git rev-parse --show-toplevel", cwd) || cwd, ".pi");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function repoSignature(cwd: string): string {
  const head = sh("git rev-parse HEAD", cwd);
  const dirty = sh("git status --porcelain | shasum | cut -d' ' -f1", cwd);
  return `${head}:${dirty}`;
}

function getOrBuildRepoMap(cwd: string): string {
  const mapPath = join(piDir(cwd), "repo-map.local.md");
  const signature = repoSignature(cwd);
  const signatureMarker = `<!-- signature: ${signature} -->`;

  if (existsSync(mapPath)) {
    const cached = readFileSync(mapPath, "utf8");
    if (cached.startsWith(signatureMarker)) {
      return cached.slice(signatureMarker.length).trim();
    }
  }

  const map = buildRepoMap(cwd);
  writeFileSync(mapPath, `${signatureMarker}\n${map}\n`);
  return map;
}

function buildRepoMap(cwd: string): string {
  const parts: string[] = [];

  const branch = sh("git branch --show-current", cwd);
  const remote = sh("git remote get-url origin", cwd);
  parts.push(`Branch: ${branch || "detached"}${remote ? ` | Remote: ${remote}` : ""}`);

  const tree = sh(
    `git ls-files | awk -F/ '{ if (NF==1) print $1; else print $1 "/" ($3 ? $2 "/…" : $2) }' | sort -u | head -${MAX_TREE_LINES}`,
    cwd,
  );
  if (tree) parts.push("### Files (top two levels)\n```\n" + tree + "\n```");

  for (const manifest of [
    "package.json",
    "Cargo.toml",
    "pyproject.toml",
    "go.mod",
    "Package.swift",
    "composer.json",
  ]) {
    if (!existsSync(join(cwd, manifest))) continue;
    if (manifest === "package.json") {
      const scripts = sh(
        `python3 -c "import json;d=json.load(open('package.json'));print(d.get('name',''));print('\\n'.join(f'  {k}: {v}' for k,v in d.get('scripts',{}).items()))"`,
        cwd,
      );
      parts.push("### package.json name + scripts\n```\n" + scripts + "\n```");
    } else {
      parts.push(`Manifest present: ${manifest}`);
    }
  }

  const makeTargets = sh(
    "[ -f Makefile ] && grep -E '^[a-zA-Z0-9_-]+:' Makefile | cut -d: -f1 | head -15 | tr '\\n' ' '",
    cwd,
  );
  if (makeTargets) parts.push(`Make targets: ${makeTargets}`);

  const readmeHead = sh("head -15 README.md 2>/dev/null", cwd);
  if (readmeHead) parts.push("### README head\n```\n" + readmeHead + "\n```");

  const recentLog = sh("git log --oneline -5", cwd);
  const recentFiles = sh("git diff --name-only HEAD~5..HEAD 2>/dev/null | head -10", cwd);
  if (recentLog || recentFiles) {
    const activityParts: string[] = [];
    if (recentLog) activityParts.push("Last 5 commits:\n" + recentLog);
    if (recentFiles) activityParts.push("Recently changed files:\n" + recentFiles);
    parts.push("### Recent activity\n```\n" + activityParts.join("\n\n") + "\n```");
  }

  return parts.join("\n\n");
}

function notesPath(cwd: string): string {
  return join(piDir(cwd), "memory.local.md");
}

function globalNotesPath(): string {
  return join(homedir(), ".config", "pi", "memory.md");
}

function readNotesFile(path: string): string {
  if (!existsSync(path)) return "";
  const lines = readFileSync(path, "utf8").trim().split("\n");
  return lines.slice(-MAX_NOTE_LINES).join("\n");
}

function appendNote(path: string, note: string): void {
  const date = new Date().toISOString().slice(0, 10);
  appendFileSync(path, `- [${date}] ${note}\n`);
}

interface IndexedNote {
  index: string;
  text: string;
  path: string;
  lineIndex: number;
}

// Reads a notes file fresh from disk (no MAX_NOTE_LINES truncation, unlike
// readNotesFile which is for system-prompt injection) and returns every
// line with a stable index computed from current file order, so /memory and
// /forget always agree with what is actually on disk right now.
function listNotes(path: string, prefix: "g" | "p"): IndexedNote[] {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf8").split("\n");
  const notes: IndexedNote[] = [];
  let noteNumber = 0;
  lines.forEach((line, lineIndex) => {
    if (!line.trim()) return;
    noteNumber += 1;
    notes.push({ index: `${prefix}${noteNumber}`, text: line, path, lineIndex });
  });
  return notes;
}

function formatIndexedNote(note: IndexedNote): string {
  return `${note.index}: ${note.text}`;
}

function deleteNote(note: IndexedNote): void {
  const lines = readFileSync(note.path, "utf8").split("\n");
  lines.splice(note.lineIndex, 1);
  writeFileSync(note.path, lines.join("\n"));
}

// Appends ' (old, verify before trusting)' to any note line older than
// NOTE_STALE_DAYS, for the copy injected into the system prompt only. Never
// touches the underlying file.
function annotateStaleNotes(notesBlock: string): string {
  const cutoff = Date.now() - NOTE_STALE_DAYS * 24 * 60 * 60 * 1000;
  return notesBlock
    .split("\n")
    .map((line) => {
      const match = /^- \[(\d{4}-\d{2}-\d{2})\]/.exec(line);
      if (!match) return line;
      const noteDate = new Date(match[1]).getTime();
      if (Number.isNaN(noteDate) || noteDate >= cutoff) return line;
      return `${line} (old, verify before trusting)`;
    })
    .join("\n");
}

function ensureGitExcludes(cwd: string): void {
  const gitDir = sh("git rev-parse --git-dir", cwd);
  if (!gitDir) return;
  const excludePath = join(cwd, gitDir, "info", "exclude");
  const entries = [".pi/memory.local.md", ".pi/repo-map.local.md"];
  let current = "";
  try {
    current = readFileSync(excludePath, "utf8");
  } catch {
    mkdirSync(join(cwd, gitDir, "info"), { recursive: true });
  }
  const missing = entries.filter((entry) => !current.includes(entry));
  if (missing.length === 0) return;
  appendFileSync(excludePath, missing.join("\n") + "\n");
}
