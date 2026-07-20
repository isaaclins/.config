export interface PaneIntervalScheduler {
  setInterval(
    callback: () => void,
    milliseconds: number,
  ): ReturnType<typeof setInterval>;
  clearInterval(timer: ReturnType<typeof setInterval>): void;
}

export interface PaneHealthMonitorOptions {
  /** Poll interval in milliseconds. */
  intervalMs: number;
  /** Liveness probe for a pane; false means the pane has exited. */
  isAlive: (paneId: string) => Promise<boolean>;
  /**
   * Invoked exactly once when a tracked pane is found dead before it has
   * delivered a report. The pane is untracked immediately afterward so the
   * signal never fires twice for the same exit.
   */
  onExitedWithoutReport: (paneId: string) => void;
  /** Injectable timer source; defaults to the global timers. */
  scheduler?: PaneIntervalScheduler;
}

const defaultScheduler: PaneIntervalScheduler = {
  setInterval: (callback, milliseconds) => setInterval(callback, milliseconds),
  clearInterval: (timer) => clearInterval(timer),
};

/**
 * Watches spawned panes for the case where a child process exits without ever
 * delivering an authenticated report. A single background interval polls every
 * tracked pane; the first time a pane is seen dead while still awaiting a
 * report, it synthesizes an "exited-without-report" signal so report history
 * reflects the exit instead of silently going stale.
 */
export class PaneHealthMonitor {
  private readonly intervalMs: number;
  private readonly isAlive: (paneId: string) => Promise<boolean>;
  private readonly onExitedWithoutReport: (paneId: string) => void;
  private readonly scheduler: PaneIntervalScheduler;
  private readonly pending = new Set<string>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private checking = false;

  constructor(options: PaneHealthMonitorOptions) {
    this.intervalMs = options.intervalMs;
    this.isAlive = options.isAlive;
    this.onExitedWithoutReport = options.onExitedWithoutReport;
    this.scheduler = options.scheduler ?? defaultScheduler;
  }

  /** Begin watching a freshly spawned pane. */
  track(paneId: string): void {
    this.pending.add(paneId);
  }

  /** A report arrived for this pane; stop watching without firing an exit. */
  markReported(paneId: string): void {
    this.pending.delete(paneId);
  }

  /** Stop watching a pane without firing an exit (e.g. explicit teardown). */
  untrack(paneId: string): void {
    this.pending.delete(paneId);
  }

  /** Start the background polling interval. Idempotent. */
  start(): void {
    if (this.timer) return;
    this.timer = this.scheduler.setInterval(() => {
      void this.checkOnce();
    }, this.intervalMs);
    this.timer.unref?.();
  }

  /** Stop the interval and release the timer. */
  stop(): void {
    if (!this.timer) return;
    this.scheduler.clearInterval(this.timer);
    this.timer = undefined;
  }

  get running(): boolean {
    return this.timer !== undefined;
  }

  get tracked(): number {
    return this.pending.size;
  }

  /** Run one polling pass over every tracked pane. */
  async checkOnce(): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    try {
      for (const paneId of [...this.pending]) {
        if (!this.pending.has(paneId)) continue;
        let alive: boolean;
        try {
          alive = await this.isAlive(paneId);
        } catch {
          // A failed probe means the pane can no longer be trusted as live.
          alive = false;
        }
        if (alive) continue;
        if (!this.pending.delete(paneId)) continue;
        this.onExitedWithoutReport(paneId);
      }
    } finally {
      this.checking = false;
    }
  }
}
