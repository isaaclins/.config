import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DeferredTriggerRegistry,
  RuntimeStore,
  createHarnessSession,
  createTriggerWake,
  deliveryOptions,
  runShellCheck,
  type DeferCheckRunner,
  type DeferMessage,
  type DeferOutcome,
  type DeferScheduler,
  type DeferSendOptions,
  type DeferredTriggerRecord,
  type HarnessSession,
} from "../src/index.ts";

/**
 * A clock and timer source the test drives by hand. Nothing here waits on real
 * time, so no assertion can depend on incidental scheduling.
 */
class FakeClock {
  private current: number;
  private sequence = 0;
  private readonly timers = new Map<number, { at: number; callback: () => void }>();

  constructor(start = Date.parse("2026-08-06T12:00:00.000Z")) {
    this.current = start;
  }

  readonly now = (): number => this.current;

  readonly scheduler: DeferScheduler = {
    setTimeout: (callback, ms) => {
      const id = ++this.sequence;
      this.timers.set(id, { at: this.current + ms, callback });
      return {
        id,
        unref() {
          return this;
        },
      } as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: (handle) => {
      this.timers.delete((handle as unknown as { id: number }).id);
    },
  };

  get armed(): number {
    return this.timers.size;
  }

  /** Move the clock forward and run every timer that came due, in order. */
  advance(ms: number): void {
    this.current += ms;
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= this.current)
        .sort((left, right) => left[1].at - right[1].at);
      if (due.length === 0) return;
      for (const [id, timer] of due) {
        this.timers.delete(id);
        timer.callback();
      }
    }
  }
}

interface Harness {
  store: RuntimeStore;
  session: HarnessSession;
  runtimeRoot: string;
}

function harness(): Harness {
  const runtimeRoot = mkdtempSync(join(tmpdir(), "pi-codrive-defer-"));
  const projectRoot = mkdtempSync(join(tmpdir(), "pi-codrive-defer-proj-"));
  const store = new RuntimeStore(runtimeRoot);
  const session = createHarnessSession({
    projectRoot,
    role: "orchestrator",
    delegationDepth: 0,
    trust: "trusted",
  });
  store.saveSession(session);
  return { store, session, runtimeRoot };
}

interface Delivered {
  message: DeferMessage;
  options: DeferSendOptions;
  idle: boolean;
}

interface Registry {
  registry: DeferredTriggerRegistry;
  clock: FakeClock;
  delivered: Delivered[];
  fired: Array<{ trigger: DeferredTriggerRecord; outcome: DeferOutcome }>;
  /** Mirrors ctx.isIdle(): nothing is streaming unless a test says so. */
  idle: { value: boolean };
}

function registryOn(
  base: Harness,
  options: { runCheck?: DeferCheckRunner; clock?: FakeClock; pid?: number } = {},
): Registry {
  const clock = options.clock ?? new FakeClock();
  const delivered: Delivered[] = [];
  const fired: Array<{ trigger: DeferredTriggerRecord; outcome: DeferOutcome }> = [];
  const idle = { value: true };
  const wake = createTriggerWake((message, sendOptions) => {
    delivered.push({ message, options: sendOptions, idle: idle.value });
  });
  const registry = new DeferredTriggerRegistry({
    sessionId: base.session.sessionId,
    projectRoot: base.session.projectRoot,
    store: base.store,
    scheduler: clock.scheduler,
    now: clock.now,
    pid: options.pid ?? 4242,
    // Only this test's own pid counts as alive, so an "earlier process" is gone.
    isOwnerAlive: (pid) => pid === (options.pid ?? 4242),
    runCheck: options.runCheck,
    fire: (trigger, outcome) => {
      fired.push({ trigger, outcome });
      wake(trigger, outcome);
    },
  });
  return { registry, clock, delivered, fired, idle };
}

test("deliveryOptions maps the two behaviors to the documented sendMessage options", () => {
  assert.deepEqual(deliveryOptions("interrupt"), { triggerTurn: true, deliverAs: "steer" });
  assert.deepEqual(deliveryOptions("quiet"), { triggerTurn: false, deliverAs: "nextTurn" });
});

test("an interrupt trigger firing while the agent is idle hands sendMessage exactly steer + triggerTurn", () => {
  const base = harness();
  const { registry, clock, delivered, idle } = registryOn(base);

  registry.create({ note: "the install should be done", delayMs: 60_000, delivery: "interrupt" });
  idle.value = true;
  clock.advance(60_000);

  assert.equal(delivered.length, 1);
  assert.deepEqual(delivered[0].options, { triggerTurn: true, deliverAs: "steer" });
  // triggerTurn is what keeps an idle fire from being lost: nothing was
  // running, and the trigger still asks pi to start a turn.
  assert.equal(delivered[0].idle, true);
  assert.equal(delivered[0].message.customType, "pi-codrive-defer");
  assert.match(delivered[0].message.content, /the install should be done/);
});

