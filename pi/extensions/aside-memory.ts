import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { listMemoryFiles, readMemoryFile, truncateMemoryOutput } from "./aside-memory-helpers.ts";

/** Read-only bridge to Aside Browser's layered agent memory. */
const MEMORY_ROOT = join(homedir(), ".aside/u/0/agents/main/memory");

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
      try {
        briefings.push(truncateMemoryOutput(readMemoryFile(MEMORY_ROOT, file)).trim());
      } catch {
        // A missing, unsafe, or malformed briefing must not block Pi.
      }
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
      "Read-only access to Aside's layered agent memory about the user. Actions list, read, and search are limited to 50 KB or 2,000 lines.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("list"), Type.Literal("read"), Type.Literal("search")]),
      path: Type.Optional(Type.String({ description: "Relative path for read, e.g. people/max-laemmler.md" })),
      query: Type.Optional(Type.String({ description: "Search term for search" })),
    }),
    async execute(_toolCallId, params) {
      return { content: [{ type: "text", text: runAction(params) }], details: {} };
    },
  });
}

export function runAction(params: { action: string; path?: string; query?: string }): string {
  if (!existsSync(MEMORY_ROOT)) return "Aside memory not found on this machine.";

  try {
    if (params.action === "list") return truncateMemoryOutput(listMemoryFiles(MEMORY_ROOT).join("\n") || "No memory files found.");
    if (params.action === "read") {
      if (!params.path) return "Error: path is required for read.";
      return truncateMemoryOutput(readMemoryFile(MEMORY_ROOT, params.path));
    }
    if (params.action === "search") {
      if (!params.query) return "Error: query is required for search.";
      const needle = params.query.toLowerCase();
      const hits: string[] = [];
      for (const relativePath of listMemoryFiles(MEMORY_ROOT)) {
        const matches = readMemoryFile(MEMORY_ROOT, relativePath).split("\n")
          .filter((line) => line.toLowerCase().includes(needle)).slice(0, 5);
        if (matches.length > 0) hits.push(`${relativePath}:\n${matches.map((match) => `  ${match.trim()}`).join("\n")}`);
      }
      return truncateMemoryOutput(hits.join("\n\n") || `No matches for "${params.query}".`);
    }
  } catch (error) {
    return `Error: ${(error as Error).message}`;
  }
  return `Unknown action: ${params.action}`;
}
