import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { migrateLegacyNotes, parseLegacyLine } from "../src/migrate.ts";

test("parseLegacyLine extracts the date and strips the dated prefix from the value", () => {
  assert.deepEqual(parseLegacyLine("- [2026-07-15] Isaac prefers cheaper models."), {
    date: "2026-07-15",
    value: "Isaac prefers cheaper models.",
  });
  assert.equal(parseLegacyLine("not a note line"), undefined);
  assert.equal(parseLegacyLine("   "), undefined);
});

test("migrateLegacyNotes imports each dated line into the store with scope, kind, and createdAt", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-memory-migrate-"));
  const legacyPath = join(directory, "legacy.md");
  const storePath = join(directory, "global.jsonl");
  writeFileSync(
    legacyPath,
    [
      "- [2026-07-15] first legacy note",
      "",
      "- [2026-07-16] second legacy note",
      "some junk line without the prefix",
    ].join("\n"),
  );

  const summary = migrateLegacyNotes({
    legacyPath,
    scope: "global",
    kind: "preference",
    storePath,
  });
  assert.equal(summary.imported, 2);

  const records = readFileSync(storePath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(records.length, 2);

  assert.equal(records[0].scope, "global");
  assert.equal(records[0].kind, "preference");
  assert.equal(records[0].value, "first legacy note");
  assert.equal(records[0].createdAt, "2026-07-15T00:00:00.000Z");
  assert.equal(records[0].updatedAt, "2026-07-15T00:00:00.000Z");
  assert.equal(records[0].status, "active");

  assert.equal(records[1].value, "second legacy note");
  assert.equal(records[1].createdAt, "2026-07-16T00:00:00.000Z");

  // Unique keys even across the whole import.
  assert.notEqual(records[0].key, records[1].key);
});

test("migrateLegacyNotes honors project scope and fact kind", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-memory-migrate-"));
  const legacyPath = join(directory, "legacy.md");
  const storePath = join(directory, "project.jsonl");
  writeFileSync(legacyPath, "- [2025-12-01] repo builds with npm test\n");

  const summary = migrateLegacyNotes({
    legacyPath,
    scope: "project",
    kind: "fact",
    storePath,
  });
  assert.equal(summary.imported, 1);

  const record = JSON.parse(readFileSync(storePath, "utf8").trim());
  assert.equal(record.scope, "project");
  assert.equal(record.kind, "fact");
  assert.equal(record.value, "repo builds with npm test");
  assert.equal(record.createdAt, "2025-12-01T00:00:00.000Z");
});
