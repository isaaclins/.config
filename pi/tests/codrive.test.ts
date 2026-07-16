import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection } from "node:net";
import {
  DEFAULT_CONFIG,
  isCodriveChildEnvironment,
  validateConfig,
} from "../lib/codrive-config.ts";
import {
  chooseSocketDirectory,
  decodeFrame,
  encodeFrame,
  frameState,
  NONCE_ENV,
  socketPathLimit,
  sendReport,
  startIpcServer,
} from "../lib/codrive-ipc.ts";
import {
  createSpawnReport,
  extractAssistantText,
  truncateReportOutput,
  truncateText,
} from "../lib/codrive-state.ts";
import { ReportRouter } from "../lib/codrive-router.ts";
import {
  buildPiArguments,
  buildLaunch,
  checkedPaneExec,
  markPaneDead,
  paneRoleArgs,
  shellQuote,
} from "../lib/codrive-pane.ts";

test("structured report schema v1 extracts the latest assistant and redacts errors", () => {
  const report = createSpawnReport(
    [
      {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        stopReason: "error",
        errorMessage: "token=secret-value",
      },
    ],
    "event",
    "%2",
    new Date("2026-01-01T00:00:00Z"),
  );
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.status, "error");
  assert.equal(report.assistantText, "done");
  assert.match(report.errorSummary!, /redacted/);
  assert.equal(extractAssistantText("plain"), "plain");
});
test("current and legacy child environment markers are recognized", () => {
  assert.equal(isCodriveChildEnvironment({}), false);
  assert.equal(isCodriveChildEnvironment({ PI_CODRIVE_SOCKET: "/tmp/socket" }), true);
  assert.equal(isCodriveChildEnvironment({ PI_CODRIVE_NONCE: "nonce" }), true);
  assert.equal(isCodriveChildEnvironment({ PI_SPAWN_NOTIFY_FILE: "/tmp/notify" }), true);
  assert.equal(isCodriveChildEnvironment({ PI_SPAWN_AGENT_REPORT_FILE: "/tmp/report" }), true);
});

