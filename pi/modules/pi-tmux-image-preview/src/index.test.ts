import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  buildDeleteSequence,
  buildPlaceholderLines,
  buildTransmitSequence,
  PLACEHOLDER,
  randomImageId,
  wrapTmuxPassthrough,
} from "./protocol.ts";

test("protocol: randomImageId generates valid IDs", () => {
  const id1 = randomImageId();
  const id2 = randomImageId();
  assert(typeof id1 === "number");
  assert(typeof id2 === "number");
  assert(id1 >= 1);
  assert(id1 <= 0xfffffe);
  assert(id2 >= 1);
  assert(id2 <= 0xfffffe);
});

test("protocol: buildDeleteSequence produces valid Kitty delete command", () => {
  const imageId = 12345;
  const result = buildDeleteSequence(imageId);
  assert(result.startsWith("\x1bPtmux;"));
  assert(result.endsWith("\x1b\\"));
  assert(result.includes(`a=d,d=I,i=${imageId},q=2`));
});

test("protocol: wrapTmuxPassthrough escapes ESC sequences", () => {
  const sequence = "\x1b_Gtest\x1b\\";
  const wrapped = wrapTmuxPassthrough(sequence);
  assert(wrapped.startsWith("\x1bPtmux;"));
  assert(wrapped.includes("\x1b\x1b_Gtest\x1b\x1b\\"));
  assert(wrapped.endsWith("\x1b\\"));
});

test("protocol: buildTransmitSequence splits large data into chunks", () => {
  const largeBase64 = "a".repeat(10000);
  const result = buildTransmitSequence(largeBase64, 999, 60, 30);
  const chunks = result.match(/\x1b_G[^\\]*\x1b\\/g);
  assert(chunks && chunks.length > 1, "Should split into multiple chunks");
  assert(result.includes("m=1"), "Should have more=1 for intermediate chunks");
  assert(result.includes("m=0"), "Should have more=0 for final chunk");
});

test("protocol: buildTransmitSequence includes image parameters on first chunk", () => {
  const base64 = "test";
  const result = buildTransmitSequence(base64, 123, 40, 20);
  assert(result.includes("a=T"));
  assert(result.includes("f=100"));
  assert(result.includes("q=2"));
  assert(result.includes("U=1"));
  assert(result.includes("i=123"));
  assert(result.includes("c=40"));
  assert(result.includes("r=20"));
});

test("protocol: buildTransmitSequence handles empty base64", () => {
  const result = buildTransmitSequence("", 555, 60, 30);
  assert(result.includes("i=555"));
  assert(result.includes("c=60"));
  assert(result.includes("r=30"));
  assert(result.includes("m=0"));
});

test("protocol: buildPlaceholderLines generates correct row count", () => {
  const lines = buildPlaceholderLines(999, 60, 10);
  assert.equal(lines.length, 10);
});

test("protocol: buildPlaceholderLines applies color based on imageId", () => {
  const imageId = 0xff0000;
  const lines = buildPlaceholderLines(imageId, 60, 1);
  const red = (imageId >> 16) & 255;
  const green = (imageId >> 8) & 255;
  const blue = imageId & 255;
  const expectedColor = `\x1b[38;2;${red};${green};${blue}m`;
  assert(lines[0].includes(expectedColor));
});

test("protocol: buildPlaceholderLines each line contains placeholder", () => {
  const lines = buildPlaceholderLines(999, 60, 5);
  lines.forEach((line) => {
    assert(line.includes(PLACEHOLDER));
  });
});

test("protocol: buildPlaceholderLines includes column repetition", () => {
  const lines = buildPlaceholderLines(999, 60, 1);
  const placeholderCount = (lines[0].match(new RegExp(PLACEHOLDER, "g")) || [])
    .length;
  assert(placeholderCount === 60, `Should have 60 placeholders, got ${placeholderCount}`);
});

test("protocol: buildPlaceholderLines pads to max columns", () => {
  const lines1 = buildPlaceholderLines(999, 1, 1);
  const lines60 = buildPlaceholderLines(999, 60, 1);
  const count1 = (lines1[0].match(new RegExp(PLACEHOLDER, "g")) || [])
    .length;
  const count60 = (lines60[0].match(new RegExp(PLACEHOLDER, "g")) || [])
    .length;
  assert(count1 < count60);
});

test("protocol: PLACEHOLDER is valid Unicode codepoint", () => {
  assert.equal(PLACEHOLDER, "\u{10EEEE}");
});
