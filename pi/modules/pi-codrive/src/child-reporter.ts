import { randomUUID } from "node:crypto";
import {
  buildChildReport,
  buildInterruptEvidence,
  classifyAgentEnd,
  lastAssistantErrorMessage,
} from "./report-builder.ts";
import type { OutgoingEnvelope } from "./report-transport.ts";

export interface ReporterScheduler {
  setTimeout(callback: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
}

const defaultScheduler: ReporterScheduler = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle),
};

export const DEFAULT_SETTLE_MS = 8000;
const HEARTBEAT_THROTTLE_MS = 5000;

export interface ChildReporterOptions {
  sessionId: string;
  childId: string;
  paneId?: string;
  /** Grace window after an error end before it becomes a terminal report. */
  settleMs?: number;
  /** Sink for outgoing envelopes; wraps sendEnvelope in production. */
  send: (envelope: OutgoingEnvelope) => void | Promise<void>;
  /** Whether the agent loop is currently idle (not streaming). */
  isIdle: () => boolean;
  /** Whether queued messages are waiting to run. */
  hasPendingMessages: () => boolean;
  newEventId?: () => string;
  now?: () => number;
  scheduler?: ReporterScheduler;
}

/**
 * Child-side counterpart to the parent supervisor. Owns the per-episode
 * classification of an agent loop ending:
 *
 *   clean end -> terminal report immediately (fast path)
 *   error end -> non-terminal "interrupt" plus a settle window; a later
 *                agent_start cancels the escalation and emits a heartbeat,
 *                otherwise the window expiring while idle sends the terminal
 *                report with status error.
 *
 * Correctness does not depend on the window length: a later agent_start always
 * cancels, and the parent's eventId dedupe guarantees at most one terminal
 * report per episode.
 */
export class ChildReporter {
  private readonly sessionId: string;
  private readonly childId: string;
  private readonly paneId?: string;
  private readonly settleMs: number;
  private readonly send: (envelope: OutgoingEnvelope) => void | Promise<void>;
  private readonly isIdle: () => boolean;
  private readonly hasPendingMessages: () => boolean;
  private readonly newEventId: () => string;
  private readonly now: () => number;
  private readonly scheduler: ReporterScheduler;

  private lastProviderStatus: number | undefined;
  private lastRetryAfter: string | undefined;
  private settleTimer: ReturnType<typeof setTimeout> | undefined;
  private settleMessages: unknown;
  private lastHeartbeatAt = 0;

  constructor(options: ChildReporterOptions) {
    this.sessionId = options.sessionId;
    this.childId = options.childId;
    this.paneId = options.paneId;
    this.settleMs = options.settleMs ?? DEFAULT_SETTLE_MS;
    this.send = options.send;
    this.isIdle = options.isIdle;
    this.hasPendingMessages = options.hasPendingMessages;
    this.newEventId = options.newEventId ?? (() => randomUUID());
    this.now = options.now ?? Date.now;
    this.scheduler = options.scheduler ?? defaultScheduler;
  }

  private emit(envelope: OutgoingEnvelope): void {
    try {
      void Promise.resolve(this.send(envelope)).catch(() => {
        // Reporting is best-effort and must never break the child session.
      });
    } catch {
      // Reporting is best-effort and must never break the child session.
    }
  }

  private base(): Pick<OutgoingEnvelope, "eventId" | "sessionId" | "childId" | "paneId" | "timestamp"> {
    return {
      eventId: this.newEventId(),
      sessionId: this.sessionId,
      childId: this.childId,
      paneId: this.paneId,
      timestamp: new Date(this.now()).toISOString(),
    };
  }

  /** Announce startup: verified pane<->child binding from the child itself. */
  announce(payload: {
    piSessionFile?: string;
    piSessionId?: string;
    cwd?: string;
    model?: string;
  }): void {
    this.emit({
      ...this.base(),
      kind: "announce",
      announce: {
        piSessionFile: payload.piSessionFile,
        piSessionId: payload.piSessionId,
        paneId: this.paneId,
        cwd: payload.cwd,
        model: payload.model,
      },
    });
  }

  /** Record the last provider HTTP response as interrupt evidence. */
  recordProviderResponse(status: number, headers: Record<string, string>): void {
    this.lastProviderStatus = status;
    const retryAfter = headers?.["retry-after"] ?? headers?.["Retry-After"];
    this.lastRetryAfter = typeof retryAfter === "string" ? retryAfter : undefined;
  }

  /** Throttled progress signal; never more than one per ~5s. */
  heartbeat(force = false): void {
    const at = this.now();
    if (!force && at - this.lastHeartbeatAt < HEARTBEAT_THROTTLE_MS) return;
    this.lastHeartbeatAt = at;
    this.emit({ ...this.base(), kind: "heartbeat" });
  }

  private clearSettleTimer(): boolean {
    const hadTimer = this.settleTimer !== undefined;
    if (this.settleTimer !== undefined) {
      this.scheduler.clearTimeout(this.settleTimer);
      this.settleTimer = undefined;
    }
    this.settleMessages = undefined;
    return hadTimer;
  }

  /** A new agent loop started: cancel any pending escalation and heartbeat. */
  onAgentStart(): void {
    const recovered = this.clearSettleTimer();
    this.lastProviderStatus = undefined;
    this.lastRetryAfter = undefined;
    if (recovered) this.heartbeat(true);
  }

  onAgentEnd(messages: unknown): void {
    const outcome = classifyAgentEnd(messages);
    if (outcome !== "interrupted") {
      this.clearSettleTimer();
      this.sendTerminal(messages);
      return;
    }
    const evidence = buildInterruptEvidence({
      providerStatus: this.lastProviderStatus,
      retryAfter: this.lastRetryAfter,
      errorMessage: lastAssistantErrorMessage(messages),
    });
    this.emit({ ...this.base(), kind: "interrupt", interrupt: evidence });
    this.clearSettleTimer();
    this.settleMessages = messages;
    this.settleTimer = this.scheduler.setTimeout(() => {
      this.settleTimer = undefined;
      const pending = this.settleMessages;
      this.settleMessages = undefined;
      if (this.isIdle() && !this.hasPendingMessages()) {
        this.sendTerminal(pending);
      }
    }, this.settleMs);
    this.settleTimer.unref?.();
  }

  onShutdown(reason: string): void {
    this.clearSettleTimer();
    this.emit({ ...this.base(), kind: "farewell", farewell: { reason } });
  }

  private sendTerminal(messages: unknown): void {
    const report = buildChildReport(messages, {
      sessionId: this.sessionId,
      childId: this.childId,
      paneId: this.paneId,
      eventId: this.newEventId(),
      now: new Date(this.now()),
    });
    this.emit({
      eventId: report.eventId,
      sessionId: report.sessionId,
      childId: report.childId,
      paneId: report.paneId,
      timestamp: report.timestamp,
      kind: "report",
      report,
      assistantText: report.assistantText,
    });
  }
}
