import assert from "node:assert/strict";
import test from "node:test";
import {
  buildChildReport,
  buildInterruptEvidence,
  classifyAgentEnd,
  extractAssistantText,
  lastAssistantErrorMessage,
  safeErrorSummary,
  truncateReportText,
} from "../src/index.ts";

test("classifyAgentEnd maps error to interrupted and is never terminal on its own", () => {
  assert.equal(
    classifyAgentEnd([{ role: "assistant", content: "x", stopReason: "error" }]),
    "interrupted",
  );
  assert.equal(
    classifyAgentEnd([{ role: "assistant", content: "x", stopReason: "aborted" }]),
    "aborted",
  );
  assert.equal(
    classifyAgentEnd([{ role: "assistant", content: "x", stopReason: "stop" }]),
    "completed",
  );
  assert.equal(classifyAgentEnd([]), "completed");
  // Only the LAST assistant message decides the outcome.
  assert.equal(
    classifyAgentEnd([
      { role: "assistant", content: "x", stopReason: "error" },
      { role: "assistant", content: "y", stopReason: "stop" },
    ]),
    "completed",
  );
});

test("buildInterruptEvidence classifies HTTP status as transient or not with a reason", () => {
  const rateLimited = buildInterruptEvidence({ providerStatus: 429, retryAfter: "30" });
  assert.equal(rateLimited.transient, true);
  assert.equal(rateLimited.providerStatus, 429);
  assert.equal(rateLimited.retryAfter, "30");
  assert.match(rateLimited.reason, /transient/);

  assert.equal(buildInterruptEvidence({ providerStatus: 503 }).transient, true);
  assert.equal(buildInterruptEvidence({ providerStatus: 400 }).transient, false);

  const noEvidence = buildInterruptEvidence({});
  assert.equal(noEvidence.transient, false);
  assert.match(noEvidence.reason, /no HTTP evidence/);

  // Error text is redacted before it is folded into the reason string.
  const redacted = buildInterruptEvidence({
    providerStatus: 500,
    errorMessage: "token: example-value",
  });
  assert.match(redacted.reason, /credential=\[redacted\]/);
});

test("lastAssistantErrorMessage returns the final assistant errorMessage", () => {
  assert.equal(
    lastAssistantErrorMessage([
      { role: "assistant", content: "x", stopReason: "error", errorMessage: "boom" },
    ]),
    "boom",
  );
  assert.equal(lastAssistantErrorMessage([]), undefined);
});

test("extractAssistantText joins text blocks and passes through plain strings", () => {
  assert.equal(extractAssistantText("plain"), "plain");
  assert.equal(
    extractAssistantText([
      { type: "text", text: "first" },
      { type: "tool_use", text: "ignored" },
      { type: "text", text: "second" },
    ]),
    "first\nsecond",
  );
  assert.equal(extractAssistantText(undefined), "");
});

test("safeErrorSummary redacts common credential shapes and caps length", () => {
  assert.equal(safeErrorSummary(undefined), undefined);
  assert.equal(safeErrorSummary(""), undefined);
  assert.match(safeErrorSummary("api_key: sk-abc123")!, /credential=\[redacted\]/);
  assert.match(safeErrorSummary("Bearer abcdef123456")!, /Bearer \[redacted\]/);
  assert.ok(safeErrorSummary("x".repeat(2000))!.length <= 1000);
});

test("truncateReportText caps both line count and byte size with a marker", () => {
  const manyLines = Array.from({ length: 2100 }, (_, i) => `line ${i}`).join("\n");
  const { content, truncated } = truncateReportText(manyLines);
  assert.ok(truncated);
  assert.match(content, /truncated/);
  const big = "x".repeat(60 * 1024);
  const byBytes = truncateReportText(big);
  assert.ok(byBytes.truncated);
  assert.ok(Buffer.byteLength(byBytes.content) <= 50 * 1024);
});

test("buildChildReport derives status from the last assistant stopReason and includes identity", () => {
  const messages = [
    { role: "user", content: "hi" },
    { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" },
  ];
  const report = buildChildReport(messages, {
    sessionId: "session-1",
    childId: "child-1",
    paneId: "%9",
    eventId: "event-1",
    now: new Date("2026-07-19T00:00:00.000Z"),
  });
  assert.equal(report.status, "completed");
  assert.equal(report.assistantText, "done");
  assert.equal(report.sessionId, "session-1");
  assert.equal(report.childId, "child-1");
  assert.equal(report.paneId, "%9");
  assert.equal(report.timestamp, "2026-07-19T00:00:00.000Z");
});

test("buildChildReport maps error and aborted stop reasons and redacts error summaries", () => {
  const errorMessages = [
    {
      role: "assistant",
      content: [{ type: "text", text: "oops" }],
      stopReason: "error",
      // Fake credential fixture; the assertion below proves it gets redacted.
      errorMessage: "token: sk-live-abcdef123456", // gitleaks:allow
    },
  ];
  const errorReport = buildChildReport(errorMessages, {
    sessionId: "s",
    childId: "c",
    eventId: "e1",
  });
  assert.equal(errorReport.status, "error");
  assert.match(errorReport.errorSummary!, /credential=\[redacted\]/);

  const abortedMessages = [{ role: "assistant", content: "partial", stopReason: "aborted" }];
  const abortedReport = buildChildReport(abortedMessages, { sessionId: "s", childId: "c", eventId: "e2" });
  assert.equal(abortedReport.status, "aborted");
});

test("buildChildReport with no assistant messages defaults to completed with empty text", () => {
  const report = buildChildReport([], { sessionId: "s", childId: "c", eventId: "e3" });
  assert.equal(report.status, "completed");
  assert.equal(report.assistantText, "");
  assert.equal(report.paneId, undefined);
});
