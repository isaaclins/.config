import { readFileSync } from "node:fs";

import { MemoryAuthority } from "./memory-authority.ts";
import type { MemoryScope } from "./memory-authority.ts";

/**
 * One-time migration of legacy dated-journal notes into the governed store.
 *
 * Legacy format is one note per line: `- [YYYY-MM-DD] free text`. Each line
 * becomes an append-only record whose createdAt is midnight UTC on the
 * parsed date, with the dated prefix stripped from the value.
 *
 * This module is a plain library. The CLI wrapper in
 * scripts/migrate-legacy-notes.mjs is the only invocation path and must be
 * run manually; nothing here runs on import.
 */

export type MigrateKind = "preference" | "fact";

export interface MigrateOptions {
  legacyPath: string;
  scope: MemoryScope;
  kind: MigrateKind;
  storePath: string;
}

export interface MigrateSummary {
  imported: number;
}

export interface ParsedLegacyLine {
  date: string;
  value: string;
}

const LEGACY_LINE = /^- \[(\d{4}-\d{2}-\d{2})\]\s?(.*)$/;

export function parseLegacyLine(line: string): ParsedLegacyLine | undefined {
  const match = LEGACY_LINE.exec(line.trim());
  if (!match) return undefined;
  return { date: match[1], value: match[2].trim() };
}

function toIsoTimestamp(date: string): string {
  return `${date}T00:00:00.000Z`;
}

export function migrateLegacyNotes(options: MigrateOptions): MigrateSummary {
  const content = readFileSync(options.legacyPath, "utf8");
  const authority = new MemoryAuthority({
    globalPath: options.storePath,
    projectPath: options.storePath,
  });

  let imported = 0;
  for (const line of content.split("\n")) {
    const parsed = parseLegacyLine(line);
    if (!parsed || !parsed.value) continue;
    authority.appendNote({
      scope: options.scope,
      kind: options.kind,
      value: parsed.value,
      createdAt: toIsoTimestamp(parsed.date),
    });
    imported += 1;
  }

  return { imported };
}
