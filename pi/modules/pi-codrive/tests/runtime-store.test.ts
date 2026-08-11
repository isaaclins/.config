import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  RuntimeStore,
  createHarnessSession,
  type CodriveReport,
} from "../src/index.ts";

test("runtime state survives parent restart and accepts a late report", () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), "pi-codrive-runtime-"));
  const projectRoot = mkdtempSync(join(tmpdir(), "pi-codrive-project-"));
  const session = createHarnessSession({
    projectRoot,
    role: "orchestrator",
    delegationDepth: 0,
    trust: "trusted",
  });
  const firstProcess = new RuntimeStore(runtimeRoot);
  firstProcess.saveSession(session);
  firstProcess.registerChild(session.sessionId, {
    childId: "child-1",
    paneId: "%3",
    model: "model-a",
    createdAt: "2026-07-19T00:00:00.000Z",
  });

  const report: CodriveReport = {
    version: 1,
    eventId: "event-1",
    sessionId: session.sessionId,
    childId: "child-1",
    paneId: "%3",
    status: "completed",
    assistantText: "done after restart",
    timestamp: "2026-07-19T00:01:00.000Z",
  };
  const restartedProcess = new RuntimeStore(runtimeRoot);
  restartedProcess.appendReport(report);
  const recovered = restartedProcess.load(session.sessionId);

  assert.equal(recovered.session?.projectRoot, session.projectRoot);
  assert.deepEqual(recovered.children.map((child) => child.childId), ["child-1"]);
  assert.equal(recovered.children[0].readOnly, false, "older child records migrate to writable");
  assert.deepEqual(recovered.reports, [report]);
  assert.equal(statSync(restartedProcess.sessionDirectory(session.sessionId)).mode & 0o077, 0);
  assert.equal(statSync(restartedProcess.statePath(session.sessionId)).mode & 0o077, 0);
});

test("runtime retention bounds report history and removes expired sessions", () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), "pi-codrive-retention-"));
  const projectRoot = mkdtempSync(join(tmpdir(), "pi-codrive-project-"));
  let now = Date.parse("2026-07-19T00:00:00.000Z");
  const store = new RuntimeStore(runtimeRoot, {
    maxReportsPerChild: 2,
    retentionMs: 60_000,
    now: () => now,
  });
  const session = createHarnessSession({
    projectRoot,
    role: "orchestrator",
    delegationDepth: 0,
    trust: "trusted",
  });
  store.saveSession(session);
  store.registerChild(session.sessionId, {
    childId: "child-1",
    paneId: "%3",
    model: "model-a",
    createdAt: new Date(now).toISOString(),
  });
  for (let index = 1; index <= 3; index++) {
    store.appendReport({
      version: 1,
      eventId: `event-${index}`,
      sessionId: session.sessionId,
      childId: "child-1",
      status: "completed",
      assistantText: `report ${index}`,
      timestamp: new Date(now + index).toISOString(),
    });
  }

  assert.deepEqual(
    store.load(session.sessionId).reports.map((report) => report.eventId),
    ["event-2", "event-3"],
  );
  now += 60_001;
  assert.deepEqual(store.cleanup(), [session.sessionId]);
  assert.equal(store.load(session.sessionId).session, undefined);
});
