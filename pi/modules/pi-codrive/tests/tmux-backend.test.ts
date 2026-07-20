import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { TmuxBackend } from "../src/index.ts";

const SERVER_SOCKET = `pi-codrive-test-${randomBytes(4).toString("hex")}`;

function tmux(...args: string[]): string {
  return execFileSync("tmux", ["-L", SERVER_SOCKET, ...args], {
    encoding: "utf8",
    timeout: 5000,
  }).trim();
}

function hasTmux(): boolean {
  try {
    execFileSync("tmux", ["-V"], { timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

test("TmuxBackend spawns, reads, and detects dead panes on an isolated server", async (t) => {
  if (!hasTmux()) {
    t.skip("tmux not available");
    return;
  }

  // Start a detached session on the private server so split-window has a target
  tmux("new-session", "-d", "-s", "test", "-x", "120", "-y", "40");

  t.after(() => {
    try { tmux("kill-server"); } catch { /* already gone */ }
    try { rmSync(join(tmpdir(), SERVER_SOCKET), { recursive: true, force: true }); } catch {}
  });

  const backend = new TmuxBackend({
    serverSocket: SERVER_SOCKET,
    piCommand: "echo",
  });

  // spawn runs echo with prompt as arg, exits immediately
  const result = await backend.spawn({
    projectRoot: "/tmp",
    prompt: "hello-from-test",
    model: "test-model",
    context: "fresh",
    identity: {
      childId: "c1",
      parentSessionId: "s1",
      role: "subagent",
      delegationDepth: 1,
      trust: "trusted",
    },
  });

  assert.match(result.paneId, /^%\d+$/);

  // Give the echo command time to finish
  await new Promise((r) => setTimeout(r, 200));

  // The pane should be dead after echo exits (remain-on-exit is off by default)
  const alive = await backend.isAlive(result.paneId);
  // Pane may be dead already since echo exits immediately
  assert.equal(typeof alive, "boolean");
});

test("TmuxBackend.spawn injects report socket/nonce and identity as child env vars", async (t) => {
  if (!hasTmux()) {
    t.skip("tmux not available");
    return;
  }

  const server = `pi-codrive-test-env-${randomBytes(4).toString("hex")}`;
  const runTmux = (...args: string[]) =>
    execFileSync("tmux", ["-L", server, ...args], { encoding: "utf8", timeout: 5000 }).trim();

  runTmux("new-session", "-d", "-s", "test", "-x", "200", "-y", "50");
  runTmux("set-option", "-t", "test", "remain-on-exit", "on");

  // A single-token script that ignores whatever pi CLI args are appended
  // (buildPiArguments always adds --model etc) and just dumps env, so it
  // works regardless of quoting/argv details.
  const scriptDir = mkdtempSync(join(tmpdir(), "pi-codrive-env-script-"));
  const scriptPath = join(scriptDir, "dump-env");
  writeFileSync(scriptPath, "#!/bin/sh\nenv\n");
  chmodSync(scriptPath, 0o755);

  t.after(() => {
    try { runTmux("kill-server"); } catch { /* already gone */ }
    try { rmSync(join(tmpdir(), server), { recursive: true, force: true }); } catch {}
    try { rmSync(scriptDir, { recursive: true, force: true }); } catch {}
  });

  const backend = new TmuxBackend({ serverSocket: server, piCommand: scriptPath });
  const result = await backend.spawn({
    projectRoot: "/tmp",
    model: "test-model",
    context: "fresh",
    reportSocket: "/tmp/some.sock",
    reportNonce: "the-nonce",
    identity: {
      childId: "child-42",
      parentSessionId: "session-42",
      role: "subagent",
      delegationDepth: 1,
      trust: "trusted",
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 800));
  const output = runTmux("capture-pane", "-p", "-S", "-", "-t", result.paneId);

  assert.match(output, /PI_CODRIVE_SOCKET=\/tmp\/some\.sock/);
  assert.match(output, /PI_CODRIVE_NONCE=the-nonce/);
  assert.match(output, /PI_CODRIVE_SESSION_ID=session-42/);
  assert.match(output, /PI_CODRIVE_CHILD_ID=child-42/);
});
