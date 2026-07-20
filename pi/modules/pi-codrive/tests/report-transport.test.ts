import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ReportServer,
  RuntimeStore,
  createHarnessSession,
  sendReport,
  type CodriveReport,
} from "../src/index.ts";

test("report transport authenticates before persisting a report", async () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), "pi-codrive-ipc-"));
  const projectRoot = mkdtempSync(join(tmpdir(), "pi-codrive-project-"));
  const store = new RuntimeStore(runtimeRoot);
  const session = createHarnessSession({
    projectRoot,
    role: "orchestrator",
    delegationDepth: 0,
    trust: "trusted",
  });
  store.saveSession(session);
  store.registerChild(session.sessionId, {
    childId: "child-1",
    paneId: "%2",
    model: "model-a",
    createdAt: new Date().toISOString(),
  });
  const server = await ReportServer.start({
    runtimeRoot,
    sessionId: session.sessionId,
    store,
  });
  const report: CodriveReport = {
    version: 1,
    eventId: "event-1",
    sessionId: session.sessionId,
    childId: "child-1",
    status: "completed",
    assistantText: "authenticated",
    timestamp: new Date().toISOString(),
  };

  await assert.rejects(
    sendReport(server.socketPath, "wrong nonce", report),
    /authentication/i,
  );
  assert.deepEqual(store.load(session.sessionId).reports, []);
  await sendReport(server.socketPath, server.nonce, report);
  assert.deepEqual(store.load(session.sessionId).reports, [report]);
  await server.close();
});

test("onReport fires exactly once per distinct eventId and never on failed auth or replays", async () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), "pi-codrive-ipc-"));
  const projectRoot = mkdtempSync(join(tmpdir(), "pi-codrive-project-"));
  const store = new RuntimeStore(runtimeRoot);
  const session = createHarnessSession({
    projectRoot,
    role: "orchestrator",
    delegationDepth: 0,
    trust: "trusted",
  });
  store.saveSession(session);
  store.registerChild(session.sessionId, {
    childId: "child-1",
    paneId: "%9",
    model: "model-a",
    createdAt: new Date().toISOString(),
  });

  const delivered: CodriveReport[] = [];
  const server = await ReportServer.start({
    runtimeRoot,
    sessionId: session.sessionId,
    store,
    onReport: (report) => delivered.push(report),
  });
  const report: CodriveReport = {
    version: 1,
    eventId: "event-once",
    sessionId: session.sessionId,
    childId: "child-1",
    paneId: "%9",
    status: "completed",
    assistantText: "done",
    timestamp: new Date().toISOString(),
  };

  await assert.rejects(sendReport(server.socketPath, "wrong nonce", report), /authentication/i);
  assert.deepEqual(delivered, []);

  await sendReport(server.socketPath, server.nonce, report);
  assert.deepEqual(delivered, [report]);

  // A replay of the same eventId (e.g. a retried send) must not re-fire the
  // callback, only the first genuinely new report per eventId does.
  await sendReport(server.socketPath, server.nonce, report);
  assert.deepEqual(delivered, [report]);

  await server.close();
});
