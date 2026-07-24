import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MemoryAuthority } from "../src/memory-authority.ts";

test("upsert keeps a stable record id and private structured storage", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-memory-"));
  const globalPath = join(directory, "global.jsonl");
  const authority = new MemoryAuthority({
    globalPath,
    now: () => new Date("2026-07-19T10:00:00.000Z"),
    createId: () => "memory-1",
  });

  const created = authority.upsert({
    scope: "global",
    kind: "preference",
    key: "prose.no-em-dash",
    value: "Use hyphens instead of em dashes.",
  });
  const updated = authority.upsert({
    scope: "global",
    kind: "preference",
    key: "prose.no-em-dash",
    value: "Never use em dashes.",
  });

  assert.equal(created.id, "memory-1");
  assert.equal(updated.id, created.id);
  assert.equal(updated.createdAt, created.createdAt);
  assert.equal(updated.updatedAt, "2026-07-19T10:00:00.000Z");
  assert.equal(statSync(globalPath).mode & 0o777, 0o600);

  const lines = readFileSync(globalPath, "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), updated);
});

test("injection contains only eligible memory data and project values win conflicts", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-memory-"));
  const authority = new MemoryAuthority({
    globalPath: join(directory, "global.jsonl"),
    projectPath: join(directory, "project.jsonl"),
    now: () => new Date("2026-07-19T10:00:00.000Z"),
    createId: (() => {
      let id = 0;
      return () => `memory-${++id}`;
    })(),
  });

  authority.upsert({
    scope: "global",
    kind: "preference",
    key: "format.answer",
    value: "Use the global format.",
  });
  authority.upsert({
    scope: "project",
    kind: "fact",
    key: "format.answer",
    value: "Use the project format.",
  });
  authority.upsert({
    scope: "global",
    kind: "fact",
    key: "global.fact",
    value: "Do not inject global facts.",
  });
  authority.upsert({
    scope: "project",
    kind: "preference",
    key: "project.preference",
    value: "Do not inject project preferences.",
  });
  authority.upsert({
    scope: "project",
    kind: "runbook",
    key: "deploy",
    value: "Do not inject runbooks.",
  });
  authority.upsert({
    scope: "global",
    kind: "preference",
    key: "expired",
    value: "Do not inject expired records.",
    expiresAt: "2026-07-18T10:00:00.000Z",
  });

  const injection = authority.buildInjection();

  assert.match(injection.text, /untrusted memory data/i);
  assert.match(injection.text, /Use the project format/);
  assert.doesNotMatch(injection.text, /Use the global format/);
  assert.doesNotMatch(injection.text, /Do not inject/);
  assert.deepEqual(injection.selectedIds, ["memory-2"]);
  assert.deepEqual(injection.conflicts, [
    {
      key: "format.answer",
      winnerId: "memory-2",
      shadowedIds: ["memory-1"],
    },
  ]);
});

test("appendNote stores a fresh unique key for every call, even with identical values", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-memory-"));
  const globalPath = join(directory, "global.jsonl");
  const authority = new MemoryAuthority({
    globalPath,
    now: () => new Date("2026-07-19T10:00:00.000Z"),
    createId: (() => {
      let id = 0;
      return () => `note-${++id}`;
    })(),
  });

  const first = authority.appendNote({ scope: "global", kind: "preference", value: "same text" });
  const second = authority.appendNote({ scope: "global", kind: "preference", value: "same text" });
  const third = authority.appendNote({ scope: "global", kind: "preference", value: "same text" });

  const keys = new Set([first.key, second.key, third.key]);
  assert.equal(keys.size, 3);

  const lines = readFileSync(globalPath, "utf8").trim().split("\n");
  assert.equal(lines.length, 3);
  for (const record of [first, second, third]) {
    assert.equal(record.scope, "global");
    assert.equal(record.kind, "preference");
    assert.equal(record.status, "active");
    assert.equal(record.value, "same text");
  }
});

test("appendNote uses an explicit createdAt when provided and mirrors it into updatedAt", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-memory-"));
  const globalPath = join(directory, "global.jsonl");
  const authority = new MemoryAuthority({
    globalPath,
    now: () => new Date("2026-07-19T10:00:00.000Z"),
    createId: () => "note-1",
  });

  const withDate = authority.appendNote({
    scope: "global",
    kind: "preference",
    value: "historical",
    createdAt: "2024-01-15T00:00:00.000Z",
  });
  assert.equal(withDate.createdAt, "2024-01-15T00:00:00.000Z");
  assert.equal(withDate.updatedAt, "2024-01-15T00:00:00.000Z");
});

