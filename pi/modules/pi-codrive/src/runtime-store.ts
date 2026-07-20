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

export interface ChildRecord {
  childId: string;
  paneId: string;
  model: string;
  createdAt: string;
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

interface PersistedState {
  version: 1;
  updatedAt: string;
  session: HarnessSession;
  children: ChildRecord[];
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
      version: 1,
      updatedAt: new Date(this.now()).toISOString(),
      session: { ...session, childIds: [...session.childIds] },
      children: existing?.children ?? [],
    });
  }

  registerChild(sessionId: string, child: ChildRecord): void {
    assertSafeId(child.childId, "childId");
    const state = this.requireState(sessionId);
    const children = state.children.filter(
      (existing) => existing.childId !== child.childId,
    );
    children.push({ ...child });
    if (!state.session.childIds.includes(child.childId)) {
      state.session.childIds.push(child.childId);
    }
    this.writeState({
      ...state,
      updatedAt: new Date(this.now()).toISOString(),
      children,
    });
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

  private loadState(sessionId: string): PersistedState | undefined {
    const path = this.statePath(sessionId);
    if (!existsSync(path)) return undefined;
    const parsed = JSON.parse(readFileSync(path, "utf8")) as PersistedState;
    if (parsed.version !== 1 || parsed.session.sessionId !== sessionId) {
      throw new Error(`Invalid runtime state for ${sessionId}`);
    }
    return parsed;
  }

  private writeState(state: PersistedState): void {
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
