import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DelegationSupervisor,
  RuntimeStore,
  createHarnessSession,
  type CodriveBackend,
  type CodriveController,
  type CodriveEnvelope,
  type ResumeRequest,
  type SupervisorScheduler,
} from "../src/index.ts";

interface FakeHandle {
  __id: number;
  unref(): FakeHandle;
}

function manualScheduler(): {
  scheduler: SupervisorScheduler;
  size: () => number;
  fireAll: () => void;
} {
  const timers = new Map<number, () => void>();
  let id = 0;
  const scheduler: SupervisorScheduler = {
    setTimeout(callback) {
      const key = ++id;
      timers.set(key, callback);
      const handle: FakeHandle = { __id: key, unref: () => handle };
      return handle as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout(handle) {
      const key = (handle as unknown as FakeHandle)?.__id;
      if (typeof key === "number") timers.delete(key);
    },
  };
  return {
    scheduler,
    size: () => timers.size,
    fireAll() {
      for (const [key, callback] of [...timers]) {
        timers.delete(key);
        callback();
      }
    },
  };
}

function fakeMonitor() {
  const calls = { track: [] as string[], untrack: [] as string[], markReported: [] as string[] };
  return {
    calls,
    track: (pane: string) => calls.track.push(pane),
    untrack: (pane: string) => calls.untrack.push(pane),
    markReported: (pane: string) => calls.markReported.push(pane),
  };
}

const idleBackend: CodriveBackend = {
  name: "fake",
  async spawn() {
    return { paneId: "%0" };
  },
  async isAlive() {
    return true;
  },
  async read() {
    return "";
  },
  async send() {},
};

function envelope(partial: Partial<CodriveEnvelope> & Pick<CodriveEnvelope, "kind">): CodriveEnvelope {
  return {
    version: 1,
    eventId: `e-${Math.random().toString(16).slice(2)}`,
    sessionId: "s",
    childId: "c1",
    paneId: "%9",
    timestamp: new Date().toISOString(),
    ...partial,
  };
}

function makeSupervisor(
  overrides: {
    backend?: CodriveBackend;
    controller?: CodriveController;
    graceMs?: number;
    readOnly?: boolean;
  } = {},
) {
  const runtimeRoot = mkdtempSync(join(tmpdir(), "pi-codrive-sup-"));
  const projectRoot = mkdtempSync(join(tmpdir(), "pi-codrive-sup-proj-"));
  const store = new RuntimeStore(runtimeRoot);
  const session = createHarnessSession({
    projectRoot,
    role: "orchestrator",
    delegationDepth: 0,
    trust: "trusted",
  });
  store.saveSession(session);
  const monitor = fakeMonitor();
  const clock = manualScheduler();
  const wakes: Array<{ pane: string; content: string; details: unknown }> = [];
  const supervisor = new DelegationSupervisor({
    sessionId: session.sessionId,
    store,
    controller: overrides.controller ?? ({} as unknown as CodriveController),
    backend: overrides.backend ?? idleBackend,
    monitor,
    scheduler: clock.scheduler,
    graceMs: overrides.graceMs ?? 20000,
    wake: ({ pane, content, details }) => wakes.push({ pane, content, details }),
  });
  supervisor.registerSpawn({
    childId: "c1",
    paneId: "%9",
    model: "m",
    piSessionId: "sess-c1",
    projectRoot: session.projectRoot,
    readOnly: overrides.readOnly,
  });
  return { supervisor, store, session, monitor, clock, wakes };
}

test("interrupt keeps tracking and arms escalation without waking; heartbeat cancels; terminal wakes once", () => {
  const { supervisor, monitor, clock, wakes } = makeSupervisor();
  assert.deepEqual(monitor.calls.track, ["%9"]);

  supervisor.onEnvelope(envelope({ kind: "interrupt", interrupt: { transient: false, reason: "boom" } }));
  assert.equal(wakes.length, 0);
  assert.deepEqual(monitor.calls.markReported, []);
  assert.equal(clock.size(), 1);

  supervisor.onEnvelope(envelope({ kind: "heartbeat" }));
  assert.equal(clock.size(), 0);
  assert.equal(wakes.length, 0);

  supervisor.onEnvelope(
    envelope({
      kind: "report",
      report: {
        version: 1,
        eventId: "r1",
        sessionId: "s",
        childId: "c1",
        paneId: "%9",
        status: "completed",
        assistantText: "done",
        timestamp: new Date().toISOString(),
      },
    }),
  );
  assert.equal(wakes.length, 1);
  assert.deepEqual(monitor.calls.markReported, ["%9"]);

  supervisor.onEnvelope(
    envelope({
      kind: "report",
      report: {
        version: 1,
        eventId: "r2",
        sessionId: "s",
        childId: "c1",
        paneId: "%9",
        status: "completed",
        assistantText: "duplicate",
        timestamp: new Date().toISOString(),
      },
    }),
  );
  assert.equal(wakes.length, 1, "a completed child never wakes twice for a duplicate terminal report");
});

test("a non-transient interruption with no recovery escalates exactly once when the grace window expires", () => {
  const { supervisor, clock, wakes } = makeSupervisor();
  supervisor.onEnvelope(envelope({ kind: "interrupt", interrupt: { transient: false, reason: "stream lost" } }));
  assert.equal(clock.size(), 1);

  clock.fireAll();
  assert.equal(wakes.length, 1);
  assert.equal((wakes[0].details as { recovery?: string }).recovery, "agent_resume");
  assert.match(wakes[0].content, /agent_resume/);

  // No timers remain and no further escalation can fire for this episode.
  clock.fireAll();
  assert.equal(wakes.length, 1);
});

test("a transient interruption holds escalation, and a later pane death escalates exactly once", () => {
  const { supervisor, clock, wakes } = makeSupervisor();
  supervisor.onEnvelope(envelope({ kind: "interrupt", interrupt: { transient: true, reason: "HTTP 429" } }));
  assert.equal(clock.size(), 0, "a transient interrupt does not arm an escalation timer");
  assert.equal(wakes.length, 0);

  supervisor.onPaneDeath("%9");
  assert.equal(wakes.length, 1);
  assert.match(wakes[0].content, /process died/);

  supervisor.onPaneDeath("%9");
  assert.equal(wakes.length, 1, "a second death signal does not double-escalate");
});

test("announce refreshes the ledger session identity and cancels a pending escalation", () => {
  const { supervisor, store, session, clock } = makeSupervisor();
  supervisor.onEnvelope(envelope({ kind: "interrupt", interrupt: { transient: false, reason: "x" } }));
  assert.equal(clock.size(), 1);

  supervisor.onEnvelope(
    envelope({
      kind: "announce",
      announce: { piSessionFile: "/sessions/c1.jsonl", piSessionId: "sess-c1" },
    }),
  );
  assert.equal(clock.size(), 0, "announce cancels the pending escalation");
  const record = store.findChildByPane(session.sessionId, "%9");
  assert.equal(record?.piSessionFile, "/sessions/c1.jsonl");
});

test("a graceful farewell while the task is unfinished escalates once and untracks", () => {
  const { supervisor, monitor, wakes } = makeSupervisor();
  supervisor.onEnvelope(envelope({ kind: "farewell", farewell: { reason: "quit" } }));
  assert.equal(wakes.length, 1);
  assert.match(wakes[0].content, /agent_resume/);
  assert.ok(monitor.calls.untrack.includes("%9"));
});

test("a session reload farewell keeps the child tracked for its replacement runtime", () => {
  const { supervisor, monitor, wakes, clock } = makeSupervisor();
  supervisor.onEnvelope(envelope({ kind: "farewell", farewell: { reason: "reload" } }));
  assert.equal(wakes.length, 0);
  assert.equal(clock.size(), 0);
  assert.deepEqual(monitor.calls.untrack, []);
  assert.equal(supervisor.isLive("%9"), true);
});

test("agent_resume keeps a read-only child read-only", async () => {
  const requests: ResumeRequest[] = [];
  const controller = {
    async resume(request: ResumeRequest) {
      requests.push(request);
      return {
        childId: request.childId,
        paneId: "%10",
        model: request.model,
        cwd: request.cwd ?? "/tmp",
        background: request.background === true,
        readOnly: request.readOnly === true,
        piSessionId: request.sessionId,
        piSessionFile: request.resumeSessionFile,
      };
    },
  } as CodriveController;
  const backend: CodriveBackend = {
    ...idleBackend,
    async isAlive() {
      return false;
    },
  };
  const { supervisor, store, session } = makeSupervisor({
    backend,
    controller,
    readOnly: true,
  });

  await supervisor.resume("%9");

  assert.equal(requests.length, 1);
  assert.equal(requests[0].readOnly, true);
  assert.equal(store.findChildByPane(session.sessionId, "%10")?.readOnly, true);
});

test("getHistory rejects an unknown pane and records lifecycle entries in order", () => {
  const { supervisor } = makeSupervisor();
  assert.throws(() => supervisor.getHistory("%404", "all"), /Unknown or unowned pane/);

  supervisor.onEnvelope(envelope({ kind: "interrupt", interrupt: { transient: true, reason: "429" } }));
  const history = supervisor.getHistory("%9", "all");
  assert.equal(history.entries.length, 1);
  assert.equal(history.entries[0].status, "interrupted");
});
