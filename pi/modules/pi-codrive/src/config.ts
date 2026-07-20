import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface CodriveExternalConfig {
  model?: string;
  thinking?: string;
}

/**
 * Fallback used when no external config file exists. Keep this in sync
 * with the user's actual model preference; it is only a last resort,
 * the external config file at defaultConfigPath() is the real source
 * of truth for delegation model defaults.
 */
export const DEFAULT_MODEL = "anthropic/claude-opus-4-8";

export function defaultConfigPath(): string {
  const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(configHome, "pi-codrive", "config.json");
}

/**
 * Load the user's external pi-codrive config (model/thinking defaults).
 *
 * A missing file is normal (first run, no preference set yet) and
 * resolves to the built-in default model. A present-but-malformed file
 * is a real misconfiguration and throws, so the caller can surface an
 * actionable diagnostic instead of silently spawning agents on the
 * wrong model.
 */
export function loadCodriveConfig(configPath: string = defaultConfigPath()): CodriveExternalConfig {
  if (!existsSync(configPath)) return { model: DEFAULT_MODEL };

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid pi-codrive config at ${configPath}: ${reason}`);
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`Invalid pi-codrive config at ${configPath}: expected a JSON object`);
  }

  const raw = parsed as Partial<CodriveExternalConfig>;
  const model = typeof raw.model === "string" && raw.model.length > 0 ? raw.model : DEFAULT_MODEL;
  const thinking = typeof raw.thinking === "string" ? raw.thinking : undefined;
  return thinking === undefined ? { model } : { model, thinking };
}
