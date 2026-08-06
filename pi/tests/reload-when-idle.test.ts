import assert from "node:assert/strict";
import test from "node:test";
import {
  ALREADY_PENDING_MESSAGE,
  COMPACTION_STALE_AFTER_MS,
  CompactionTracker,
  GAVE_UP_MESSAGE,
  PendingReload,
  QUEUED_MESSAGE,
  type ReloadDeps,
} from "../lib/reload-when-idle.ts";

type SessionState = { idle: boolean; compacting: boolean };

/**
 * A stand-in for the live command context. The session only changes state when
 * the code under test actually waits, which is what makes "did it re-check"
 * observable: each entry of `timeline` is applied by one waitForIdle or sleep.
 */
function fakeDeps(initial: Partial<SessionState>, timeline: Partial<SessionState>[] = []) {
  const state: SessionState = { idle: true, compacting: false, ...initial };
  const notes: { message: string; level: string }[] = [];
  let reloads = 0;
  let waits = 0;
  let sleeps = 0;
  let step = 0;

  const advance = () => Object.assign(state, timeline[step++] ?? {});

  const deps: ReloadDeps = {
    isIdle: () => state.idle,
    isCompacting: () => state.compacting,
    waitForIdle: async () => {
      waits++;
      advance();
    },
    notify: (message, level) => notes.push({ message, level }),
    reload: async () => {
      reloads++;
    },
    sleep: async () => {
      sleeps++;
      advance();
    },
    pollMs: 0,
    maxChecks: 50,
  };

  return {
    deps,
    notes,
    get reloads() {
      return reloads;
    },
    get waits() {
      return waits;
    },
    get sleeps() {
      return sleeps;
    },
  };
}

test("an idle, non-compacting session reloads immediately and says nothing", async () => {
  const fake = fakeDeps({ idle: true });
  const reload = new PendingReload();

  const outcome = await reload.request(fake.deps);

  assert.deepEqual(outcome, { status: "reloaded", waited: false });
  assert.equal(fake.reloads, 1);
  assert.equal(fake.waits, 0, "no need to wait for a session that is already settled");
  assert.deepEqual(fake.notes, [], "an immediate reload speaks for itself");
});

test("a streaming session is told the reload is queued, then reloads once idle", async () => {
  const fake = fakeDeps({ idle: false }, [{ idle: true }]);
  const reload = new PendingReload();

  const outcome = await reload.request(fake.deps);

  assert.deepEqual(outcome, { status: "reloaded", waited: true });
  assert.equal(fake.reloads, 1);
  assert.equal(fake.waits, 1);
  assert.deepEqual(fake.notes, [{ message: QUEUED_MESSAGE, level: "info" }]);
  assert.equal(reload.isPending, false, "the arm is released once the reload fires");
});

test("compaction starting right after the turn ends is waited out too", async () => {
  // The turn ends and auto-compaction kicks in immediately, so one waitForIdle
  // is not enough: the session is idle but still not reloadable.
  const fake = fakeDeps({ idle: false }, [{ idle: true, compacting: true }, { compacting: false }]);
  const reload = new PendingReload();

  const outcome = await reload.request(fake.deps);

  assert.deepEqual(outcome, { status: "reloaded", waited: true });
  assert.equal(fake.reloads, 1);
  assert.equal(fake.waits, 1, "streaming is awaited once");
  assert.equal(fake.sleeps, 1, "compaction has no completion signal, so it is polled");
});

test("a second request while one is pending does not arm a second reload", async () => {
  let releaseTurn: (() => void) | undefined;
  const turnDone = new Promise<void>((resolve) => {
    releaseTurn = resolve;
  });

  let idle = false;
  const notes: { message: string; level: string }[] = [];
  let reloads = 0;
  const deps: ReloadDeps = {
    isIdle: () => idle,
    isCompacting: () => false,
    waitForIdle: async () => {
      await turnDone;
      idle = true;
    },
    notify: (message, level) => notes.push({ message, level }),
    reload: async () => {
      reloads++;
    },
    sleep: async () => {},
    pollMs: 0,
  };

  const reload = new PendingReload();
  const first = reload.request(deps);
  await Promise.resolve();
  assert.equal(reload.isPending, true);

  const second = await reload.request(deps);
  assert.deepEqual(second, { status: "already-pending" });

  releaseTurn!();
  assert.deepEqual(await first, { status: "reloaded", waited: true });
  assert.equal(reloads, 1, "exactly one reload, not one per invocation");
  assert.deepEqual(notes, [
    { message: QUEUED_MESSAGE, level: "info" },
    { message: ALREADY_PENDING_MESSAGE, level: "info" },
  ]);
});

