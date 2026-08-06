/**
 * "Reload as soon as the agent is done" logic, kept free of the Pi runtime so
 * the waiting rules are unit-testable.
 *
 * Pi's builtin /reload refuses to run while the session is streaming or
 * compacting: `handleReloadCommand` warns and returns. The literal string
 * `/reload` is matched on the editor submit path before extension commands are
 * dispatched, so an extension can never own that name; the workaround is a
 * separate command that waits for the refusal conditions to clear and only
 * then calls the same guarded reload through `ctx.reload()`.
 *
 * Two facts shape the loop:
 * - `waitForIdle()` resolves when the agent run settles, but auto-compaction
 *   is kicked off right after a turn ends, so one wait is not enough. Both
 *   conditions have to be re-checked until they are simultaneously clear.
 * - Extensions get `session_before_compact` (compaction starting) and
 *   `session_compact` (compaction *succeeded*). There is no extension-visible
 *   end event for a compaction that failed, and no `isCompacting()` on the
 *   context. A tracked flag can therefore be left stuck on, so it expires.
 */

/** Minimal shape of an AbortSignal, so tests do not need the DOM lib. */
export interface AbortLike {
  aborted: boolean;
  addEventListener(type: "abort", listener: () => void, options?: { once?: boolean }): void;
}

/**
 * How long a compaction may stay "in progress" before the flag is treated as
 * stale. Compaction only reports completion to extensions when it succeeds, so
 * without an expiry a failed compaction would block reloading forever.
 */
export const COMPACTION_STALE_AFTER_MS = 5 * 60_000;

/** Gap between re-checks while waiting for a compaction to finish. */
export const COMPACTION_POLL_MS = 100;

/**
 * Spin guard for the settle loop. Only reachable if `waitForIdle()` keeps
 * resolving while the session claims to be busy; the compaction path is bounded
 * by the staleness expiry long before this many polls elapse.
 */
export const MAX_SETTLE_CHECKS = 4000;

/**
 * Tracks whether a compaction is running, from the two events extensions can
 * see. `end()` is driven by `session_compact` (success) and by the abort signal
 * carried on `session_before_compact` (cancellation); a compaction that fails
 * for any other reason reports nothing, which is what the expiry covers.
 */
export class CompactionTracker {
  private active = 0;
  private startedAt: number | undefined;
  private readonly now: () => number;
  private readonly staleAfterMs: number;

  // Plain field assignment, not constructor parameter properties: the tests and
  // pi both load these files through Node's strip-only type stripping, which
  // rejects parameter properties outright.
  constructor(now: () => number = Date.now, staleAfterMs: number = COMPACTION_STALE_AFTER_MS) {
    this.now = now;
    this.staleAfterMs = staleAfterMs;
  }

  /** Record a compaction start. The signal, when given, clears it on abort. */
  begin(signal?: AbortLike): void {
    if (signal?.aborted) return;
    this.active++;
    this.startedAt ??= this.now();
    signal?.addEventListener("abort", () => this.end(), { once: true });
  }

  end(): void {
    this.active = Math.max(0, this.active - 1);
    if (this.active === 0) this.startedAt = undefined;
  }

  isCompacting(): boolean {
    if (this.active === 0) return false;
    if (this.startedAt !== undefined && this.now() - this.startedAt >= this.staleAfterMs) {
      // The end event never arrived. Assume it never will rather than wedging
      // every future reload request behind a flag nothing can clear.
      this.active = 0;
      this.startedAt = undefined;
      return false;
    }
    return true;
  }
}

/** Everything the pending reload needs from the live command context. */
export interface ReloadDeps {
  isIdle(): boolean;
  isCompacting(): boolean;
  waitForIdle(): Promise<void>;
  notify(message: string, level: "info" | "warning"): void;
  /** Must be the last call: the captured context is stale afterwards. */
  reload(): Promise<void>;
  sleep?(ms: number): Promise<void>;
  pollMs?: number;
  maxChecks?: number;
}

export type ReloadOutcome =
  /** Reloaded. `waited` is false when the session was already settled. */
  | { status: "reloaded"; waited: boolean }
  /** A reload is already armed; a second request must not arm another. */
  | { status: "already-pending" }
  /** The session went away before the reload could fire. */
  | { status: "cancelled" }
  /** The session never settled within the bound. */
  | { status: "gave-up" };

export const QUEUED_MESSAGE = "Reload queued: it will run as soon as the agent is idle";
export const ALREADY_PENDING_MESSAGE = "Reload already queued: it will run as soon as the agent is idle";
export const GAVE_UP_MESSAGE = "Reload dropped: the session never became idle. Run /reload-when-idle again.";

/**
 * A single armed reload. Holding this across invocations is what makes the
 * command idempotent: a second request while one is pending is reported, not
 * queued behind the first.
 */
export class PendingReload {
  private pending = false;
  private cancelled = false;
  private wake: (() => void) | undefined;

  get isPending(): boolean {
    return this.pending;
  }

  /**
   * Drop an armed reload. Called on session_shutdown, so a reload waiting on a
   * session that is being torn down or replaced never fires against a dead one.
   *
   * This has to interrupt the wait, not just set a flag. A settle loop parked
   * in waitForIdle() on a session that is being replaced would otherwise wait
   * on a promise nobody is left to resolve, pinning this instance and its
   * closure for the life of the process.
   */
  cancel(): void {
    this.cancelled = true;
    this.pending = false;
    this.wake?.();
  }

  async request(deps: ReloadDeps): Promise<ReloadOutcome> {
    if (this.pending) {
      deps.notify(ALREADY_PENDING_MESSAGE, "info");
      return { status: "already-pending" };
    }

    if (this.settled(deps)) {
      await deps.reload();
      return { status: "reloaded", waited: false };
    }

    // Nothing visible happens for however long the turn runs, so say so.
    deps.notify(QUEUED_MESSAGE, "info");
    this.pending = true;
    this.cancelled = false;
    let result: "settled" | "cancelled" | "gave-up";
    try {
      result = await this.settle(deps);
    } finally {
      this.pending = false;
    }

    if (result === "cancelled") return { status: "cancelled" };
    if (result === "gave-up") {
      deps.notify(GAVE_UP_MESSAGE, "warning");
      return { status: "gave-up" };
    }

    await deps.reload();
    return { status: "reloaded", waited: true };
  }

  private settled(deps: ReloadDeps): boolean {
    return deps.isIdle() && !deps.isCompacting();
  }

  private async settle(deps: ReloadDeps): Promise<"settled" | "cancelled" | "gave-up"> {
    const sleep = deps.sleep ?? defaultSleep;
    const pollMs = deps.pollMs ?? COMPACTION_POLL_MS;
    const maxChecks = deps.maxChecks ?? MAX_SETTLE_CHECKS;
    const interrupted = new Promise<void>((resolve) => {
      this.wake = resolve;
    });

    try {
      for (let check = 0; check < maxChecks; check++) {
        if (this.cancelled) return "cancelled";
        if (this.settled(deps)) return "settled";
        // Streaming has a real completion signal; compaction only has polling,
        // because its end is not observable while it runs. Either way the wait
        // loses to cancel(), so a dead session never parks this loop forever.
        const step = deps.isIdle() ? sleep(pollMs) : deps.waitForIdle();
        await Promise.race([step, interrupted]);
      }
      return "gave-up";
    } finally {
      this.wake = undefined;
    }
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
