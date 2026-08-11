/**
 * Skills catalog compression.
 *
 * Pi injects every discovered skill into the system prompt as name +
 * full description + path. With a couple dozen skills installed that is
 * several thousand tokens in every request, and most of each description is
 * disambiguation prose the agent only needs once it is already considering
 * that skill.
 *
 * This rewrites the block into a one-line trigger index. The name and path
 * survive intact, so the agent can still read the SKILL.md to get the full
 * description whenever the short line looks relevant.
 */

const BLOCK_START = "<available_skills>";
const BLOCK_END = "</available_skills>";

export const DEFAULT_TRIGGER_CHARS = 130;

export interface SkillEntry {
  name: string;
  description: string;
  location: string;
}

function unescapeXml(value: string): string {
  return value
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}

export function parseSkillsBlock(block: string): SkillEntry[] {
  const entries: SkillEntry[] = [];
  const pattern =
    /<name>([\s\S]*?)<\/name>\s*<description>([\s\S]*?)<\/description>\s*<location>([\s\S]*?)<\/location>/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(block)) !== null) {
    entries.push({
      name: unescapeXml(match[1].trim()),
      description: unescapeXml(match[2].trim()),
      location: unescapeXml(match[3].trim()),
    });
  }
  return entries;
}

/**
 * Keep the part of a description that tells the agent when to reach for the
 * skill, and drop the disambiguation tail it only needs after opening the file.
 */
export function triggerLine(
  description: string,
  maxChars: number = DEFAULT_TRIGGER_CHARS,
): string {
  const flattened = description.replace(/\s+/g, " ").trim();
  const cutMarkers = [
    " NOT for",
    " Not for",
    " Do not trigger",
    " Do not use",
    " Scope is",
    " This is the primary skill",
    " Includes an optional",
    " Biases towards",
  ];
  let text = flattened;
  for (const marker of cutMarkers) {
    const index = text.indexOf(marker);
    if (index > 0) text = text.slice(0, index);
  }
  if (text.length <= maxChars) return text.trim();

  // Prefer a sentence boundary inside the budget, else a word boundary.
  const window = text.slice(0, maxChars + 1);
  const sentenceEnd = Math.max(window.lastIndexOf(". "), window.lastIndexOf("; "));
  if (sentenceEnd > maxChars * 0.5) return text.slice(0, sentenceEnd).trim();
  const wordEnd = window.lastIndexOf(" ");
  const cut = wordEnd > maxChars * 0.5 ? wordEnd : maxChars;
  return `${text.slice(0, cut).trim()}...`;
}

/** Drop repeats of the same skill name coming from symlinked skill roots. */
export function dedupeByName(entries: SkillEntry[]): SkillEntry[] {
  const seen = new Set<string>();
  const unique: SkillEntry[] = [];
  for (const entry of entries) {
    if (seen.has(entry.name)) continue;
    seen.add(entry.name);
    unique.push(entry);
  }
  return unique;
}

export function renderIndex(
  entries: SkillEntry[],
  maxChars: number = DEFAULT_TRIGGER_CHARS,
): string {
  const lines = [
    BLOCK_START,
    "One line per skill: name, when to use it, path. Descriptions are abridged;",
    "read the SKILL.md at the path for the full trigger and instructions before",
    "deciding a skill does not apply.",
  ];
  for (const entry of entries) {
    lines.push(`- ${entry.name}: ${triggerLine(entry.description, maxChars)} [${entry.location}]`);
  }
  lines.push(BLOCK_END);
  return lines.join("\n");
}

/**
 * Replace the skills block in a system prompt with the compact index.
 * Returns undefined when there is nothing to rewrite or nothing to save.
 */
export function compactSkillsInPrompt(
  systemPrompt: string,
  maxChars: number = DEFAULT_TRIGGER_CHARS,
): string | undefined {
  const start = systemPrompt.indexOf(BLOCK_START);
  const end = systemPrompt.indexOf(BLOCK_END);
  if (start === -1 || end === -1 || end < start) return undefined;

  const block = systemPrompt.slice(start, end + BLOCK_END.length);
  const entries = dedupeByName(parseSkillsBlock(block));
  if (entries.length === 0) return undefined;

  const replacement = renderIndex(entries, maxChars);
  if (replacement.length >= block.length) return undefined;
  return systemPrompt.slice(0, start) + replacement + systemPrompt.slice(end + BLOCK_END.length);
}
