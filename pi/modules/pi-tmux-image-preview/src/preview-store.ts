import type { StoredImagePreview } from "./types.ts";

export type PromotedPreview = {
  preview: StoredImagePreview;
  evicted?: StoredImagePreview;
};

export class PreviewStore {
  private readonly pending = new Map<string, StoredImagePreview>();
  private readonly completed = new Map<string, StoredImagePreview>();
  private readonly capacity: number;

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error("PreviewStore capacity must be a positive integer");
    }
    this.capacity = capacity;
  }

  queue(toolCallId: string, preview: StoredImagePreview): void {
    this.pending.delete(toolCallId);
    while (this.pending.size >= this.capacity) {
      const oldest = this.pending.keys().next().value;
      if (oldest === undefined) break;
      this.pending.delete(oldest);
    }
    this.pending.set(toolCallId, preview);
  }

  promote(toolCallId: string, previewId: string): PromotedPreview | undefined {
    const preview = this.pending.get(toolCallId);
    if (!preview) return undefined;

    this.pending.delete(toolCallId);
    let evicted: StoredImagePreview | undefined;
    while (this.completed.size >= this.capacity) {
      const oldest = this.completed.keys().next().value;
      if (oldest === undefined) break;
      evicted = this.completed.get(oldest);
      this.completed.delete(oldest);
    }
    this.completed.set(previewId, preview);
    return { preview, evicted };
  }

  get(previewId: string): StoredImagePreview | undefined {
    return this.completed.get(previewId);
  }

  clear(): StoredImagePreview[] {
    const completed = [...this.completed.values()];
    this.pending.clear();
    this.completed.clear();
    return completed;
  }

  get pendingSize(): number {
    return this.pending.size;
  }

  get completedSize(): number {
    return this.completed.size;
  }
}
