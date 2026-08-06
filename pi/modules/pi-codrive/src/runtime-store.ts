import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { HarnessSession } from "./session.ts";

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

export type ChildStatus =
  | "spawned"
  | "running"
  | "interrupted"
  | "dead"
  | "completed";

export interface ChildRecord {
  childId: string;
  paneId: string;
  model: string;
  createdAt: string;
  /** The child's own pi session id, pre-assigned at spawn for deterministic resume. */
  piSessionId?: string;
  /** The child's resolved pi session file, learned from its announce envelope. */
  piSessionFile?: string;
  /** The project root the child was launched in. */
  projectRoot?: string;
  /** Lifecycle status mirrored from the supervisor state machine. */
  status?: ChildStatus;
  /** How many times this child has been relaunched via agent_resume. */
  resumeCount?: number;
  /** Every pane id this child has ever occupied, oldest first. */
  paneHistory?: string[];
}

export type DeferDelivery = "interrupt" | "quiet";
export type DeferKind = "after" | "when";

/**
 * One pending deferred trigger, as it lives on disk.
 *
 * The deadline is stored as an absolute epoch timestamp rather than a
 * remaining duration: a remaining duration silently restarts its own countdown
 * every time the process restarts, which is exactly how a deferred wake-up
 * gets lost or drifts.
 */
export interface DeferredTriggerRecord {
  id: string;
  kind: DeferKind;
  /** Text delivered back to the agent when this trigger fires. */
  note: string;
  delivery: DeferDelivery;
  createdAt: string;
  /** Absolute epoch ms. "after" fires here; "when" gives up here with a timeout. */
  dueAt: number;
  /** Shell command whose exit code 0 means the condition is true ("when" only). */
  check?: string;
  /** Poll interval for "when". */
  pollMs?: number;
  /** pid of the process that armed it, so only a dead owner's triggers are adopted. */
  ownerPid?: number;
}

export type ReportStatus = "completed" | "error" | "aborted";

export interface CodriveReport {
  version: 1;
  eventId: string;
  sessionId: string;
  childId: string;
  paneId?: string;
  status: ReportStatus;
  assistantText: string;
  timestamp: string;
  errorSummary?: string;
}

const STATE_VERSION = 3;
const KNOWN_STATE_VERSIONS = [1, 2, STATE_VERSION];

interface PersistedState {
  version: 3;
  updatedAt: string;
  session: HarnessSession;
  children: ChildRecord[];
  triggers: DeferredTriggerRecord[];
}

/**
 * Normalize a child record so old (v1) records and minimal registrations gain
 * the fields the resume machinery depends on. Missing fields are tolerated and
 * filled with safe defaults rather than rejected.
 */
function normalizeChild(child: ChildRecord, projectRoot: string): ChildRecord {
  return {
    ...child,
    projectRoot: child.projectRoot ?? projectRoot,
    status: child.status ?? "running",
    resumeCount: child.resumeCount ?? 0,
    paneHistory:
      child.paneHistory && child.paneHistory.length > 0
        ? [...child.paneHistory]
        : [child.paneId],
  };
}

/**
 * A record with no id, kind, or deadline can never fire, so it is dropped on
 * load instead of being carried forward as a trigger that looks pending.
 */
function isUsableTrigger(trigger: DeferredTriggerRecord | undefined): boolean {
  if (!trigger) return false;
  if (!SAFE_ID.test(trigger.id ?? "")) return false;
  if (trigger.kind !== "after" && trigger.kind !== "when") return false;
  if (typeof trigger.note !== "string") return false;
  return Number.isFinite(trigger.dueAt);
}

/** Fill the fields a trigger written by an older version may not carry. */
function normalizeTrigger(trigger: DeferredTriggerRecord): DeferredTriggerRecord {
  return {
    ...trigger,
    delivery: trigger.delivery === "quiet" ? "quiet" : "interrupt",
    createdAt: trigger.createdAt ?? new Date(trigger.dueAt).toISOString(),
  };
}