test("a quiet trigger firing while the agent is idle never interrupts and waits for the next turn", () => {
  const base = harness();
  const { registry, clock, delivered, idle } = registryOn(base);

  registry.create({ note: "background note", delayMs: 1000, delivery: "quiet" });
  idle.value = true;
  clock.advance(1000);

  assert.equal(delivered.length, 1);
  assert.deepEqual(delivered[0].options, { triggerTurn: false, deliverAs: "nextTurn" });
  assert.equal(delivered[0].idle, true);
});

test("an after trigger fires once, at its deadline and not before", () => {
  const base = harness();
  const { registry, clock, fired } = registryOn(base);

  const trigger = registry.create({ note: "four minutes are up", delayMs: 240_000 });
  assert.equal(trigger.kind, "after");
  assert.equal(trigger.dueAt, clock.now() + 240_000);

  clock.advance(239_999);
  assert.equal(fired.length, 0);

  clock.advance(1);
  assert.equal(fired.length, 1);
  assert.equal(fired[0].outcome, "elapsed");
  assert.equal(fired[0].trigger.id, trigger.id);

  // Nothing is left armed, so it cannot fire a second time.
  clock.advance(1_000_000);
  assert.equal(fired.length, 1);
  assert.equal(clock.armed, 0);
  assert.deepEqual(registry.list(), []);
});

test("a when trigger fires as soon as its condition flips true", async () => {
  const base = harness();
  let satisfied = false;
  const checked: string[] = [];
  const { registry, clock, fired, delivered } = registryOn(base, {
    runCheck: async (command) => {
      checked.push(command);
      return satisfied;
    },
  });

  const trigger = registry.create({
    note: "the marker appeared",
    check: "test -f /tmp/whatever",
    pollMs: 5000,
    timeoutMs: 60_000,
  });
  assert.equal(trigger.kind, "when");
  assert.equal(trigger.pollMs, 5000);

  clock.advance(5000);
  await registry.settled();
  assert.equal(fired.length, 0);

  satisfied = true;
  clock.advance(5000);
  await registry.settled();

  assert.equal(fired.length, 1);
  assert.equal(fired[0].outcome, "condition");
  assert.deepEqual(checked, ["test -f /tmp/whatever", "test -f /tmp/whatever"]);
  assert.deepEqual(delivered[0].options, { triggerTurn: true, deliverAs: "steer" });
  assert.deepEqual(registry.list(), []);
});

test("a when trigger whose condition never comes true fires a timeout instead of giving up silently", async () => {
  const base = harness();
  const { registry, clock, fired } = registryOn(base, { runCheck: async () => false });

  registry.create({
    note: "the deploy never finished",
    check: "false",
    pollMs: 1000,
    timeoutMs: 3000,
  });

  for (let pass = 0; pass < 3; pass++) {
    clock.advance(1000);
    await registry.settled();
  }

  assert.equal(fired.length, 1);
  assert.equal(fired[0].outcome, "timeout");
  assert.match(fired[0].trigger.note, /the deploy never finished/);
  assert.equal(clock.armed, 0);
});

test("a check that cannot run at all still reaches its timeout rather than throwing", async () => {
  const base = harness();
  const { registry, clock, fired } = registryOn(base);

  registry.create({
    note: "broken check",
    check: "definitely-not-a-real-binary-9f3a",
    pollMs: 1000,
    timeoutMs: 1000,
  });
  clock.advance(1000);
  await registry.settled();

  assert.equal(fired.length, 1);
  assert.equal(fired[0].outcome, "timeout");
});

test("list reports pending triggers and cancel stops one from ever firing", () => {
  const base = harness();
  const { registry, clock, fired } = registryOn(base);

  const first = registry.create({ note: "first", delayMs: 10_000 });
  const second = registry.create({ note: "second", delayMs: 5000, delivery: "quiet" });

  const listed = registry.list();
  assert.deepEqual(
    listed.map((trigger) => trigger.id),
    [second.id, first.id],
  );
  assert.deepEqual(
    listed.map((trigger) => trigger.delivery),
    ["quiet", "interrupt"],
  );

  const cancelled = registry.cancel(second.id);
  assert.equal(cancelled?.id, second.id);
  assert.deepEqual(
    registry.list().map((trigger) => trigger.id),
    [first.id],
  );

  clock.advance(60_000);
  assert.equal(fired.length, 1);
  assert.equal(fired[0].trigger.id, first.id);
});

test("cancelling an unknown or already fired id is reported, not silently accepted", () => {
  const base = harness();
  const { registry, clock } = registryOn(base);

  assert.equal(registry.cancel("defer-deadbeef"), undefined);

  const trigger = registry.create({ note: "gone soon", delayMs: 1000 });
  clock.advance(1000);
  assert.equal(registry.cancel(trigger.id), undefined);
});

