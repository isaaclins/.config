import type { CodriveController, SpawnedChild } from "./controller.ts";
import type { CodriveBackend } from "./controller.ts";
import type { RuntimeStore, ChildStatus, CodriveReport } from "./runtime-store.ts";
import type { CodriveEnvelope } from "./report-transport.ts";

export interface SupervisorScheduler {
  setTimeout(callback: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
}

const defaultScheduler: SupervisorScheduler = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle),
};

/** Minimal surface of the pane health monitor the supervisor drives. */
export interface HealthMonitorLike {
  track(paneId: string): void;
  untrack(paneId: string): void;
  markReported(paneId: string): void;
}

export interface SupervisorWake {
  (input: { pane: string; content: string; details: unknown }): void;
}

export interface SupervisorHistoryEntry {
  status: string;
  text: string;
  timestamp: string;
}

export interface DelegationSupervisorOptions {
  sessionId: string;
  store: RuntimeStore;
  controller: CodriveController;
  backend: CodriveBackend;
  monitor: HealthMonitorLike;
  /** Wake the orchestrator with a message. Called at most once per terminal or escalation. */
  wake: SupervisorWake;
  /** Grace window after a non-transient interruption before escalation fires. */
  graceMs?: number;
  scheduler?: SupervisorScheduler;
  now?: () => number;
}

interface ChildState {
  childId: string;
  model: string;
  status: ChildStatus;
  currentPane: string;
  paneHistory: string[];
  piSessionId?: string;
  piSessionFile?: string;
  projectRoot: string;
  history: SupervisorHistoryEntry[];
  lastSeen: number;
  episode: number;
  escalated: boolean;
  escalationTimer: ReturnType<typeof setTimeout> | undefined;
}

const DEFAULT_GRACE_MS = 20000;

/**
 * Parent-side per-child lifecycle state machine. It owns the transition graph
 * (spawned -> running -> interrupted -> running|dead -> completed), the history
 * lists, escalation timers, and ledger writes. extension.ts is a thin adapter
 * that forwards Pi events and IPC envelopes here.
 *
 * Rules:
 *   terminal report -> wake the orchestrator ONCE, untrack, mark completed
 *   interrupt       -> append history, KEEP tracking, arm escalation, no wake
 *   heartbeat/announce -> refresh lastSeen, cancel escalation, no wake
 *   escalation      -> fires at most once per interruption episode, only when
 *                      the grace window expired with no heartbeat OR a
 *                      farewell/pane death arrived while the task was unfinished
 */
export class DelegationSupervisor {
  private readonly sessionId: string;
  private readonly store: RuntimeStore;
  private readonly controller: CodriveController;
  private readonly backend: CodriveBackend;
  private readonly monitor: HealthMonitorLike;
  private readonly wake: SupervisorWake;
  private readonly graceMs: number;
  private readonly scheduler: SupervisorScheduler;
  private readonly now: () => number;

  private readonly byChild = new Map<string, ChildState>();
  private readonly paneIndex = new Map<string, string>();

  constructor(options: DelegationSupervisorOptions) {
    this.sessionId = options.sessionId;
    this.store = options.store;
    this.controller = options.controller;
    this.backend = options.backend;
    this.monitor = options.monitor;
    this.wake = options.wake;
    this.graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.now = options.now ?? Date.now;
  }

  /** Record a freshly spawned child, write the ledger, and start health tracking. */
  registerSpawn(input: {
    childId: string;
    paneId: string;
    model: string;
    piSessionId?: string;
    piSessionFile?: string;
    projectRoot: string;
    createdAt?: string;
  }): void {
    const state: ChildState = {
      childId: input.childId,
      model: input.model,
      status: "running",
      currentPane: input.paneId,
      paneHistory: [input.paneId],
      piSessionId: input.piSessionId,
      piSessionFile: input.piSessionFile,
      projectRoot: input.projectRoot,
      history: [],
      lastSeen: this.now(),
      episode: 0,
      escalated: false,
      escalationTimer: undefined,
    };
    this.byChild.set(input.childId, state);
    this.paneIndex.set(input.paneId, input.childId);
    this.store.registerChild(this.sessionId, {
      childId: input.childId,
      paneId: input.paneId,
      model: input.model,
      createdAt: input.createdAt ?? new Date(this.now()).toISOString(),
      piSessionId: input.piSessionId,
      piSessionFile: input.piSessionFile,
      projectRoot: input.projectRoot,
      status: "running",
      resumeCount: 0,
      paneHistory: [input.paneId],
    });
    this.monitor.track(input.paneId);
  }

  private resolveByPane(paneId: string): ChildState | undefined {
    const childId = this.paneIndex.get(paneId);
    return childId ? this.byChild.get(childId) : undefined;
  }