/**
 * True when a process is still running. EPERM means it exists but belongs to
 * another user, which still counts as alive: its triggers are not ours to take.
 */
export function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface RuntimeStoreOptions {
  maxReportsPerChild?: number;
  retentionMs?: number;
  now?: () => number;
}

export interface RecoveredRuntime {
  session?: HarnessSession;
  children: ChildRecord[];
  reports: CodriveReport[];
}

export class RuntimeStore {
  private readonly root: string;
  private readonly maxReportsPerChild: number;
  private readonly retentionMs: number;
  private readonly now: () => number;

  constructor(root: string, options: RuntimeStoreOptions = {}) {
    this.root = root;
    this.maxReportsPerChild = options.maxReportsPerChild ?? 100;
    this.retentionMs = options.retentionMs ?? 7 * 24 * 60 * 60 * 1000;
    this.now = options.now ?? Date.now;
    ensurePrivateDirectory(root);
  }

  sessionDirectory(sessionId: string): string {
    assertSafeId(sessionId, "sessionId");
    return join(this.root, sessionId);
  }

  statePath(sessionId: string): string {
    return join(this.sessionDirectory(sessionId), "state.json");
  }

  saveSession(session: HarnessSession): void {
    const existing = this.loadState(session.sessionId);
    this.writeState({
      version: STATE_VERSION,
      updatedAt: new Date(this.now()).toISOString(),
      session: { ...session, childIds: [...session.childIds] },
      children: existing?.children ?? [],
      triggers: existing?.triggers ?? [],
    });
  }

  /** Pending deferred triggers owned by this session. */
  loadTriggers(sessionId: string): DeferredTriggerRecord[] {
    const state = this.loadState(sessionId);
    return (state?.triggers ?? []).map((trigger) => ({ ...trigger }));
  }

  /**
   * Replace the pending trigger list wholesale. The list is small and always
   * rewritten as a unit, so one atomic write per change keeps disk state and
   * armed timers from ever disagreeing about what is still pending.
   */
  saveTriggers(sessionId: string, triggers: DeferredTriggerRecord[]): void {
    const state = this.requireState(sessionId);
    for (const trigger of triggers) assertSafeId(trigger.id, "triggerId");
    this.writeState({
      ...state,
      updatedAt: new Date(this.now()).toISOString(),
      triggers: triggers.map((trigger) => ({ ...trigger })),
    });
  }

  /**
   * Take over pending triggers left behind by earlier sessions in the same
   * project, and return the full pending list for this session.
   *
   * Every session gets a fresh sessionId, so without adoption a restart would
   * orphan its own triggers under the old id. A second live session in the
   * same project must still not steal timers the first one is counting down,
   * so a trigger is only taken when nothing is left to fire it.
   *
   * That means two cases, not one. A dead owner is the restart case. An owner
   * that is this very process is the reload case: /reload mints a new
   * sessionId inside the same pid, and the previous registry already dropped
   * its timers in stop(), so those records have no live timer behind them
   * either. Treating only a dead owner as adoptable stranded them under the
   * old session id forever, which silently swallowed every pending defer
   * across a reload.
   */
  adoptTriggers(
    sessionId: string,
    projectRoot: string,
    isOwnerAlive: (pid: number) => boolean = processIsAlive,
    selfPid: number = process.pid,
  ): DeferredTriggerRecord[] {
    const own = this.loadTriggers(sessionId);
    const adopted: DeferredTriggerRecord[] = [];
    for (const entry of readdirSync(this.root)) {
      if (entry === sessionId || !SAFE_ID.test(entry)) continue;
      const state = this.tryLoadState(entry);
      if (!state || state.session.projectRoot !== projectRoot) continue;
      const orphans = state.triggers.filter(
        (trigger) =>
          trigger.ownerPid === undefined ||
          trigger.ownerPid === selfPid ||
          !isOwnerAlive(trigger.ownerPid),
      );
      if (orphans.length === 0) continue;
      this.writeState({
        ...state,
        updatedAt: new Date(this.now()).toISOString(),
        triggers: state.triggers.filter((trigger) => !orphans.includes(trigger)),
      });
      adopted.push(...orphans);
    }
    if (adopted.length === 0) return own;
    const merged = [...own, ...adopted];
    this.saveTriggers(sessionId, merged);
    return merged.map((trigger) => ({ ...trigger }));
  }

