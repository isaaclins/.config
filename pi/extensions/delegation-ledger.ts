import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

/**
 * Delegation ledger: enforces the user's subagent delegation policy
 * (track cost, prefer cheap models) with zero manual bookkeeping.
 *
 * - Ledger: every `subagent` tool call appends one JSON line to
 *   ~/.pi/agent/delegation-ledger.jsonl with the request shape (agent,
 *   chain, tasks, model overrides) and any usage/cost fields found in the
 *   result. Runtime state, intentionally not in the dotfiles repo.
 * - Model guard: warns (never blocks) when a delegation requests an
 *   opus-class model, nudging toward cheaper models per policy.
 * - /delegations: shows the last 10 ledger entries plus a total count.
 */

const LEDGER_PATH = join(homedir(), ".pi/agent/delegation-ledger.jsonl");
const SUBAGENT_TOOL_NAME = "subagent";
const TASK_TRUNCATE_LENGTH = 120;
const OPUS_PATTERN = /opus/i;

interface LedgerEntry {
  time: string;
  cwd: string;
  agent?: string;
  model?: string;
  chain?: unknown;
  tasks?: unknown;
  usage: Record<string, unknown>;
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    try {
      if (event.toolName !== SUBAGENT_TOOL_NAME) return;
      warnIfOpusModel(event.input, ctx);
    } catch {
      // Model guard must never break a session.
    }
  });

  pi.on("tool_result", async (event) => {
    try {
      if (event.toolName !== SUBAGENT_TOOL_NAME) return;
      appendLedgerEntry(buildLedgerEntry(event.input, event.details));
    } catch {
      // Ledger failures must never break a session.
    }
  });

  pi.registerCommand("delegations", {
    description: "Show recent subagent delegations from the ledger",
    handler: async (_args, ctx) => {
      ctx.ui.notify(formatDelegationsSummary(), "info");
    },
  });
}

function warnIfOpusModel(input: unknown, ctx: { ui: { notify: (msg: string, level: string) => void } }): void {
  const models = collectModelStrings(input);
  if (models.some((model) => OPUS_PATTERN.test(model))) {
    ctx.ui.notify(
      "Delegation uses an opus-class model; policy prefers cheaper models unless truly needed.",
      "warning",
    );
  }
}

/** Collect every model string that could appear across single/parallel/chain params. */
function collectModelStrings(input: unknown): string[] {
  if (!input || typeof input !== "object") return [];
  const params = input as Record<string, unknown>;
  const models: string[] = [];

  if (typeof params.model === "string") models.push(params.model);

  for (const list of [params.tasks, params.chain]) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (item && typeof item === "object" && typeof (item as Record<string, unknown>).model === "string") {
        models.push((item as Record<string, unknown>).model as string);
      }
    }
  }

  return models;
}

function buildLedgerEntry(input: unknown, details: unknown): LedgerEntry {
  const params = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;

  return {
    time: new Date().toISOString(),
    cwd: basename(process.cwd()),
    agent: typeof params.agent === "string" ? params.agent : undefined,
    model: typeof params.model === "string" ? params.model : undefined,
    chain: truncateTasksField(params.chain),
    tasks: truncateTasksField(params.tasks),
    usage: extractUsage(details),
  };
}

/** Truncate any embedded task/prompt strings so the ledger stays compact. */
function truncateTasksField(value: unknown): unknown {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(truncateAllTaskStrings(JSON.stringify(value)));
  } catch {
    return undefined;
  }
}

function truncateAllTaskStrings(json: string): string {
  const parsed = JSON.parse(json);
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(node as Record<string, unknown>)) {
        if ((key === "task" || key === "context") && typeof val === "string") {
          out[key] = val.length > TASK_TRUNCATE_LENGTH ? `${val.slice(0, TASK_TRUNCATE_LENGTH)}…` : val;
        } else {
          out[key] = walk(val);
        }
      }
      return out;
    }
    return node;
  };
  return JSON.stringify(walk(parsed));
}

/**
 * Defensively search a tool result's details payload for usage/cost fields.
 * pi-subagents exposes `totalChildUsage` ({input, output, cacheRead,
 * cacheWrite, cost, turns}) and `totalCost` on Details, but the exact shape
 * is not part of pi's own public contract, so this searches broadly instead
 * of asserting a type.
 */
function extractUsage(details: unknown): Record<string, unknown> {
  if (!details || typeof details !== "object") return {};
  const record = details as Record<string, unknown>;
  const usage: Record<string, unknown> = {};

  for (const key of ["totalChildUsage", "totalCost", "usage", "cost", "tokens"]) {
    if (key in record && record[key] !== undefined) usage[key] = record[key];
  }

  return usage;
}

function appendLedgerEntry(entry: LedgerEntry): void {
  const dir = dirname(LEDGER_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  appendFileSync(LEDGER_PATH, `${JSON.stringify(entry)}\n`);
}

function readLedgerEntries(): LedgerEntry[] {
  if (!existsSync(LEDGER_PATH)) return [];
  return readFileSync(LEDGER_PATH, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as LedgerEntry;
      } catch {
        return undefined;
      }
    })
    .filter((entry): entry is LedgerEntry => entry !== undefined);
}

function formatDelegationsSummary(): string {
  const entries = readLedgerEntries();
  if (entries.length === 0) return "No delegations recorded yet.";

  const last10 = entries.slice(-10);
  const lines = last10.map((entry) => formatLedgerLine(entry));
  return [`Last ${last10.length} of ${entries.length} total delegations:`, ...lines].join("\n");
}

function formatLedgerLine(entry: LedgerEntry): string {
  const agent = entry.agent ?? (entry.chain ? "chain" : entry.tasks ? "parallel" : "?");
  const model = entry.model ?? "default";
  const task = firstTaskSummary(entry) ?? "";
  return `${entry.time} · ${agent} · ${model} · ${task}`;
}

function firstTaskSummary(entry: LedgerEntry): string | undefined {
  if (Array.isArray(entry.tasks) && entry.tasks[0] && typeof entry.tasks[0] === "object") {
    const task = (entry.tasks[0] as Record<string, unknown>).task;
    if (typeof task === "string") return task;
  }
  if (Array.isArray(entry.chain) && entry.chain[0] && typeof entry.chain[0] === "object") {
    const task = (entry.chain[0] as Record<string, unknown>).task;
    if (typeof task === "string") return task;
  }
  return undefined;
}
