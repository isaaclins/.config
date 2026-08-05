import assert from "node:assert/strict";
import test from "node:test";
import {
  createNotificationQueue,
  type NotificationPayload,
} from "../lib/notify-queue.ts";

function payload(message: string): NotificationPayload {
  return { title: "pi", subtitle: "done", message };
}

test("posts never overlap, so applet launches cannot collide (notify-sound.ts)", async () => {
  const started: string[] = [];
  const finished: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;

  const queue = createNotificationQueue({
    post: async (item) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      started.push(item.message);
      await new Promise((resolve) => setTimeout(resolve, 1));
      finished.push(item.message);
      inFlight--;
    },
  });

  queue.enqueue(payload("first"));
  queue.enqueue(payload("second"));
  await queue.enqueue(payload("third"));

  assert.equal(maxInFlight, 1);
  assert.deepEqual(started, ["first", "second", "third"]);
  assert.deepEqual(finished, ["first", "second", "third"]);
  assert.equal(queue.busy, false);
  assert.equal(queue.queued, 0);
});

test("a burst collapses to the newest posts instead of piling up", async () => {
  const posted: string[] = [];
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });

  const queue = createNotificationQueue({
    maxQueued: 2,
    post: async (item) => {
      posted.push(item.message);
      if (item.message === "first") await blocked;
    },
  });

  queue.enqueue(payload("first"));
  let drained!: Promise<void>;
  for (const message of ["a", "b", "c", "d"]) drained = queue.enqueue(payload(message));
  assert.equal(queue.queued, 2);

  release();
  await drained;

  assert.deepEqual(posted, ["first", "c", "d"]);
});

test("a failed post is reported and does not stop the queue", async () => {
  const posted: string[] = [];
  const errors: string[] = [];

  const queue = createNotificationQueue({
    post: async (item) => {
      posted.push(item.message);
      if (item.message === "boom") throw new Error("launch failed");
    },
    onError: (error) => errors.push(error),
  });

  queue.enqueue(payload("boom"));
  await queue.enqueue(payload("after"));

  assert.deepEqual(posted, ["boom", "after"]);
  assert.deepEqual(errors, ["launch failed"]);
});

test("enqueueing after a drain starts a new drain", async () => {
  const posted: string[] = [];
  const queue = createNotificationQueue({
    post: async (item) => {
      posted.push(item.message);
    },
  });

  await queue.enqueue(payload("one"));
  assert.equal(queue.busy, false);
  await queue.enqueue(payload("two"));

  assert.deepEqual(posted, ["one", "two"]);
});
