/**
 * Ollama model discovery, kept free of the network and of the Pi runtime so
 * the translation rules are unit-testable.
 *
 * Ollama serves an OpenAI compatible API on /v1, which pi drives directly with
 * api "openai-completions". What Ollama does not do is describe its models in
 * pi's vocabulary, so the interesting part is the translation:
 *
 * - /api/tags already reports per-model capabilities, so tool support,
 *   thinking, and vision are read rather than guessed.
 * - A model that cannot call tools cannot drive this agent at all, so it is
 *   left out rather than offered and allowed to fail on its first turn.
 * - Context is the subtle one. A model's own maximum is not what the server
 *   serves. Ollama picks num_ctx from available VRAM (4k/32k/256k) unless
 *   OLLAMA_CONTEXT_LENGTH overrides it, so gemma4:12b-mlx advertises 262144
 *   and is actually loaded at 32768 here. Declaring the model maximum would
 *   let pi fill a window Ollama silently truncates, which is the worst kind of
 *   failure for a coding agent: it looks like the model forgot rather than
 *   like a misconfiguration. The declared window is therefore the smaller of
 *   the model maximum and what the server will actually serve.
 */

export const DEFAULT_BASE_URL = "http://127.0.0.1:11434";

/**
 * What Ollama serves when VRAM lands in the middle tier, which is the case on
 * this machine. Only a floor for guessing: OLLAMA_CONTEXT_LENGTH wins when set,
 * and a model whose own maximum is smaller still wins over both.
 */
export const DEFAULT_CONTEXT_CEILING = 32768;

/** Discovery is local and fast, and must never hold up pi's startup. */
export const DISCOVERY_TIMEOUT_MS = 2000;

/** Ollama ignores the key, but pi hides models that have no auth configured. */
export const PLACEHOLDER_API_KEY = "ollama";

export interface OllamaTag {
  name?: string;
  model?: string;
  capabilities?: string[];
}

export interface OllamaShow {
  model_info?: Record<string, unknown>;
}

export interface OllamaModelConfig {
  id: string;
  name: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
  compat: { supportsDeveloperRole: boolean; supportsReasoningEffort: boolean };
}

export interface OllamaProviderConfig {
  name: string;
  baseUrl: string;
  apiKey: string;
  api: "openai-completions";
  models: OllamaModelConfig[];
}

type Env = Record<string, string | undefined>;

/**
 * Honour Ollama's own OLLAMA_HOST rather than inventing a second setting, so
 * a remote or relocated server is already configured once it is configured for
 * the ollama CLI. Accepts "host:port", "host", ":port", and full URLs.
 */
export function resolveBaseUrl(env: Env = process.env): string {
  const raw = env.OLLAMA_HOST?.trim();
  if (!raw) return DEFAULT_BASE_URL;

  // A full URL is taken as given: a reverse proxy on 443 must not be rewritten
  // to Ollama's default port.
  if (/^https?:\/\//i.test(raw)) {
    try {
      return new URL(raw).origin;
    } catch {
      return DEFAULT_BASE_URL;
    }
  }

  try {
    const url = new URL(`http://${raw.startsWith(":") ? `127.0.0.1${raw}` : raw}`);
    if (!url.port) url.port = "11434";
    return url.origin;
  } catch {
    return DEFAULT_BASE_URL;
  }
}

/**
 * The ceiling pi is willing to claim. Reusing Ollama's own variable keeps the
 * declared window and the served window in step: raising one raises the other.
 */
export function resolveContextCeiling(env: Env = process.env): number {
  const raw = env.OLLAMA_CONTEXT_LENGTH?.trim();
  if (!raw) return DEFAULT_CONTEXT_CEILING;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) return DEFAULT_CONTEXT_CEILING;
  return parsed;
}

/** The id Ollama expects back, e.g. "gemma4:12b-mlx". */
export function tagId(tag: OllamaTag): string | undefined {
  const id = (tag.model ?? tag.name)?.trim();
  return id ? id : undefined;
}

/**
 * pi is a tool-calling agent: a model without tool support cannot run a single
 * turn of it, so offering one would only produce a confusing failure later.
 */
export function canDriveAgent(tag: OllamaTag): boolean {
  return (tag.capabilities ?? []).includes("tools");
}

/** /api/show reports the model maximum under "<architecture>.context_length". */
export function maxContextFrom(show: OllamaShow | undefined): number | undefined {
  const info = show?.model_info;
  if (!info) return undefined;
  for (const [key, value] of Object.entries(info)) {
    if (!key.endsWith(".context_length")) continue;
    if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  }
  return undefined;
}

/**
 * Translate one tag into a pi model. Returns undefined for anything pi could
 * not actually run, so callers can map and filter in one pass.
 */
export function buildModel(
  tag: OllamaTag,
  options: { maxContext?: number; ceiling?: number } = {},
): OllamaModelConfig | undefined {
  const id = tagId(tag);
  if (!id || !canDriveAgent(tag)) return undefined;

  const capabilities = tag.capabilities ?? [];
  const ceiling = options.ceiling ?? DEFAULT_CONTEXT_CEILING;
  const contextWindow =
    options.maxContext && options.maxContext > 0
      ? Math.min(options.maxContext, ceiling)
      : ceiling;

  return {
    id,
    name: id,
    reasoning: capabilities.includes("thinking"),
    input: capabilities.includes("vision") ? ["text", "image"] : ["text"],
    // Local inference is free, and reporting a fake price would poison the
    // usage figures that the real providers report honestly.
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    // Leave room for the conversation: a reply that may consume the whole
    // window cannot coexist with the context it is replying to.
    maxTokens: Math.max(1024, Math.floor(contextWindow / 4)),
    compat: {
      // Ollama accepts the developer role but does nothing useful with it, and
      // reasoning_effort is accepted and ignored. Saying so up front keeps pi
      // from shaping requests around support that is not really there.
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
    },
  };
}

export function buildProvider(
  baseUrl: string,
  models: OllamaModelConfig[],
): OllamaProviderConfig {
  return {
    name: "Ollama (local)",
    baseUrl: `${baseUrl}/v1`,
    apiKey: PLACEHOLDER_API_KEY,
    api: "openai-completions",
    models,
  };
}

/** Whole-list translation, sorted so the picker order does not depend on disk order. */
export function buildModels(
  tags: OllamaTag[],
  contexts: Map<string, number | undefined>,
  ceiling: number,
): OllamaModelConfig[] {
  return tags
    .map((tag) => {
      const id = tagId(tag);
      return buildModel(tag, { maxContext: id ? contexts.get(id) : undefined, ceiling });
    })
    .filter((model): model is OllamaModelConfig => model !== undefined)
    .sort((a, b) => a.id.localeCompare(b.id));
}
