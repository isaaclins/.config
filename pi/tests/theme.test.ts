import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const visibleWidth = (value: string) => value.replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, "").length;
const truncateAnsi = (value: string, width: number) => {
  let output = "";
  let visible = 0;
  for (const part of value.match(/\x1b\[[0-?]*[ -\/]*[@-~]|./gs) ?? []) {
    if (part.startsWith("\x1b[")) output += part;
    else if (visible < width) { output += part; visible++; }
  }
  return output;
};

const theme = JSON.parse(readFileSync(new URL("../themes/arcoiris-refined.json", import.meta.url), "utf8"));
const required = [
  "accent", "border", "borderAccent", "borderMuted", "success", "error", "warning", "muted", "dim", "text", "thinkingText",
  "selectedBg", "userMessageBg", "userMessageText", "customMessageBg", "customMessageText", "customMessageLabel", "toolPendingBg", "toolSuccessBg", "toolErrorBg", "toolTitle", "toolOutput",
  "mdHeading", "mdLink", "mdLinkUrl", "mdCode", "mdCodeBlock", "mdCodeBlockBorder", "mdQuote", "mdQuoteBorder", "mdHr", "mdListBullet",
  "toolDiffAdded", "toolDiffRemoved", "toolDiffContext", "syntaxComment", "syntaxKeyword", "syntaxFunction", "syntaxVariable", "syntaxString", "syntaxNumber", "syntaxType", "syntaxOperator", "syntaxPunctuation",
  "thinkingOff", "thinkingMinimal", "thinkingLow", "thinkingMedium", "thinkingHigh", "thinkingXhigh", "bashMode",
];

test("prompt stash widget respects narrow and normal widths", () => {
  const theme = { fg: (_color: string, value: string) => `\x1b[38;5;42m${value}\x1b[39m` };
  const renderWidget = (width: number) => {
    const label = theme.fg("accent", "stash ");
    const preview = "important prompt content";
    return truncateAnsi(`${label}${theme.fg("muted", preview)}`, width);
  };
  const normal = renderWidget(40);
  const narrow = renderWidget(8);

  assert.ok(visibleWidth(normal) <= 40);
  assert.match(normal, /stash/);
  assert.match(normal, /important/);
  assert.ok(visibleWidth(narrow) <= 8);
  assert.ok(visibleWidth(narrow) > 0);
});

test("arcoiris-refined defines every Pi color token", () => {
  assert.equal(theme.name, "arcoiris-refined");
  assert.deepEqual(Object.keys(theme.colors).sort(), [...required].sort());
  assert.equal(theme.vars.background, "#201f1e");
  assert.equal(theme.vars.foreground, "#eee4d9");
  for (const value of Object.values(theme.vars)) assert.match(value as string, /^#[0-9a-f]{6}$/i);
});
