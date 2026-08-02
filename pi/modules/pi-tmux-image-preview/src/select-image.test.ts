import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  findRenderableImage,
  previewNote,
  selectToolResultImage,
} from "./select-image.ts";

test("select-image: previews image from a non-read tool result", () => {
  const image = selectToolResultImage({
    toolName: "act_ui",
    isError: false,
    content: [
      { type: "text", text: "acted on @e12" },
      { type: "image", data: "AAAA", mimeType: "image/jpeg" },
    ],
  });
  assert(image);
  assert.equal(image.mimeType, "image/jpeg");
  assert.equal(image.data, "AAAA");
});

test("select-image: skips error results even when an image is present", () => {
  const image = selectToolResultImage({
    toolName: "act_ui",
    isError: true,
    content: [{ type: "image", data: "AAAA", mimeType: "image/jpeg" }],
  });
  assert.equal(image, undefined);
});

test("select-image: still previews read tool images", () => {
  const image = selectToolResultImage({
    toolName: "read",
    isError: false,
    content: [{ type: "image", data: "PNGD", mimeType: "image/png" }],
  });
  assert(image);
  assert.equal(image.mimeType, "image/png");
});

test("select-image: ignores image blocks without data or mimeType", () => {
  assert.equal(
    findRenderableImage([{ type: "image", mimeType: "image/png" }]),
    undefined,
  );
  assert.equal(findRenderableImage("not an array"), undefined);
});

test("select-image: read note keeps its existing text and fallback", () => {
  assert.equal(
    previewNote("read", [{ type: "text", text: "/tmp/pic.png" }]),
    "/tmp/pic.png",
  );
  assert.equal(
    previewNote("read", [{ type: "image", data: "PNGD", mimeType: "image/png" }]),
    "Read image file",
  );
});

test("select-image: generic note summarizes the tool and first text line", () => {
  assert.equal(
    previewNote("observe_ui", [
      { type: "text", text: "Look @l3\nOutline (42 nodes)" },
      { type: "image", data: "AAAA", mimeType: "image/jpeg" },
    ]),
    "observe_ui: Look @l3",
  );
  assert.equal(
    previewNote("act_ui", [{ type: "image", data: "AAAA", mimeType: "image/jpeg" }]),
    "act_ui image",
  );
});