  registerChild(sessionId: string, child: ChildRecord): void {
    assertSafeId(child.childId, "childId");
    const state = this.requireState(sessionId);
    const children = state.children.filter(
      (existing) => existing.childId !== child.childId,
    );
    children.push(normalizeChild(child, state.session.projectRoot));
    if (!state.session.childIds.includes(child.childId)) {
      state.session.childIds.push(child.childId);
    }
    this.writeState({
      ...state,
      updatedAt: new Date(this.now()).toISOString(),
      children,
    });
  }

  /**
   * Apply a partial update to a single child record. Used by the resume path
   * to record the new pane id, bump resumeCount, append pane history, and set
   * status without rewriting the whole record.
   */
  updateChild(
    sessionId: string,
    childId: string,
    patch: Partial<Omit<ChildRecord, "childId">>,
  ): ChildRecord {
    assertSafeId(childId, "childId");
    const state = this.requireState(sessionId);
    const index = state.children.findIndex((child) => child.childId === childId);
    if (index < 0) throw new Error(`Unknown child ${childId}`);
    const merged = normalizeChild(
      { ...state.children[index], ...patch, childId },
      state.session.projectRoot,
    );
    const children = [...state.children];
    children[index] = merged;
    this.writeState({
      ...state,
      updatedAt: new Date(this.now()).toISOString(),
      children,
    });
    return { ...merged };
  }

  /**
   * Resolve a child by any pane id it has ever occupied, current or historical.
   * This lets the parent still locate a child after a resume moved it to a new
   * pane, and keeps the old pane id resolvable.
   */
  findChildByPane(sessionId: string, paneId: string): ChildRecord | undefined {
    const state = this.loadState(sessionId);
    if (!state) return undefined;
    const match = state.children.find(
      (child) =>
        child.paneId === paneId ||
        (child.paneHistory ?? []).includes(paneId),
    );
    return match ? { ...match } : undefined;
  }

  appendReport(report: CodriveReport): void {
    assertReport(report);
    const state = this.requireState(report.sessionId);
    if (!state.children.some((child) => child.childId === report.childId)) {
      throw new Error(`Unknown child ${report.childId}`);
    }
    const reportDirectory = join(
      this.sessionDirectory(report.sessionId),
      "reports",
      report.childId,
    );
    ensurePrivateDirectory(reportDirectory);
    const path = join(reportDirectory, `${report.eventId}.json`);
    if (existsSync(path)) return;
    writePrivateJson(path, report);
    this.pruneReports(reportDirectory);
    this.writeState({
      ...state,
      updatedAt: new Date(this.now()).toISOString(),
    });
  }

  load(sessionId: string): RecoveredRuntime {
    const state = this.loadState(sessionId);
    if (!state) return { children: [], reports: [] };
    const reports: CodriveReport[] = [];
    for (const child of state.children) {
      const directory = join(
        this.sessionDirectory(sessionId),
        "reports",
        child.childId,
      );
      if (!existsSync(directory)) continue;
      for (const file of readdirSync(directory).sort()) {
        if (!file.endsWith(".json")) continue;
        const parsed = JSON.parse(
          readFileSync(join(directory, file), "utf8"),
        ) as CodriveReport;
        assertReport(parsed);
        reports.push(parsed);
      }
    }
    reports.sort((left, right) =>
      left.timestamp.localeCompare(right.timestamp),
    );
    return {
      session: { ...state.session, childIds: [...state.session.childIds] },
      children: state.children.map((child) => ({ ...child })),
      reports,
    };
  }

