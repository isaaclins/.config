import assert from "node:assert/strict";
import test from "node:test";
import { ChildReporter, type OutgoingEnvelope, type ReporterScheduler } from "../src/index.ts";

interface FakeHandle {
  __id: number;
  unref(): FakeHandle;
}

function manualScheduler(): {
  scheduler: ReporterScheduler;
  size: () => number;
  fireAll: () => void;
} {
  const timers = new Map<number, () => void>();
  let id = 0;
  const scheduler: ReporterScheduler = {
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

function makeReporter(opts: { idle?: boolean; pending?: boolean } = {}) {
  const sent: OutgoingEnvelope[] = [];
  const clock = manualScheduler();
  let eventSeq = 0;
  const reporter = new ChildReporter({
    sessionId: "s",
    childId: "c1",
    paneId: "%9",
    settleMs: 8000,
    scheduler: clock.scheduler,
    newEventId: () => `e${++eventSeq}`,
    now: () => 1_000_000,
    send: (envelope) => {
      sent.push(envelope);
    },
    isIdle: () => opts.idle ?? true,
    hasPendingMessages: () => opts.pending ?? false,
  });
  return { reporter, sent, clock };
}

const cleanEnd = [{ role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" }];
const errorEnd = [
  {
    role: "assistant",
    content: [{ type: "text", text: "working" }],
    stopReason: "error",
    errorMessage: "stream closed",
  },
];

test("a clean agent end sends a terminal report immediately (fast path)", () => {
  const { reporter, sent, clock } = makeReporter();
  reporter.onAgentEnd(cleanEnd);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].kind, "report");
  assert.equal(sent[0].report?.status, "completed");
  assert.equal(clock.size(), 0, "a clean end arms no settle timer");
});

test("a clean end cancels a pending error settle before sending the terminal report", () => {
  const { reporter, sent, clock } = makeReporter();
  reporter.onAgentEnd(errorEnd);
  reporter.onAgentEnd(cleanEnd);
  clock.fireAll();
  assert.deepEqual(sent.map((envelope) => envelope.kind), ["interrupt", "report"]);
  assert.equal(clock.size(), 0);
});

test("an error agent end sends a non-terminal interrupt and arms the settle window", () => {
  const { reporter, sent, clock } = makeReporter();
  reporter.recordProviderResponse(500, { "retry-after": "5" });
  reporter.onAgentEnd(errorEnd);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].kind, "interrupt");
  assert.equal(sent[0].interrupt?.transient, true);
  assert.equal(sent[0].interrupt?.retryAfter, "5");
  assert.equal(clock.size(), 1, "the settle window is armed");
});

test("a later agent start cancels the settle window and emits a heartbeat instead of a terminal report", () => {
  const { reporter, sent, clock } = makeReporter();
  reporter.onAgentEnd(errorEnd);
  reporter.onAgentStart();
  assert.equal(clock.size(), 0);
  assert.deepEqual(sent.map((envelope) => envelope.kind), ["interrupt", "heartbeat"]);

  clock.fireAll();
  assert.equal(sent.filter((envelope) => envelope.kind === "report").length, 0, "no terminal report after recovery");
});

test("the settle window expiring while idle sends the terminal error report", () => {
  const { reporter, sent, clock } = makeReporter({ idle: true, pending: false });
  reporter.onAgentEnd(errorEnd);
  clock.fireAll();
  const terminal = sent.filter((envelope) => envelope.kind === "report");
  assert.equal(terminal.length, 1);
  assert.equal(terminal[0].report?.status, "error");
});

test("the settle window expiring while not idle does not send a terminal report", () => {
  const { reporter, sent, clock } = makeReporter({ idle: false, pending: true });
  reporter.onAgentEnd(errorEnd);
  clock.fireAll();
  assert.equal(sent.filter((envelope) => envelope.kind === "report").length, 0);
});

test("announce carries the pre-assigned session identity and the child's own pane", () => {
  const { reporter, sent } = makeReporter();
  reporter.announce({ piSessionFile: "/sessions/c1.jsonl", piSessionId: "sess-c1", cwd: "/work", model: "m" });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].kind, "announce");
  assert.equal(sent[0].announce?.piSessionId, "sess-c1");
  assert.equal(sent[0].announce?.paneId, "%9");
});
