import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ReportServer,
  RuntimeStore,
  createHarnessSession,
  sendEnvelope,
  sendReport,
  type CodriveEnvelope,
  type CodriveReport,
  type OutgoingEnvelope,
} from "../src/index.ts";

function seededStore(): {
  runtimeRoot: string;
  store: RuntimeStore;
  sessionId: string;
} {
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
  return { runtimeRoot, store, sessionId: session.sessionId };
}

test("a legacy envelope with no kind is accepted as a terminal report (protocol v1)", async () => {
  const { runtimeRoot, store, sessionId } = seededStore();
  const envelopes: CodriveEnvelope[] = [];
  const server = await ReportServer.start({
    runtimeRoot,
    sessionId,
    store,
    onEnvelope: (envelope) => envelopes.push(envelope),
  });
  const report: CodriveReport = {
    version: 1,
    eventId: "legacy-1",
    sessionId,
    childId: "child-1",
    paneId: "%9",
    status: "completed",
    assistantText: "legacy ok",
    timestamp: new Date().toISOString(),
  };
  // sendReport emits the legacy { version, nonce, report } wire with no kind.
  await sendReport(server.socketPath, server.nonce, report);
  assert.equal(envelopes.length, 1);
  assert.equal(envelopes[0].kind, "report");
  assert.deepEqual(store.load(sessionId).reports, [report]);
  await server.close();
});

test("non-terminal and unknown kinds are delivered but never inflate the on-disk report history", async () => {
  const { runtimeRoot, store, sessionId } = seededStore();
  const envelopes: CodriveEnvelope[] = [];
  const reports: CodriveReport[] = [];
  const server = await ReportServer.start({
    runtimeRoot,
    sessionId,
    store,
    onReport: (report) => reports.push(report),
    onEnvelope: (envelope) => envelopes.push(envelope),
  });

  const base = { sessionId, childId: "child-1", paneId: "%9" };
  await sendEnvelope(server.socketPath, server.nonce, {
    ...base,
    kind: "interrupt",
    eventId: "int-1",
    interrupt: { transient: true, reason: "HTTP 429" },
  });
  await sendEnvelope(server.socketPath, server.nonce, {
    ...base,
    kind: "heartbeat",
    eventId: "hb-1",
  });
  // An unknown future kind must be tolerated: delivered, not persisted, no crash.
  await sendEnvelope(server.socketPath, server.nonce, {
    ...base,
    kind: "mystery" as OutgoingEnvelope["kind"],
    eventId: "unk-1",
  });

  assert.deepEqual(envelopes.map((envelope) => envelope.kind), ["interrupt", "heartbeat", "mystery"]);
  assert.deepEqual(reports, [], "no terminal onReport for non-terminal kinds");
  assert.deepEqual(store.load(sessionId).reports, [], "non-terminal kinds are never persisted");
  await server.close();
});

test("a wrong nonce is rejected before any state mutation for a non-terminal kind", async () => {
  const { runtimeRoot, store, sessionId } = seededStore();
  const envelopes: CodriveEnvelope[] = [];
  const server = await ReportServer.start({
    runtimeRoot,
    sessionId,
    store,
    onEnvelope: (envelope) => envelopes.push(envelope),
  });
  await assert.rejects(
    sendEnvelope(server.socketPath, "wrong nonce", {
      kind: "interrupt",
      eventId: "int-x",
      sessionId,
      childId: "child-1",
      paneId: "%9",
      interrupt: { transient: false, reason: "boom" },
    }),
    /authentication/i,
  );
  assert.deepEqual(envelopes, [], "a bad nonce never reaches onEnvelope");
  assert.deepEqual(store.load(sessionId).reports, []);
  await server.close();
});

test("a terminal event is eligible for retry when persistence fails before dedupe", async () => {
  const { runtimeRoot, store, sessionId } = seededStore();
  const reports: CodriveReport[] = [];
  const server = await ReportServer.start({
    runtimeRoot,
    sessionId,
    store,
    onReport: (report) => reports.push(report),
  });
  const report: CodriveReport = {
    version: 1,
    eventId: "retry-after-persistence-failure",
    sessionId,
    childId: "child-added-later",
    status: "completed",
    assistantText: "retry me",
    timestamp: new Date().toISOString(),
  };

  await assert.rejects(sendReport(server.socketPath, server.nonce, report));
  store.registerChild(sessionId, {
    childId: report.childId,
    paneId: "%10",
    model: "model-a",
    createdAt: new Date().toISOString(),
  });
  await sendReport(server.socketPath, server.nonce, report);

  assert.deepEqual(reports, [report]);
  assert.deepEqual(store.load(sessionId).reports, [report]);
  await server.close();
});

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