  cleanup(): string[] {
    const removed: string[] = [];
    const cutoff = this.now() - this.retentionMs;
    for (const entry of readdirSync(this.root)) {
      if (!SAFE_ID.test(entry)) continue;
      const state = this.loadState(entry);
      if (!state || Date.parse(state.updatedAt) > cutoff) continue;
      rmSync(this.sessionDirectory(entry), { recursive: true, force: true });
      removed.push(entry);
    }
    return removed.sort();
  }

  private requireState(sessionId: string): PersistedState {
    const state = this.loadState(sessionId);
    if (!state) throw new Error(`Unknown codrive session ${sessionId}`);
    return state;
  }

  /**
   * Read another session's state without letting a foreign, newer, or
   * half-written file break this session's startup. Only adoption uses this;
   * it is the one path that reads state files this process does not own.
   */
  private tryLoadState(sessionId: string): PersistedState | undefined {
    try {
      return this.loadState(sessionId);
    } catch {
      return undefined;
    }
  }

  private loadState(sessionId: string): PersistedState | undefined {
    const path = this.statePath(sessionId);
    if (!existsSync(path)) return undefined;
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      version?: number;
      updatedAt: string;
      session: HarnessSession;
      children: ChildRecord[];
      triggers?: DeferredTriggerRecord[];
    };
    if (
      !KNOWN_STATE_VERSIONS.includes(parsed.version ?? 0) ||
      parsed.session.sessionId !== sessionId
    ) {
      throw new Error(`Invalid runtime state for ${sessionId}`);
    }
    // Tolerate and migrate older records: v1 lacks the resume fields, v1 and
    // v2 lack triggers entirely. Both load as an empty, valid v3 state.
    return {
      version: STATE_VERSION,
      updatedAt: parsed.updatedAt,
      session: parsed.session,
      children: (parsed.children ?? []).map((child) =>
        normalizeChild(child, parsed.session.projectRoot),
      ),
      triggers: (parsed.triggers ?? []).filter(isUsableTrigger).map(normalizeTrigger),
    };
  }

  private writeState(state: PersistedState): void {
    state = { ...state, version: STATE_VERSION };
    const directory = this.sessionDirectory(state.session.sessionId);
    ensurePrivateDirectory(directory);
    const path = this.statePath(state.session.sessionId);
    const temporary = join(directory, `.state-${randomUUID()}.tmp`);
    writePrivateJson(temporary, state);
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  }

  private pruneReports(directory: string): void {
    const reports = readdirSync(directory)
      .filter((file) => file.endsWith(".json"))
      .map((file) => ({
        file,
        report: JSON.parse(
          readFileSync(join(directory, file), "utf8"),
        ) as CodriveReport,
      }))
      .sort((left, right) =>
        left.report.timestamp.localeCompare(right.report.timestamp),
      );
    for (const stale of reports.slice(
      0,
      Math.max(0, reports.length - this.maxReportsPerChild),
    )) {
      unlinkSync(join(directory, stale.file));
    }
  }
}

function assertSafeId(value: string, name: string): void {
  if (!SAFE_ID.test(value)) throw new Error(`${name} is invalid`);
}

function assertReport(report: CodriveReport): void {
  if (report.version !== 1) throw new Error("Unsupported report version");
  assertSafeId(report.sessionId, "sessionId");
  assertSafeId(report.childId, "childId");
  assertSafeId(report.eventId, "eventId");
  if (!["completed", "error", "aborted"].includes(report.status)) {
    throw new Error("Invalid report status");
  }
  if (typeof report.assistantText !== "string") {
    throw new Error("Invalid report text");
  }
}

function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Unsafe runtime directory ${path}`);
  }
  chmodSync(path, 0o700);
}

function writePrivateJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  chmodSync(path, 0o600);
}
