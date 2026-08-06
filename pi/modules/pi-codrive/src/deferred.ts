import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { processIsAlive, type DeferDelivery, type DeferredTriggerRecord } from "./runtime-store.ts";

/**
 * Deferred triggers: the cheap way to come back to something later.
 *
 * Without this the only out-of-band wake path is a spawned subagent running a
 * sleep, which costs a model context, a tmux pane, and the single delegation
 * slot to do nothing. A trigger costs a timer and a JSON record.
 *
 * Two invariants shape everything here:
 *   1. A trigger that fires has an absolute deadline on disk, so a restart can
 *      neither shift it nor lose it.
 *   2. A trigger always ends in a delivered outcome. A condition that never
 *      comes true fires "timeout"; giving up silently is the bug this exists
 *      to remove.
 */

export const DEFAULT_POLL_MS = 15000;
export const MIN_POLL_MS = 1000;
export const DEFAULT_TIMEOUT_MS = 3600000;
export const MAX_TIMEOUT_MS = 86400000;
/** Same 24 hour ceiling as a condition timeout: longer waits are a calendar's job. */
export const MAX_DELAY_MS = MAX_TIMEOUT_MS;
/** setTimeout fires immediately past 2^31-1 ms, so long waits are re-armed in slices. */
const MAX_TIMER_SLICE_MS = 2147483647;
/** A condition check that hangs must not pin a poll slot forever. */
const CHECK_TIMEOUT_MS = 30000;

export const DEFER_MESSAGE = "pi-codrive-defer";

export type DeferOutcome = "elapsed" | "condition" | "timeout";

export interface DeferScheduler {
  setTimeout(callback: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
}

const defaultScheduler: DeferScheduler = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle),
};

export interface DeferCheckRunner {
  (command: string, signal?: AbortSignal): Promise<boolean>;
}

/**
 * Default condition evaluator: exit code 0 means the condition holds.
 *
 * It never throws and never rejects. A missing binary, a shell syntax error,
 * and a false test are all just "not true yet", because a broken check must
 * still reach its timeout instead of killing the timer that owns it.
 */
export const runShellCheck: DeferCheckRunner = (command, signal) =>
  new Promise((resolve) => {
    execFile(
      command,
      { shell: true, timeout: CHECK_TIMEOUT_MS, maxBuffer: 1024 * 1024, signal },
      (error) => resolve(!error),
    );
  });

export interface DeferSendOptions {
  triggerTurn: boolean;
  deliverAs: "steer" | "nextTurn";
}

/**
 * The two delivery behaviors, as pi.sendMessage options.
 *
 * "interrupt" -> steer + triggerTurn. "steer" is delivered after the running
 * assistant turn finishes its current tool calls and before the next LLM call,
 * which is the earliest point Pi lets an extension cut in. triggerTurn means a
 * trigger that fires while the agent sits idle still starts a turn, so a
 * reminder cannot land in an empty room and be forgotten.
 *
 * "quiet" -> nextTurn without a turn trigger. It never interrupts and never
 * wakes anything; it surfaces the next time the user prompts. Same split the
 * supervisor uses for a background child's result.
 */
export function deliveryOptions(delivery: DeferDelivery): DeferSendOptions {
  if (delivery === "quiet") return { triggerTurn: false, deliverAs: "nextTurn" };
  return { triggerTurn: true, deliverAs: "steer" };
}

export interface DeferMessage {
  customType: string;
  content: string;
  display: boolean;
  details: unknown;
}

export interface DeferMessageSink {
  (message: DeferMessage, options: DeferSendOptions): void;
}

export interface DeferredFire {
  (trigger: DeferredTriggerRecord, outcome: DeferOutcome): void;
}

/**
 * Build the wake port: the single place a fired trigger becomes a message.
 * extension.ts only supplies the sink, so the delivery mapping has exactly one
 * implementation and one place to test.
 */
export function createTriggerWake(send: DeferMessageSink): DeferredFire {
  return (trigger, outcome) => {
    send(
      {
        customType: DEFER_MESSAGE,
        content: formatTriggerFire(trigger, outcome),
        display: true,
        details: {
          id: trigger.id,
          kind: trigger.kind,
          outcome,
          delivery: trigger.delivery,
          dueAt: new Date(trigger.dueAt).toISOString(),
        },
      },
      deliveryOptions(trigger.delivery),
    );
  };
}

/** The text an agent reads when a trigger fires. */
export function formatTriggerFire(
  trigger: DeferredTriggerRecord,
  outcome: DeferOutcome,
): string {
  const head =
    outcome === "elapsed"
      ? `Deferred trigger ${trigger.id} is due.`
      : outcome === "condition"
        ? `Deferred trigger ${trigger.id} fired: \`${trigger.check}\` succeeded.`
        : `Deferred trigger ${trigger.id} timed out: \`${trigger.check}\` never succeeded before ${new Date(trigger.dueAt).toISOString()}.`;
  return `${head}\n\n${trigger.note}`;
}

