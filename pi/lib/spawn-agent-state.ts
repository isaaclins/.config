export class NotifyEventCursor {
  private processedBytes = 0;
  private pending = "";

  ingest(content: string): string[] {
    const newContent = content.slice(this.processedBytes);
    this.processedBytes = content.length;
    this.pending += newContent;
    const completeLines = this.pending.split("\n");
    this.pending = completeLines.pop() ?? "";
    return completeLines.filter((line) => line.trim() !== "");
  }

  reset(): void {
    this.processedBytes = 0;
    this.pending = "";
  }
}

export class OwnedPaneRegistry {
  private readonly panes = new Set<string>();

  add(pane: string): void { this.panes.add(pane); }
  has(pane: string): boolean { return this.panes.has(pane); }
  delete(pane: string): void { this.panes.delete(pane); }
  clear(): void { this.panes.clear(); }
}