  isLive(paneId: string): boolean {
    const state = this.resolveByPane(paneId);
    if (!state) return false;
    return state.status === "running" || state.status === "interrupted";
  }

  hasPane(paneId: string): boolean {
    return this.paneIndex.has(paneId);
  }

  currentPaneFor(paneId: string): string | undefined {
    return this.resolveByPane(paneId)?.currentPane;
  }

  private cancelEscalation(state: ChildState): void {
    if (state.escalationTimer !== undefined) {
      this.scheduler.clearTimeout(state.escalationTimer);
      state.escalationTimer = undefined;
    }
  }

  private escalateOnce(state: ChildState, reason: string): void {
    if (state.escalated || state.status === "completed") return;
    state.escalated = true;
    this.cancelEscalation(state);
    const pane = state.currentPane;
    this.wake({
      pane,
      content:
        `SUBAGENT ${pane} needs attention: ${reason}. ` +
        `The task did not finish and the child is not recovering. ` +
        `Relaunch it into a fresh pane with agent_resume({ pane: "${pane}" }).`,
      details: {
        pane,
        childId: state.childId,
        role: "subagent",
        status: state.status,
        reason,
        recovery: "agent_resume",
      },
    });
  }

  private armEscalation(state: ChildState, reason: string): void {
    this.cancelEscalation(state);
    state.escalationTimer = this.scheduler.setTimeout(() => {
      state.escalationTimer = undefined;
      // Reaching here means the grace window expired with no heartbeat.
      if (state.status === "interrupted") this.escalateOnce(state, reason);
    }, this.graceMs);
    state.escalationTimer.unref?.();
  }

  onEnvelope(envelope: CodriveEnvelope): void {
    const state = this.byChild.get(envelope.childId) ?? this.resolveByPane(envelope.paneId ?? "");
    if (!state) return;
    if (envelope.paneId && envelope.paneId !== state.currentPane) return;
    state.lastSeen = this.now();
    switch (envelope.kind) {
      case "announce":
        this.handleAnnounce(state, envelope);
        return;
      case "heartbeat":
        this.handleHeartbeat(state);
        return;
      case "interrupt":
        this.handleInterrupt(state, envelope);
        return;
      case "report":
        this.handleTerminal(state, envelope);
        return;
      case "farewell":
        this.handleFarewell(state, envelope);
        return;
    }
  }

  private handleAnnounce(state: ChildState, envelope: CodriveEnvelope): void {
    const announce = envelope.announce;
    const patch: Record<string, unknown> = {};
    if (announce?.piSessionFile) {
      state.piSessionFile = announce.piSessionFile;
      patch.piSessionFile = announce.piSessionFile;
    }
    if (announce?.piSessionId) {
      state.piSessionId = announce.piSessionId;
      patch.piSessionId = announce.piSessionId;
    }
    if (state.status !== "completed") {
      if (state.status !== "running") patch.status = "running";
      state.status = "running";
    }
    this.cancelEscalation(state);
    if (Object.keys(patch).length > 0) {
      try {
        this.store.updateChild(this.sessionId, state.childId, patch);
      } catch {
        // Ledger update is best-effort; in-memory state remains authoritative.
      }
    }
  }

  private handleHeartbeat(state: ChildState): void {
    if (state.status === "interrupted") state.status = "running";
    this.cancelEscalation(state);
  }

  private handleInterrupt(state: ChildState, envelope: CodriveEnvelope): void {
    const reason = envelope.interrupt?.reason ?? "the subagent loop was interrupted";
    const transient = envelope.interrupt?.transient ?? false;
    state.status = "interrupted";
    state.episode += 1;
    state.escalated = false;
    state.history.push({
      status: "interrupted",
      text: reason,
      timestamp: envelope.timestamp,
    });
    this.persistStatus(state);
    // KEEP the health monitor tracking so a real death is still noticed.
    // A transient (429/5xx) failure is expected to retry, so hold the
    // escalation; a non-transient or evidence-free interrupt arms the grace
    // window as the authoritative signal.
    if (!transient) this.armEscalation(state, reason);
    else this.cancelEscalation(state);
  }

  private handleTerminal(state: ChildState, envelope: CodriveEnvelope): void {
    if (state.status === "completed") return;
    const report = envelope.report as CodriveReport | undefined;
    const status = report?.status ?? "completed";
    const text = report?.assistantText ?? envelope.assistantText ?? "";
    this.cancelEscalation(state);
    state.status = "completed";
    state.history.push({ status, text, timestamp: envelope.timestamp });
    this.monitor.markReported(state.currentPane);
    this.persistStatus(state);
    if (state.escalated) return;
    this.wake({
      pane: state.currentPane,
      content: `SUBAGENT ${state.currentPane} completed with status ${status}.\n\n${text}`,
      details: { pane: state.currentPane, report, role: "subagent" },
    });
  }

