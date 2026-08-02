import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerMemoryExtension from "../extensions/index.ts";

interface RegisteredTool {
  execute(toolCallId: string, params: Record<string, unknown>): Promise<{
    content: Array<{ type: string; text: string }>;
    details: Record<string, unknown>;
  }>;
}

interface VisibleRecord {
  id: string;
  key: string;
  scope: string;
  kind: string;
  status: string;
  value: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
}

type ExtensionHandler = (event?: unknown, ctx?: unknown) => Promise<unknown>;

function registerExtension(): {
  tools: Map<string, RegisteredTool>;
  handlers: Map<string, ExtensionHandler>;
} {
  const tools = new Map<string, RegisteredTool>();
  const handlers = new Map<string, ExtensionHandler>();
  const pi = {
    on(event: string, handler: ExtensionHandler) {
      handlers.set(event, handler);
    },
    registerCommand() {},
    registerTool(tool: RegisteredTool & { name: string }) {
      tools.set(tool.name, tool);
    },
  } as unknown as ExtensionAPI;
  registerMemoryExtension(pi);
  return { tools, handlers };
}

function textOf(result: Awaited<ReturnType<RegisteredTool["execute"]>>): string {
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, "text");
  return result.content[0].text;
}

function parseVisibleRecord(text: string, heading: string): VisibleRecord {
  const prefix = `${heading}\n`;
  assert.ok(text.startsWith(prefix), `expected result to start with ${JSON.stringify(prefix)}`);
  return JSON.parse(text.slice(prefix.length)) as VisibleRecord;
}

test("registered governed-memory tools expose complete create, replace, retire, and not-found results", async () => {
  const originalCwd = process.cwd();
  const projectRoot = mkdtempSync(join(tmpdir(), "pi-memory-tools-"));
  process.chdir(projectRoot);

  try {
    const { tools } = registerExtension();
    const upsert = tools.get("pi_memory_upsert");
    const retire = tools.get("pi_memory_retire");
    assert.ok(upsert);
    assert.ok(retire);

    const createdResult = await upsert.execute("upsert-create", {
      key: "transparency.distinctive",
      scope: "project",
      kind: "fact",
      value: "DISTINCTIVE full value with spaces, punctuation, and audit context.",
      expiresAt: "2030-01-02T03:04:05.000Z",
    });
    const created = parseVisibleRecord(textOf(createdResult), "Created governed memory record:");
    assert.deepEqual(Object.keys(created), [
      "id",
      "key",
      "scope",
      "kind",
      "status",
      "value",
      "createdAt",
      "updatedAt",
      "expiresAt",
    ]);
    assert.deepEqual(created, {
      id: created.id,
      key: "transparency.distinctive",
      scope: "project",
      kind: "fact",
      status: "active",
      value: "DISTINCTIVE full value with spaces, punctuation, and audit context.",
      createdAt: created.createdAt,
      updatedAt: created.updatedAt,
      expiresAt: "2030-01-02T03:04:05.000Z",
    });
    assert.ok(created.id);
    assert.ok(created.createdAt);
    assert.ok(created.updatedAt);
    assert.deepEqual(createdResult.details, { operation: "created", record: created });

    const replacedResult = await upsert.execute("upsert-replace", {
      key: "transparency.distinctive",
      scope: "project",
      kind: "runbook",
      value: "REPLACEMENT full value remains completely visible.",
    });
    const replaced = parseVisibleRecord(textOf(replacedResult), "Replaced governed memory record:");
    assert.equal(replaced.id, created.id);
    assert.equal(replaced.createdAt, created.createdAt);
    assert.equal(replaced.scope, "project");
    assert.equal(replaced.kind, "runbook");
    assert.equal(replaced.status, "active");
    assert.equal(replaced.value, "REPLACEMENT full value remains completely visible.");
    assert.equal(replaced.expiresAt, null);
    assert.deepEqual(replacedResult.details, { operation: "replaced", record: replaced });

    const retiredResult = await retire.execute("retire-existing", {
      key: "transparency.distinctive",
      scope: "project",
    });
    const retired = parseVisibleRecord(textOf(retiredResult), "Retired governed memory record:");
    assert.equal(retired.id, created.id);
    assert.equal(retired.key, "transparency.distinctive");
    assert.equal(retired.scope, "project");
    assert.equal(retired.kind, "runbook");
    assert.equal(retired.status, "retired");
    assert.equal(retired.value, "REPLACEMENT full value remains completely visible.");
    assert.equal(retired.createdAt, created.createdAt);
    assert.ok(retired.updatedAt);
    assert.equal(retired.expiresAt, null);
    assert.deepEqual(retiredResult.details, { operation: "retired", record: retired });

    await assert.rejects(
      retire.execute("retire-missing", { key: "missing.record", scope: "project" }),
      /No record found for scope=project key=missing\.record/,
    );
  } finally {
    process.chdir(originalCwd);
  }
});

test("registered lifecycle injects active memory once per session", async () => {
  const originalCwd = process.cwd();
  const projectRoot = mkdtempSync(join(tmpdir(), "pi-memory-lifecycle-"));
  process.chdir(projectRoot);

  try {
    const { tools, handlers } = registerExtension();
    const upsert = tools.get("pi_memory_upsert");
    const sessionStart = handlers.get("session_start");
    const beforeAgentStart = handlers.get("before_agent_start");
    assert.ok(upsert);
    assert.ok(sessionStart);
    assert.ok(beforeAgentStart);

    await upsert.execute("upsert-lifecycle", {
      key: "lifecycle.active",
      scope: "project",
      kind: "fact",
      value: "Lifecycle injection remains active.",
    });

    await sessionStart();
    const first = (await beforeAgentStart({ systemPrompt: "BASE" })) as
      | { systemPrompt: string }
      | undefined;
    assert.ok(first);
    assert.match(first.systemPrompt, /^BASE\n\n## Governed memory/);
    assert.match(first.systemPrompt, /Lifecycle injection remains active\./);
    assert.equal(await beforeAgentStart({ systemPrompt: "BASE" }), undefined);

    await sessionStart();
    const nextSession = (await beforeAgentStart({ systemPrompt: "BASE" })) as
      | { systemPrompt: string }
      | undefined;
    assert.ok(nextSession);
    assert.match(nextSession.systemPrompt, /Lifecycle injection remains active\./);
  } finally {
    process.chdir(originalCwd);
  }
});
