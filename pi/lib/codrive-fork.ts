import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

export interface ForkSessionEntry {
  type: string;
  id?: string;
  parentId?: string | null;
  timestamp?: string;
  thinkingLevel?: string;
  message?: {
    role?: string;
    content?: unknown;
    provider?: string;
    api?: string;
    model?: string;
  };
}

export interface ForkSource {
  getSessionFile(): string | undefined;
  getLeafId(): string | null;
  getSessionDir?(): string;
}

export interface BranchingSessionManager {
  createBranchedSession(leafId: string): string | undefined;
  getLeafId(): string | null;
}

export type OpenSession = (
  path: string,
  sessionDir?: string,
) => BranchingSessionManager;

export interface ForkResult {
  sessionFile: string;
  thinkingOverride?: "off";
}

function isUnsafeAnthropicThinkingBlock(
  message: ForkSessionEntry["message"],
  block: unknown,
): boolean {
  if (!message || !block || typeof block !== "object" || !("type" in block))
    return false;
  const typed = block as Record<string, unknown>;
  if (typed.type === "redacted_thinking") return true;
  const provider =
    typeof message.provider === "string" ? message.provider.toLowerCase() : "";
  const api = typeof message.api === "string" ? message.api.toLowerCase() : "";
  const model =
    typeof message.model === "string" ? message.model.toLowerCase() : "";
  const isAnthropic =
    provider === "anthropic" ||
    api === "anthropic-messages" ||
    model.startsWith("anthropic/");
  if (typed.type !== "thinking" || !isAnthropic) return false;
  const signature = typed.thinkingSignature ?? typed.signature;
  return (
    typed.redacted === true ||
    (typeof signature === "string" && signature.length > 0)
  );
}

function createEntryId(entries: ForkSessionEntry[]): string {
  const ids = new Set(
    entries
      .map((entry) => entry.id)
      .filter((id): id is string => typeof id === "string"),
  );
  for (let attempt = 0; attempt < 100; attempt++) {
    const id = randomUUID().slice(0, 8);
    if (!ids.has(id)) return id;
  }
  return randomUUID();
}

function appendThinkingOffEntry(entries: ForkSessionEntry[]): void {
  const last = entries[entries.length - 1];
  if (last?.type === "thinking_level_change" && last.thinkingLevel === "off")
    return;
  const parent = [...entries]
    .reverse()
    .find((entry) => typeof entry.id === "string");
  entries.push({
    type: "thinking_level_change",
    id: createEntryId(entries),
    parentId: parent?.id ?? null,
    timestamp: new Date().toISOString(),
    thinkingLevel: "off",
  });
}

/**
 * Anthropic signed or redacted thinking blocks fail provider validation when
 * a forked session is continued, especially by a different model. Strip them
 * and force thinking off so the child session starts clean.
 * Returns true when any block was removed.
 */
export function sanitizeUnsafeThinkingBlocks(
  entries: ForkSessionEntry[],
): boolean {
  let sanitized = false;
  for (const entry of entries) {
    if (
      entry.type !== "message" ||
      entry.message?.role !== "assistant" ||
      !Array.isArray(entry.message.content)
    )
      continue;
    const filtered = entry.message.content.filter(
      (block) => !isUnsafeAnthropicThinkingBlock(entry.message, block),
    );
    if (filtered.length === entry.message.content.length) continue;
    entry.message.content = filtered;
    sanitized = true;
  }
  if (sanitized) appendThinkingOffEntry(entries);
  return sanitized;
}

export function readSessionEntries(sessionFile: string): ForkSessionEntry[] {
  const lines = readFileSync(sessionFile, "utf-8")
    .split("\n")
    .filter((line) => line.trim().length > 0);
  return lines.map((line, index) => {
    try {
      return JSON.parse(line) as ForkSessionEntry;
    } catch (error) {
      throw new Error(
        `Forked session ${sessionFile} has invalid JSONL on line ${index + 1}: ${(error as Error).message}`,
      );
    }
  });
}

/**
 * Create a branched copy of the parent session up to its current leaf and
 * sanitize it for continuation by an arbitrary child model.
 */
export function createForkedSession(
  source: ForkSource,
  openSession: OpenSession,
): ForkResult {
  const parentSessionFile = source.getSessionFile();
  if (!parentSessionFile || !existsSync(parentSessionFile))
    throw new Error(
      "Forking requires a persisted parent session (run without --no-session).",
    );
  const manager = openSession(parentSessionFile, source.getSessionDir?.());
  const parentLeafId = source.getLeafId();
  let sessionFile: string | undefined;
  try {
    if (!parentLeafId) throw new Error("parent session has no leaf yet");
    sessionFile = manager.createBranchedSession(parentLeafId);
  } catch {
    // The in-memory leaf may not be flushed to disk yet; fall back to the
    // newest persisted entry so the fork loses at most the in-flight turn.
    const persistedLeafId = manager.getLeafId();
    if (!persistedLeafId)
      throw new Error("Parent session has no persisted entries to fork from.");
    sessionFile = manager.createBranchedSession(persistedLeafId);
  }
  if (!sessionFile || !existsSync(sessionFile))
    throw new Error("Session manager did not persist a forked session file.");
  const entries = readSessionEntries(sessionFile);
  if (!sanitizeUnsafeThinkingBlocks(entries)) return { sessionFile };
  writeFileSync(
    sessionFile,
    `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    "utf-8",
  );
  return { sessionFile, thinkingOverride: "off" };
}
