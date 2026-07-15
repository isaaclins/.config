import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, normalize } from "node:path";
import { homedir } from "node:os";

/**
 * Bridge to Aside Browser's agent memory (read-only).
 *
 * Aside maintains a layered memory at ~/.aside/u/0/agents/main/memory:
 * - L1 briefings (MEMORY.md, USER.md): tiny by design, meant for prompt
 *   loading. Injected into the system prompt once per session (~1K tokens).
 * - Deeper layers (people/, sites/, projects/, episodic/, users/, agent/):
 *   exposed through the aside_memory tool, so they cost nothing until the
 *   model actually needs them.
 *
 * Pi never writes to Aside's memory; Aside's own "dreaming" process owns it.
 */

const MEMORY_ROOT = join(homedir(), ".aside/u/0/agents/main/memory");
const IGNORED_DIRS = new Set([".moss-cache"]);

export default function (pi: ExtensionAPI) {
  let injectedThisSession = false;

  pi.on("session_start", async () => {
    injectedThisSession = false;
  });

  pi.on("before_agent_start", async (event) => {
    if (injectedThisSession || !existsSync(MEMORY_ROOT)) return;
    injectedThisSession = true;

    const briefings: string[] = [];
    for (const file of ["USER.md", "MEMORY.md"]) {
      const path = join(MEMORY_ROOT, file);
      if (existsSync(path)) briefings.push(readFileSync(path, "utf8").trim());
    }
    if (briefings.length === 0) return;

    return {
      systemPrompt:
        event.systemPrompt +
        "\n\n## Aside agent memory (L1 briefings about the user, read-only)\n\n" +
        briefings.join("\n\n---\n\n") +
        "\n\nDeeper memory (people/, sites/, projects/, episodic/) is available via the aside_memory tool. Use it when a task involves a specific person, website, or past activity.",
    };
  });

  pi.registerTool({
    name: "aside_memory",
    label: "Aside memory",
    description:
      "Read-only access to Aside's layered agent memory about the user: people/ (contacts), sites/ (per-website knowledge), projects/, episodic/ (daily logs), users/ (full user dossier). Actions: list (all memory files), read (one file by relative path), search (case-insensitive text search across all files).",
    parameters: Type.Object({
      action: Type.Union(
        [Type.Literal("list"), Type.Literal("read"), Type.Literal("search")],
        { description: "What to do" },
      ),
      path: Type.Optional(
        Type.String({ description: "Relative path for read, e.g. people/max-laemmler.md" }),
      ),
      query: Type.Optional(Type.String({ description: "Search term for search" })),
    }),
    async execute(_toolCallId, params) {
      const text = runAction(params);
      return { content: [{ type: "text", text }], details: {} };
    },
  });
}

function runAction(params: { action: string; path?: string; query?: string }): string {
  if (!existsSync(MEMORY_ROOT)) return "Aside memory not found on this machine.";

  if (params.action === "list") {
    return listMemoryFiles().join("\n") || "No memory files found.";
  }

  if (params.action === "read") {
    if (!params.path) return "Error: path is required for read.";
    const resolved = normalize(join(MEMORY_ROOT, params.path));
    if (!resolved.startsWith(MEMORY_ROOT)) return "Error: path escapes memory root.";
    if (!existsSync(resolved)) return `Error: no such file: ${params.path}`;
    return readFileSync(resolved, "utf8");
  }

  if (params.action === "search") {
    if (!params.query) return "Error: query is required for search.";
    const needle = params.query.toLowerCase();
    const hits: string[] = [];
    for (const relPath of listMemoryFiles()) {
      const content = readFileSync(join(MEMORY_ROOT, relPath), "utf8");
      const matches = content
        .split("\n")
        .filter((line) => line.toLowerCase().includes(needle))
        .slice(0, 5);
      if (matches.length > 0) {
        hits.push(`${relPath}:\n${matches.map((m) => `  ${m.trim()}`).join("\n")}`);
      }
    }
    return hits.join("\n\n") || `No matches for "${params.query}".`;
  }

  return `Unknown action: ${params.action}`;
}

function listMemoryFiles(dir = MEMORY_ROOT, prefix = ""): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith(".") || IGNORED_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const rel = prefix ? `${prefix}/${entry}` : entry;
    if (statSync(full).isDirectory()) {
      results.push(...listMemoryFiles(full, rel));
    } else if (entry.endsWith(".md")) {
      results.push(rel);
    }
  }
  return results;
}
