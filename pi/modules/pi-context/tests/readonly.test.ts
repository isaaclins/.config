import assert from "node:assert/strict";
import test from "node:test";
import { registerReadonlyMode } from "../src/readonly.ts";

interface CommandLike {
  handler(args: string | undefined, ctx: any): Promise<void>;
}

type EventHandler = (event: any, ctx: any) => Promise<unknown> | unknown;

function loadExtension(
  options: { flag?: boolean; branch?: unknown[]; idle?: boolean } = {},
) {
  let activeTools = [
    "read",
    "bash",
    "edit",
    "write",
    "web_search",
    "spawn_agent",
  ];
  const commands = new Map<string, CommandLike>();
  const handlers = new Map<string, EventHandler[]>();
  const entries: Array<{ customType: string; data: unknown }> = [];
  const statuses: Array<{ key: string; value: string | undefined }> = [];
  const notifications: string[] = [];
  let branch = options.branch ?? [];
  let idle = options.idle ?? true;
  let aborts = 0;
  let waits = 0;

  const pi = {
    on(event: string, handler: EventHandler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerFlag() {},
    getFlag() {
      return options.flag ?? false;
    },
    registerCommand(name: string, command: CommandLike) {
      commands.set(name, command);
    },
    registerTool() {},
    registerMessageRenderer() {},
    registerShortcut() {},
    sendMessage() {},
    sendUserMessage() {},
    getActiveTools() {
      return [...activeTools];
    },
    getAllTools() {
      return activeTools.map((name) => ({ name, description: "", parameters: {} }));
    },
    setActiveTools(names: string[]) {
      activeTools = [...names];
    },
    appendEntry(customType: string, data: unknown) {
      entries.push({ customType, data });
    },
  };

  registerReadonlyMode(pi as never);
  const ctx = {
    hasUI: true,
    ui: {
      notify(message: string) {
        notifications.push(message);
      },
      setStatus(key: string, value: string | undefined) {
        statuses.push({ key, value });
      },
      theme: { fg: (_color: string, text: string) => text },
    },
    sessionManager: { getBranch: () => branch },
    isIdle: () => idle,
    abort: () => {
      aborts++;
      idle = true;
    },
    waitForIdle: async () => {
      waits++;
      idle = true;
    },
  };

  return {
    commands,
    handlers,
    entries,
    statuses,
    notifications,
    ctx,
    get aborts() {
      return aborts;
    },
    get waits() {
      return waits;
    },
    activeTools: () => activeTools,
    setBranch(entries: unknown[]) {
      branch = entries;
    },
    forceActiveTools(names: string[]) {
      activeTools = [...names];
    },
  };
}

async function runEvent(
  harness: ReturnType<typeof loadExtension>,
  eventName: string,
  event: any,
): Promise<unknown[]> {
  const results: unknown[] = [];
  for (const handler of harness.handlers.get(eventName) ?? []) {
    results.push(await handler(event, harness.ctx));
  }
  return results;
}

test("/readonly removes every active mutation-capable tool", async () => {
  const harness = loadExtension();
  const command = harness.commands.get("readonly");
  assert.ok(command, "/readonly is registered");

  await command.handler("on", harness.ctx);

  assert.deepEqual(harness.activeTools(), ["read"]);
  assert.match(harness.notifications.at(-1) ?? "", /read-only mode enabled/i);
  assert.deepEqual(harness.entries.at(-1), {
    customType: "readonly-state",
    data: {
      enabled: true,
      toolsBeforeReadonly: [
        "read",
        "bash",
        "edit",
        "write",
        "web_search",
        "spawn_agent",
      ],
    },
  });
});

test("enabling /readonly aborts and settles an active turn before claiming safety", async () => {
  const harness = loadExtension({ idle: false });
  const command = harness.commands.get("readonly");
  assert.ok(command);

  await command.handler("on", harness.ctx);

  assert.equal(harness.aborts, 1);
  assert.equal(harness.waits, 1);
  assert.deepEqual(harness.activeTools(), ["read"]);
});

test("/readonly off restores exactly the tools that were active before the toggle", async () => {
  const harness = loadExtension();
  const command = harness.commands.get("readonly");
  assert.ok(command);

  await command.handler("on", harness.ctx);
  await command.handler("off", harness.ctx);

  assert.deepEqual(harness.activeTools(), [
    "read",
    "bash",
    "edit",
    "write",
    "web_search",
    "spawn_agent",
  ]);
  assert.match(harness.notifications.at(-1) ?? "", /read-only mode disabled/i);
  assert.deepEqual(harness.entries.at(-1), {
    customType: "readonly-state",
    data: { enabled: false },
  });
});

test("read-only mode blocks a stale mutation tool call even if another extension reactivates it", async () => {
  const harness = loadExtension();
  const command = harness.commands.get("readonly");
  assert.ok(command);
  await command.handler("on", harness.ctx);

  const results = await runEvent(harness, "tool_call", { toolName: "edit", input: {} });
  const blocked = results.find((result) => result !== undefined);
  const allowed = await runEvent(harness, "tool_call", { toolName: "read", input: {} });

  assert.deepEqual(blocked, {
    block: true,
    reason: "Read-only mode blocked edit. Run /readonly off to restore mutation tools.",
  });
  assert.equal(allowed.every((result) => result === undefined), true);
});

test("--readonly starts a session with mutation tools already removed", async () => {
  const harness = loadExtension({ flag: true });

  await runEvent(harness, "session_start", { reason: "startup" });

  assert.deepEqual(harness.activeTools(), ["read"]);
  assert.deepEqual(harness.statuses.at(-1), { key: "readonly", value: "readonly" });
});

test("read-only state survives extension reload and session resume", async () => {
  const toolsBeforeReadonly = ["read", "bash", "edit", "write", "web_search"];
  const harness = loadExtension({
    branch: [
      {
        type: "custom",
        customType: "readonly-state",
        data: { enabled: true, toolsBeforeReadonly },
      },
    ],
  });

  await runEvent(harness, "session_start", { reason: "reload" });

  assert.deepEqual(harness.activeTools(), ["read"]);
  const command = harness.commands.get("readonly");
  assert.ok(command);
  await command.handler("off", harness.ctx);
  assert.deepEqual(harness.activeTools(), toolsBeforeReadonly);
});

test("tree navigation restores the read-only state of the selected branch", async () => {
  const toolsBeforeReadonly = ["read", "bash", "edit", "write"];
  const harness = loadExtension({
    branch: [
      {
        type: "custom",
        customType: "readonly-state",
        data: { enabled: true, toolsBeforeReadonly },
      },
    ],
  });
  await runEvent(harness, "session_start", { reason: "startup" });
  assert.deepEqual(harness.activeTools(), ["read"]);

  harness.setBranch([
    {
      type: "custom",
      customType: "readonly-state",
      data: { enabled: false },
    },
  ]);
  await runEvent(harness, "session_tree", {});

  assert.deepEqual(harness.activeTools(), toolsBeforeReadonly);
  assert.deepEqual(harness.statuses.at(-1), { key: "readonly", value: undefined });
});

test("every read-only turn reasserts the restriction and tells the model it cannot mutate", async () => {
  const harness = loadExtension();
  const command = harness.commands.get("readonly");
  assert.ok(command);
  await command.handler("on", harness.ctx);
  harness.forceActiveTools(["read", "edit", "write", "web_search"]);

  let event = { systemPrompt: "base prompt" };
  for (const result of await runEvent(harness, "before_agent_start", event)) {
    const patch = result as { systemPrompt?: string } | undefined;
    if (patch?.systemPrompt) event = { systemPrompt: patch.systemPrompt };
  }

  assert.deepEqual(harness.activeTools(), ["read"]);
  assert.match(event.systemPrompt, /^base prompt/);
  assert.match(event.systemPrompt, /READ-ONLY MODE ACTIVE/);
  assert.match(event.systemPrompt, /cannot modify files/i);
});

test("lazy tool families cannot be activated while read-only mode is enabled", async () => {
  const harness = loadExtension();
  const command = harness.commands.get("readonly");
  assert.ok(command);
  await command.handler("on", harness.ctx);

  const gateway = harness.handlers.get("tool_call")?.at(-1);
  const result = await gateway?.(
    { toolName: "use_toolset", input: { family: "desktop_ui" } },
    harness.ctx,
  );

  assert.deepEqual(result, {
    block: true,
    reason: "Read-only mode blocked use_toolset. Run /readonly off to restore mutation tools.",
  });
});
