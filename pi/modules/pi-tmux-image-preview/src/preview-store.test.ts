import { strict as assert } from "node:assert";
import { test } from "node:test";
import { PreviewStore } from "./preview-store.ts";
import type { StoredImagePreview } from "./types.ts";

function preview(imageId: number): StoredImagePreview {
  return {
    data: `data-${imageId}`,
    mimeType: "image/png",
    imageId,
    note: `preview ${imageId}`,
  };
}

test("PreviewStore bounds pending previews and drops the oldest", () => {
  const store = new PreviewStore(2);
  store.queue("call-1", preview(1));
  store.queue("call-2", preview(2));
  store.queue("call-3", preview(3));

  assert.equal(store.pendingSize, 2);
  assert.equal(store.promote("call-1", "preview-1"), undefined);
  assert.equal(store.promote("call-2", "preview-2")?.preview.imageId, 2);
});

test("PreviewStore promotes by tool call and evicts completed previews", () => {
  const store = new PreviewStore(2);
  store.queue("call-1", preview(1));
  store.queue("call-2", preview(2));
  assert.equal(store.promote("call-1", "preview-1")?.evicted, undefined);
  assert.equal(store.promote("call-2", "preview-2")?.evicted, undefined);

  store.queue("call-3", preview(3));
  const promoted = store.promote("call-3", "preview-3");
  assert.equal(promoted?.evicted?.imageId, 1);
  assert.equal(store.get("preview-1"), undefined);
  assert.equal(store.get("preview-3")?.imageId, 3);
  assert.equal(store.completedSize, 2);
});

test("PreviewStore clear removes pending and completed lifecycle state", () => {
  const store = new PreviewStore(2);
  store.queue("call-1", preview(1));
  store.queue("call-2", preview(2));
  store.promote("call-1", "preview-1");

  assert.deepEqual(
    store.clear().map((item) => item.imageId),
    [1],
  );
  assert.equal(store.pendingSize, 0);
  assert.equal(store.completedSize, 0);
});

test("PreviewStore rejects an invalid capacity", () => {
  assert.throws(() => new PreviewStore(0), /positive integer/);
});