/** One pending trigger as a single line, for the list action. */
export function formatTriggerLine(trigger: DeferredTriggerRecord): string {
  const due = new Date(trigger.dueAt).toISOString();
  const shape =
    trigger.kind === "after"
      ? `fires ${due}`
      : `polls \`${trigger.check}\` every ${trigger.pollMs ?? DEFAULT_POLL_MS} ms, times out ${due}`;
  return `${trigger.id}  [${trigger.kind}/${trigger.delivery}]  ${shape}  note: ${trigger.note}`;
}

/** Minimal persistence surface the registry needs. RuntimeStore implements it. */
export interface DeferredTriggerStore {
  loadTriggers(sessionId: string): DeferredTriggerRecord[];
  saveTriggers(sessionId: string, triggers: DeferredTriggerRecord[]): void;
  adoptTriggers(
    sessionId: string,
    projectRoot: string,
    isOwnerAlive?: (pid: number) => boolean,
  ): DeferredTriggerRecord[];
}

export interface DeferredTriggerRegistryOptions {
  sessionId: string;
  projectRoot: string;
  store: DeferredTriggerStore;
  /** Deliver a fired trigger. Called at most once per trigger. */
  fire: DeferredFire;
  runCheck?: DeferCheckRunner;
  scheduler?: DeferScheduler;
  now?: () => number;
  /** Owning process id, stamped on every trigger. Injectable for tests. */
  pid?: number;
  isOwnerAlive?: (pid: number) => boolean;
}

export interface CreateTriggerInput {
  /** Text delivered back when the trigger fires. */
  note: string;
  /** Elapsed wall clock for an "after" trigger. */
  delayMs?: number;
  /** Shell command for a "when" trigger; exit 0 means the condition is true. */
  check?: string;
  pollMs?: number;
  timeoutMs?: number;
  delivery?: DeferDelivery;
}

export interface RestoreResult {
  fired: DeferredTriggerRecord[];
  resumed: DeferredTriggerRecord[];
}

export class DeferredTriggerRegistry {
  private readonly sessionId: string;
  private readonly projectRoot: string;
  private readonly store: DeferredTriggerStore;
  private readonly fire: DeferredFire;
  private readonly runCheck: DeferCheckRunner;
  private readonly scheduler: DeferScheduler;
  private readonly now: () => number;
  private readonly pid: number;
  private readonly isOwnerAlive: (pid: number) => boolean;

  private readonly pending = new Map<string, DeferredTriggerRecord>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly aborts = new Map<string, AbortController>();
  private readonly inflight = new Map<string, Promise<void>>();

  constructor(options: DeferredTriggerRegistryOptions) {
    this.sessionId = options.sessionId;
    this.projectRoot = options.projectRoot;
    this.store = options.store;
    this.fire = options.fire;
    this.runCheck = options.runCheck ?? runShellCheck;
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.now = options.now ?? Date.now;
    this.pid = options.pid ?? process.pid;
    this.isOwnerAlive = options.isOwnerAlive ?? processIsAlive;
  }

  /** Arm a new trigger, persist it, and return the stored record. */
  create(input: CreateTriggerInput): DeferredTriggerRecord {
    const note = (input.note ?? "").trim();
    if (!note) {
      throw new Error("note is required: it is the text delivered back when the trigger fires");
    }
    const check = input.check?.trim();
    if (check && input.delayMs !== undefined) {
      throw new Error(
        "pass delayMs for a time trigger or check for a condition trigger, not both",
      );
    }

    const now = this.now();
    const createdAt = new Date(now).toISOString();
    const delivery: DeferDelivery = input.delivery === "quiet" ? "quiet" : "interrupt";
    const record: DeferredTriggerRecord = check
      ? {
          id: this.newId(),
          kind: "when",
          note,
          delivery,
          createdAt,
          dueAt: now + clampTimeout(input.timeoutMs),
          check,
          pollMs: clampPoll(input.pollMs),
          ownerPid: this.pid,
        }
      : {
          id: this.newId(),
          kind: "after",
          note,
          delivery,
          createdAt,
          dueAt: now + requireDelay(input.delayMs),
          ownerPid: this.pid,
        };

    this.pending.set(record.id, record);
    this.persist();
    this.arm(record);
    return { ...record };
  }

  /** Pending triggers, soonest deadline first. */
  list(): DeferredTriggerRecord[] {
    return [...this.pending.values()]
      .sort((left, right) => left.dueAt - right.dueAt)
      .map((trigger) => ({ ...trigger }));
  }

  /** Cancel by id. Returns the removed record, or undefined when unknown. */
  cancel(id: string): DeferredTriggerRecord | undefined {
    const trigger = this.pending.get(id);
    if (!trigger) return undefined;
    this.pending.delete(id);
    this.release(id);
    this.persist();
    return { ...trigger };
  }

