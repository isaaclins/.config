import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  DISCOVERY_TIMEOUT_MS,
  buildModels,
  buildProvider,
  canDriveAgent,
  maxContextFrom,
  resolveBaseUrl,
  resolveContextCeiling,
  tagId,
  type OllamaShow,
  type OllamaTag,
} from "../lib/ollama.ts";

/**
 * Register every locally installed Ollama model that can actually drive pi.
 *
 * Discovery rather than a models.json block, because the point is "and the
 * other ones too": pulling a new model should make it selectable without
 * editing config. The factory is awaited before startup continues, so pi sees
 * the provider during interactive startup and in `pi --list-models`, and a
 * /reload re-runs it, which is how a freshly pulled model shows up.
 *
 * Ollama not running is the normal case for most sessions, not a failure, so a
 * refused connection or a timeout leaves the provider unregistered and says
 * nothing. Anything else is allowed to surface as an extension error, because
 * a server that answers with nonsense is a real problem worth reporting.
 */

async function getJson<T>(url: string): Promise<T | undefined> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });
    if (!response.ok) return undefined;
    return (await response.json()) as T;
  } catch {
    // Not running, not reachable, or too slow to be worth blocking startup on.
    return undefined;
  }
}

async function postJson<T>(url: string, body: unknown): Promise<T | undefined> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });
    if (!response.ok) return undefined;
    return (await response.json()) as T;
  } catch {
    return undefined;
  }
}

export default async function (pi: ExtensionAPI) {
  const baseUrl = resolveBaseUrl();

  const tags = await getJson<{ models?: OllamaTag[] }>(`${baseUrl}/api/tags`);
  const usable = (tags?.models ?? []).filter(canDriveAgent);
  if (usable.length === 0) return;

  // The model maximum only comes from /api/show, one call per model. They run
  // together and each one may fail on its own: a model whose ceiling cannot be
  // read still gets registered, just with the conservative window.
  const contexts = new Map<string, number | undefined>();
  await Promise.all(
    usable.map(async (tag) => {
      const id = tagId(tag);
      if (!id) return;
      const show = await postJson<OllamaShow>(`${baseUrl}/api/show`, { model: id });
      contexts.set(id, maxContextFrom(show));
    }),
  );

  const models = buildModels(usable, contexts, resolveContextCeiling());
  if (models.length === 0) return;

  pi.registerProvider("ollama", buildProvider(baseUrl, models));
}
