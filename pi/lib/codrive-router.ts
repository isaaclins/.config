import type { SpawnReportRecord } from "./codrive-state.ts";

interface PendingReport {
  report: SpawnReportRecord;
  bytes: number;
  receivedAt: number;
}

export interface ReportRouterOptions {
  maxPendingCount?: number;
  maxPendingBytes?: number;
  pendingTtlMs?: number;
  now?: () => number;
}

export class ReportRouter {
  private readonly owned = new Set<string>();
  private readonly pending = new Map<string, PendingReport>();
  private readonly delivered = new Set<string>();
  private pendingBytes = 0;
  private readonly maxPendingCount: number;
  private readonly maxPendingBytes: number;
  private readonly pendingTtlMs: number;
  private readonly now: () => number;
  private readonly deliver: (report: SpawnReportRecord) => void;

  constructor(
    deliver: (report: SpawnReportRecord) => void,
    options: ReportRouterOptions = {},
  ) {
    this.deliver = deliver;
    this.maxPendingCount = options.maxPendingCount ?? 100;
    this.maxPendingBytes = options.maxPendingBytes ?? 5 * 1024 * 1024;
    this.pendingTtlMs = options.pendingTtlMs ?? 60_000;
    this.now = options.now ?? Date.now;
  }

  receive(report: SpawnReportRecord): boolean {
    if (this.delivered.has(report.eventId) || this.pending.has(report.eventId))
      return true;
    if (report.pane && this.owned.has(report.pane)) {
      this.deliverOnce(report);
      return true;
    }
    this.prune();
    const bytes = Buffer.byteLength(JSON.stringify(report));
    if (
      !report.pane ||
      this.pending.size >= this.maxPendingCount ||
      this.pendingBytes + bytes > this.maxPendingBytes
    )
      return false;
    this.pending.set(report.eventId, { report, bytes, receivedAt: this.now() });
    this.pendingBytes += bytes;
    return true;
  }

  registerPane(pane: string): void {
    this.owned.add(pane);
    this.prune();
    for (const [eventId, pending] of this.pending) {
      if (pending.report.pane !== pane) continue;
      this.pending.delete(eventId);
      this.pendingBytes -= pending.bytes;
      this.deliverOnce(pending.report);
    }
  }

  owns(pane: string): boolean {
    return this.owned.has(pane);
  }

  clear(): void {
    this.owned.clear();
    this.pending.clear();
    this.delivered.clear();
    this.pendingBytes = 0;
  }

  private deliverOnce(report: SpawnReportRecord): void {
    if (this.delivered.has(report.eventId)) return;
    this.delivered.add(report.eventId);
    this.deliver(report);
  }

  private prune(): void {
    const cutoff = this.now() - this.pendingTtlMs;
    for (const [eventId, pending] of this.pending) {
      if (pending.receivedAt > cutoff) continue;
      this.pending.delete(eventId);
      this.pendingBytes -= pending.bytes;
    }
  }
}