test("a cancelled when trigger cannot fire even if its check was already running", async () => {
  const base = harness();
  let announceStart: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    announceStart = resolve;
  });
  let finishCheck: ((satisfied: boolean) => void) | undefined;
  const { registry, clock, fired } = registryOn(base, {
    // The check stays pending until the test releases it, so the cancel really
    // lands in the window where a condition is already being evaluated.
    runCheck: () =>
      new Promise<boolean>((resolve) => {
        finishCheck = resolve;
        announceStart?.();
      }),
  });

  const trigger = registry.create({ note: "racing", check: "true", pollMs: 1000, timeoutMs: 9000 });
  clock.advance(1000);
  await started;
  registry.cancel(trigger.id);
  finishCheck?.(true);
  await registry.settled();

  assert.equal(fired.length, 0);
});

test("an overdue after trigger fires immediately after a restart, and a when trigger resumes", async () => {
  const base = harness();
  const first = registryOn(base, { pid: 1111 });

  const overdue = first.registry.create({ note: "overdue while down", delayMs: 30_000 });
  const pending = first.registry.create({ note: "still waiting", delayMs: 600_000 });
  const condition = first.registry.create({
    note: "condition still open",
    check: "true",
    pollMs: 1000,
    timeoutMs: 600_000,
  });
  const expired = first.registry.create({
    note: "condition expired while down",
    check: "true",
    pollMs: 1000,
    timeoutMs: 60_000,
  });
  first.registry.stop();
  assert.deepEqual(first.fired, []);

  // A new process: new pid, new clock reading, same on-disk state.
  const restartClock = new FakeClock(first.clock.now() + 120_000);
  const second = registryOn(base, {
    clock: restartClock,
    pid: 2222,
    runCheck: async () => false,
  });
  const restored = second.registry.restore();

  assert.deepEqual(
    restored.fired.map((trigger) => trigger.id).sort(),
    [overdue.id, expired.id].sort(),
  );
  assert.deepEqual(
    restored.resumed.map((trigger) => trigger.id).sort(),
    [pending.id, condition.id].sort(),
  );
  assert.deepEqual(
    second.fired.map((entry) => entry.outcome).sort(),
    ["elapsed", "timeout"],
  );
  // Nothing vanished: what did not fire is still pending and still armed.
  assert.deepEqual(
    second.registry.list().map((trigger) => trigger.id).sort(),
    [pending.id, condition.id].sort(),
  );
  assert.equal(second.clock.armed, 2);

  // The resumed condition trigger really is polling again.
  restartClock.advance(1000);
  await second.registry.settled();
  assert.equal(second.fired.length, 2);

  // Fired triggers left the store; the survivors are what a third process sees.
  assert.deepEqual(
    base.store.loadTriggers(base.session.sessionId).map((trigger) => trigger.id).sort(),
    [pending.id, condition.id].sort(),
  );
});

test("a reload reclaims its own pending triggers instead of stranding them", () => {
  // /reload mints a fresh sessionId inside the SAME process, so the previous
  // owner pid is still alive. Treating only a dead owner as adoptable used to
  // strand every pending defer under the old session id, silently.
  const base = harness();
  const samePid = 4242;
  const before = registryOn(base, { pid: samePid });
  const armed = before.registry.create({ note: "survives the reload", delayMs: 600_000 });
  // session_shutdown: timers go, records stay.
  before.registry.stop();

  const reloaded = createHarnessSession({
    projectRoot: base.session.projectRoot,
    role: "orchestrator",
    delegationDepth: 0,
    trust: "trusted",
  });
  base.store.saveSession(reloaded);
  const clock = new FakeClock();
  const registry = new DeferredTriggerRegistry({
    sessionId: reloaded.sessionId,
    projectRoot: reloaded.projectRoot,
    store: base.store,
    scheduler: clock.scheduler,
    now: clock.now,
    pid: samePid,
    // The old owner is this very process, so it is emphatically alive.
    isOwnerAlive: () => true,
    fire: () => {},
  });

  assert.deepEqual(
    registry.restore().resumed.map((trigger) => trigger.id),
    [armed.id],
    "the reload must re-arm the trigger it stopped moments earlier",
  );
  assert.deepEqual(
    base.store.loadTriggers(base.session.sessionId),
    [],
    "and must not leave a duplicate under the old session id",
  );
});