  private handleFarewell(state: ChildState, envelope: CodriveEnvelope): void {
    const reason = envelope.farewell?.reason ?? "session_shutdown";
    state.history.push({
      status: "farewell",
      text: reason,
      timestamp: envelope.timestamp,
    });
    if (state.status === "completed") return;
    if (["reload", "new", "resume", "fork"].includes(reason)) {
      state.status = "running";
      this.cancelEscalation(state);
      this.persistStatus(state);
      return;
    }
    state.status = "dead";
    this.monitor.untrack(state.currentPane);
    this.persistStatus(state);
    this.escalateOnce(state, `the subagent exited (${reason}) with the task unfinished`);
  }

  /** A tracked pane was found dead before delivering a terminal report. */
  onPaneDeath(paneId: string): void {
    const state = this.resolveByPane(paneId);
    if (!state || state.currentPane !== paneId || state.status === "completed") return;
    state.history.push({
      status: "exited-without-report",
      text: "",
      timestamp: new Date(this.now()).toISOString(),
    });
    state.status = "dead";
    this.persistStatus(state);
    this.escalateOnce(state, "the subagent process died");
  }

  private persistStatus(state: ChildState): void {
    try {
      this.store.updateChild(this.sessionId, state.childId, { status: state.status });
    } catch {
      // Best-effort ledger sync.
    }
  }

  getHistory(paneId: string, selector: string): {
    entries: SupervisorHistoryEntry[];
  } {
    const state = this.resolveByPane(paneId);
    if (!state) throw new Error("Unknown or unowned pane");
    const all = state.history;
    if (selector === "all") return { entries: all };
    if (selector === "latest") return { entries: all.slice(-1) };
    if (/^\d+$/.test(selector) && Number(selector) > 0) {
      return { entries: all.slice(Number(selector) - 1, Number(selector)) };
    }
    throw new Error("turn must be latest, all, or a positive integer");
  }

  async readPane(paneId: string, maxLines: number): Promise<string> {
    const state = this.resolveByPane(paneId);
    if (!state) throw new Error("Unknown or unowned pane");
    if (!this.isLive(paneId)) throw new Error("Pane is not live; use agent_report for history");
    return this.backend.read(state.currentPane, maxLines);
  }

  async sendPane(paneId: string, text: string): Promise<string> {
    const state = this.resolveByPane(paneId);
    if (!state) throw new Error("Unknown or unowned pane");
    if (!this.isLive(paneId)) throw new Error("Pane is not live; use agent_report for history");
    await this.backend.send(state.currentPane, text);
    return state.currentPane;
  }

  /**
   * Relaunch a child into a fresh pane, resuming its recorded pi session. The
   * same childId is reused, report history carries forward, and both the new
   * and old pane ids resolve afterward.
   */
  async resume(
    paneId: string,
    options: { prompt?: string; force?: boolean } = {},
  ): Promise<{ childId: string; oldPane: string; newPane: string; resumeCount: number }> {
    const state = this.resolveByPane(paneId);
    if (!state) throw new Error("Unknown or unowned pane");
    const healthyAndLive =
      state.status === "running" && (await this.backend.isAlive(state.currentPane));
    if (healthyAndLive && !options.force) {
      throw new Error(
        "Child is live and healthy; pass force to resume it anyway",
      );
    }
    if (!state.piSessionId && !state.piSessionFile) {
      throw new Error("No recorded pi session to resume for this child");
    }
    const oldPane = state.currentPane;
    const relaunched: SpawnedChild = await this.controller.resume({
      childId: state.childId,
      model: state.model,
      sessionId: state.piSessionId,
      resumeSessionFile: state.piSessionId ? undefined : state.piSessionFile,
      prompt: options.prompt,
    });
    const newPane = relaunched.paneId;
    state.currentPane = newPane;
    state.paneHistory.push(newPane);
    state.status = "running";
    state.escalated = false;
    state.episode = 0;
    state.lastSeen = this.now();
    this.cancelEscalation(state);
    this.paneIndex.set(newPane, state.childId);
    this.monitor.untrack(oldPane);
    this.monitor.track(newPane);
    const record = this.store.updateChild(this.sessionId, state.childId, {
      paneId: newPane,
      status: "running",
      resumeCount: (this.store.findChildByPane(this.sessionId, oldPane)?.resumeCount ?? 0) + 1,
      paneHistory: state.paneHistory,
    });
    return {
      childId: state.childId,
      oldPane,
      newPane,
      resumeCount: record.resumeCount ?? 0,
    };
  }

  teardown(): void {
    for (const state of this.byChild.values()) this.cancelEscalation(state);
    this.byChild.clear();
    this.paneIndex.clear();
  }
}
