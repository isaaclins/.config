import { homedir, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { readFileSync } from "node:fs";

export type ThinkingLevel =
  "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
export interface CodriveConfig {
  piCommand: string;
  model: string | null;
  thinking: ThinkingLevel | null;
  tmux: {
    split: "horizontal" | "vertical";
    size: number | null;
    captureLines: number;
    roleOption: string;
  };
  notifications: {
    connectTimeoutMs: number;
    retryMs: number;
    retries: number;
    maxMessageBytes: number;
  };
  waitingWidget: { enabled: boolean; intervalMs: number };
}
export const DEFAULT_CONFIG: CodriveConfig = {
  piCommand: "pi",
  model: null,
  thinking: null,
  tmux: {
    split: "horizontal",
    size: null,
    captureLines: 200,
    roleOption: "@pi_codrive_role",
  },
  notifications: {
    connectTimeoutMs: 2000,
    retryMs: 150,
    retries: 3,
    maxMessageBytes: 512 * 1024,
  },
  waitingWidget: { enabled: true, intervalMs: 600 },
};

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("config must be a JSON object");
  return value as Record<string, unknown>;
}
function optionalString(value: unknown, name: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${name} must be a non-empty string or null`);
  return value;
}
function boolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean`);
  return value;
}
function integer(
  value: unknown,
  name: string,
  min: number,
  max: number,
): number {
  if (
    !Number.isInteger(value) ||
    (value as number) < min ||
    (value as number) > max
  )
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  return value as number;
}
export function validateConfig(raw: unknown): CodriveConfig {
  const root = object(raw);
  const tmux = root.tmux === undefined ? {} : object(root.tmux);
  const notifications =
    root.notifications === undefined ? {} : object(root.notifications);
  const waitingWidget =
    root.waitingWidget === undefined ? {} : object(root.waitingWidget);
  const thinking = optionalString(root.thinking, "thinking");
  if (
    thinking !== null &&
    !["off", "minimal", "low", "medium", "high", "xhigh"].includes(thinking)
  )
    throw new Error("thinking is invalid");
  const split = tmux.split ?? DEFAULT_CONFIG.tmux.split;
  if (split !== "horizontal" && split !== "vertical")
    throw new Error("tmux.split must be horizontal or vertical");
  const roleOption = tmux.roleOption ?? DEFAULT_CONFIG.tmux.roleOption;
  if (typeof roleOption !== "string" || !/^@[A-Za-z0-9_]+$/.test(roleOption))
    throw new Error("tmux.roleOption must match @name");
  const sizeValue = tmux.size;
  const size =
    sizeValue === undefined || sizeValue === null
      ? null
      : integer(sizeValue, "tmux.size", 1, 1000);
  return {
    piCommand:
      optionalString(root.piCommand, "piCommand") ?? DEFAULT_CONFIG.piCommand,
    model: optionalString(root.model, "model"),
    thinking: thinking as ThinkingLevel | null,
    tmux: {
      split,
      size,
      captureLines:
        tmux.captureLines === undefined
          ? DEFAULT_CONFIG.tmux.captureLines
          : integer(tmux.captureLines, "tmux.captureLines", 1, 2000),
      roleOption,
    },
    notifications: {
      connectTimeoutMs:
        notifications.connectTimeoutMs === undefined
          ? DEFAULT_CONFIG.notifications.connectTimeoutMs
          : integer(
              notifications.connectTimeoutMs,
              "notifications.connectTimeoutMs",
              100,
              30000,
            ),
      retryMs:
        notifications.retryMs === undefined
          ? DEFAULT_CONFIG.notifications.retryMs
          : integer(notifications.retryMs, "notifications.retryMs", 10, 10000),
      retries:
        notifications.retries === undefined
          ? DEFAULT_CONFIG.notifications.retries
          : integer(notifications.retries, "notifications.retries", 0, 20),
      maxMessageBytes:
        notifications.maxMessageBytes === undefined
          ? DEFAULT_CONFIG.notifications.maxMessageBytes
          : integer(
              notifications.maxMessageBytes,
              "notifications.maxMessageBytes",
              4096,
              4 * 1024 * 1024,
            ),
    },
    waitingWidget: {
      enabled:
        waitingWidget.enabled === undefined
          ? DEFAULT_CONFIG.waitingWidget.enabled
          : boolean(waitingWidget.enabled, "waitingWidget.enabled"),
      intervalMs:
        waitingWidget.intervalMs === undefined
          ? DEFAULT_CONFIG.waitingWidget.intervalMs
          : integer(
              waitingWidget.intervalMs,
              "waitingWidget.intervalMs",
              100,
              10000,
            ),
    },
  };
}
export function configPath(env = process.env): string {
  const base = env.XDG_CONFIG_HOME || join(homedir(), ".config");
  if (!isAbsolute(base)) throw new Error("XDG_CONFIG_HOME must be absolute");
  return join(base, "pi-codrive", "config.json");
}
export function loadConfig(env = process.env): CodriveConfig {
  const file = configPath(env);
  try {
    return validateConfig(JSON.parse(readFileSync(file, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return structuredClone(DEFAULT_CONFIG);
    throw new Error(
      `Invalid pi-codrive config at ${file}: ${(error as Error).message}`,
    );
  }
}
export function socketBase(env = process.env): string {
  return env.XDG_RUNTIME_DIR || tmpdir();
}
