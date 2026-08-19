import { appendFile, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { SeenAccount, SeenChat } from "./types.ts";

export const DEFAULT_SEND_BUDGET = 12;
export const DEFAULT_DISTINCT_CHAT_BUDGET = 5;
export const MIN_WRITE_INTERVAL_MS = 5000;

export const BEEPER_STATE_DIRECTORY = join(homedir(), ".local", "state", "pi-beeper");
export const BEEPER_AUDIT_PATH = join(BEEPER_STATE_DIRECTORY, "send-audit.jsonl");
export const BEEPER_KILL_SWITCH_PATH = join(BEEPER_STATE_DIRECTORY, "send.disabled");

export interface SendAuditRecord {
  timestamp: string;
  sessionID: string;
  action: "send" | "reaction";
  status: "attempted";
  chatID: string;
  chatTitle: string;
  network: string;
  accountID: string;
  body: string;
}

export interface AuditWriter {
  append(record: SendAuditRecord): Promise<void>;
}

export class FileAuditWriter implements AuditWriter {
  private readonly path: string;

  constructor(path = BEEPER_AUDIT_PATH) {
    this.path = path;
  }

  async append(record: SendAuditRecord): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    try {
      await chmod(dirname(this.path), 0o700);
    } catch {
      // The directory mode is best effort on filesystems without POSIX modes.
    }
    await appendFile(this.path, `${JSON.stringify(record)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "a",
    });
    try {
      await chmod(this.path, 0o600);
    } catch {
      // The file mode is best effort on filesystems without POSIX modes.
    }
  }
}

export interface KillSwitch {
  isDisabled(): boolean;
  disable(): Promise<void>;
  enable(): Promise<void>;
}

export class FileKillSwitch implements KillSwitch {
  private readonly path: string;

  constructor(path = BEEPER_KILL_SWITCH_PATH) {
    this.path = path;
  }

  isDisabled(): boolean {
    return existsSync(this.path);
  }

  async disable(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await writeFile(this.path, "disabled\n", { encoding: "utf8", mode: 0o600, flag: "w" });
  }

  async enable(): Promise<void> {
    const { unlink } = await import("node:fs/promises");
    try {
      await unlink(this.path);
    } catch (error) {
      if ((error as { code?: string }).code !== "ENOENT") throw error;
    }
  }
}

export interface SendReservation {
  sendCount: number;
  distinctChatCount: number;
}

export class SendBudget {
  private sendCount = 0;
  private readonly distinctChats = new Set<string>();
  private lastWriteAt = 0;
  private readonly maxSends: number;
  private readonly maxDistinctChats: number;
  private readonly minIntervalMs: number;
  private readonly now: () => number;

  constructor(
    maxSends = DEFAULT_SEND_BUDGET,
    maxDistinctChats = DEFAULT_DISTINCT_CHAT_BUDGET,
    minIntervalMs = MIN_WRITE_INTERVAL_MS,
    now: () => number = Date.now,
  ) {
    this.maxSends = maxSends;
    this.maxDistinctChats = maxDistinctChats;
    this.minIntervalMs = minIntervalMs;
    this.now = now;
  }

  restore(records: readonly SendAuditRecord[], sessionID: string): void {
    for (const record of records) {
      if (record.sessionID !== sessionID) continue;
      if (record.action !== "send" && record.action !== "reaction") continue;
      this.sendCount += 1;
      this.distinctChats.add(record.chatID);
      const timestamp = Date.parse(record.timestamp);
      if (Number.isFinite(timestamp)) this.lastWriteAt = Math.max(this.lastWriteAt, timestamp);
    }
  }

  reserve(chatID: string): SendReservation {
    const now = this.now();
    if (this.sendCount >= this.maxSends) {
      throw new Error(
        `Beeper send budget exhausted: this session has reached its hard limit of ${this.maxSends} writes. Start a new session after reviewing the audit log.`,
      );
    }
    const isNewChat = !this.distinctChats.has(chatID);
    if (isNewChat && this.distinctChats.size >= this.maxDistinctChats) {
      throw new Error(
        `Beeper send budget exhausted: this session has reached its hard limit of ${this.maxDistinctChats} distinct chats. Start a new session after reviewing the audit log.`,
      );
    }
    if (this.lastWriteAt > 0 && now - this.lastWriteAt < this.minIntervalMs) {
      const waitMs = this.minIntervalMs - (now - this.lastWriteAt);
      throw new Error(`Beeper writes are rate-limited. Retry after ${waitMs} ms.`);
    }

    this.sendCount += 1;
    this.distinctChats.add(chatID);
    this.lastWriteAt = now;
    return {
      sendCount: this.sendCount,
      distinctChatCount: this.distinctChats.size,
    };
  }

  snapshot(): SendReservation {
    return { sendCount: this.sendCount, distinctChatCount: this.distinctChats.size };
  }
}

export interface RestoredSessionState {
  accounts: SeenAccount[];
  chats: SeenChat[];
  messageIDs: Array<{ id: string; chatID: string }>;
  ambiguousChatIDs: string[];
  uniqueResolutionChatIDs: string[];
  sends: SendAuditRecord[];
}

export function restoreSafeDetails(entries: readonly unknown[]): RestoredSessionState {
  const accounts = new Map<string, SeenAccount>();
  const chats = new Map<string, SeenChat>();
  const ambiguousChatIDs = new Set<string>();
  const uniqueResolutionChatIDs = new Set<string>();
  const messageIDs = new Map<string, { id: string; chatID: string }>();

  for (const entry of entries) {
    const details = getToolDetails(entry);
    if (!details) continue;
    for (const account of readSeenAccounts(details.seenAccounts)) accounts.set(account.accountID, account);
    for (const chat of readSeenChats(details.seenChats)) {
      chats.set(chat.id, chat);
      if (details.resolution === "ambiguous") ambiguousChatIDs.add(chat.id);
      if (details.resolution === "unique") uniqueResolutionChatIDs.add(chat.id);
    }
    for (const message of readMessageIDs(details.messageIDs)) messageIDs.set(message.id, message);
  }

  return {
    accounts: [...accounts.values()],
    chats: [...chats.values()],
    messageIDs: [...messageIDs.values()],
    ambiguousChatIDs: [...ambiguousChatIDs],
    uniqueResolutionChatIDs: [...uniqueResolutionChatIDs],
    sends: [],
  };
}

export async function readAuditRecords(path = BEEPER_AUDIT_PATH): Promise<SendAuditRecord[]> {
  try {
    const text = await readFile(path, "utf8");
    const records: SendAuditRecord[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const value: unknown = JSON.parse(line);
        if (isAuditRecord(value)) records.push(value);
      } catch {
        // Ignore a torn final append. Earlier records remain append-only.
      }
    }
    return records;
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return [];
    throw error;
  }
}

function getToolDetails(entry: unknown): Record<string, unknown> | undefined {
  if (!entry || typeof entry !== "object") return undefined;
  const record = entry as Record<string, unknown>;
  if (record.type !== "message") return undefined;
  const message = record.message;
  if (!message || typeof message !== "object") return undefined;
  const messageRecord = message as Record<string, unknown>;
  if (messageRecord.role !== "toolResult") return undefined;
  const details = messageRecord.details;
  if (!details || typeof details !== "object") return undefined;
  const value = details as Record<string, unknown>;
  return value.beeper === true ? value : undefined;
}

function readSeenAccounts(value: unknown): SeenAccount[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isSeenAccount);
}

function readSeenChats(value: unknown): SeenChat[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isSeenChat);
}

function readMessageIDs(value: unknown): Array<{ id: string; chatID: string }> {
  if (!Array.isArray(value)) return [];
  return value.filter(isMessageID);
}

function isSeenAccount(value: unknown): value is SeenAccount {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.accountID === "string" &&
    typeof record.network === "string" &&
    typeof record.status === "string" &&
    typeof record.userID === "string" &&
    typeof record.userHandle === "string" &&
    typeof record.userName === "string"
  );
}

function isSeenChat(value: unknown): value is SeenChat {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    typeof record.title === "string" &&
    typeof record.network === "string" &&
    typeof record.accountID === "string" &&
    (record.type === "single" || record.type === "group") &&
    typeof record.participantCount === "number" &&
    typeof record.participantCountIsComplete === "boolean" &&
    typeof record.isReadOnly === "boolean"
  );
}

function isMessageID(value: unknown): value is { id: string; chatID: string } {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === "string" && typeof record.chatID === "string";
}

function isAuditRecord(value: unknown): value is SendAuditRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.timestamp === "string" &&
    typeof record.sessionID === "string" &&
    (record.action === "send" || record.action === "reaction") &&
    record.status === "attempted" &&
    typeof record.chatID === "string" &&
    typeof record.chatTitle === "string" &&
    typeof record.network === "string" &&
    typeof record.accountID === "string" &&
    typeof record.body === "string"
  );
}
