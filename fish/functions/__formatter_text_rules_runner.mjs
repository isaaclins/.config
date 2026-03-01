#!/usr/bin/env node

/**
 * ~/.config/fish/functions/__formatter_text_rules_runner.mjs
 *
 * Purpose:
 *   Execute config-driven, text-based transforms for arbitrary file types when the fish `prettier`
 *   wrapper is in global-fallback mode (no repo-local Prettier config).
 *
 * Architecture:
 *   1) Read candidate file list from stdin (newline-delimited paths).
 *   2) Load global Prettier config and extract non-enumerable `__codexFormatter` metadata.
 *   3) Validate schema defensively (fail fast on malformed config).
 *   4) Match candidates to rules using glob include/exclude patterns.
 *   5) Apply ordered transforms (and optional fixTransforms when `--fix=1`).
 *   6) Write changed files atomically and emit Prettier-style output lines.
 *   7) Emit `[error]` blocks with optional codeframes when per-file processing fails.
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";

/**
 * @typedef {{
 *   style: "prettier-write",
 *   colors: "auto" | "always" | "never"
 * }} CodexOutput
 *
 * @typedef {{
 *   op: "regexReplace",
 *   find: string,
 *   replace: string,
 *   flags?: string
 * } | {
 *   op: "ensureFinalNewline"
 * } | {
 *   op: "normalizeNewlines"
 * } | {
 *   op: "closeOpenDelimiters",
 *   pairs?: string[],
 *   maxAutoClose?: number
 * } | {
 *   op: "appendSemicolons",
 *   linePattern: string,
 *   skipIfEndsWith?: string
 * }} CodexTransform
 *
 * @typedef {{
 *   name: string,
 *   include: string[],
 *   exclude?: string[],
 *   transforms: CodexTransform[],
 *   fixTransforms?: CodexTransform[]
 * }} CodexRule
 *
 * @typedef {{
 *   version: 1,
 *   output: CodexOutput,
 *   rules: CodexRule[]
 * }} CodexFormatterConfig
 */

class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigError";
  }
}

class TransformError extends Error {
  /**
   * @param {string} message
   * @param {{line?: number, column?: number}} [meta]
   */
  constructor(message, meta = {}) {
    super(message);
    this.name = "TransformError";
    this.line = meta.line;
    this.column = meta.column;
  }
}

const ANSI = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  dim: "\x1b[2m",
};

/**
 * Parse simple `--key value` or `--key=value` CLI format used by the fish wrapper.
 * @param {string[]} argv
 */
function parseCli(argv) {
  /** @type {Record<string, string>} */
  const out = {};

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      continue;
    }

    const eqIndex = token.indexOf("=");
    if (eqIndex > -1) {
      const key = token.slice(0, eqIndex);
      const value = token.slice(eqIndex + 1);
      out[key] = value;
      continue;
    }

    const key = token;
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = "1";
    }
  }

  return out;
}

/**
 * Normalize path separators to POSIX style to make glob behavior deterministic.
 * @param {string} value
 */
function toPosixPath(value) {
  return value.split(path.sep).join("/");
}

/**
 * Convert a glob to a regex.
 * Supported tokens:
 *   - `*` => any chars except slash
 *   - `**` => any chars including slash
 *   - `?` => any single char except slash
 *
 * This intentionally does not implement brace expansion to keep behavior explicit.
 * @param {string} glob
 */