  /**
   * Reload pending triggers after a restart.
   *
   * A deadline that passed while the process was down is overdue, not void: it
   * fires immediately. A condition trigger resumes polling, or fires its
   * timeout when its deadline is already behind us.
   */
  restore(): RestoreResult {
    const stored = this.store.adoptTriggers(
      this.sessionId,
      this.projectRoot,
      this.isOwnerAlive,
    );
    for (const trigger of stored) {
      // This process owns the timer now, so it owns the record.
      this.pending.set(trigger.id, { ...trigger, ownerPid: this.pid });
    }
    this.persist();

    const fired: DeferredTriggerRecord[] = [];
    const resumed: DeferredTriggerRecord[] = [];
    for (const trigger of [...this.pending.values()]) {
      if (this.now() < trigger.dueAt) {
        this.arm(trigger);
        resumed.push({ ...trigger });
        continue;
      }
      fired.push({ ...trigger });
      this.fireOnce(trigger, trigger.kind === "after" ? "elapsed" : "timeout");
    }
    return { fired, resumed };
  }

  /**
   * Run one polling pass for a "when" trigger. Public and awaitable for the
   * same reason PaneHealthMonitor.checkOnce is: a caller can drive one pass
   * deterministically instead of racing a background timer.
   */
  async pollOnce(id: string): Promise<void> {
    const trigger = this.pending.get(id);
    if (!trigger || trigger.kind !== "when") return;
    const pass = this.runPoll(trigger);
    this.inflight.set(id, pass);
    await pass;
    this.inflight.delete(id);
  }

  /** Await any in-flight condition check started by a timer callback. */
  async settled(): Promise<void> {
    await Promise.all([...this.inflight.values()]);
  }

  /**
   * Drop every timer without touching disk. Pending triggers stay persisted so
   * the next session restores them; shutdown is not cancellation.
   */
  stop(): void {
    for (const id of [...this.pending.keys()]) this.release(id);
    this.pending.clear();
  }

  private newId(): string {
    for (;;) {
      const id = `defer-${randomBytes(4).toString("hex")}`;
      if (!this.pending.has(id)) return id;
    }
  }

  private persist(): void {
    this.store.saveTriggers(this.sessionId, [...this.pending.values()]);
  }

  private release(id: string): void {
    const handle = this.timers.get(id);
    if (handle !== undefined) {
      this.scheduler.clearTimeout(handle);
      this.timers.delete(id);
    }
    this.aborts.get(id)?.abort();
    this.aborts.delete(id);
  }

  private arm(trigger: DeferredTriggerRecord): void {
    const remaining = Math.max(0, trigger.dueAt - this.now());
    const wait =
      trigger.kind === "after"
        ? remaining
        : Math.min(trigger.pollMs ?? DEFAULT_POLL_MS, remaining);
    const handle = this.scheduler.setTimeout(
      () => this.onTimer(trigger.id),
      Math.min(wait, MAX_TIMER_SLICE_MS),
    );
    handle.unref?.();
    this.timers.set(trigger.id, handle);
  }

  private onTimer(id: string): void {
    this.timers.delete(id);
    const trigger = this.pending.get(id);
    if (!trigger) return;
    if (trigger.kind === "when") {
      void this.pollOnce(id);
      return;
    }
    // A sliced timer wakes early on purpose; only the absolute dueAt decides.
    if (this.now() < trigger.dueAt) {
      this.arm(trigger);
      return;
    }
    this.fireOnce(trigger, "elapsed");
  }

  private async runPoll(trigger: DeferredTriggerRecord): Promise<void> {
    const controller = new AbortController();
    this.aborts.set(trigger.id, controller);
    const satisfied = await this.runCheck(trigger.check ?? "", controller.signal);
    this.aborts.delete(trigger.id);
    // A cancel or a shutdown during the check must not resurrect the trigger.
    if (!this.pending.has(trigger.id)) return;
    // The condition wins at the deadline boundary: a check that came true on
    // the last possible pass is a success, not a timeout.
    if (satisfied) {
      this.fireOnce(trigger, "condition");
      return;
    }
    if (this.now() >= trigger.dueAt) {
      this.fireOnce(trigger, "timeout");
      return;
    }
    this.arm(trigger);
  }

  private fireOnce(trigger: DeferredTriggerRecord, outcome: DeferOutcome): void {
    // Delete before delivering: the record leaves disk first, so a failure
    // inside the wake port can never replay the same trigger after a restart.
    if (!this.pending.delete(trigger.id)) return;
    this.release(trigger.id);
    this.persist();
    this.fire({ ...trigger }, outcome);
  }
}

function requireDelay(delayMs: number | undefined): number {
  if (delayMs === undefined) {
    throw new Error("create needs delayMs (a time trigger) or check (a condition trigger)");
  }
  if (!Number.isFinite(delayMs) || delayMs <= 0) {
    throw new Error("delayMs must be a positive number of milliseconds");
  }
  if (delayMs > MAX_DELAY_MS) {
    throw new Error(`delayMs may not exceed ${MAX_DELAY_MS} ms (24 hours)`);
  }
  return Math.round(delayMs);
}

/** Floored: a sub-second poll burns CPU without making the condition truer. */
function clampPoll(pollMs: number | undefined): number {
  if (pollMs === undefined || !Number.isFinite(pollMs)) return DEFAULT_POLL_MS;
  return Math.max(MIN_POLL_MS, Math.round(pollMs));
}

function clampTimeout(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs)) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_POLL_MS, Math.round(timeoutMs)));
}
