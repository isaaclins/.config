/**
 * Session polling lifecycle: a generic interval-based poller with
 * proper cleanup and duplicate-start prevention.
 */

export interface IntervalScheduler {
  setInterval(callback: () => void, milliseconds: number): ReturnType<typeof setInterval>;
  clearInterval(timer: ReturnType<typeof setInterval>): void;
}

export class SessionPoller {
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly scheduler: IntervalScheduler;
  private readonly intervalMs: number;

  constructor(scheduler: IntervalScheduler, intervalMs: number) {
    this.scheduler = scheduler;
    this.intervalMs = intervalMs;
  }

  start(callback: () => void): void {
    if (this.timer) return;
    this.timer = this.scheduler.setInterval(callback, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    this.scheduler.clearInterval(this.timer);
    this.timer = undefined;
  }

  get running(): boolean {
    return this.timer !== undefined;
  }
}
