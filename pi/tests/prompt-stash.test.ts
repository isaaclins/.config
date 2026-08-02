import assert from "node:assert/strict";
import test from "node:test";
import {
  PromptStash,
  preservesStash,
  stashSlot,
  type StashHost,
} from "../lib/prompt-stash.ts";

test("a held stash survives a reload, including a rebound extension instance (shared by prompt-stash.ts)", () => {
  const host: StashHost = {};

  // The extension instance that held the stash.
  const before = new PromptStash(stashSlot(host));
  before.set("draft prompt I am not ready to send");
  assert.equal(before.has, true);

  // /reload tears the runtime down and rebinds a fresh instance, so the new
  // one must find the stash rather than a fresh empty closure.
  const after = new PromptStash(stashSlot(host));
  const restored = after.onSessionStart("reload");

  assert.equal(restored, "draft prompt I am not ready to send");
  assert.equal(after.has, true, "the stash is still held, not consumed by the reload");
  assert.equal(after.peek(), "draft prompt I am not ready to send");
});

test("only a reload preserves the stash; other session starts clear it", () => {
  assert.equal(preservesStash("reload"), true);
  for (const reason of ["startup", "new", "resume", "fork"]) {
    const host: StashHost = {};
    const stash = new PromptStash(stashSlot(host));
    stash.set("held text");

    assert.equal(preservesStash(reason), false);
    assert.equal(stash.onSessionStart(reason), undefined, `${reason} restores nothing`);
    assert.equal(stash.has, false, `${reason} clears the stash`);
  }
});

test("the slot is shared per host and take() consumes it exactly once", () => {
  const host: StashHost = {};
  assert.equal(stashSlot(host), stashSlot(host), "repeated lookups return the same slot");

  const stash = new PromptStash(stashSlot(host));
  stash.set("one shot");
  assert.equal(stash.take(), "one shot");
  assert.equal(stash.take(), undefined, "a consumed stash does not come back");
  assert.equal(stash.has, false);

  // Independent hosts stay independent, so tests never leak into each other.
  const other = new PromptStash(stashSlot({}));
  other.set("elsewhere");
  assert.equal(new PromptStash(stashSlot(host)).has, false);
});
