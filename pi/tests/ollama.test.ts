import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_BASE_URL,
  DEFAULT_CONTEXT_CEILING,
  buildModel,
  buildModels,
  buildProvider,
  canDriveAgent,
  maxContextFrom,
  resolveBaseUrl,
  resolveContextCeiling,
  tagId,
} from "../lib/ollama.ts";

const toolCapable = { name: "qwen2.5:7b", capabilities: ["completion", "tools"] };
const thinker = { name: "gemma4:12b-mlx", capabilities: ["completion", "tools", "thinking"] };
const chatOnly = { name: "gemma3n:e2b", capabilities: ["completion"] };

test("only tool-capable models are offered", () => {
  // pi cannot run a single turn without tool calls, so a chat-only model would
  // be a trap: selectable, then broken on the first thing the agent tries.
  assert.equal(canDriveAgent(toolCapable), true);
  assert.equal(canDriveAgent(thinker), true);
  assert.equal(canDriveAgent(chatOnly), false);
  assert.equal(canDriveAgent({ name: "mystery" }), false);
  assert.equal(buildModel(chatOnly), undefined);
});

test("capabilities decide reasoning and image input, rather than a guess", () => {
  assert.equal(buildModel(thinker)?.reasoning, true);
  assert.equal(buildModel(toolCapable)?.reasoning, false);
  assert.deepEqual(buildModel(toolCapable)?.input, ["text"]);
  assert.deepEqual(
    buildModel({ name: "seer", capabilities: ["tools", "vision"] })?.input,
    ["text", "image"],
  );
});

test("the declared window never exceeds what the server will serve", () => {
  // gemma4:12b-mlx advertises 262144 and is loaded at 32768. Claiming the
  // model maximum would let pi fill a window Ollama silently truncates.
  const model = buildModel(thinker, { maxContext: 262144, ceiling: 32768 });
  assert.equal(model?.contextWindow, 32768);
});

test("a model smaller than the ceiling keeps its own smaller window", () => {
  const model = buildModel(toolCapable, { maxContext: 8192, ceiling: 32768 });
  assert.equal(model?.contextWindow, 8192, "the model maximum still wins when it is lower");
});

test("an unreadable model maximum falls back to the ceiling rather than dropping the model", () => {
  const model = buildModel(toolCapable, { maxContext: undefined, ceiling: 32768 });
  assert.equal(model?.contextWindow, 32768);
});

test("output tokens leave room for the conversation they answer", () => {
  const model = buildModel(toolCapable, { maxContext: 32768, ceiling: 32768 });
  assert.ok(model !== undefined);
  assert.ok(model.maxTokens < model.contextWindow, "a reply cannot consume the whole window");
  assert.ok(model.maxTokens >= 1024, "and must still be usable on a tiny window");

  const tiny = buildModel(toolCapable, { maxContext: 2048, ceiling: 2048 });
  assert.equal(tiny?.maxTokens, 1024, "the floor holds for very small windows");
});

test("local models are free, so usage accounting is not polluted", () => {
  assert.deepEqual(buildModel(toolCapable)?.cost, {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  });
});

test("compat says up front what Ollama does not really support", () => {
  // Ollama accepts the developer role and reasoning_effort and then ignores
  // both, which is worse than refusing them.
  assert.deepEqual(buildModel(thinker)?.compat, {
    supportsDeveloperRole: false,
    supportsReasoningEffort: false,
  });
});

test("the model maximum is read from the architecture-prefixed key", () => {
  assert.equal(
    maxContextFrom({ model_info: { "gemma4_unified.context_length": 262144 } }),
    262144,
  );
  assert.equal(maxContextFrom({ model_info: { "qwen2.embedding_length": 3584 } }), undefined);
  assert.equal(maxContextFrom({ model_info: { "x.context_length": 0 } }), undefined);
  assert.equal(maxContextFrom(undefined), undefined);
});

test("OLLAMA_HOST is honoured in each of the forms Ollama itself accepts", () => {
  assert.equal(resolveBaseUrl({}), DEFAULT_BASE_URL);
  assert.equal(resolveBaseUrl({ OLLAMA_HOST: "  " }), DEFAULT_BASE_URL);
  assert.equal(resolveBaseUrl({ OLLAMA_HOST: "box:11500" }), "http://box:11500");
  assert.equal(resolveBaseUrl({ OLLAMA_HOST: "box" }), "http://box:11434");
  assert.equal(resolveBaseUrl({ OLLAMA_HOST: ":11500" }), "http://127.0.0.1:11500");
});

test("a full URL is taken as given, so a proxy on 443 is not rewritten", () => {
  assert.equal(
    resolveBaseUrl({ OLLAMA_HOST: "https://ollama.example.com" }),
    "https://ollama.example.com",
    "forcing Ollama's default port here would break a reverse proxy",
  );
  assert.equal(resolveBaseUrl({ OLLAMA_HOST: "http://box:9999/" }), "http://box:9999");
});

test("a malformed OLLAMA_HOST falls back instead of throwing during startup", () => {
  assert.equal(resolveBaseUrl({ OLLAMA_HOST: "http://" }), DEFAULT_BASE_URL);
});

test("the ceiling follows Ollama's own variable, and ignores nonsense", () => {
  assert.equal(resolveContextCeiling({}), DEFAULT_CONTEXT_CEILING);
  assert.equal(resolveContextCeiling({ OLLAMA_CONTEXT_LENGTH: "262144" }), 262144);
  assert.equal(resolveContextCeiling({ OLLAMA_CONTEXT_LENGTH: "0" }), DEFAULT_CONTEXT_CEILING);
  assert.equal(resolveContextCeiling({ OLLAMA_CONTEXT_LENGTH: "-5" }), DEFAULT_CONTEXT_CEILING);
  assert.equal(resolveContextCeiling({ OLLAMA_CONTEXT_LENGTH: "lots" }), DEFAULT_CONTEXT_CEILING);
});

test("ids come from either field Ollama uses", () => {
  assert.equal(tagId({ model: "a:1" }), "a:1");
  assert.equal(tagId({ name: "b:2" }), "b:2");
  assert.equal(tagId({ model: "a:1", name: "b:2" }), "a:1");
  assert.equal(tagId({}), undefined);
  assert.equal(tagId({ name: "   " }), undefined);
});

test("a whole tag list becomes a stable, filtered model list", () => {
  const contexts = new Map<string, number | undefined>([
    ["gemma4:12b-mlx", 262144],
    ["qwen2.5:7b", 32768],
  ]);
  const models = buildModels([thinker, chatOnly, toolCapable], contexts, 32768);

  assert.deepEqual(
    models.map((model) => model.id),
    ["gemma4:12b-mlx", "qwen2.5:7b"],
    "chat-only is dropped and the order does not depend on disk order",
  );
  assert.equal(models[0]?.contextWindow, 32768, "clamped down from 262144");
});

test("the provider points at the OpenAI-compatible path with a placeholder key", () => {
  // Ollama ignores the key, but pi hides models with no auth configured, so an
  // empty one would make every discovered model invisible.
  const provider = buildProvider("http://127.0.0.1:11434", [buildModel(thinker)!]);
  assert.equal(provider.baseUrl, "http://127.0.0.1:11434/v1");
  assert.equal(provider.api, "openai-completions");
  assert.ok(provider.apiKey.length > 0);
});
