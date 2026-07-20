import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createHarnessSession, assertCanDelegate } from "../src/index.ts";

test("harness identity uses the canonical project root and explicit depth", () => {
  const fixture = mkdtempSync(join(tmpdir(), "pi-codrive-identity-"));
  const project = join(fixture, "project");
  const alias = join(fixture, "alias");
  mkdirSync(project);
  symlinkSync(project, alias);

  const session = createHarnessSession({
    projectRoot: alias,
    role: "subagent",
    delegationDepth: 1,
    trust: "trusted",
  });

  assert.equal(session.projectRoot, realpathSync(project));
  assert.equal(session.role, "subagent");
  assert.equal(session.delegationDepth, 1);
  assert.match(session.sessionId, /^[0-9a-f-]{36}$/);
  assert.throws(() => assertCanDelegate(session), /one delegation level/i);
});
