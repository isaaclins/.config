/**
 * ~/.config/prettier/global.prettier.config.js
 *
 * This file has two responsibilities:
 * 1) Standard Prettier configuration (enumerable keys) for filetypes Prettier supports.
 * 2) Non-enumerable `__codexFormatter` metadata consumed by fish wrapper custom text rules.
 *
 * Why non-enumerable:
 * - Prettier warns on unknown top-level options.
 * - Defining custom metadata as non-enumerable keeps Prettier clean while allowing custom logic.
 */

/** @type {import("prettier").Config} */
const config = {
  semi: true,
  singleQuote: false,
  printWidth: 100,
  tabWidth: 2,
  trailingComma: "all",

  overrides: [
    {
      files: "*.md",
      options: {
        proseWrap: "always",
        printWidth: 80,
      },
    },
    {
      files: "*.mdx",
      options: {
        proseWrap: "always",
      },
    },
    {
      files: ["*.yml", "*.yaml"],
      options: {
        tabWidth: 2,
      },
    },
    {
      files: "*.json",
      options: {
        printWidth: 80,
      },
    },
  ],
};

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

/** @type {CodexFormatterConfig} */
const codexFormatter = {
  version: 1,
  output: {
    // `prettier-write` means: <file> <N>ms + optional `(unchanged)` and [error] blocks.
    style: "prettier-write",
    // auto: use ANSI colors on tty unless disabled by NO_COLOR.
    colors: "auto",
  },
  rules: [
    {
      name: "isaacfile-default",
      include: ["**/*.isaacfile"],
      exclude: ["**/.git/**", "**/node_modules/**"],
      transforms: [
        // Normalize newline style first so downstream regexes behave predictably.
        { op: "normalizeNewlines" },
        // Remove trailing spaces/tabs.
        { op: "regexReplace", find: "[ \\t]+$", replace: "", flags: "gm" },
        // Collapse 3+ consecutive blank lines to 2.
        { op: "regexReplace", find: "\\n{3,}", replace: "\n\n", flags: "g" },
        // Maintain exactly one trailing newline at EOF.
        { op: "ensureFinalNewline" },
      ],
      fixTransforms: [
        // Conservative bracket auto-close; only appends at EOF and only for small mismatch counts.
        { op: "closeOpenDelimiters", pairs: ["{}", "[]", "()"], maxAutoClose: 1 },
        // Conservative semicolon fixer for non-comment, non-empty lines.
        {
          op: "appendSemicolons",
          linePattern: "^(?!\\s*(#|//|/\\*|\\*|$)).+",
          skipIfEndsWith: "[;{}:,)]$",
        },
      ],
    },
    {
      name: "fish-default",
      include: ["**/*.fish"],
      exclude: ["**/.git/**", "**/node_modules/**"],
      transforms: [
        { op: "normalizeNewlines" },
        { op: "regexReplace", find: "[ \\t]+$", replace: "", flags: "gm" },
        { op: "ensureFinalNewline" },
      ],
    },
    {
      name: "shell-default",
      include: ["**/*.sh"],
      exclude: ["**/.git/**", "**/node_modules/**"],
      transforms: [
        { op: "normalizeNewlines" },
        { op: "regexReplace", find: "[ \\t]+$", replace: "", flags: "gm" },
        { op: "ensureFinalNewline" },
      ],
    },
    {
      name: "text-default",
      include: ["**/*.txt"],
      exclude: ["**/.git/**", "**/node_modules/**"],
      transforms: [
        { op: "normalizeNewlines" },
        { op: "regexReplace", find: "[ \\t]+$", replace: "", flags: "gm" },
        { op: "ensureFinalNewline" },
      ],
    },
    {
      name: "lua-default",
      include: ["**/*.lua"],
      exclude: ["**/.git/**", "**/node_modules/**"],
      transforms: [
        { op: "normalizeNewlines" },
        { op: "regexReplace", find: "[ \\t]+$", replace: "", flags: "gm" },
        { op: "ensureFinalNewline" },
      ],
      fixTransforms: [
        { op: "closeOpenDelimiters", pairs: ["{}", "[]", "()"], maxAutoClose: 1 },
      ],
    },

    // Example for adding your own filetype quickly:
    // {
    //   name: "my-custom-type",
    //   include: ["**/*.myext"],
    //   transforms: [
    //     { op: "normalizeNewlines" },
    //     { op: "regexReplace", find: "\\t", replace: "  ", flags: "g" },
    //     { op: "ensureFinalNewline" },
    //   ],
    //   fixTransforms: [
    //     { op: "closeOpenDelimiters", pairs: ["{}", "[]", "()"], maxAutoClose: 1 },
    //   ],
    // },
  ],
};

Object.defineProperty(config, "__codexFormatter", {
  value: codexFormatter,
  enumerable: false,
  writable: false,
  configurable: false,
});

module.exports = config;
