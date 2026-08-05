import assert from "node:assert/strict";
import test from "node:test";
import {
  createInterruptSubmitHandler,
  mergeEditorText,
} from "../src/interrupt-submit.ts";

function fakeContext(editorText: string, idle = true) {
  const state = { editorText, idle, abortCalled: false, notifications: [] as string[] };
  return {
    state,
    ctx: {
      hasUI: true,
      ui: {
        getEditorText: () => state.editorText,
        setEditorText: (text: string) => { state.editorText = text; },
        notify: (message: string) => { state.notifications.push(message); },
      },
      abort: () => { state.abortCalled = true; },
      isIdle: () => state.idle,
    },
  };
}

test("mergeEditorText puts captured text first with a blank line", () => {
  assert.equal(mergeEditorText("queued", "new"), "queued\n\nnew");
  assert.equal(mergeEditorText("queued", ""), "queued");
});

test("aborts before reading and sends once idle", async () => {
  const { ctx, state } = fakeContext("send me");
  const order: string[] = [];
  ctx.abort = () => { order.push("abort"); state.abortCalled = true; };
  ctx.ui.getEditorText = () => { order.push("read"); return state.editorText; };
  const sent: string[] = [];
  await createInterruptSubmitHandler({ sendUserMessage: (text) => sent.push(text) })(ctx);
  assert.deepEqual(order, ["abort", "read"]);
  assert.deepEqual(sent, ["send me"]);
  assert.equal(state.abortCalled, true);
});

test("sends queued text restored by abort after the active turn becomes idle", async () => {
  const { ctx, state } = fakeContext("current", false);
  ctx.abort = () => {
    state.abortCalled = true;
    state.editorText = "queued\n\ncurrent";
  };
  const sent: string[] = [];
  const handler = createInterruptSubmitHandler({ sendUserMessage: (text) => sent.push(text) }, {
    sleep: async () => { state.idle = true; },
  });

  await handler(ctx);

  assert.deepEqual(sent, ["queued\n\ncurrent"]);
  assert.equal(state.editorText, "");
});

test("timeout restores captured text before newly typed text", async () => {
  const { ctx, state } = fakeContext("captured", false);
  const handler = createInterruptSubmitHandler({ sendUserMessage: () => {} }, {
    timeoutMs: 1,
    pollIntervalMs: 0,
    now: (() => {
      const values = [0, 0, 2];
      return () => values.shift() ?? 2;
    })(),
    sleep: async () => { state.editorText = "typed while waiting"; },
  });
  await handler(ctx);
  assert.equal(state.editorText, "captured\n\ntyped while waiting");
  assert.equal(state.notifications.length, 1);
});

test("empty input aborts silently", async () => {
  const { ctx, state } = fakeContext("  ");
  const sent: string[] = [];
  await createInterruptSubmitHandler({ sendUserMessage: (text) => sent.push(text) })(ctx);
  assert.equal(state.abortCalled, true);
  assert.deepEqual(sent, []);
  assert.deepEqual(state.notifications, []);
});

test("double presses do not race sends", async () => {
  const { ctx } = fakeContext("once");
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const sent: string[] = [];
  const handler = createInterruptSubmitHandler({ sendUserMessage: (text) => sent.push(text) }, {
    sleep: () => waiting,
  });
  const first = handler(ctx);
  const second = handler(ctx);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(sent, ["once"]);
});
