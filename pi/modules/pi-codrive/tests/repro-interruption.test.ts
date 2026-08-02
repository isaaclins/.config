/**
 * Positive lifecycle assertions proving delegation recovery. These replace the
 * earlier reproduction tests that documented the broken behavior, keeping the
 * same two scenarios:
 *
 *   A. a child hits a transient stream error mid-task: no orchestrator wake-up,
 *      the pane stays tracked, a later heartbeat clears the episode, and the
 *      eventual real completion produces exactly ONE terminal report.
 *   B. a child process dies: the supervisor notices, escalates exactly once,
 *      and agent_resume relaunches it with `--session-id <recorded id>`,
 *      restoring ownership, steering, tracking, and ledger accounting.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  ChildReporter,
  CodriveController,
  DelegationSupervisor,
  PaneHealthMonitor,
  RuntimeStore,
  TmuxBackend,
  createHarnessSession,
  type CodriveBackend,
  type CodriveEnvelope,
  type OutgoingEnvelope,
} from "../src/index.ts";

interface FakeHandle {
  __id: number;
  unref(): FakeHandle;
}

function manualScheduler() {
  const timers = new Map<number, () => void>();
  let id = 0;
  const scheduler = {
    setTimeout(callback: () => void) {
      const key = ++id;
      timers.set(key, callback);
      const handle: FakeHandle = { __id: key, unref: () => handle };
      return handle as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout(handle: ReturnType<typeof setTimeout>) {
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

function hasTmux(): boolean {
  try {
    execFileSync("tmux", ["-V"], { timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

test("SCENARIO A: a transient stream error never wakes the orchestrator and the real completion wakes it exactly once", () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), "pi-codrive-scenarioA-"));
  const projectRoot = mkdtempSync(join(tmpdir(), "pi-codrive-scenarioA-proj-"));
  const store = new RuntimeStore(runtimeRoot);
  const session = createHarnessSession({
    projectRoot,
    role: "orchestrator",
    delegationDepth: 0,
    trust: "trusted",
  });
  store.saveSession(session);

  const monitor = fakeMonitor();
  const supClock = manualScheduler();
  const wakes: Array<{ pane: string; content: string }> = [];
  const supervisor = new DelegationSupervisor({
    sessionId: session.sessionId,
    store,
    controller: {} as unknown as CodriveController,
    backend: idleBackend,
    monitor,
    scheduler: supClock.scheduler,
    graceMs: 20000,
    wake: ({ pane, content }) => wakes.push({ pane, content }),
  });

  supervisor.registerSpawn({
    childId: "c1",
    paneId: "%9",
    model: "test-model",
    piSessionId: "sess-c1",
    projectRoot,
  });
  assert.deepEqual(monitor.calls.track, ["%9"]);

  const childClock = manualScheduler();
  const send = (envelope: OutgoingEnvelope): void => {
    supervisor.onEnvelope({
      version: 1,
      timestamp: new Date().toISOString(),
      ...envelope,
    } as CodriveEnvelope);
  };
  const reporter = new ChildReporter({
    sessionId: session.sessionId,
    childId: "c1",
    paneId: "%9",
    settleMs: 8000,
    scheduler: childClock.scheduler,
    send,
    isIdle: () => true,
    hasPendingMessages: () => false,
  });

  // Transient stream error tears down the loop. No HTTP evidence was recorded,
  // so the interrupt is non-transient from the parent's view and arms the
  // grace window, but it must NOT wake the orchestrator or untrack the pane.
  reporter.onAgentEnd([
    {
      role: "assistant",
      content: [{ type: "text", text: "working on it" }],
      stopReason: "error",
      errorMessage: "stream error: WebSocket closed unexpectedly",
    },
  ]);
  assert.equal(wakes.length, 0, "an interruption must not wake the orchestrator");
  assert.deepEqual(monitor.calls.markReported, [], "the pane must stay tracked through an interruption");
  assert.equal(supClock.size(), 1, "a non-transient interruption arms one escalation timer");

  // pi retries: a new agent loop starts, which cancels the escalation via a
  // heartbeat and clears the interruption episode.
  reporter.onAgentStart();
  assert.equal(wakes.length, 0);
  assert.equal(supClock.size(), 0, "a heartbeat cancels the pending escalation");

  // The real task then completes cleanly: exactly ONE terminal report, one wake.
  reporter.onAgentEnd([
    { role: "assistant", content: [{ type: "text", text: "all done" }], stopReason: "stop" },
  ]);
  assert.equal(wakes.length, 1, "exactly one terminal wake for the whole episode");
  assert.match(wakes[0].content, /completed with status completed/);
  assert.deepEqual(monitor.calls.markReported, ["%9"], "the terminal report untracks the pane once");

  // Firing any stale timers must not produce a second wake.
  supClock.fireAll();
  childClock.fireAll();
  assert.equal(wakes.length, 1, "no second terminal report after completion");
});

/**
 * The compound case that motivated this work: an interruption used to untrack
 * the pane permanently, so the watchdog went blind and a later real death was
 * never noticed. This wires the REAL PaneHealthMonitor to the supervisor the
 * same way extension.ts does, so the regression cannot come back unseen.
 */