test("configuration validates and null model/thinking inherit by omitting flags", () => {
  assert.deepEqual(buildPiArguments("work", null, null), ["work"]);
  assert.deepEqual(buildPiArguments(undefined, "provider/model", "low"), [
    "--model",
    "provider/model",
    "--thinking",
    "low",
  ]);
  assert.equal(
    validateConfig({ tmux: { split: "vertical" } }).tmux.split,
    "vertical",
  );
  assert.throws(() => validateConfig({ tmux: { roleOption: "bad" } }));
  assert.throws(
    () => validateConfig({ waitingWidget: { enabled: "false" } }),
    /boolean/,
  );
});
test("command construction quotes prompts and pane roles are scoped", () => {
  assert.equal(shellQuote("it's safe"), "'it'\\''s safe'");
  assert.match(buildLaunch("pi", ["hello world"]), /^'pi' 'hello world'$/);
  assert.deepEqual(paneRoleArgs("%1", "@pi_codrive_role", "orchestrator"), [
    "set-option",
    "-p",
    "-t",
    "%1",
    "@pi_codrive_role",
    "orchestrator",
  ]);
  assert.deepEqual(paneRoleArgs("%1", "@pi_codrive_role", null), [
    "set-option",
    "-p",
    "-u",
    "-t",
    "%1",
    "@pi_codrive_role",
  ]);
});
test("framing validates length, schema, and size", () => {
  const report = createSpawnReport([], "x");
  const frame = encodeFrame({ version: 1, nonce: "n", report });
  assert.equal(decodeFrame(frame, 4096).report.eventId, "x");
  assert.throws(() => decodeFrame(frame, 2), /oversized/);
  assert.equal(frameState(frame, 4096), "exact");
  assert.equal(frameState(frame.subarray(0, -1), 4096), "incomplete");
  assert.throws(
    () => frameState(Buffer.concat([frame, Buffer.from([0])]), 4096),
    /overlong/,
  );
  assert.throws(
    () => frameState(Buffer.concat([frame, frame]), 4096),
    /multiple/,
  );
  assert.throws(() => decodeFrame(frame.subarray(0, -1), 4096), /incomplete/);
});
test("socket paths respect macOS and Linux limits and reject Windows", () => {
  const longBase = `/${"nested/".repeat(30)}`;
  for (const operatingSystem of ["darwin", "linux"] as const) {
    const directory = chooseSocketDirectory(
      longBase,
      operatingSystem,
      123,
      "abcdef123456",
    );
    assert.ok(
      Buffer.byteLength(join(directory, "s")) <=
        socketPathLimit(operatingSystem),
    );
    assert.match(directory, /^\/tmp\//);
  }
  assert.throws(() => socketPathLimit("win32"));
});
test("report router drains report-before-register and delivers register-before-report once", () => {
  const delivered: string[] = [];
  const router = new ReportRouter((report) => delivered.push(report.eventId));
  const early = createSpawnReport([], "early", "%1");
  router.receive(early);
  router.receive(early);
  assert.deepEqual(delivered, []);
  router.registerPane("%1");
  assert.deepEqual(delivered, ["early"]);
  const late = createSpawnReport([], "late", "%1");
  router.receive(late);
  router.receive(late);
  assert.deepEqual(delivered, ["early", "late"]);
});
test("pending router bounds and expires unknown-pane reports", () => {
  let now = 0;
  const delivered: string[] = [];
  const router = new ReportRouter((report) => delivered.push(report.eventId), {
    maxPendingCount: 1,
    maxPendingBytes: 4096,
    pendingTtlMs: 10,
    now: () => now,
  });
  assert.equal(router.receive(createSpawnReport([], "old", "%1")), true);
  assert.equal(router.receive(createSpawnReport([], "overflow", "%2")), false);
  now = 20;
  router.receive(createSpawnReport([], "new", "%2"));
  router.registerPane("%1");
  router.registerPane("%2");
  assert.deepEqual(delivered, ["new"]);
});
test("private socket accepts authenticated reports, deduplicates, and cleans up", async () => {
  const runtime = mkdtempSync(join(tmpdir(), "pcd-test-runtime-"));
  const env = { ...process.env, XDG_RUNTIME_DIR: runtime };
  const old = process.env.XDG_RUNTIME_DIR;
  process.env.XDG_RUNTIME_DIR = runtime;
  const reports: string[] = [];
  const server = await startIpcServer(DEFAULT_CONFIG, (report) => {
    reports.push(report.eventId);
    return true;
  });
  assert.equal(statSync(join(server.path, "..")).mode & 0o077, 0);
  const report = createSpawnReport([], "same", "%1");
  assert.equal(
    await sendReport(report, DEFAULT_CONFIG, {
      ...env,
      PI_CODRIVE_SOCKET: server.path,
      PI_CODRIVE_NONCE: server.nonce,
    }),
    true,
  );
  assert.equal(
    await sendReport(report, DEFAULT_CONFIG, {
      ...env,
      PI_CODRIVE_SOCKET: server.path,
      PI_CODRIVE_NONCE: server.nonce,
    }),
    true,
  );
  assert.deepEqual(reports, ["same"]);
  const directory = join(server.path, "..");
  await server.close();
  assert.throws(() => statSync(directory));
  if (old === undefined) delete process.env.XDG_RUNTIME_DIR;
  else process.env.XDG_RUNTIME_DIR = old;
});
test("multiple children can report concurrently and malformed clients are isolated", async () => {
  const runtime = mkdtempSync(join(tmpdir(), "pcd-test-concurrent-"));
  const old = process.env.XDG_RUNTIME_DIR;
  process.env.XDG_RUNTIME_DIR = runtime;
  const reports: string[] = [];
  const server = await startIpcServer(DEFAULT_CONFIG, (report) => {
    reports.push(report.eventId);
    return true;
  });
  const environment = {
    PI_CODRIVE_SOCKET: server.path,
    PI_CODRIVE_NONCE: server.nonce,
  };
  await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      sendReport(
        createSpawnReport([], `event-${index}`, `%${index + 1}`),
        DEFAULT_CONFIG,
        environment,
      ),
    ),
  );
  await new Promise<void>((resolve) => {
    const client = createConnection(server.path, () =>
      client.end(Buffer.from([0xff, 0xff, 0xff, 0xff])),
    );
    client.on("close", () => resolve());
  });
  assert.equal(new Set(reports).size, 8);
  await server.close();
  if (old === undefined) delete process.env.XDG_RUNTIME_DIR;
  else process.env.XDG_RUNTIME_DIR = old;
});