test("restore adopts triggers from an earlier session of the same project, but not from a live one", () => {
  const base = harness();
  const previous = registryOn(base, { pid: 1111 });
  const orphan = previous.registry.create({ note: "left behind", delayMs: 600_000 });
  previous.registry.stop();

  // A different session id, as every restart gets, in the same project root.
  const restarted = createHarnessSession({
    projectRoot: base.session.projectRoot,
    role: "orchestrator",
    delegationDepth: 0,
    trust: "trusted",
  });
  base.store.saveSession(restarted);
  const clock = new FakeClock();
  const registry = new DeferredTriggerRegistry({
    sessionId: restarted.sessionId,
    projectRoot: restarted.projectRoot,
    store: base.store,
    scheduler: clock.scheduler,
    now: clock.now,
    pid: 3333,
    isOwnerAlive: (pid) => pid === 3333,
    fire: () => {},
  });

  assert.deepEqual(
    registry.restore().resumed.map((trigger) => trigger.id),
    [orphan.id],
  );
  assert.deepEqual(base.store.loadTriggers(base.session.sessionId), []);

  // A second live session must not steal a timer the first one is still holding.
  const rival = createHarnessSession({
    projectRoot: base.store.load(restarted.sessionId).session?.projectRoot ?? restarted.projectRoot,
    role: "orchestrator",
    delegationDepth: 0,
    trust: "trusted",
  });
  base.store.saveSession(rival);
  const rivalRegistry = new DeferredTriggerRegistry({
    sessionId: rival.sessionId,
    projectRoot: rival.projectRoot,
    store: base.store,
    scheduler: new FakeClock().scheduler,
    pid: 4444,
    isOwnerAlive: (pid) => pid === 3333,
    fire: () => {},
  });

  assert.deepEqual(rivalRegistry.restore().resumed, []);
  assert.deepEqual(
    base.store.loadTriggers(restarted.sessionId).map((trigger) => trigger.id),
    [orphan.id],
  );
});

test("state written before deferred triggers existed still loads and accepts new triggers", () => {
  const base = harness();
  const statePath = base.store.statePath(base.session.sessionId);
  writeFileSync(
    statePath,
    `${JSON.stringify({
      version: 2,
      updatedAt: new Date().toISOString(),
      session: base.session,
      children: [],
    })}\n`,
  );

  const { registry } = registryOn(base);
  assert.deepEqual(registry.restore().resumed, []);
  const trigger = registry.create({ note: "after migration", delayMs: 1000 });
  assert.deepEqual(
    base.store.loadTriggers(base.session.sessionId).map((record) => record.id),
    [trigger.id],
  );
});

test("the motivating case end to end: a marker file that appears wakes the agent with an interrupt", async () => {
  const base = harness();
  const workspace = mkdtempSync(join(tmpdir(), "pi-codrive-defer-marker-"));
  const marker = join(workspace, "install-finished");
  // The shipped shell check runner, not a stub: this is the real command path.
  const { registry, clock, fired, delivered } = registryOn(base, { runCheck: runShellCheck });

  const trigger = registry.create({
    note: `The install finished: ${marker} exists now. Continue where you left off.`,
    check: `test -f '${marker}'`,
    pollMs: 15_000,
    timeoutMs: 600_000,
    delivery: "interrupt",
  });

  clock.advance(15_000);
  await registry.settled();
  assert.equal(fired.length, 0, "must not fire while the marker is missing");

  writeFileSync(marker, "done\n");
  clock.advance(15_000);
  await registry.settled();

  assert.equal(fired.length, 1);
  assert.equal(fired[0].outcome, "condition");
  assert.equal(fired[0].trigger.id, trigger.id);
  assert.deepEqual(delivered[0].options, { triggerTurn: true, deliverAs: "steer" });
  assert.match(delivered[0].message.content, /The install finished/);
  assert.deepEqual(registry.list(), []);
});

test("create refuses inputs that could never produce a deliverable trigger", () => {
  const base = harness();
  const { registry } = registryOn(base);

  assert.throws(() => registry.create({ note: "   ", delayMs: 1000 }), /note is required/);
  assert.throws(() => registry.create({ note: "no trigger" }), /delayMs/);
  assert.throws(() => registry.create({ note: "negative", delayMs: -5 }), /positive/);
  assert.throws(() => registry.create({ note: "too far", delayMs: 90_000_000 }), /24 hours/);
  assert.throws(
    () => registry.create({ note: "both", delayMs: 1000, check: "true" }),
    /not both/,
  );
});

test("poll interval and timeout are clamped to values that can actually be honored", () => {
  const base = harness();
  const { registry, clock } = registryOn(base);

  const floored = registry.create({ note: "busy", check: "true", pollMs: 5 });
  assert.equal(floored.pollMs, 1000);
  assert.equal(floored.dueAt, clock.now() + 3_600_000, "default timeout is one hour");

  const capped = registry.create({ note: "long", check: "true", timeoutMs: 999_999_999 });
  assert.equal(capped.dueAt, clock.now() + 86_400_000);
});