test("a session shutdown drops the pending reload instead of firing it", async () => {
  let releaseTurn: (() => void) | undefined;
  const turnDone = new Promise<void>((resolve) => {
    releaseTurn = resolve;
  });

  let reloads = 0;
  const reload = new PendingReload();
  const deps: ReloadDeps = {
    isIdle: () => false,
    isCompacting: () => false,
    waitForIdle: async () => {
      await turnDone;
    },
    notify: () => {},
    reload: async () => {
      reloads++;
    },
    sleep: async () => {},
    pollMs: 0,
  };

  const pending = reload.request(deps);
  await Promise.resolve();

  // session_shutdown: quit, or the session was replaced under us.
  reload.cancel();
  releaseTurn!();

  assert.deepEqual(await pending, { status: "cancelled" });
  assert.equal(reloads, 0, "never reload a session that is already gone");
});

test("cancelling interrupts a wait that nothing else would ever resolve", async () => {
  // A session being replaced stops resolving waitForIdle(), so a cancel that
  // only set a flag would leave this loop parked on a dead promise forever.
  let reloads = 0;
  const reload = new PendingReload();
  const deps: ReloadDeps = {
    isIdle: () => false,
    isCompacting: () => false,
    waitForIdle: () => new Promise<void>(() => {}),
    notify: () => {},
    reload: async () => {
      reloads++;
    },
    sleep: () => new Promise<void>(() => {}),
    pollMs: 0,
  };

  const pending = reload.request(deps);
  await Promise.resolve();
  assert.equal(reload.isPending, true);

  reload.cancel();

  // No turn is ever released here: only cancel() can settle this.
  assert.deepEqual(await pending, { status: "cancelled" });
  assert.equal(reloads, 0);
  assert.equal(reload.isPending, false);
});

test("a session that never settles gives up loudly rather than spinning forever", async () => {
  // Permanently busy: nothing on the timeline ever makes it idle.
  const fake = fakeDeps({ idle: false });
  fake.deps.maxChecks = 5;

  const outcome = await new PendingReload().request(fake.deps);

  assert.deepEqual(outcome, { status: "gave-up" });
  assert.equal(fake.reloads, 0);
  assert.deepEqual(fake.notes, [
    { message: QUEUED_MESSAGE, level: "info" },
    { message: GAVE_UP_MESSAGE, level: "warning" },
  ]);
});

test("giving up releases the arm so the command can be run again", async () => {
  const reload = new PendingReload();
  const deps: ReloadDeps = {
    isIdle: () => false,
    isCompacting: () => false,
    waitForIdle: async () => {},
    notify: () => {},
    reload: async () => {},
    sleep: async () => {},
    pollMs: 0,
    maxChecks: 3,
  };

  assert.deepEqual(await reload.request(deps), { status: "gave-up" });
  assert.equal(reload.isPending, false);
  assert.deepEqual(await reload.request(deps), { status: "gave-up" }, "not stuck as pending");
});

test("compaction is tracked from start to success", () => {
  const tracker = new CompactionTracker();
  assert.equal(tracker.isCompacting(), false);

  tracker.begin();
  assert.equal(tracker.isCompacting(), true, "session_before_compact opens the window");

  tracker.end();
  assert.equal(tracker.isCompacting(), false, "session_compact closes it");
});

test("an aborted compaction clears the flag through its abort signal", () => {
  const tracker = new CompactionTracker();
  const controller = new AbortController();

  tracker.begin(controller.signal);
  assert.equal(tracker.isCompacting(), true);

  controller.abort();
  assert.equal(tracker.isCompacting(), false, "no session_compact arrives for a cancelled one");

  // An already-aborted signal must not open a window that nothing can close.
  const done = new AbortController();
  done.abort();
  tracker.begin(done.signal);
  assert.equal(tracker.isCompacting(), false);
});

test("a compaction that never reports an end expires instead of blocking reloads", () => {
  // Pi emits session_compact only on success, so a failed compaction leaves no
  // extension-visible end event. Without the expiry the flag would stay on for
  // the lifetime of the session and /reload-when-idle would never fire.
  let now = 1_000;
  const tracker = new CompactionTracker(() => now);

  tracker.begin();
  now += COMPACTION_STALE_AFTER_MS - 1;
  assert.equal(tracker.isCompacting(), true, "a slow compaction is still a real one");

  now += 1;
  assert.equal(tracker.isCompacting(), false, "the stuck flag self-heals");
  assert.equal(tracker.isCompacting(), false, "and stays cleared");
});

test("overlapping compactions need every start to end before the window closes", () => {
  const tracker = new CompactionTracker();

  tracker.begin();
  tracker.begin();
  tracker.end();
  assert.equal(tracker.isCompacting(), true);

  tracker.end();
  assert.equal(tracker.isCompacting(), false);

  // Stray end events must not push the count negative.
  tracker.end();
  tracker.begin();
  assert.equal(tracker.isCompacting(), true);
});