test("wrong nonce and unavailable parent fail without throwing", async () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.notifications.retries = 0;
  config.notifications.connectTimeoutMs = 100;
  assert.equal(
    await sendReport(createSpawnReport([], "x"), config, {
      [NONCE_ENV]: "bad",
      PI_CODRIVE_SOCKET: "/tmp/does-not-exist",
    }),
    false,
  );
});
test("failed capture and send operations mark panes dead with actionable errors", async () => {
  for (const operation of ["capture-pane", "send text", "send Enter"]) {
    let deadCalls = 0;
    await assert.rejects(
      checkedPaneExec(
        "%7",
        operation,
        [operation],
        async () => ({ code: 1, stdout: "", stderr: "pane vanished" }),
        () => deadCalls++,
      ),
      new RegExp(
        `${operation} failed.*pane vanished.*history is preserved`,
        "i",
      ),
    );
    assert.equal(deadCalls, 1);
  }
  let deadCalls = 0;
  await assert.rejects(
    checkedPaneExec(
      "%8",
      "capture-pane",
      [],
      async () => {
        throw new Error("socket closed");
      },
      () => deadCalls++,
    ),
    /socket closed.*history is preserved/i,
  );
  assert.equal(deadCalls, 1);
});
test("dead panes stop live waiting but retain history and accept later reports", () => {
  const live = new Set(["%1", "%2"]);
  const waiting = new Set(["%1", "%2"]);
  const histories = new Map<string, ReturnType<typeof createSpawnReport>[]>([
    ["%1", []],
    ["%2", [createSpawnReport([], "existing", "%2")]],
  ]);
  assert.deepEqual(markPaneDead("%1", live, waiting, histories), {
    wasWaiting: true,
    hasReports: false,
  });
  assert.deepEqual(markPaneDead("%2", live, waiting, histories), {
    wasWaiting: true,
    hasReports: true,
  });
  const router = new ReportRouter((report) =>
    histories.get(report.pane!)!.push(report),
  );
  router.registerPane("%1");
  router.receive(createSpawnReport([], "delayed", "%1"));
  assert.equal(histories.get("%1")?.length, 1);
  assert.equal(live.has("%1"), false);
});
test("huge Unicode and multiline reports are capped before framing and remain valid UTF-8", () => {
  const report = createSpawnReport(
    [
      {
        role: "assistant",
        content: `${"🙂".repeat(30000)}\n${"line\n".repeat(3000)}`,
      },
    ],
    "huge",
    "%1",
  );
  assert.ok(Buffer.byteLength(report.assistantText) <= 50 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(report)) <= 50 * 1024);
  assert.ok(report.assistantText.split("\n").length <= 2000);
  assert.doesNotMatch(report.assistantText, /�/);
  const frame = encodeFrame({ version: 1, nonce: "n", report });
  assert.ok(frame.length <= DEFAULT_CONFIG.notifications.maxMessageBytes + 4);
  assert.equal(
    decodeFrame(frame, DEFAULT_CONFIG.notifications.maxMessageBytes).report
      .eventId,
    "huge",
  );
  assert.equal(truncateText("🙂".repeat(30000)).truncated, true);
});
test("report and pane output caps are enforced", () => {
  const output = truncateReportOutput("x".repeat(100000));
  assert.equal(output.truncated, true);
  assert.ok(Buffer.byteLength(output.content) <= 50 * 1024);
});
