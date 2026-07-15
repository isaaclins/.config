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
 * 2. Notes (.pi/memory.local.md): durable facts the agent or user records
 *    via the `remember` tool or the /remember command while working. No
 *    background summarizer fork, so no extra quota burn.
 *
 * Both are injected into the system prompt on the first prompt of a session.
 * Both files are excluded from git via .git/info/exclude (local only).
 */

const MAX_TREE_LINES = 80;
const MAX_NOTE_LINES = 100;

export default function (pi: ExtensionAPI) {
  let injectedThisSession = false;

  pi.on("session_start", async () => {
    injectedThisSession = false;
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (injectedThisSession) return;
    injectedThisSession = true;

    const cwd = process.cwd();
    if (!isGitRepo(cwd)) return;

    ensureGitExcludes(cwd);
    const repoMap = getOrBuildRepoMap(cwd);
    const notes = readNotes(cwd);

    const sections: string[] = [];
    if (repoMap) {
      sections.push(
        "## Repo map (auto-generated, trust it, do not re-scout the repo structure)\n\n" +
          repoMap,
      );
    }
    if (notes) {
      sections.push("## Repo memory notes (learned in previous sessions)\n\n" + notes);
    }
    if (sections.length === 0) return;

    return {
      systemPrompt: event.systemPrompt + "\n\n" + sections.join("\n\n"),
    };
  });

  pi.registerTool({
    name: "remember",
    label: "Remember",
    description:
      "Persist a durable fact about this repo for future sessions (build/test commands, architecture decisions, gotchas, file locations). Use whenever you learn something that took effort to discover and will be useful again. Keep each note to one concise line.",
    parameters: Type.Object({
      note: Type.String({ description: "One-line durable fact about this repo" }),
    }),
    async execute(_toolCallId, params) {
      appendNote(process.cwd(), params.note);
      return {
        content: [{ type: "text", text: `Remembered: ${params.note}` }],
        details: {},
      };
    },
  });

  pi.registerCommand("remember", {
    description: "Save a repo memory note for future sessions",
    handler: async (args, ctx) => {
      if (!args?.trim()) {
        ctx.ui.notify("Usage: /remember <note>", "warning");
        return;
      }
      appendNote(process.cwd(), args.trim());
      ctx.ui.notify("Note saved to .pi/memory.local.md", "info");
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

  return parts.join("\n\n");
}

function notesPath(cwd: string): string {
  return join(piDir(cwd), "memory.local.md");
}

function readNotes(cwd: string): string {
  const path = notesPath(cwd);
  if (!existsSync(path)) return "";
  const lines = readFileSync(path, "utf8").trim().split("\n");
  return lines.slice(-MAX_NOTE_LINES).join("\n");
}

function appendNote(cwd: string, note: string): void {
  const date = new Date().toISOString().slice(0, 10);
  appendFileSync(notesPath(cwd), `- [${date}] ${note}\n`);
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
