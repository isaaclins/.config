import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  caffeinateArgs,
  claimKeepAwake,
  keepAwakeDir,
  releaseKeepAwake,
} from "../lib/keep-awake.ts";

test("caffeinate blocks all sleep flavors and dies with the watched pid", () => {
  assert.deepEqual(caffeinateArgs(4242), ["-dimsu", "-w", "4242"]);
});

test("keepAwakeDir honors XDG_RUNTIME_DIR and falls back to tmpdir", () => {
  assert.equal(
    keepAwakeDir({ XDG_RUNTIME_DIR: "/run/user/1" } as NodeJS.ProcessEnv),
    "/run/user/1/pi-keep-awake",
  );
  assert.equal(keepAwakeDir({} as NodeJS.ProcessEnv), join(tmpdir(), "pi-keep-awake"));
});

test("last live claim releases; concurrent live claims block restore", () => {
  const dir = mkdtempSync(join(tmpdir(), "keep-awake-"));
  claimKeepAwake(dir, 100);
  claimKeepAwake(dir, 200);
  const alive = new Set([100, 200]);
  const isAlive = (pid: number) => alive.has(pid);
  assert.equal(releaseKeepAwake(dir, 100, isAlive), false);
  alive.delete(100);
  assert.equal(releaseKeepAwake(dir, 200, isAlive), true);
  assert.deepEqual(readdirSync(dir), []);
});

test("stale claims from crashed sessions are pruned and do not block restore", () => {
  const dir = mkdtempSync(join(tmpdir(), "keep-awake-"));
  claimKeepAwake(dir, 100);
  claimKeepAwake(dir, 999); // crashed session, not alive
  writeFileSync(join(dir, "junk.txt"), "ignore me");
  assert.equal(
    releaseKeepAwake(dir, 100, (pid) => pid === 100),
    true,
  );
  assert.equal(existsSync(join(dir, "999.pid")), false);
});

test("releasing a claim in a missing directory is safe and restores", () => {
  const dir = join(mkdtempSync(join(tmpdir(), "keep-awake-")), "never-created");
  assert.equal(releaseKeepAwake(dir, 100), true);
});