test("appendNote falls back to now() when no createdAt is provided", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-memory-"));
  const globalPath = join(directory, "global.jsonl");
  const authority = new MemoryAuthority({
    globalPath,
    now: () => new Date("2026-07-19T10:00:00.000Z"),
    createId: () => "note-1",
  });

  const record = authority.appendNote({ scope: "global", kind: "preference", value: "fresh" });
  assert.equal(record.createdAt, "2026-07-19T10:00:00.000Z");
  assert.equal(record.updatedAt, "2026-07-19T10:00:00.000Z");
});

test("appendNote rejects values larger than the configured hard cap", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-memory-"));
  const globalPath = join(directory, "global.jsonl");
  const authority = new MemoryAuthority({ globalPath, maxRecordChars: 5 });

  assert.throws(
    () => authority.appendNote({ scope: "global", kind: "preference", value: "123456" }),
    /5 characters/,
  );
  assert.equal(existsSync(globalPath), false);
});

test("upsert rejects records larger than the configured hard cap", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-memory-"));
  const globalPath = join(directory, "global.jsonl");
  const authority = new MemoryAuthority({ globalPath, maxRecordChars: 5 });

  assert.throws(
    () =>
      authority.upsert({
        scope: "global",
        kind: "preference",
        key: "too-large",
        value: "123456",
      }),
    /5 characters/,
  );
  assert.equal(existsSync(globalPath), false);
});

test("buildInjection annotates records older than the stale window in the injected copy only", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-memory-"));
  const globalPath = join(directory, "global.jsonl");
  const authority = new MemoryAuthority({
    globalPath,
    now: () => new Date("2026-07-19T10:00:00.000Z"),
    createId: (() => {
      let id = 0;
      return () => `note-${++id}`;
    })(),
  });

  authority.appendNote({
    scope: "global",
    kind: "preference",
    value: "ancient truth",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  authority.appendNote({
    scope: "global",
    kind: "preference",
    value: "recent truth",
    createdAt: "2026-07-18T00:00:00.000Z",
  });

  const injection = authority.buildInjection();
  assert.match(injection.text, /ancient truth \(old, verify before trusting\)/);
  assert.doesNotMatch(injection.text, /recent truth \(old, verify before trusting\)/);
  assert.match(injection.text, /recent truth/);

  // Stored values are never mutated by the aging annotation.
  const stored = readFileSync(globalPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(stored[0].value, "ancient truth");
  assert.equal(stored[1].value, "recent truth");
});

test("buildInjection stale window is configurable via staleDays", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-memory-"));
  const globalPath = join(directory, "global.jsonl");
  const authority = new MemoryAuthority({
    globalPath,
    staleDays: 5,
    now: () => new Date("2026-07-19T10:00:00.000Z"),
    createId: () => "note-1",
  });

  authority.appendNote({
    scope: "global",
    kind: "preference",
    value: "eight days old",
    createdAt: "2026-07-11T00:00:00.000Z",
  });

  const injection = authority.buildInjection();
  assert.match(injection.text, /eight days old \(old, verify before trusting\)/);
});

test("retired records are excluded from buildInjection but not deleted", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-memory-"));
  const globalPath = join(directory, "global.jsonl");
  const authority = new MemoryAuthority({
    globalPath,
    now: () => new Date("2026-07-19T10:00:00.000Z"),
    createId: (() => {
      let id = 0;
      return () => `memory-${++id}`;
    })(),
  });

  authority.upsert({ scope: "global", kind: "preference", key: "keep", value: "visible" });
  authority.upsert({ scope: "global", kind: "preference", key: "hide", value: "should vanish" });
  authority.retire("global", "hide");

  const injection = authority.buildInjection();
  assert.match(injection.text, /visible/);
  assert.doesNotMatch(injection.text, /should vanish/);

  // Record still on disk (append-only)
  const lines = readFileSync(globalPath, "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  const retired = JSON.parse(lines[1]);
  assert.equal(retired.status, "retired");
});

test("listActive returns only active records sorted by createdAt, tolerating a missing project store", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-memory-"));
  const globalPath = join(directory, "global.jsonl");
  const authority = new MemoryAuthority({
    globalPath,
    now: () => new Date("2026-07-19T10:00:00.000Z"),
    createId: (() => {
      let id = 0;
      return () => `note-${++id}`;
    })(),
  });

  authority.appendNote({
    scope: "global",
    kind: "preference",
    value: "newer",
    createdAt: "2026-05-01T00:00:00.000Z",
  });
  authority.appendNote({
    scope: "global",
    kind: "preference",
    value: "older",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  const retired = authority.appendNote({
    scope: "global",
    kind: "preference",
    value: "gone",
    createdAt: "2026-03-01T00:00:00.000Z",
  });
  authority.retire("global", retired.key);

  const active = authority.listActive("global");
  assert.deepEqual(active.map((record) => record.value), ["older", "newer"]);

  // No project store configured -> empty list, no throw.
  assert.deepEqual(authority.listActive("project"), []);
});
