import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MemoryAuthority } from "../src/memory-authority.ts";
import {
  parseRememberArgs,
  rememberNote,
  buildMemoryListing,
  forgetNote,
  shouldShowNudge,
} from "../src/notes.ts";

function newAuthority() {
  const directory = mkdtempSync(join(tmpdir(), "pi-memory-notes-"));
  return new MemoryAuthority({
    globalPath: join(directory, "global.jsonl"),
    projectPath: join(directory, "project.jsonl"),
    now: () => new Date("2026-07-19T10:00:00.000Z"),
    createId: (() => {
      let id = 0;
      return () => `note-${++id}`;
    })(),
  });
}

test("parseRememberArgs detects the leading -g and --global flags", () => {
  assert.deepEqual(parseRememberArgs("-g stays global"), { scope: "global", note: "stays global" });
  assert.deepEqual(parseRememberArgs("--global also global"), {
    scope: "global",
    note: "also global",
  });
  assert.deepEqual(parseRememberArgs("plain project note"), {
    scope: "project",
    note: "plain project note",
  });
  assert.deepEqual(parseRememberArgs("  -g   trimmed  "), { scope: "global", note: "trimmed" });
});

test("rememberNote stores global notes as preference and project notes as fact", () => {
  const authority = newAuthority();
  const globalRecord = rememberNote(authority, { note: "user likes hyphens", scope: "global" });
  const projectRecord = rememberNote(authority, { note: "build via npm test", scope: "project" });

  assert.equal(globalRecord.scope, "global");
  assert.equal(globalRecord.kind, "preference");
  assert.equal(projectRecord.scope, "project");
  assert.equal(projectRecord.kind, "fact");
});

test("buildMemoryListing shows stable g/p indices with dates, and (none) when empty", () => {
  const authority = newAuthority();
  const listingEmpty = buildMemoryListing(authority);
  assert.match(listingEmpty, /## Global notes/);
  assert.match(listingEmpty, /\(none\)/);

  rememberNote(authority, { note: "first global", scope: "global" });
  rememberNote(authority, { note: "second global", scope: "global" });
  rememberNote(authority, { note: "only project", scope: "project" });

  const listing = buildMemoryListing(authority);
  assert.match(listing, /g1: \[2026-07-19\] first global/);
  assert.match(listing, /g2: \[2026-07-19\] second global/);
  assert.match(listing, /p1: \[2026-07-19\] only project/);
});

test("buildMemoryListing excludes retired records and re-numbers from current order", () => {
  const authority = newAuthority();
  const a = rememberNote(authority, { note: "keep me", scope: "global" });
  const b = rememberNote(authority, { note: "drop me", scope: "global" });
  const c = rememberNote(authority, { note: "keep me too", scope: "global" });
  void a;
  void c;
  authority.retire("global", b.key);

  const listing = buildMemoryListing(authority);
  assert.match(listing, /g1: \[2026-07-19\] keep me/);
  assert.match(listing, /g2: \[2026-07-19\] keep me too/);
  assert.doesNotMatch(listing, /drop me/);
});

test("forgetNote retires by display index", () => {
  const authority = newAuthority();
  rememberNote(authority, { note: "alpha", scope: "global" });
  rememberNote(authority, { note: "beta", scope: "project" });

  const result = forgetNote(authority, "p1");
  assert.equal(result.status, "retired");
  assert.match(result.message, /beta/);
  assert.deepEqual(
    authority.listActive("project").map((r) => r.value),
    [],
  );
});

test("forgetNote retires a unique case-insensitive text match", () => {
  const authority = newAuthority();
  rememberNote(authority, { note: "Deploy runbook lives here", scope: "project" });
  rememberNote(authority, { note: "unrelated", scope: "global" });

  const result = forgetNote(authority, "DEPLOY RUNBOOK");
  assert.equal(result.status, "retired");
  assert.deepEqual(
    authority.listActive("project").map((r) => r.value),
    [],
  );
});

test("forgetNote refuses to retire when a text search matches more than one record", () => {
  const authority = newAuthority();
  rememberNote(authority, { note: "test command is npm test", scope: "project" });
  rememberNote(authority, { note: "test coverage is thin", scope: "project" });

  const result = forgetNote(authority, "test");
  assert.equal(result.status, "ambiguous");
  assert.match(result.message, /p1/);
  assert.match(result.message, /p2/);
  // Nothing retired.
  assert.equal(authority.listActive("project").length, 2);
});

test("forgetNote reports when nothing matches", () => {
  const authority = newAuthority();
  rememberNote(authority, { note: "solo", scope: "global" });

  assert.equal(forgetNote(authority, "g9").status, "none");
  assert.equal(forgetNote(authority, "nomatch").status, "none");
  assert.equal(authority.listActive("global").length, 1);
});

test("shouldShowNudge fires once for a long session that never used remember", () => {
  const base = { turnCount: 12, elapsedMs: 0, rememberUsed: false, nudgeShown: false };
  assert.equal(shouldShowNudge(base), true);
  assert.equal(shouldShowNudge({ ...base, elapsedMs: 20 * 60 * 1000, turnCount: 0 }), true);

  assert.equal(shouldShowNudge({ ...base, rememberUsed: true }), false);
  assert.equal(shouldShowNudge({ ...base, nudgeShown: true }), false);
  assert.equal(shouldShowNudge({ turnCount: 2, elapsedMs: 1000, rememberUsed: false, nudgeShown: false }), false);
});
