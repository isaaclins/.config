import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createForkedSession,
  readSessionEntries,
  sanitizeUnsafeThinkingBlocks,
  type ForkSessionEntry,
} from "../lib/codrive-fork.ts";
import { buildPiArguments } from "../lib/codrive-pane.ts";

function assistantEntry(
  id: string,
  content: unknown[],
  provider = "anthropic",
): ForkSessionEntry {
  return {
    type: "message",
    id,
    parentId: null,
    message: { role: "assistant", provider, content },
  };
}

test("signed anthropic thinking blocks are stripped and thinking is forced off", () => {
  const entries: ForkSessionEntry[] = [
    assistantEntry("a1", [
      { type: "thinking", thinking: "secret", thinkingSignature: "sig" },
      { type: "text", text: "answer" },
    ]),
  ];
  assert.equal(sanitizeUnsafeThinkingBlocks(entries), true);
  const content = entries[0].message!.content as Array<{ type: string }>;
  assert.deepEqual(
    content.map((block) => block.type),
    ["text"],
  );
  const appended = entries[entries.length - 1];
  assert.equal(appended.type, "thinking_level_change");
  assert.equal(appended.thinkingLevel, "off");
  assert.equal(appended.parentId, "a1");
});

test("redacted thinking is always stripped regardless of provider", () => {
  const entries = [assistantEntry("a1", [{ type: "redacted_thinking" }], "openai")];
  assert.equal(sanitizeUnsafeThinkingBlocks(entries), true);
  assert.deepEqual(entries[0].message!.content, []);
});

test("unsigned or non-anthropic thinking blocks are preserved", () => {
  const entries = [
    assistantEntry("a1", [{ type: "thinking", thinking: "open" }], "openai"),
    assistantEntry("a2", [{ type: "thinking", thinking: "unsigned" }]),
  ];
  assert.equal(sanitizeUnsafeThinkingBlocks(entries), false);
  assert.equal((entries[0].message!.content as unknown[]).length, 1);
  assert.equal((entries[1].message!.content as unknown[]).length, 1);
});

test("createForkedSession branches from the parent leaf and sanitizes the copy", () => {
  const dir = mkdtempSync(join(tmpdir(), "codrive-fork-"));
  const parentFile = join(dir, "parent.jsonl");
  const forkedFile = join(dir, "forked.jsonl");
  writeFileSync(parentFile, "{}\n");
  writeFileSync(
    forkedFile,
    `${[
      { type: "session", id: "s2" },
      assistantEntry("a1", [
        { type: "thinking", thinking: "secret", thinkingSignature: "sig" },
        { type: "text", text: "answer" },
      ]),
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n")}\n`,
  );
  const requestedLeafIds: string[] = [];
  const result = createForkedSession(
    {
      getSessionFile: () => parentFile,
      getLeafId: () => "leaf-live",
      getSessionDir: () => dir,
    },
    () => ({
      createBranchedSession(leafId: string) {
        requestedLeafIds.push(leafId);
        return forkedFile;
      },
      getLeafId: () => "leaf-live",
    }),
  );
  assert.deepEqual(requestedLeafIds, ["leaf-live"]);
  assert.equal(result.sessionFile, forkedFile);
  assert.equal(result.thinkingOverride, "off");
  const persisted = readSessionEntries(forkedFile);
  const rewritten = persisted.find((entry) => entry.id === "a1")!;
  assert.deepEqual(
    (rewritten.message!.content as Array<{ type: string }>).map((b) => b.type),
    ["text"],
  );
  assert.equal(persisted[persisted.length - 1].type, "thinking_level_change");
});

test("createForkedSession falls back to the persisted leaf when the live leaf is unknown", () => {
  const dir = mkdtempSync(join(tmpdir(), "codrive-fork-"));
  const parentFile = join(dir, "parent.jsonl");
  const forkedFile = join(dir, "forked.jsonl");
  writeFileSync(parentFile, "{}\n");
  writeFileSync(
    forkedFile,
    `${JSON.stringify(assistantEntry("a1", [{ type: "text", text: "hi" }]))}\n`,
  );
  const requestedLeafIds: string[] = [];
  const result = createForkedSession(
    {
      getSessionFile: () => parentFile,
      getLeafId: () => "leaf-not-flushed",
    },
    () => ({
      createBranchedSession(leafId: string) {
        requestedLeafIds.push(leafId);
        if (leafId === "leaf-not-flushed")
          throw new Error(`Entry ${leafId} not found`);
        return forkedFile;
      },
      getLeafId: () => "a1",
    }),
  );
  assert.deepEqual(requestedLeafIds, ["leaf-not-flushed", "a1"]);
  assert.equal(result.sessionFile, forkedFile);
  assert.equal(result.thinkingOverride, undefined);
  assert.equal(readFileSync(forkedFile, "utf-8").includes("thinking_level_change"), false);
});

test("createForkedSession requires a persisted parent session", () => {
  assert.throws(
    () =>
      createForkedSession(
        { getSessionFile: () => undefined, getLeafId: () => "x" },
        () => {
          throw new Error("must not open");
        },
      ),
    /persisted parent session/,
  );
});

test("buildPiArguments wires fork session and thinking override", () => {
  assert.deepEqual(
    buildPiArguments("go", "opus", "high", undefined, {
      sessionFile: "/tmp/fork.jsonl",
      thinkingOverride: "off",
    }),
    ["--model", "opus", "--thinking", "off", "--session", "/tmp/fork.jsonl", "go"],
  );
  assert.deepEqual(
    buildPiArguments("go", null, null, "haiku", { sessionFile: "/tmp/f.jsonl" }),
    ["--model", "haiku", "--session", "/tmp/f.jsonl", "go"],
  );
  assert.deepEqual(buildPiArguments("go", null, null), ["go"]);
});
