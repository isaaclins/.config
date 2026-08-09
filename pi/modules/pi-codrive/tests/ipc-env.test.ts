import assert from "node:assert/strict";
import test from "node:test";
import { captureChildIpcEnvironment, CHILD_MARKER_ENV } from "../src/index.ts";

test("captureChildIpcEnvironment scrubs current and legacy env keys", () => {
  const env: NodeJS.ProcessEnv = {
    PI_CODRIVE_SOCKET: "/tmp/socket",
    PI_CODRIVE_NONCE: "secret-nonce",
    PI_CODRIVE_SESSION_ID: "session-1",
    PI_CODRIVE_CHILD_ID: "child-1",
    PI_SPAWN_NOTIFY_FILE: "/tmp/notify",
    PI_SPAWN_AGENT_REPORT_FILE: "/tmp/report",
    UNRELATED: "kept",
  };
  const captured = captureChildIpcEnvironment(env);
  assert.equal(captured.PI_CODRIVE_SOCKET, "/tmp/socket");
  assert.equal(captured.PI_CODRIVE_NONCE, "secret-nonce");
  assert.equal(captured.PI_CODRIVE_SESSION_ID, "session-1");
  assert.equal(captured.PI_CODRIVE_CHILD_ID, "child-1");
  assert.equal(env.PI_CODRIVE_SOCKET, undefined);
  assert.equal(env.PI_CODRIVE_NONCE, undefined);
  assert.equal(env.PI_CODRIVE_SESSION_ID, undefined);
  assert.equal(env.PI_CODRIVE_CHILD_ID, undefined);
  assert.equal(env.PI_SPAWN_NOTIFY_FILE, undefined);
  assert.equal(env.PI_SPAWN_AGENT_REPORT_FILE, undefined);
  assert.equal(env[CHILD_MARKER_ENV], "1");
  assert.equal(env.UNRELATED, "kept");
});

test("a grandchild process cannot recover session/child identity after scrubbing", () => {
  const env: NodeJS.ProcessEnv = {
    PI_CODRIVE_SESSION_ID: "session-1",
    PI_CODRIVE_CHILD_ID: "child-1",
  };
  captureChildIpcEnvironment(env);
  const inheritedByGrandchild = { ...env };
  assert.equal(inheritedByGrandchild.PI_CODRIVE_SESSION_ID, undefined);
  assert.equal(inheritedByGrandchild.PI_CODRIVE_CHILD_ID, undefined);
  assert.equal(inheritedByGrandchild[CHILD_MARKER_ENV], "1");
});

test("captureChildIpcEnvironment returns empty object when no keys present", () => {
  const env: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
  const captured = captureChildIpcEnvironment(env);
  assert.deepEqual(captured, {});
  assert.equal(env.PATH, "/usr/bin");
});
