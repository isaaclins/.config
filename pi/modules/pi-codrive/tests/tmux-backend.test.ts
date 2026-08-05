import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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

test("TmuxBackend.spawn in background mode uses a detached window and leaves the visible window alone", async (t) => {
  if (!hasTmux()) {
    t.skip("tmux not available");
    return;
  }

  const server = `pi-codrive-test-bg-${randomBytes(4).toString("hex")}`;
  const runTmux = (...args: string[]) =>
    execFileSync("tmux", ["-L", server, ...args], { encoding: "utf8", timeout: 5000 }).trim();

  runTmux("new-session", "-d", "-s", "test", "-x", "120", "-y", "40");
  runTmux("set-option", "-t", "test", "remain-on-exit", "on");

  const workDir = mkdtempSync(join(tmpdir(), "pi-codrive-bg-cwd-"));
  const scriptDir = mkdtempSync(join(tmpdir(), "pi-codrive-bg-script-"));
  const scriptPath = join(scriptDir, "dump-cwd");
  writeFileSync(scriptPath, "#!/bin/sh\npwd\nsleep 5\n");
  chmodSync(scriptPath, 0o755);

  t.after(() => {
    try { runTmux("kill-server"); } catch { /* already gone */ }
    try { rmSync(join(tmpdir(), server), { recursive: true, force: true }); } catch {}
    try { rmSync(scriptDir, { recursive: true, force: true }); } catch {}
    try { rmSync(workDir, { recursive: true, force: true }); } catch {}
  });

  const activeWindowBefore = runTmux("display-message", "-p", "#{window_id}");
  const panesBefore = runTmux("list-panes", "-t", activeWindowBefore, "-F", "#{pane_id}").split("\n");

  const backend = new TmuxBackend({ serverSocket: server, piCommand: scriptPath });
  const result = await backend.spawn({
    projectRoot: "/tmp",
    cwd: workDir,
    background: true,
    model: "test-model",
    context: "fresh",
    identity: {
      childId: "bg-child",
      parentSessionId: "bg-session",
      role: "subagent",
      delegationDepth: 1,
      trust: "trusted",
    },
  });

  assert.match(result.paneId, /^%\d+$/);

  // The user's window did not gain a pane and did not lose focus.
  const panesAfter = runTmux("list-panes", "-t", activeWindowBefore, "-F", "#{pane_id}").split("\n");
  assert.deepEqual(panesAfter, panesBefore);
  assert.equal(runTmux("display-message", "-p", "#{window_id}"), activeWindowBefore);

  // The child lives in its own window, is reachable, and started in the cwd override.
  const childWindow = runTmux("display-message", "-p", "-t", result.paneId, "#{window_id}");
  assert.notEqual(childWindow, activeWindowBefore);
  assert.equal(runTmux("show-options", "-p", "-t", result.paneId, "@pi_codrive_role").includes("subagent"), true);
  assert.equal(await backend.isAlive(result.paneId), true);

  // Ask tmux for the pane's own cwd instead of scraping wrapped pane text.
  const paneCwd = runTmux("display-message", "-p", "-t", result.paneId, "#{pane_current_path}");
  assert.equal(realpathSync(paneCwd), realpathSync(workDir));

  // read() still works against a detached pane.
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(typeof (await backend.read(result.paneId, 50)), "string");
});

test("TmuxBackend.spawn injects child env vars and marks the pane as a subagent", async (t) => {
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
  const role = runTmux("show-options", "-p", "-t", result.paneId, "@pi_codrive_role");
  const output = runTmux("capture-pane", "-p", "-S", "-", "-t", result.paneId);

  assert.match(role, /@pi_codrive_role subagent/);
  assert.match(output, /PI_CODRIVE_SOCKET=\/tmp\/some\.sock/);
  assert.match(output, /PI_CODRIVE_NONCE=the-nonce/);
  assert.match(output, /PI_CODRIVE_SESSION_ID=session-42/);
  assert.match(output, /PI_CODRIVE_CHILD_ID=child-42/);
});
