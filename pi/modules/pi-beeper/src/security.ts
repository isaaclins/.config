import { randomBytes } from "node:crypto";
import { MAX_MESSAGE_CHARS, truncateMessageText } from "./truncate.ts";

export interface RedactionResult {
  text: string;
  count: number;
}

export interface SanitizedMessageText extends RedactionResult {
  truncated: boolean;
}

const ZERO_WIDTH_AND_BIDI = /[\u200B-\u200D\uFEFF\u061C\u202A-\u202E\u2066-\u2069]/gu;
const UNICODE_TAG_CHARACTERS = /[\u{E0000}-\u{E007F}]/gu;
const PI_MARKUP = /<\|[^|\r\n]{0,100}\|>|<\/?(?:turn(?:[_ -](?:start|end))?|tool(?:[_ -](?:result|call|use))?|assistant|user|system)[^>]*>|\[\[?\s*(?:turn|tool(?:[_ -]?(?:result|call|use))?)\s*(?:start|end)?\s*\]?\]|\b(?:turn_start|turn_end|tool_result|tool_call|tool_use)\b/giu;
const BEEPER_FENCE = /<\/?\s*(?:beeper\s*:\s*)?untrusted(?:\s+[^>]*)?>/giu;

export function createNonce(): string {
  return randomBytes(8).toString("hex");
}

/**
 * Normalize third-party text before any framing or redaction. Format controls
 * are removed rather than displayed because they can change visual direction
 * or hide an instruction from the model and the user.
 */
export function normalizeUntrustedText(value: string): string {
  return value
    .normalize("NFC")
    .replace(ZERO_WIDTH_AND_BIDI, "")
    .replace(UNICODE_TAG_CHARACTERS, "")
    .replace(/[ \t\f\v]{3,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function replaceMatches(
  value: string,
  pattern: RegExp,
  replacement: string | ((match: string, ...args: unknown[]) => string),
): RedactionResult {
  let count = 0;
  const text = value.replace(pattern, (...args) => {
    const match = String(args[0]);
    const replacementText = typeof replacement === "function"
      ? replacement(match, ...args.slice(1))
      : replacement;
    if (replacementText !== match) count += 1;
    return replacementText;
  });
  return { text, count };
}

function luhnValid(value: string): boolean {
  const digits = value.replace(/\D/g, "");
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let doubleDigit = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);
    if (doubleDigit) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    doubleDigit = !doubleDigit;
  }
  return sum % 10 === 0;
}

/**
 * Redact secrets commonly pasted into chats. The broad numeric rule is
 * intentionally conservative: a short code is safer out of model context
 * than in it. Each replacement contributes one count for the caller.
 */
export function redactMessageSecrets(value: string, enabled = true): RedactionResult {
  if (!enabled) return { text: value, count: 0 };

  let text = value;
  let count = 0;

  const password = replaceMatches(text, /\bpassword\s*:\s*[^\s,;]+/giu, (match: string) => {
    const prefix = match.slice(0, match.indexOf(":") + 1);
    return `${prefix} [redacted:password]`;
  });
  text = password.text;
  count += password.count;

  const recovery = replaceMatches(
    text,
    /\b(?:recovery|backup|emergency)\s+(?:codes?|keys?)\s*:\s*[^\n]*(?:\n[ \t]*[A-Z0-9][A-Z0-9-]{3,}){0,10}/giu,
    (match: string) => {
      const separator = match.indexOf(":");
      return `${match.slice(0, separator + 1)} [redacted:recovery-codes]`;
    },
  );
  text = recovery.text;
  count += recovery.count;

  const card = replaceMatches(
    text,
    /(?<!\d)(?:\d[ -]?){13,19}(?!\d)/gu,
    (match: string) => (luhnValid(match) ? "[redacted:card]" : match),
  );
  text = card.text;
  count += card.count;

  const labeledCode = replaceMatches(
    text,
    /\b(?:otp|one[- ]time|verification|security|passcode|confirmation|authentication|login)\b[^\n]{0,48}?\b\d{4,8}\b/giu,
    (match: string) => match.replace(/\b\d{4,8}\b(?!.*\b\d{4,8}\b)/u, "[redacted:otp]"),
  );
  text = labeledCode.text;
  count += labeledCode.count;

  const bareCode = replaceMatches(text, /(?<![\d\w])\d{6,8}(?![\d\w])/gu, "[redacted:otp]");
  text = bareCode.text;
  count += bareCode.count;

  return { text, count };
}

/**
 * Remove syntax that can impersonate an agent protocol before putting text
 * inside a nonce fence. The replacement is deliberately empty so a message
 * cannot learn or close the current fence by echoing it.
 */
export function stripInjectionMarkers(value: string, nonce: string): string {
  let text = value;
  if (nonce) text = text.split(nonce).join("");
  text = text.replace(BEEPER_FENCE, "");
  text = text.replace(/\b(?:beeper\s*:\s*)?untrusted\b/giu, "");
  return text.replace(PI_MARKUP, "");
}

export function sanitizeMessageText(
  value: string,
  nonce: string,
  options: { redactSecrets?: boolean; maxChars?: number } = {},
): SanitizedMessageText {
  const normalized = normalizeUntrustedText(stripInjectionMarkers(value, nonce));
  const redacted = redactMessageSecrets(normalized, options.redactSecrets ?? true);
  const truncated = truncateMessageText(redacted.text, options.maxChars ?? MAX_MESSAGE_CHARS);
  return {
    text: truncated.text,
    count: redacted.count,
    truncated: truncated.truncated,
  };
}

export function frameUntrustedText(text: string, nonce: string): string {
  return `<beeper:untrusted ${nonce}>${text}</beeper:untrusted ${nonce}>`;
}

export function redactTokenText(value: string, token: string | undefined): string {
  let text = value
    .replace(/authorization\s*:\s*bearer\s+[^\s,;}]+/giu, "Authorization: Bearer [redacted]")
    .replace(/bearer\s+[^\s,;}]+/giu, "Bearer [redacted]");
  if (token) text = text.split(token).join("[redacted:beeper-token]");
  return text;
}

export function containsProtocolMarker(value: string, nonce: string): boolean {
  return Boolean(
    value.includes(nonce) ||
      /beeper\s*:\s*untrusted|<\|[^|]+\|>|tool[_ -]?result|turn[_ -]?(?:start|end)/iu.test(value),
  );
}