function globToRegex(glob) {
  const normalized = toPosixPath(glob).replace(/^\.\//, "");
  let body = "^";

  for (let i = 0; i < normalized.length; i += 1) {
    const char = normalized[i];

    if (char === "*") {
      const next = normalized[i + 1];
      if (next === "*") {
        const afterStarStar = normalized[i + 2];
        i += 1;
        if (afterStarStar === "/") {
          i += 1;
          body += "(?:.*\\/)?";
        } else {
          body += ".*";
        }
      } else {
        body += "[^/]*";
      }
      continue;
    }

    if (char === "?") {
      body += "[^/]";
      continue;
    }

    if (char === "/") {
      body += "\\/";
      continue;
    }

    if (/[\\^$.*+?()[\]{}|]/.test(char)) {
      body += `\\${char}`;
      continue;
    }

    body += char;
  }

  body += "$";
  return new RegExp(body);
}

/**
 * @param {"auto"|"always"|"never"} mode
 */
function shouldUseColor(mode) {
  if (mode === "always") {
    return true;
  }

  if (mode === "never") {
    return false;
  }

  const forced = process.env.FORCE_COLOR;
  const noColor = process.env.NO_COLOR;

  if (forced && forced !== "0") {
    return true;
  }

  if (noColor) {
    return false;
  }

  if (!process.stdout.isTTY) {
    return false;
  }

  if ((process.env.TERM || "").toLowerCase() === "dumb") {
    return false;
  }

  return true;
}

/**
 * @param {string} text
 * @param {"red"|"dim"} style
 * @param {boolean} enabled
 */
function colorize(text, style, enabled) {
  if (!enabled) {
    return text;
  }

  if (style === "red") {
    return `${ANSI.red}${text}${ANSI.reset}`;
  }

  return `${ANSI.dim}${text}${ANSI.reset}`;
}

/**
 * @param {unknown} value
 * @param {string} message
 */
function ensure(value, message) {
  if (!value) {
    throw new ConfigError(message);
  }
}

/**
 * Validate top-level schema and return normalized config.
 * @param {unknown} raw
 * @returns {CodexFormatterConfig}
 */
function validateFormatterConfig(raw) {
  ensure(raw && typeof raw === "object", "`__codexFormatter` must be an object.");

  /** @type {any} */
  const cfg = raw;

  ensure(cfg.version === 1, "`__codexFormatter.version` must be 1.");
  ensure(cfg.output && typeof cfg.output === "object", "`__codexFormatter.output` is required.");
  ensure(cfg.output.style === "prettier-write", "`output.style` must be `prettier-write`.");
  ensure(
    ["auto", "always", "never"].includes(cfg.output.colors),
    "`output.colors` must be auto|always|never.",
  );
  ensure(Array.isArray(cfg.rules), "`__codexFormatter.rules` must be an array.");

  for (const rule of cfg.rules) {
    ensure(rule && typeof rule === "object", "Each rule must be an object.");
    ensure(
      typeof rule.name === "string" && rule.name.length > 0,
      "Each rule must have non-empty `name`.",
    );
    ensure(
      Array.isArray(rule.include) && rule.include.length > 0,
      `Rule \`${rule.name}\` must define non-empty \`include\`.`,
    );
    ensure(
      Array.isArray(rule.transforms),
      `Rule \`${rule.name}\` must define \`transforms\` array.`,
    );

    if (rule.exclude !== undefined) {
      ensure(
        Array.isArray(rule.exclude),
        `Rule \`${rule.name}\`: \`exclude\` must be an array when present.`,
      );
    }

    if (rule.fixTransforms !== undefined) {
      ensure(
        Array.isArray(rule.fixTransforms),
        `Rule \`${rule.name}\`: \`fixTransforms\` must be an array when present.`,
      );
    }

    const allTransforms = [...rule.transforms, ...(rule.fixTransforms || [])];
    for (const transform of allTransforms) {
      ensure(
        transform && typeof transform === "object",
        `Rule \`${rule.name}\`: each transform must be an object.`,
      );
      ensure(
        typeof transform.op === "string",
        `Rule \`${rule.name}\`: each transform requires \`op\`.`,
      );

      if (transform.op === "regexReplace") {
        ensure(
          typeof transform.find === "string",
          `Rule \`${rule.name}\`: regexReplace requires string \`find\`.`,
        );
        ensure(
          typeof transform.replace === "string",
          `Rule \`${rule.name}\`: regexReplace requires string \`replace\`.`,
        );
        if (transform.flags !== undefined) {
          ensure(
            typeof transform.flags === "string",
            `Rule \`${rule.name}\`: regexReplace \`flags\` must be a string.`,
          );
        }
      } else if (transform.op === "appendSemicolons") {
        ensure(
          typeof transform.linePattern === "string",
          `Rule \`${rule.name}\`: appendSemicolons requires string \`linePattern\`.`,
        );
        if (transform.skipIfEndsWith !== undefined) {
          ensure(
            typeof transform.skipIfEndsWith === "string",
            `Rule \`${rule.name}\`: appendSemicolons \`skipIfEndsWith\` must be a string.`,
          );
        }
      } else if (transform.op === "closeOpenDelimiters") {
        if (transform.pairs !== undefined) {
          ensure(
            Array.isArray(transform.pairs),
            `Rule \`${rule.name}\`: closeOpenDelimiters \`pairs\` must be an array.`,
          );
        }
        if (transform.maxAutoClose !== undefined) {
          ensure(
            Number.isInteger(transform.maxAutoClose) && transform.maxAutoClose >= 0,
            `Rule \`${rule.name}\`: closeOpenDelimiters \`maxAutoClose\` must be integer >= 0.`,
          );
        }
      } else if (transform.op === "normalizeNewlines" || transform.op === "ensureFinalNewline") {
        // No extra validation needed.
      } else {
        throw new ConfigError(
          `Rule \`${rule.name}\`: unsupported transform op \`${transform.op}\`.`,
        );
      }
    }
  }

  return /** @type {CodexFormatterConfig} */ (cfg);
}

/**
 * Compile include/exclude globs once for efficient matching.
 * @param {CodexRule[]} rules
 */
function compileRules(rules) {
  return rules.map((rule) => ({
    ...rule,
    includeMatchers: rule.include.map(globToRegex),
    excludeMatchers: (rule.exclude || []).map(globToRegex),
  }));
}

/**
 * @param {ReturnType<typeof compileRules>[number]} compiledRule
 * @param {string} relPosixPath
 */
function ruleMatches(compiledRule, relPosixPath) {
  const included = compiledRule.includeMatchers.some((matcher) => matcher.test(relPosixPath));
  if (!included) {
    return false;
  }

  const excluded = compiledRule.excludeMatchers.some((matcher) => matcher.test(relPosixPath));
  return !excluded;
}

/**
 * Produce a compact codeframe around line/column if available.
 * @param {string} source
 * @param {number} line
 * @param {number} column
 * @param {boolean} useColor
 */
function buildCodeFrame(source, line, column, useColor) {
  const allLines = source.split("\n");
  if (line < 1 || line > allLines.length) {
    return [];
  }

  const startLine = Math.max(1, line - 1);
  const endLine = Math.min(allLines.length, line + 2);
  const numberWidth = String(endLine).length;
  const rows = [];

  for (let current = startLine; current <= endLine; current += 1) {
    const marker = current === line ? ">" : " ";
    const gutter = `${marker} ${String(current).padStart(numberWidth, " ")} |`;
    const styledGutter = colorize(gutter, "dim", useColor);
    rows.push(`${styledGutter} ${allLines[current - 1]}`);

    if (current === line) {
      const safeColumn = Math.max(1, column || 1);
      const caretSpacing = " ".repeat(safeColumn - 1);
      const caret = colorize("^", "red", useColor);
      const caretGutter = colorize(`${" ".repeat(numberWidth + 2)}|`, "dim", useColor);
      rows.push(`${caretGutter} ${caretSpacing}${caret}`);
    }
  }

  return rows;
}

/**
 * @param {string} filePath
 * @param {Error} error
 * @param {boolean} useColor
 * @param {string} [source]
 */
function printErrorBlock(filePath, error, useColor, source) {
  const errorTag = colorize("[error]", "red", useColor);
  const errorName = error.name || "Error";
  const message = error.message || "Unknown error";
  console.error(`${errorTag} ${filePath}: ${errorName}: ${message}`);

  const maybeLine = /** @type {any} */ (error).line;
  const maybeColumn = /** @type {any} */ (error).column;
  if (
    typeof maybeLine === "number" &&
    typeof maybeColumn === "number" &&
    typeof source === "string"
  ) {
    const codeFrameRows = buildCodeFrame(source, maybeLine, maybeColumn, useColor);
    for (const row of codeFrameRows) {
      console.error(`${errorTag} ${row}`);
    }
  }
}

/**
 * Apply a single transform operation.
 *
 * Safety model:
 *   - Transform ops are intentionally conservative and text-based.
 *   - Any malformed transform configuration fails fast with TransformError.
 *   - This function never swallows transform failures; caller decides aggregation behavior.
 *
 * @param {string} input
 * @param {CodexTransform} transform
 */
function applyTransform(input, transform) {
  if (transform.op === "regexReplace") {
    let matcher;
    try {
      matcher = new RegExp(transform.find, transform.flags || "g");
    } catch (error) {
      throw new TransformError(
        `Invalid regex in regexReplace: ${/** @type {Error} */ (error).message}`,
      );
    }

    return input.replace(matcher, transform.replace);
  }

  if (transform.op === "normalizeNewlines") {
    return input.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  }

  if (transform.op === "ensureFinalNewline") {
    const normalized = input.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const withoutTrailing = normalized.replace(/\n*$/g, "");
    return `${withoutTrailing}\n`;
  }

  if (transform.op === "closeOpenDelimiters") {
    return closeOpenDelimitersConservative(
      input,
      transform.pairs || ["{}", "[]", "()"],
      transform.maxAutoClose ?? 1,
    );
  }

  if (transform.op === "appendSemicolons") {
    return appendSemicolonsConservative(
      input,
      transform.linePattern,
      transform.skipIfEndsWith || "[;{}:,]$",
    );
  }

  throw new TransformError(`Unsupported transform op: ${/** @type {any} */ (transform).op}`);
}

/**
 * Conservative delimiter balancing:
 *   - Tracks unmatched open delimiters outside comments/strings.
 *   - Only appends missing closing delimiters at EOF.
 *   - Refuses to modify when unmatched count exceeds `maxAutoClose`.
 *
 * Failure behavior:
 *   - Invalid pair definitions throw TransformError.
 *   - Ambiguous nested mismatches are ignored (no aggressive rewrite).
 *
 * @param {string} input
 * @param {string[]} pairs
 * @param {number} maxAutoClose
 */
function closeOpenDelimitersConservative(input, pairs, maxAutoClose) {
  /** @type {Map<string,string>} */
  const openToClose = new Map();
  /** @type {Map<string,string>} */
  const closeToOpen = new Map();

  for (const pair of pairs) {
    if (typeof pair !== "string" || pair.length !== 2) {
      throw new TransformError(
        "closeOpenDelimiters requires pair strings of length 2 (e.g. '{}').",
      );
    }

    const open = pair[0];
    const close = pair[1];
    openToClose.set(open, close);
    closeToOpen.set(close, open);
  }

  /** @type {string[]} */
  const stack = [];

  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    const next = input[i + 1];

    if (inLineComment) {
      if (char === "\n") {
        inLineComment = false;
      }
      continue;
    }

    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }

    if (inSingle) {
      if (char === "\\") {
        i += 1;
        continue;
      }
      if (char === "'") {
        inSingle = false;
      }
      continue;
    }

    if (inDouble) {
      if (char === "\\") {
        i += 1;
        continue;
      }
      if (char === '"') {
        inDouble = false;
      }
      continue;
    }

    if (inTemplate) {
      if (char === "\\") {
        i += 1;
        continue;
      }
      if (char === "`") {
        inTemplate = false;
      }
      continue;
    }

    if (char === "/" && next === "/") {
      inLineComment = true;
      i += 1;
      continue;
    }

    if (char === "/" && next === "*") {
      inBlockComment = true;
      i += 1;
      continue;
    }

    if (char === "'") {
      inSingle = true;
      continue;
    }

    if (char === '"') {
      inDouble = true;
      continue;
    }

    if (char === "`") {
      inTemplate = true;
      continue;
    }

    if (openToClose.has(char)) {
      stack.push(char);
      continue;
    }

    if (closeToOpen.has(char)) {
      const expectedOpen = closeToOpen.get(char);
      const top = stack[stack.length - 1];
      if (top && top === expectedOpen) {
        stack.pop();
      }
    }
  }

  if (stack.length === 0) {
    return input;
  }

  if (stack.length > maxAutoClose) {
    return input;
  }

  const missingClosers = stack
    .slice()
    .reverse()
    .map((open) => openToClose.get(open))
    .filter(Boolean)
    .join("");

  return `${input}${missingClosers}`;
}

