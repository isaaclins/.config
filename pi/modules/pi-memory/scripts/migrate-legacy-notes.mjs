#!/usr/bin/env node
// One-time, MANUALLY invoked migration for legacy dated-journal notes.
//
// This script is never imported or run by the extension. Run it yourself:
//
//   node scripts/migrate-legacy-notes.mjs <legacy-file> \
//     --scope=<global|project> --kind=<preference|fact> --store=<jsonl-path>
//
// Each `- [YYYY-MM-DD] text` line in <legacy-file> becomes an append-only
// record in <jsonl-path>, with createdAt set to midnight UTC on that date
// and the dated prefix stripped from the value.

import { migrateLegacyNotes } from "../src/migrate.ts";

function parseArgs(argv) {
  const positionals = [];
  const flags = {};
  for (const arg of argv) {
    const match = /^--([^=]+)=(.*)$/.exec(arg);
    if (match) flags[match[1]] = match[2];
    else positionals.push(arg);
  }
  return { positionals, flags };
}

function fail(message) {
  console.error(message);
  console.error(
    "Usage: node scripts/migrate-legacy-notes.mjs <legacy-file> " +
      "--scope=<global|project> --kind=<preference|fact> --store=<jsonl-path>",
  );
  process.exit(1);
}

function main() {
  const { positionals, flags } = parseArgs(process.argv.slice(2));
  const legacyPath = positionals[0];
  const { scope, kind, store } = flags;

  if (!legacyPath) fail("Missing <legacy-file> argument.");
  if (scope !== "global" && scope !== "project") fail("--scope must be 'global' or 'project'.");
  if (kind !== "preference" && kind !== "fact") fail("--kind must be 'preference' or 'fact'.");
  if (!store) fail("Missing --store=<jsonl-path>.");

  const summary = migrateLegacyNotes({ legacyPath, scope, kind, storePath: store });
  console.log(`Imported ${summary.imported} record(s) into ${store} (scope=${scope}, kind=${kind}).`);
}

main();
