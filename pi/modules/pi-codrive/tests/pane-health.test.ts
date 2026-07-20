import assert from "node:assert/strict";
import test from "node:test";
import { PaneHealthMonitor, type PaneIntervalScheduler } from "../src/pane-health.ts";
import type { CodriveBackend } from "../src/index.ts";

interface FakeTimer {
  cleared: boolean;
}

function fakeScheduler(): {
  scheduler: PaneIntervalScheduler;
  timers: FakeTimer[];
  callbacks: Array<() => void>;
} {
  const timers: FakeTimer[] = [];
  const callbacks: Array<() => void> = [];
  const scheduler: PaneIntervalScheduler = {
    setInterval(callback) {
      const timer = { cleared: false } as FakeTimer & {
        unref?: () => void;
      };
      timer.unref = () => timer;
      timers.push(timer);
      callbacks.push(callback);
      return timer as unknown as ReturnType<typeof setInterval>;
    },
    clearInterval(timer) {
      (timer as unknown as FakeTimer).cleared = true;
    },
  };
  return { scheduler, timers, callbacks };
}

test("a tracked pane that dies before reporting fires exited-without-report once and records history", async () => {
  const alive = new Set<string>(["%1"]);
  const exits: string[] = [];
  const history: string[] = [];
  const monitor = new PaneHealthMonitor({
    intervalMs: 5000,
    isAlive: async (pane) => alive.has(pane),
    onExitedWithoutReport: (pane) => {
      exits.push(pane);
      history.push(`${pane}:exited-without-report`);
    },
  });

  monitor.track("%1");
  await monitor.checkOnce();
  assert.deepEqual(exits, []);

  alive.delete("%1");
  await monitor.checkOnce();
  await monitor.checkOnce();

  assert.deepEqual(exits, ["%1"]);
  assert.deepEqual(history, ["%1:exited-without-report"]);
});

test("a pane that reported before dying does not fire exited-without-report", async () => {
  const alive = new Set<string>(["%2"]);
  const exits: string[] = [];
  const monitor = new PaneHealthMonitor({
    intervalMs: 5000,
    isAlive: async (pane) => alive.has(pane),
    onExitedWithoutReport: (pane) => exits.push(pane),
  });

  monitor.track("%2");
  monitor.markReported("%2");
  alive.delete("%2");
  await monitor.checkOnce();

  assert.deepEqual(exits, []);
  assert.equal(monitor.tracked, 0);
});

test("start schedules a single interval and stop clears it without leaking a timer", () => {
  const { scheduler, timers } = fakeScheduler();
  const monitor = new PaneHealthMonitor({
    intervalMs: 5000,
    isAlive: async () => true,
    onExitedWithoutReport: () => {},
    scheduler,
  });

  assert.equal(monitor.running, false);
  monitor.start();
  monitor.start();
  assert.equal(timers.length, 1);
  assert.equal(monitor.running, true);
  assert.equal(timers[0].cleared, false);

  monitor.stop();
  assert.equal(monitor.running, false);
  assert.equal(timers[0].cleared, true);

  monitor.stop();
  assert.equal(timers.length, 1);
});

test("the scheduled interval callback runs a polling pass", async () => {
  const { scheduler, callbacks } = fakeScheduler();
  const alive = new Set<string>(["%3"]);
  const exits: string[] = [];
  const monitor = new PaneHealthMonitor({
    intervalMs: 5000,
    isAlive: async (pane) => alive.has(pane),
    onExitedWithoutReport: (pane) => exits.push(pane),
    scheduler,
  });

  monitor.track("%3");
  monitor.start();
  alive.delete("%3");
  callbacks[0]();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(exits, ["%3"]);
  monitor.stop();
});

test("a fake CodriveBackend whose pane dies mid-run drives exactly one exit signal", async () => {
  let alivePane = true;
  const backend: CodriveBackend = {
    name: "fake",
    async spawn() {
      return { paneId: "%42" };
    },
    async isAlive() {
      return alivePane;
    },
    async read() {
      return "";
    },
    async send() {},
  };

  const exits: string[] = [];
  const history = new Map<string, string[]>();
  const monitor = new PaneHealthMonitor({
    intervalMs: 5000,
    isAlive: (pane) => backend.isAlive(pane),
    onExitedWithoutReport: (pane) => {
      exits.push(pane);
      const entries = history.get(pane) ?? [];
      entries.push("exited-without-report");
      history.set(pane, entries);
    },
  });

  const spawned = await backend.spawn({
    projectRoot: "/tmp",
    model: "m",
    context: "fresh",
    identity: {
      childId: "c1",
      parentSessionId: "s1",
      role: "subagent",
      delegationDepth: 1,
      trust: "trusted",
    },
  });
  monitor.track(spawned.paneId);

  await monitor.checkOnce();
  assert.deepEqual(exits, []);

  alivePane = false;
  await monitor.checkOnce();
  await monitor.checkOnce();

  assert.deepEqual(exits, ["%42"]);
  assert.deepEqual(history.get("%42"), ["exited-without-report"]);
  assert.equal(monitor.tracked, 0);
});
