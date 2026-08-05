/**
 * Serial queue for desktop notifications.
 *
 * Posting is a single-instance macOS app launch plus a shared payload file, so
 * two overlapping posts corrupt each other: the second launch reopens the app
 * that is still running and the applet answers with a blocking "Press Run to
 * run this script" dialog instead of a notification. The queue guarantees one
 * post at a time, and collapses bursts so an interrupt cannot pile up launches.
 */

export interface NotificationPayload {
  title: string;
  subtitle: string;
  message: string;
}

export interface NotificationQueueOptions {
  post: (payload: NotificationPayload) => Promise<void>;
  /** Pending posts kept during a burst; older ones are dropped. */
  maxQueued?: number;
  onError?: (error: string) => void;
}

export interface NotificationQueue {
  /** Queue a post; resolves when the queue has drained. */
  enqueue(payload: NotificationPayload): Promise<void>;
  readonly queued: number;
  readonly busy: boolean;
}

export const DEFAULT_MAX_QUEUED = 3;

export function createNotificationQueue(
  options: NotificationQueueOptions,
): NotificationQueue {
  const maxQueued = options.maxQueued ?? DEFAULT_MAX_QUEUED;
  const queue: NotificationPayload[] = [];
  let draining: Promise<void> | null = null;

  const drain = async (): Promise<void> => {
    while (queue.length > 0) {
      const payload = queue.shift() as NotificationPayload;
      try {
        await options.post(payload);
      } catch (error) {
        options.onError?.(error instanceof Error ? error.message : String(error));
      }
    }
    draining = null;
  };

  return {
    enqueue(payload: NotificationPayload): Promise<void> {
      queue.push(payload);
      while (queue.length > maxQueued) queue.shift();
      draining ??= drain();
      return draining;
    },
    get queued(): number {
      return queue.length;
    },
    get busy(): boolean {
      return draining !== null;
    },
  };
}