test("SCENARIO A2: a real death AFTER an interruption is still noticed and escalated once", async () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), "pi-codrive-scenarioA2-"));
  const projectRoot = mkdtempSync(join(tmpdir(), "pi-codrive-scenarioA2-proj-"));
  const store = new RuntimeStore(runtimeRoot);
  const session = createHarnessSession({
    projectRoot,
    role: "orchestrator",
    delegationDepth: 0,
    trust: "trusted",
  });
  store.saveSession(session);

  const alive = new Set<string>(["%9"]);
  const wakes: string[] = [];

  let supervisor: DelegationSupervisor;
  const monitor = new PaneHealthMonitor({
    intervalMs: 1000,
    isAlive: async (pane) => alive.has(pane),
    onExitedWithoutReport: (pane) => supervisor.onPaneDeath(pane),
  });

  supervisor = new DelegationSupervisor({
    sessionId: session.sessionId,
    store,
    controller: {} as unknown as CodriveController,
    backend: idleBackend,
    monitor,
    wake: ({ content }) => wakes.push(content),
  });

  supervisor.registerSpawn({
    childId: "c1",
    paneId: "%9",
    model: "test-model",
    piSessionId: "sess-c1",
    projectRoot,
  });
  assert.equal(monitor.tracked, 1);

  supervisor.onEnvelope({
    version: 1,
    kind: "interrupt",
    eventId: "e1",
    sessionId: session.sessionId,
    childId: "c1",
    paneId: "%9",
    timestamp: new Date().toISOString(),
    interrupt: { transient: true, reason: "overloaded" },
  } as CodriveEnvelope);

  assert.equal(wakes.length, 0, "an interruption must not wake the orchestrator");
  assert.equal(monitor.tracked, 1, "the pane must STILL be tracked after an interruption");

  alive.delete("%9");
  await monitor.checkOnce();

  assert.equal(wakes.length, 1, "the real death is noticed and escalated exactly once");
  assert.match(wakes[0], /agent_resume/, "the escalation names the recovery path");

  await monitor.checkOnce();
  assert.equal(wakes.length, 1, "and never escalates twice for the same death");

  rmSync(runtimeRoot, { recursive: true, force: true });
  rmSync(projectRoot, { recursive: true, force: true });
});

