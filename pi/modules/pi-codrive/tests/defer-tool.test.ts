import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

/**
 * The permanent form of the deferral repro: load the extension with a fake
 * ExtensionAPI and prove that some registered tool can express "come back to
 * this later" without spending a subagent on a sleep.
 */

// The extension returns early in child mode, and these vars leak in when the
// test itself runs under a codrive child. Clear them before loading it.
for (const key of [
  "PI_CODRIVE_SOCKET",
  "PI_CODRIVE_NONCE",
  "PI_CODRIVE_SESSION_ID",
  "PI_CODRIVE_CHILD_ID",
  "PI_CODRIVE_CHILD",
  "PI_SPAWN_NOTIFY_FILE",
  "PI_SPAWN_AGENT_REPORT_FILE",
  "TMUX_PANE",
]) {
  delete process.env[key];
}
process.env.XDG_RUNTIME_DIR = mkdtempSync(join(tmpdir(), "pi-codrive-defer-rt-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "pi-codrive-defer-cfg-"));

const { default: piCodrive } = await import("../extension.ts");

interface ToolLike {
  name: string;
  description: string;
  promptGuidelines?: string[];
  parameters: { properties?: Record<string, unknown> };
  execute(
    id: string,
    params: Record<string, unknown>,
    signal?: unknown,
    onUpdate?: unknown,
    ctx?: unknown,
  ): Promise<{ content: Array<{ type: string; text: string }>; details?: unknown }>;
}

interface Harness {
  tools: Map<string, ToolLike>;
  handlers: Map<string, Array<(event: unknown, ctx: unknown) => Promise<void>>>;
  sent: Array<{ message: unknown; options: unknown }>;
}

function loadExtension(): Harness {
  const tools = new Map<string, ToolLike>();
  const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => Promise<void>>>();
  const sent: Array<{ message: unknown; options: unknown }> = [];
  const pi = {
    on(event: string, handler: (event: unknown, ctx: unknown) => Promise<void>) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    events: { on: () => () => {} },
    registerCommand() {},
    registerTool(tool: ToolLike) {
      tools.set(tool.name, tool);
    },
    sendMessage(message: unknown, options: unknown) {
      sent.push({ message, options });
    },
    appendEntry() {},
  };
  piCodrive(pi as never);
  return { tools, handlers, sent };
}

const TRIGGER_FIELDS =
  /^(delay|delayMs|after|afterMs|at|when|until|condition|check|every|pollMs)$/i;

test("a registered tool accepts a trigger parameter, so deferral no longer needs a subagent", () => {
  const { tools } = loadExtension();

  const candidates = [...tools.values()].filter((tool) =>
    Object.keys(tool.parameters.properties ?? {}).some((key) => TRIGGER_FIELDS.test(key)),
  );

  assert.deepEqual(
    candidates.map((tool) => tool.name),
    ["defer"],
    "exactly one tool owns deferral",
  );
});

test("defer exposes create, list, and cancel with both trigger shapes", () => {
  const { tools } = loadExtension();
  const defer = tools.get("defer");
  assert.ok(defer, "defer is registered");

  const properties = Object.keys(defer.parameters.properties ?? {}).sort();
  assert.deepEqual(properties, [
    "action",
    "check",
    "delayMs",
    "delivery",
    "id",
    "note",
    "pollMs",
    "timeoutMs",
  ]);
  // The description has to steer a future agent away from the expensive path.
  assert.match(defer.description, /no model context, no tmux pane, and no delegation slot|costs no model context/i);
  assert.ok(
    (defer.promptGuidelines ?? []).some((line) => /spawn_agent/.test(line)),
    "prompt guidelines contrast defer with spawn_agent",
  );
});

test("spawn_agent exposes an explicit readOnly setting for safe investigations", () => {
  const { tools } = loadExtension();
  const spawn = tools.get("spawn_agent");
  assert.ok(spawn, "spawn_agent is registered");

  assert.ok(
    Object.hasOwn(spawn.parameters.properties ?? {}, "readOnly"),
    "the orchestrator can require a read-only child",
  );
  assert.ok(
    (spawn.promptGuidelines ?? []).some((line) => /readOnly: true/.test(line)),
    "the model-facing guidance explains when to require read-only mode",
  );
});

test("defer refuses to arm anything before the session is initialized", async () => {
  const { tools } = loadExtension();
  const defer = tools.get("defer");
  assert.ok(defer);

  await assert.rejects(
    defer.execute("call-0", { action: "create", delayMs: 1000, note: "too early" }),
    /not initialized/,
  );
});

test("after session_start the defer tool arms, lists, and cancels against a live registry", async (t) => {
  const { tools, handlers } = loadExtension();
  const defer = tools.get("defer");
  assert.ok(defer);

  const projectRoot = mkdtempSync(join(tmpdir(), "pi-codrive-defer-project-"));
  const ctx = { cwd: projectRoot, ui: { notify() {} } };
  const start = handlers.get("session_start")?.[0];
  const shutdown = handlers.get("session_shutdown")?.[0];
  assert.ok(start && shutdown, "session lifecycle handlers are registered");
  t.after(async () => {
    await shutdown({ type: "session_shutdown", reason: "quit" }, ctx);
  });

  await start({ type: "session_start", reason: "startup" }, ctx);

  const created = await defer.execute("call-1", {
    action: "create",
    check: "test -f /tmp/pi-codrive-defer-marker",
    pollMs: 15000,
    timeoutMs: 600000,
    note: "the marker appeared",
  });
  const details = created.details as { id: string; kind: string; delivery: string };
  assert.equal(details.kind, "when");
  assert.equal(details.delivery, "interrupt", "interrupt is the default delivery");

  const listed = await defer.execute("call-2", { action: "list" });
  assert.match(listed.content[0].text, new RegExp(details.id));
  assert.match(listed.content[0].text, /the marker appeared/);

  const cancelled = await defer.execute("call-3", { action: "cancel", id: details.id });
  assert.match(cancelled.content[0].text, /will not fire/);

  await assert.rejects(
    defer.execute("call-4", { action: "cancel", id: details.id }),
    /No pending deferred trigger/,
  );

  const empty = await defer.execute("call-5", { action: "list" });
  assert.match(empty.content[0].text, /no pending deferred triggers/);
});
