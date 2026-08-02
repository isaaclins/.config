import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { homedir } from "node:os";
import { join } from "node:path";
import { MemoryAuthority, type MemoryRecord } from "../src/memory-authority.ts";
import {
  NUDGE_MESSAGE,
  buildMemoryListing,
  forgetNote,
  parseRememberArgs,
  rememberNote,
  shouldShowNudge,
} from "../src/notes.ts";

/**
 * Pi extension entry point for @isaaclins/pi-memory.
 *
 * Injects governed memory into the system prompt and exposes the notes UX
 * (remember tool, /remember, /memory, /forget) plus the keyed upsert/retire
 * tools. Does not read or inject any external briefing content.
 */

const GLOBAL_STORE_PATH = join(homedir(), ".pi", "agent", "memory", "global.jsonl");
const MAX_RECORD_CHARS = 2000;

function projectStorePath(projectRoot: string): string {
  return join(projectRoot, ".pi", "memory.jsonl");
}

function makeAuthority(): MemoryAuthority {
  return new MemoryAuthority({
    globalPath: GLOBAL_STORE_PATH,
    projectPath: projectStorePath(process.cwd()),
    maxRecordChars: MAX_RECORD_CHARS,
  });
}

type MemoryMutationOperation = "created" | "replaced" | "retired";

function visibleRecord(record: MemoryRecord) {
  return {
    id: record.id,
    key: record.key,
    scope: record.scope,
    kind: record.kind,
    status: record.status,
    value: record.value,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    expiresAt: record.expiresAt ?? null,
  };
}

function memoryMutationResult(operation: MemoryMutationOperation, record: MemoryRecord) {
  const visible = visibleRecord(record);
  const heading = `${operation[0].toUpperCase()}${operation.slice(1)} governed memory record:`;
  return {
    content: [{ type: "text", text: `${heading}\n${JSON.stringify(visible, null, 2)}` }],
    details: { operation, record: visible },
  };
}

export default function (pi: ExtensionAPI) {
  let injectedThisSession = false;
  let rememberUsedThisSession = false;
  let nudgeShownThisSession = false;
  let sessionStartedAt = 0;
  let turnCount = 0;

  pi.on("session_start", async () => {
    injectedThisSession = false;
    rememberUsedThisSession = false;
    nudgeShownThisSession = false;
    sessionStartedAt = Date.now();
    turnCount = 0;
  });

  pi.on("turn_end", async () => {
    turnCount += 1;
  });

  pi.on("agent_end", async (_event, ctx) => {
    const elapsedMs = sessionStartedAt ? Date.now() - sessionStartedAt : 0;
    if (
      !shouldShowNudge({
        turnCount,
        elapsedMs,
        rememberUsed: rememberUsedThisSession,
        nudgeShown: nudgeShownThisSession,
      })
    ) {
      return;
    }
    nudgeShownThisSession = true;
    ctx?.ui.notify(NUDGE_MESSAGE, "info");
  });

  pi.on("before_agent_start", async (event) => {
    if (injectedThisSession) return;
    injectedThisSession = true;

    const projectRoot = process.cwd();
    void projectRoot;
    const authority = makeAuthority();

    const injection = authority.buildInjection();
    if (injection.selectedIds.length === 0) return;

    return {
      systemPrompt: event.systemPrompt + "\n\n" + injection.text,
    };
  });

  // No `remember` tool is registered on purpose. Agents must use
  // `pi_memory_upsert`, whose stable keys make a record correctable and
  // expirable; `appendNote`'s random `note.<uuid>` keys are append-only and
  // produced a store that could only be cleaned up by hand. `/remember`
  // stays as a fast human affordance.
  pi.registerCommand("remember", {
    description: "Save a memory note for future sessions (-g/--global for user-wide notes)",
    handler: async (args, ctx) => {
      const { scope, note } = parseRememberArgs(args);
      if (!note) {
        ctx.ui.notify("Usage: /remember [-g|--global] <note>", "warning");
        return;
      }
      rememberNote(makeAuthority(), { note, scope });
      rememberUsedThisSession = true;
      const where = scope === "global" ? "global" : "project";
      ctx.ui.notify(`Remembered (${where}): ${note}`, "info");
    },
  });

  pi.registerCommand("memory", {
    description: "List all active memory notes from both scopes with their /forget indices",
    handler: async (_args, ctx) => {
      ctx.ui.notify(buildMemoryListing(makeAuthority()), "info");
    },
  });

  pi.registerCommand("forget", {
    description: "Retire a memory note by index (g2, p3) or by unique text match",
    handler: async (args, ctx) => {
      const result = forgetNote(makeAuthority(), args);
      ctx.ui.notify(result.message, result.status === "retired" ? "info" : "warning");
    },
  });

  pi.registerTool({
    name: "pi_memory_upsert",
    label: "Remember (governed)",
    description:
      "Persist a governed memory record. scope='global' for user preferences across all projects; scope='project' for facts about THIS repo. Each record has a unique key; upserting the same key overwrites the value.",
    parameters: Type.Object({
      key: Type.String({ description: "Stable dotted key, e.g. 'prose.no-em-dash'" }),
      scope: Type.Union([Type.Literal("global"), Type.Literal("project")], {
        description: "'global' or 'project'",
      }),
      kind: Type.Union([Type.Literal("preference"), Type.Literal("fact"), Type.Literal("runbook")], {
        description: "Memory kind: preference, fact, or runbook",
      }),
      value: Type.String({ description: "The content to remember (plain text, one concise statement)" }),
      expiresAt: Type.Optional(Type.String({ description: "ISO 8601 expiration timestamp (optional)" })),
    }),
    async execute(_toolCallId, params) {
      const projectRoot = process.cwd();
      const authority = new MemoryAuthority({
        globalPath: GLOBAL_STORE_PATH,
        projectPath: projectStorePath(projectRoot),
        maxRecordChars: MAX_RECORD_CHARS,
      });
      const result = authority.upsertWithResult(params);
      return memoryMutationResult(result.operation, result.record);
    },
  });

  pi.registerTool({
    name: "pi_memory_retire",
    label: "Retire memory",
    description:
      "Mark a governed memory record as retired (excluded from injection but preserved in history). Identify by scope + key.",
    parameters: Type.Object({
      key: Type.String({ description: "The record key to retire" }),
      scope: Type.Union([Type.Literal("global"), Type.Literal("project")], {
        description: "'global' or 'project'",
      }),
    }),
    async execute(_toolCallId, params) {
      const projectRoot = process.cwd();
      const authority = new MemoryAuthority({
        globalPath: GLOBAL_STORE_PATH,
        projectPath: projectStorePath(projectRoot),
        maxRecordChars: MAX_RECORD_CHARS,
      });
      const record = authority.retire(params.scope, params.key);
      return memoryMutationResult("retired", record);
    },
  });
}
