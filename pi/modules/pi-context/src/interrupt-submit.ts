/**
 * Interrupt-and-submit: abort the active generation, capture the editor
 * text, wait for idle, then send it as a user message.
 */

export const DEFAULT_IDLE_TIMEOUT_MS = 10_000;
export const IDLE_POLL_INTERVAL_MS = 10;

export function mergeEditorText(capturedText: string, currentEditorText: string): string {
  if (!capturedText) return currentEditorText;
  if (!currentEditorText) return capturedText;
  return `${capturedText}\n\n${currentEditorText}`;
}

export async function waitForIdle(
  isIdle: () => boolean,
  timeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
  pollIntervalMs = IDLE_POLL_INTERVAL_MS,
  now = Date.now,
  sleep = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
): Promise<void> {
  const deadline = now() + timeoutMs;
  while (!isIdle()) {
    if (now() >= deadline) throw new Error("Timed out waiting for pi to become idle");
    await sleep(pollIntervalMs);
  }
}

export interface InterruptSubmitContext {
  hasUI: boolean;
  ui: {
    getEditorText(): string;
    setEditorText(text: string): void;
    notify(message: string, type?: "info" | "warning" | "error"): void;
  };
  abort(): void;
  isIdle(): boolean;
}

export interface InterruptSubmitAPI {
  sendUserMessage(text: string): void;
}

export function createInterruptSubmitHandler(
  api: InterruptSubmitAPI,
  options: {
    timeoutMs?: number;
    pollIntervalMs?: number;
    now?: () => number;
    sleep?: (milliseconds: number) => Promise<void>;
  } = {},
) {
  let running = false;

  return async (ctx: InterruptSubmitContext): Promise<void> => {
    if (!ctx.hasUI || running) return;
    running = true;
    try {
      ctx.abort();
      const capturedText = ctx.ui.getEditorText();
      // Empty editor: ctrl+enter is a plain interrupt, and interrupting is not
      // a failure, so it stays silent.
      if (!capturedText.trim()) return;

      ctx.ui.setEditorText("");
      try {
        await waitForIdle(
          ctx.isIdle,
          options.timeoutMs,
          options.pollIntervalMs,
          options.now,
          options.sleep,
        );
        api.sendUserMessage(capturedText);
      } catch (error) {
        const currentEditorText = ctx.ui.getEditorText();
        ctx.ui.setEditorText(mergeEditorText(capturedText, currentEditorText));
        const detail = error instanceof Error ? `: ${error.message}` : "";
        ctx.ui.notify(`Could not send prompt${detail}`, "error");
      }
    } finally {
      running = false;
    }
  };
}
