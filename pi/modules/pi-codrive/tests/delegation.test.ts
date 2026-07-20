import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildPiArguments,
  CodriveController,
  createForkedSession,
  createHarnessSession,
  type CodriveBackend,
  type SpawnLaunch,
} from "../src/index.ts";

test("spawn centralizes cwd, model policy, accounting, and descendant identity", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "pi-codrive-spawn-"));
  const launches: SpawnLaunch[] = [];
  const accounted: Array<{ childId: string; model: string }> = [];
  const backend: CodriveBackend = {
    name: "fake",
    async spawn(launch) {
      launches.push(launch);
      return { paneId: "%7" };
    },
    async isAlive() {
      return true;
    },
    async read() {
      return "";
    },
    async send() {},
  };
  const controller = new CodriveController({
    session: createHarnessSession({
      projectRoot,
      role: "orchestrator",
      delegationDepth: 0,
      trust: "trusted",
    }),
    backend,
    policy: {
      defaultModel: "openai-codex/gpt-5.6-luna",
      allowedModels: ["openai-codex/gpt-5.6-luna"],
      account(event) {
        accounted.push({ childId: event.childId, model: event.model });
      },
    },
  });

  const child = await controller.spawn({ prompt: "audit", context: "fresh" });

  assert.equal(child.paneId, "%7");
  assert.equal(launches.length, 1);
  assert.equal(launches[0].projectRoot, realpathSync(projectRoot));
  assert.equal(launches[0].model, "openai-codex/gpt-5.6-luna");
  assert.equal(launches[0].identity.role, "subagent");
  assert.equal(launches[0].identity.delegationDepth, 1);
  assert.equal(launches[0].identity.parentSessionId, controller.session.sessionId);
  assert.deepEqual(accounted, [
    { childId: child.childId, model: "openai-codex/gpt-5.6-luna" },
  ]);
  assert.deepEqual(controller.session.childIds, [child.childId]);
});

test("spawn threads reportSocket/reportNonce from controller options into every launch", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "pi-codrive-report-creds-"));
  const launches: SpawnLaunch[] = [];
  const backend: CodriveBackend = {
    name: "fake",
    async spawn(launch) {
      launches.push(launch);
      return { paneId: "%3" };
    },
    async isAlive() {
      return true;
    },
    async read() {
      return "";
    },
    async send() {},
  };
  const controller = new CodriveController({
    session: createHarnessSession({
      projectRoot,
      role: "orchestrator",
      delegationDepth: 0,
      trust: "trusted",
    }),
    backend,
    policy: { defaultModel: "m", account() {} },
    reportSocket: "/tmp/parent.sock",
    reportNonce: "parent-nonce",
  });

  await controller.spawn({ prompt: "hi", context: "fresh" });

  assert.equal(launches[0].reportSocket, "/tmp/parent.sock");
  assert.equal(launches[0].reportNonce, "parent-nonce");
});

test("spawn omits reportSocket/reportNonce when the controller was not given any", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "pi-codrive-no-report-creds-"));
  const launches: SpawnLaunch[] = [];
  const backend: CodriveBackend = {
    name: "fake",
    async spawn(launch) {
      launches.push(launch);
      return { paneId: "%4" };
    },
    async isAlive() {
      return true;
    },
    async read() {
      return "";
    },
    async send() {},
  };
  const controller = new CodriveController({
    session: createHarnessSession({
      projectRoot,
      role: "orchestrator",
      delegationDepth: 0,
      trust: "trusted",
    }),
    backend,
    policy: { defaultModel: "m", account() {} },
  });

  await controller.spawn({ prompt: "hi", context: "fresh" });

  assert.equal(launches[0].reportSocket, undefined);
  assert.equal(launches[0].reportNonce, undefined);
});

test("spawn with fork context branches a session file and passes fork args to the backend", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "pi-codrive-fork-"));
  const parentFile = join(projectRoot, "parent.jsonl");
  const forkedFile = join(projectRoot, "forked.jsonl");
  writeFileSync(parentFile, "{}\n");
  writeFileSync(
    forkedFile,
    `${[
      { type: "session", id: "s2" },
      {
        type: "message",
        id: "a1",
        parentId: null,
        message: {
          role: "assistant",
          provider: "anthropic",
          content: [
            { type: "thinking", thinking: "secret", thinkingSignature: "sig" },
            { type: "text", text: "answer" },
          ],
        },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n")}\n`,
  );

  const launches: SpawnLaunch[] = [];
  const backend: CodriveBackend = {
    name: "fake",
    async spawn(launch) {
      launches.push(launch);
      return { paneId: "%9" };
    },
    async isAlive() {
      return true;
    },
    async read() {
      return "";
    },
    async send() {},
  };

  const controller = new CodriveController({
    session: createHarnessSession({
      projectRoot,
      role: "orchestrator",
      delegationDepth: 0,
      trust: "trusted",
    }),
    backend,
    policy: { defaultModel: "anthropic/claude-opus-4-8", account() {} },
    forkResolver: () =>
      createForkedSession(
        {
          getSessionFile: () => parentFile,
          getLeafId: () => "leaf-live",
          getSessionDir: () => projectRoot,
        },
        () => ({
          createBranchedSession: () => forkedFile,
          getLeafId: () => "leaf-live",
        }),
      ),
  });

  const child = await controller.spawn({ prompt: "continue", context: "fork" });

  assert.equal(child.paneId, "%9");
  assert.equal(launches.length, 1);
  const launch = launches[0];
  assert.equal(launch.context, "fork");
  assert.equal(launch.forkSessionFile, forkedFile);
  assert.equal(launch.thinkingOverride, "off");
  assert.ok(existsSync(forkedFile));
  assert.equal(
    readFileSync(forkedFile, "utf-8").includes("thinking_level_change"),
    true,
  );

  const args = buildPiArguments({
    prompt: launch.prompt,
    model: launch.model,
    thinking: launch.thinking,
    fork: launch.forkSessionFile
      ? { sessionFile: launch.forkSessionFile, thinkingOverride: launch.thinkingOverride }
      : undefined,
  });
  assert.deepEqual(args, [
    "--model",
    "anthropic/claude-opus-4-8",
    "--thinking",
    "off",
    "--session",
    forkedFile,
    "continue",
  ]);
});

test("spawn with fork context requires a fork source when no forkSessionFile is supplied", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "pi-codrive-fork-missing-"));
  const backend: CodriveBackend = {
    name: "fake",
    async spawn() {
      return { paneId: "%1" };
    },
    async isAlive() {
      return true;
    },
    async read() {
      return "";
    },
    async send() {},
  };
  const controller = new CodriveController({
    session: createHarnessSession({
      projectRoot,
      role: "orchestrator",
      delegationDepth: 0,
      trust: "trusted",
    }),
    backend,
    policy: { defaultModel: "m", account() {} },
  });
  await assert.rejects(
    () => controller.spawn({ context: "fork" }),
    /Fork context requires/,
  );
});