test("SCENARIO B: a dead child is escalated once and agent_resume relaunches it with --session-id under module ownership", async (t) => {
  if (!hasTmux()) {
    t.skip("tmux not available");
    return;
  }

  const server = `pi-codrive-resume-${randomBytes(4).toString("hex")}`;
  const runTmux = (...args: string[]) =>
    execFileSync("tmux", ["-L", server, ...args], { encoding: "utf8", timeout: 5000 }).trim();
  runTmux("new-session", "-d", "-s", "test", "-x", "200", "-y", "50");

  const scriptDir = mkdtempSync(join(tmpdir(), "pi-codrive-resume-script-"));
  const logPath = join(scriptDir, "invocations.log");
  const scriptPath = join(scriptDir, "fake-pi");
  writeFileSync(
    scriptPath,
    `#!/bin/sh\n{\n  echo "ARGV: $*"\n  echo "SOCKET: $PI_CODRIVE_SOCKET"\n  echo "NONCE: $PI_CODRIVE_NONCE"\n  echo "CHILDENV: $PI_CODRIVE_CHILD_ID"\n} >> ${logPath}\nsleep 300\n`,
  );
  chmodSync(scriptPath, 0o755);

  const runtimeRoot = mkdtempSync(join(tmpdir(), "pi-codrive-resume-rt-"));
  const projectRoot = mkdtempSync(join(tmpdir(), "pi-codrive-resume-proj-"));
  const store = new RuntimeStore(runtimeRoot);
  const session = createHarnessSession({
    projectRoot,
    role: "orchestrator",
    delegationDepth: 0,
    trust: "trusted",
  });
  store.saveSession(session);

  const backend = new TmuxBackend({ serverSocket: server, piCommand: scriptPath });
  const controller = new CodriveController({
    session,
    backend,
    policy: { defaultModel: "test-model", account() {} },
    reportSocket: "/tmp/parent.sock",
    reportNonce: "parent-nonce",
  });

  const monitor = fakeMonitor();
  const supClock = manualScheduler();
  const wakes: Array<{ pane: string; content: string; details: unknown }> = [];
  const supervisor = new DelegationSupervisor({
    sessionId: session.sessionId,
    store,
    controller,
    backend,
    monitor,
    scheduler: supClock.scheduler,
    wake: ({ pane, content, details }) => wakes.push({ pane, content, details }),
  });

  t.after(() => {
    try { runTmux("kill-server"); } catch {}
    rmSync(scriptDir, { recursive: true, force: true });
    rmSync(runtimeRoot, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(join(tmpdir(), server), { recursive: true, force: true });
  });

  // Spawn a fresh child and register it under module ownership.
  const spawned = await controller.spawn({ prompt: "long task", context: "fresh" });
  supervisor.registerSpawn({
    childId: spawned.childId,
    paneId: spawned.paneId,
    model: spawned.model,
    piSessionId: spawned.piSessionId,
    piSessionFile: spawned.piSessionFile,
    projectRoot: session.projectRoot,
  });
  const originalPane = spawned.paneId;
  assert.ok(spawned.piSessionId, "a fresh spawn pre-assigns a pi session id");

  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(await backend.isAlive(originalPane), true);

  const firstLog = readFileSync(logPath, "utf8");
  assert.match(firstLog, new RegExp(`--session-id ${spawned.piSessionId}`), "spawn command carries --session-id");
  assert.match(firstLog, new RegExp(`CHILDENV: ${spawned.childId}`), "spawn carries the child IPC identity");

  // Provider hard failure -> process death. The health monitor notices.
  runTmux("kill-pane", "-t", originalPane);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(await backend.isAlive(originalPane), false);

  supervisor.onPaneDeath(originalPane);
  assert.equal(wakes.length, 1, "a real death escalates exactly once");
  assert.equal((wakes[0].details as { recovery?: string }).recovery, "agent_resume");

  // Recover it: relaunch into a fresh pane, resuming the SAME pi session id.
  const result = await supervisor.resume(originalPane, { prompt: "continue the task" });
  assert.notEqual(result.newPane, originalPane);
  assert.equal(result.oldPane, originalPane);
  assert.equal(result.childId, spawned.childId, "resume reuses the same childId");
  assert.equal(result.resumeCount, 1);

  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(await backend.isAlive(result.newPane), true, "the relaunched pane is alive");

  const secondLog = readFileSync(logPath, "utf8");
  const resumeLine = secondLog
    .split("\n")
    .filter((line) => line.startsWith("ARGV:"))
    .at(-1);
  assert.ok(resumeLine, "the resume produced a second invocation");
  assert.match(resumeLine!, new RegExp(`--session-id ${spawned.piSessionId}`), "resume carries the SAME --session-id as spawn");
  assert.match(resumeLine!, /continue the task/);
  assert.match(secondLog, new RegExp(`CHILDENV: ${spawned.childId}`), "the relaunched pane carries the IPC env vars");

  // Ownership, tracking, steering, and ledger accounting are restored.
  assert.deepEqual(monitor.calls.track, [originalPane, result.newPane]);
  assert.ok(monitor.calls.untrack.includes(originalPane));

  const ledger = store.findChildByPane(session.sessionId, originalPane);
  assert.ok(ledger, "the old pane id still resolves in the ledger");
  assert.equal(ledger!.childId, spawned.childId);
  assert.equal(ledger!.resumeCount, 1);
  assert.deepEqual(ledger!.paneHistory, [originalPane, result.newPane]);
  assert.equal(ledger!.paneId, result.newPane);

  // agent_report history carries forward and the old pane id still resolves.
  assert.doesNotThrow(() => supervisor.getHistory(originalPane, "all"));
  assert.equal(supervisor.currentPaneFor(originalPane), result.newPane);
});
