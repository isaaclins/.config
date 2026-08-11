import assert from "node:assert/strict";
import { test } from "node:test";
import {
  compactSkillsInPrompt,
  dedupeByName,
  parseSkillsBlock,
  renderIndex,
  triggerLine,
} from "../src/skills-index.ts";

const BLOCK = `<available_skills>
  <skill>
    <name>xlsx</name>
    <description>Use this skill any time a spreadsheet file is the primary input or output. This means any task where the user wants to: open, read, edit, or fix an existing .xlsx file. Scope is when the deliverable itself is a spreadsheet file.</description>
    <location>/skills/xlsx/SKILL.md</location>
  </skill>
  <skill>
    <name>tdd</name>
    <description>Drive feature work with a strict red-green-refactor loop. Use when the user wants test-first development. Do not write all tests up front.</description>
    <location>/skills/tdd/SKILL.md</location>
  </skill>
</available_skills>`;

const PROMPT = `You are an agent.\n\n${BLOCK}\n\nCurrent date: 2026-08-07`;

test("parses name, description, and location for every skill", () => {
  const entries = parseSkillsBlock(BLOCK);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].name, "xlsx");
  assert.equal(entries[1].location, "/skills/tdd/SKILL.md");
});

test("trigger line drops scope and negative tails", () => {
  const line = triggerLine("Do a thing. Use when X happens. Scope is only Y.");
  assert.ok(!line.includes("Scope is"));
  assert.ok(line.includes("Use when X happens"));
});

test("trigger line respects the char budget and stays on a boundary", () => {
  const long = `${"word ".repeat(80)}end`;
  const line = triggerLine(long, 60);
  assert.ok(line.length <= 64, line.length.toString());
  assert.ok(!line.includes("wor..."));
});

test("duplicate skill names from symlinked roots collapse", () => {
  const entries = dedupeByName([
    { name: "tdd", description: "a", location: "/one" },
    { name: "tdd", description: "a", location: "/two" },
  ]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].location, "/one");
});

test("index keeps every name and path so skills stay loadable", () => {
  const entries = parseSkillsBlock(BLOCK);
  const index = renderIndex(entries);
  for (const entry of entries) {
    assert.ok(index.includes(entry.name));
    assert.ok(index.includes(entry.location));
  }
});

test("prompt rewrite replaces only the skills block and shrinks it", () => {
  const compacted = compactSkillsInPrompt(PROMPT);
  assert.ok(compacted);
  assert.ok(compacted.startsWith("You are an agent."));
  assert.ok(compacted.endsWith("Current date: 2026-08-07"));
  assert.ok(compacted.length < PROMPT.length);
  assert.ok(!compacted.includes("<description>"));
});

test("prompt without a skills block is left alone", () => {
  assert.equal(compactSkillsInPrompt("no skills here"), undefined);
});
