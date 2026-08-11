/**
 * Process-scoped storage for the single prompt stash slot.
 *
 * A reload tears down the extension runtime and rebinds a fresh extension
 * instance, so anything held in the extension factory's closure (or in plain
 * module scope, since the module is re-imported) is gone by the time the new
 * instance receives session_start. A registered symbol on a host object is
 * the same slot across re-imports, so the stash survives a reload while still
 * dying naturally with the process.
 */

const SLOT_KEY = Symbol.for("pi.prompt-stash.slot");

export interface StashSlot {
  value?: string;
}

export type StashHost = Record<PropertyKey, unknown>;

/** Get the shared slot, creating it on first use. */
export function stashSlot(host: StashHost = globalThis as unknown as StashHost): StashSlot {
  const existing = host[SLOT_KEY] as StashSlot | undefined;
  if (existing) return existing;
  const slot: StashSlot = {};
  host[SLOT_KEY] = slot;
  return slot;
}

/**
 * Reloading or starting a fresh session keeps the stash, so /clear does not
 * discard a draft the user deliberately held. Startup, resume, and fork move to
 * a conversation where that draft would reappear out of nowhere, so they clear it.
 */
export function preservesStash(reason: string): boolean {
  return reason === "reload" || reason === "new";
}

/** Single-slot prompt stash backed by process-scoped storage. */
export class PromptStash {
  private readonly slot: StashSlot;

  constructor(slot: StashSlot = stashSlot()) {
    this.slot = slot;
  }

  get has(): boolean {
    return this.slot.value !== undefined;
  }

  peek(): string | undefined {
    return this.slot.value;
  }

  set(text: string): void {
    this.slot.value = text;
  }

  /** Read and clear in one step. */
  take(): string | undefined {
    const held = this.slot.value;
    this.slot.value = undefined;
    return held;
  }

  clear(): void {
    this.slot.value = undefined;
  }

  /**
   * Apply a session_start. Returns the stash that should be shown again after
   * a reload or fresh session, or undefined when nothing should be restored.
   */
  onSessionStart(reason: string): string | undefined {
    if (!preservesStash(reason)) {
      this.clear();
      return undefined;
    }
    return this.slot.value;
  }
}