/**
 * Conservative semicolon appender:
 *   - Applies only to lines matching caller-provided linePattern.
 *   - Skips lines that are comments, blank, or already ending with skip pattern.
 *   - Avoids touching inline-comment lines to reduce accidental syntax corruption.
 *
 * Failure behavior:
 *   - Invalid regex configuration throws TransformError.
 *
 * @param {string} input
 * @param {string} linePattern
 * @param {string} skipIfEndsWith
 */
function appendSemicolonsConservative(input, linePattern, skipIfEndsWith) {
  let lineMatcher;
  let skipMatcher;

  try {
    lineMatcher = new RegExp(linePattern);
  } catch (error) {
    throw new TransformError(
      `Invalid regex for appendSemicolons.linePattern: ${/** @type {Error} */ (error).message}`,
    );
  }

  try {
    skipMatcher = new RegExp(skipIfEndsWith);
  } catch (error) {
    throw new TransformError(
      `Invalid regex for appendSemicolons.skipIfEndsWith: ${/** @type {Error} */ (error).message}`,
    );
  }

  const lines = input.split("\n");

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      continue;
    }

    if (/^(#|\/\/|\/\*|\*|\*\/)/.test(trimmed)) {
      continue;
    }

    if (line.includes("//") || line.includes("#")) {
      continue;
    }

    if (!lineMatcher.test(line)) {
      continue;
    }

    const trailingWhitespaceMatch = line.match(/[ \t]*$/);
    const trailingWhitespace = trailingWhitespaceMatch ? trailingWhitespaceMatch[0] : "";
    const core = line.slice(0, line.length - trailingWhitespace.length);

    if (!core) {
      continue;
    }

    if (skipMatcher.test(core)) {
      continue;
    }

    if (core.endsWith("\\")) {
      continue;
    }

    lines[i] = `${core};${trailingWhitespace}`;
  }

  return lines.join("\n");
}

