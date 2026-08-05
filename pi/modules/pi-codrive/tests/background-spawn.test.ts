import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CodriveController,
  DelegationSupervisor,
  RuntimeStore,
  createHarnessSession,
  type CodriveBackend,
  type CodriveEnvelope,
  type SpawnLaunch,
} from "../src/index.ts";

interface RecordingBackend {
  backend: CodriveBackend;
  launches: SpawnLaunch[];
}

function recordingBackend(paneId = "%11"): RecordingBackend {
  const launches: SpawnLaunch[] = [];
  return {
    launches,
    backend: {
      name: "fake",
      async spawn(launch) {
        launches.push(launch);
        return { paneId };
      },
      async isAlive() {
        return true;
      },
      async read() {
        return "";
      },
      async send() {},
    },
  };
}

function makeController(backend: CodriveBackend) {
  const projectRoot = mkdtempSync(join(tmpdir(), "pi-codrive-bg-"));
  const controller = new CodriveController({
    session: createHarnessSession({
      projectRoot,
      role: "orchestrator",
      delegationDepth: 0,
      trust: "trusted",
    }),
    backend,
    policy: { defaultModel: "m", account() {} },
  });
  return { controller, projectRoot: controller.session.projectRoot };
}

test("a spawn without cwd or background keeps today's visible, project-root behavior", async () => {
  const { backend, launches } = recordingBackend();
  const { controller, projectRoot } = makeController(backend);

  const child = await controller.spawn({ prompt: "go" });

  assert.equal(launches[0].cwd, projectRoot);
  assert.equal(launches[0].background, false);
  assert.equal(launches[0].projectRoot, projectRoot);
  assert.equal(child.cwd, projectRoot);
  assert.equal(child.background, false);
});

test("spawn threads a cwd override and background flag to the backend", async () => {
  const { backend, launches } = recordingBackend();
  const { controller, projectRoot } = makeController(backend);
  const worktree = mkdtempSync(join(tmpdir(), "pi-codrive-bg-wt-"));

  const child = await controller.spawn({ prompt: "fix", cwd: worktree, background: true });

  assert.equal(launches[0].cwd, worktree);
  assert.equal(launches[0].background, true);
  // projectRoot still names the session's root, so the ledger keeps both facts.
  assert.equal(launches[0].projectRoot, projectRoot);
  assert.equal(child.cwd, worktree);
  assert.equal(child.background, true);
});

test("a blank cwd falls back to the project root instead of launching in an empty path", async () => {
  const { backend, launches } = recordingBackend();
  const { controller, projectRoot } = makeController(backend);

  await controller.spawn({ prompt: "go", cwd: "   " });

  assert.equal(launches[0].cwd, projectRoot);
});

test("resume carries the cwd and background flags so a worktree child stays put", async () => {
  const { backend, launches } = recordingBackend("%12");
  const { controller } = makeController(backend);
  const worktree = mkdtempSync(join(tmpdir(), "pi-codrive-bg-resume-"));

  const resumed = await controller.resume({
    childId: "c1",
    model: "m",
    sessionId: "sess-c1",
    cwd: worktree,
    background: true,
  });

  assert.equal(launches[0].cwd, worktree);
  assert.equal(launches[0].background, true);
  assert.equal(resumed.cwd, worktree);
  assert.equal(resumed.background, true);
});

function makeSupervisor(background: boolean) {
  const runtimeRoot = mkdtempSync(join(tmpdir(), "pi-codrive-bg-sup-"));
  const projectRoot = mkdtempSync(join(tmpdir(), "pi-codrive-bg-sup-proj-"));
  const store = new RuntimeStore(runtimeRoot);
  const session = createHarnessSession({
    projectRoot,
    role: "orchestrator",
    delegationDepth: 0,
    trust: "trusted",
  });
  store.saveSession(session);
  const wakes: Array<{ quiet: boolean; details: unknown }> = [];
  const supervisor = new DelegationSupervisor({
    sessionId: session.sessionId,
    store,
    controller: {} as never,
    backend: {
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
    },
    monitor: { track() {}, untrack() {}, markReported() {} },
    wake: ({ quiet, details }) => wakes.push({ quiet, details }),
  });
  supervisor.registerSpawn({
    childId: "c1",
    paneId: "%9",
    model: "m",
    piSessionId: "sess-c1",
    projectRoot: session.projectRoot,
    background,
  });
  return { supervisor, wakes };
}

function terminalEnvelope(): CodriveEnvelope {
  return {
    version: 1,
    eventId: "e1",
    sessionId: "s",
    childId: "c1",
    paneId: "%9",
    timestamp: new Date().toISOString(),
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
  };
}

test("a background child's completion wakes quietly and names its childId", () => {
  const { supervisor, wakes } = makeSupervisor(true);

  assert.equal(supervisor.isBackground("%9"), true);
  supervisor.onEnvelope(terminalEnvelope());

  assert.equal(wakes.length, 1);
  assert.equal(wakes[0].quiet, true);
  const details = wakes[0].details as { childId: string; background: boolean };
  assert.equal(details.childId, "c1");
  assert.equal(details.background, true);
});

test("a foreground child's completion still interrupts as before", () => {
  const { supervisor, wakes } = makeSupervisor(false);

  assert.equal(supervisor.isBackground("%9"), false);
  supervisor.onEnvelope(terminalEnvelope());

  assert.equal(wakes.length, 1);
  assert.equal(wakes[0].quiet, false);
});

test("escalation for a dead background child is never quiet", () => {
  const { supervisor, wakes } = makeSupervisor(true);

  supervisor.onPaneDeath("%9");

  assert.equal(wakes.length, 1);
  assert.equal(wakes[0].quiet, false);
});