/**
 * Atomically persist rewritten content.
 * @param {string} absolutePath
 * @param {string} nextContent
 * @param {number} mode
 */
async function writeFileAtomically(absolutePath, nextContent, mode) {
  const dir = path.dirname(absolutePath);
  const base = path.basename(absolutePath);
  const tempName = `.${base}.codex-tmp-${process.pid}-${Date.now()}`;
  const tempPath = path.join(dir, tempName);

  await fsp.writeFile(tempPath, nextContent, "utf8");
  await fsp.chmod(tempPath, mode);
  await fsp.rename(tempPath, absolutePath);
}

/**
 * @param {string} filePath
 * @param {number} elapsedMs
 * @param {boolean} changed
 * @param {boolean} useColor
 */
function printFileResult(filePath, elapsedMs, changed, useColor) {
  const safeMs = Math.max(1, Math.round(elapsedMs));
  if (changed) {
    console.log(`${filePath} ${safeMs}ms`);
    return;
  }

  const unchangedLabel = colorize("(unchanged)", "dim", useColor);
  console.log(`${filePath} ${safeMs}ms ${unchangedLabel}`);
}

async function main() {
  const args = parseCli(process.argv.slice(2));
  const configPath = args["--config"];
  const cwd = path.resolve(args["--cwd"] || process.cwd());
  const fixEnabled = args["--fix"] === "1" || args["--fix"] === "true";

  if (!configPath) {
    throw new ConfigError("Missing required --config argument.");
  }

  const absoluteConfigPath = path.resolve(cwd, configPath);
  const stdinPayload = fs.readFileSync(0, "utf8");
  const rawCandidates = stdinPayload
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const dedupedCandidates = [...new Set(rawCandidates)];

  const require = createRequire(import.meta.url);
  // Support both CJS export object and transpiled/default export object patterns.
  const loadedConfig = require(absoluteConfigPath);
  const prettierConfig =
    loadedConfig && typeof loadedConfig === "object" && "default" in loadedConfig
      ? loadedConfig.default
      : loadedConfig;

  const rawFormatterConfig = prettierConfig?.__codexFormatter;
  if (!rawFormatterConfig) {
    // Explicitly no custom rules configured: nothing to do, not an error.
    return;
  }

  const formatterConfig = validateFormatterConfig(rawFormatterConfig);
  const effectiveColorMode = /** @type {"auto"|"always"|"never"} */ (
    args["--color-mode"] || formatterConfig.output.colors || "auto"
  );
  const useColor = shouldUseColor(effectiveColorMode);

  const compiledRules = compileRules(formatterConfig.rules);

  /** @type {{absPath: string, relPath: string}[]} */
  const files = [];
  for (const candidate of dedupedCandidates) {
    const absolutePath = path.resolve(cwd, candidate);

    let stat;
    try {
      stat = await fsp.stat(absolutePath);
    } catch {
      continue;
    }

    if (!stat.isFile()) {
      continue;
    }

    const relPath = toPosixPath(path.relative(cwd, absolutePath) || path.basename(absolutePath));
    files.push({ absPath: absolutePath, relPath });
  }

  files.sort((a, b) => a.relPath.localeCompare(b.relPath));

  let hadFailures = false;

  for (const file of files) {
    const matchingRules = compiledRules.filter((rule) => ruleMatches(rule, file.relPath));
    if (matchingRules.length === 0) {
      continue;
    }

    const startedAt = performance.now();

    try {
      const initialStat = await fsp.stat(file.absPath);
      const originalContent = await fsp.readFile(file.absPath, "utf8");

      // Skip likely-binary files based on NUL byte presence to avoid corruption.
      if (originalContent.includes("\u0000")) {
        continue;
      }

      let nextContent = originalContent;
      for (const rule of matchingRules) {
        for (const transform of rule.transforms) {
          nextContent = applyTransform(nextContent, transform);
        }

        if (fixEnabled && Array.isArray(rule.fixTransforms)) {
          for (const transform of rule.fixTransforms) {
            nextContent = applyTransform(nextContent, transform);
          }
        }
      }

      const changed = nextContent !== originalContent;
      if (changed) {
        await writeFileAtomically(file.absPath, nextContent, initialStat.mode);
      }

      const elapsedMs = performance.now() - startedAt;
      printFileResult(file.relPath, elapsedMs, changed, useColor);
    } catch (error) {
      hadFailures = true;
      const runtimeError = /** @type {Error} */ (error);

      let sourceForFrame;
      try {
        sourceForFrame = await fsp.readFile(file.absPath, "utf8");
      } catch {
        sourceForFrame = undefined;
      }

      printErrorBlock(file.relPath, runtimeError, useColor, sourceForFrame);
    }
  }

  if (hadFailures) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  const runtimeError = /** @type {Error} */ (error);
  const mode = process.argv.includes("--color-mode")
    ? parseCli(process.argv.slice(2))["--color-mode"] || "auto"
    : "auto";
  const useColor = shouldUseColor(/** @type {"auto"|"always"|"never"} */ (mode));

  printErrorBlock("config", runtimeError, useColor);
  process.exit(1);
});
