import assert from "node:assert/strict";
import test from "node:test";
import {
  PapercutDispatcher,
  branchNameFor,
  buildFixerPrompt,
  buildVerifierPrompt,
  evaluateGate,
  formatJobs,
  parsePapercutEvent,
  parseVerdict,
  isForeignNote,
  parseNoteSections,
  touchesRepairMechanism,
  type ChildOutcome,
  type PapercutNote,
  type PapercutPort,
  type PapercutRole,
  type WorktreeInfo,
} from "../src/index.ts";

function note(overrides: Partial<PapercutNote> = {}): PapercutNote {
  return {
    id: "a1b2c3d4",
    note: "tried: read shot.png\ngot: unsupported image type\nworkaround: converted to jpeg\nrepro: read shot.png",
    owner: "config",
    suspects: [],
    cwd: "/repo",
    ts: "2026-08-05T10:00:00.000Z",
    ...overrides,
  };
}

// ============================================================================
// Event parsing
// ============================================================================

test("parsePapercutEvent accepts a real note record and normalizes its fields", () => {
  const parsed = parsePapercutEvent({
    ts: "2026-08-05T10:00:00.000Z",
    sessionId: "s",
    agentId: "s",
    callId: "a1b2c3d4",
    cwd: "/repo",
    tool: "note",
    args: "{}",
    outcome: "ok",
    preview: "",
    note: "tried: x\ngot: y",
    owner: "config",
    refCallId: "deadbeef",
    suspects: [" pi/lib/a.ts ", "", 7],
  });

  assert.equal(parsed?.id, "a1b2c3d4");
  assert.equal(parsed?.owner, "config");
  assert.equal(parsed?.refCallId, "deadbeef");
  assert.deepEqual(parsed?.suspects, ["pi/lib/a.ts"]);
});

test("parsePapercutEvent rejects anything that is not a complete papercut", () => {
  assert.equal(parsePapercutEvent(undefined), undefined);
  assert.equal(parsePapercutEvent("note"), undefined);
  assert.equal(parsePapercutEvent({ tool: "bash", callId: "a", note: "x" }), undefined);
  assert.equal(parsePapercutEvent({ tool: "note", note: "x" }), undefined);
  assert.equal(parsePapercutEvent({ tool: "note", callId: "a" }), undefined);
  assert.equal(parsePapercutEvent({ tool: "note", callId: "a", note: "  " }), undefined);
});

test("parsePapercutEvent drops an unknown owner instead of trusting it", () => {
  const parsed = parsePapercutEvent({ tool: "note", callId: "a", note: "x", owner: "codrive" });
  assert.equal(parsed?.owner, undefined);
});

// ============================================================================
// Safety gate
// ============================================================================

test("an owner-config note with no self-reference is eligible for auto repair", () => {
  const decision = evaluateGate(note());
  assert.equal(decision.dispatch, true);
});

test("owners other than config are queued for review, never auto-dispatched", () => {
  for (const owner of ["pi", "model", "env"] as const) {
    const decision = evaluateGate(note({ owner }));
    assert.equal(decision.dispatch, false);
    assert.match(decision.reason, new RegExp(`owner ${owner}`));
  }
  const unassigned = evaluateGate(note({ owner: undefined }));
  assert.equal(unassigned.dispatch, false);
  assert.match(unassigned.reason, /unassigned/);
});

test("a note whose suspects touch pi-codrive is never auto-dispatched", () => {
  const selfNote = note({ suspects: ["pi/modules/pi-codrive/src/supervisor.ts"] });

  assert.equal(touchesRepairMechanism(selfNote), true);
  const decision = evaluateGate(selfNote);
  assert.equal(decision.dispatch, false);
  assert.match(decision.reason, /repair mechanism itself/);
});

test("the self-protection gate also reads the note body and blocks manual dispatch", () => {
  const viaText = note({ note: "tried: spawn_agent with a fork context\ngot: the pane died" });
  assert.equal(evaluateGate(viaText).dispatch, false);
  assert.equal(evaluateGate(viaText, { manual: true }).dispatch, false);

  const viaPath = note({ suspects: ["PI/MODULES/PI-CODRIVE/extension.ts"] });
  assert.equal(evaluateGate(viaPath, { manual: true }).dispatch, false);
});

test("a workaround that merely names agent tooling is not self-reference", () => {
  // Observed on the first real batch: a note about a missing typecheck script
  // was blocked because its workaround mentioned a path under pi-codrive.
  const incidental = note({
    note: [
      "tried: typecheck pi/lib and pi/extensions before committing",
      "got: no typecheck script exists for pi/",
      "workaround: borrowed the tsc in pi/modules/pi-codrive/node_modules",
      "expected: npm --prefix pi run typecheck exists",
    ].join("\n"),
    suspects: ["pi/package.json"],
  });

  assert.equal(touchesRepairMechanism(incidental), false);
  assert.equal(evaluateGate(incidental).dispatch, true);
});

test("a marker in repro or expected still blocks, they are not coping text", () => {
  // repro is the first command the fixer runs, and expected states the change
  // being requested, so a marker in either aims a fixer at the machinery.
  const viaRepro = note({
    note: "tried: run the suite\ngot: it failed\nrepro: npm --prefix pi/modules/pi-codrive test",
  });
  const viaExpected = note({
    note: "tried: pass a cwd to a child\ngot: no way to do it\nexpected: spawn_agent accepts cwd",
  });

  assert.equal(evaluateGate(viaRepro).dispatch, false);
  assert.equal(evaluateGate(viaExpected).dispatch, false);
});

test("the loop's own vocabulary counts as self-reference", () => {
  const viaVocabulary = note({
    note: "tried: dispatch a filed note to the background fixer\ngot: the dispatcher spawned two",
  });

  assert.equal(evaluateGate(viaVocabulary, { manual: true }).dispatch, false);
});

test("a config note filed in another repo is not repaired here", () => {
  const foreign = note({ cwd: "/Users/me/Projects/website" });

  assert.equal(isForeignNote(foreign, "/Users/me/.config"), true);
  const decision = evaluateGate(foreign, { repoRoot: "/Users/me/.config" });
  assert.equal(decision.dispatch, false);
  assert.match(decision.reason, /not this repo/);

  // Same repo, and a subdirectory of it, both stay dispatchable.
  assert.equal(evaluateGate(note({ cwd: "/Users/me/.config" }), { repoRoot: "/Users/me/.config" }).dispatch, true);
  assert.equal(evaluateGate(note({ cwd: "/Users/me/.config/pi" }), { repoRoot: "/Users/me/.config" }).dispatch, true);
  // A path that merely shares a prefix is foreign, not a subdirectory.
  assert.equal(isForeignNote(note({ cwd: "/Users/me/.config-backup" }), "/Users/me/.config"), true);
});

test("a note in an unrecognised shape is scanned whole, so it fails closed", () => {
  const freeform = note({ note: "spawn_agent died and I have no idea why" });

  assert.equal(touchesRepairMechanism(freeform), true);
  assert.equal(evaluateGate(freeform, { manual: true }).dispatch, false);
});

test("parseNoteSections keeps multi-line values with their label", () => {
  const sections = parseNoteSections(
    ["tried: run the suite", "got: it failed", "  with a stack trace", "repro: npm test"].join("\n"),
  );

  assert.equal(sections.tried, "run the suite");
  assert.equal(sections.got, "it failed\n  with a stack trace");
  assert.equal(sections.repro, "npm test");
});

test("manual dispatch overrides only the owner gate", () => {
  const decision = evaluateGate(note({ owner: "env" }), { manual: true });
  assert.equal(decision.dispatch, true);
  assert.match(decision.reason, /manual dispatch/);
});

test("branchNameFor sanitizes ids into a papercut namespace", () => {
  assert.equal(branchNameFor("a1b2c3d4"), "papercut/a1b2c3d4");
  assert.equal(branchNameFor("../../evil branch"), "papercut/evilbranch");
  assert.equal(branchNameFor(""), "papercut/unknown");
});

// ============================================================================
// Prompts
// ============================================================================

test("the fixer prompt carries the note and every hard boundary", () => {
  const prompt = buildFixerPrompt({
    note: note({ suspects: ["pi/lib/read.ts"] }),
    branch: "papercut/a1b2c3d4",
    worktreePath: "/tmp/wt-1",
  });

  assert.match(prompt, /tried: read shot\.png/);
  assert.match(prompt, /pi\/lib\/read\.ts/);
  assert.match(prompt, /Reproduce it FIRST/);
  assert.match(prompt, /root cause/);
  assert.match(prompt, /Commit on the current branch/);
  assert.match(prompt, /Never spawn, resume, or message another agent/);
  assert.match(prompt, /never merge, never push/);
  assert.match(prompt, /\/tmp\/wt-1/);
  assert.equal(prompt.includes("RETRY"), false);
});

test("a retry prompt appends the verifier's rejection verbatim", () => {
  const prompt = buildFixerPrompt({
    note: note(),
    branch: "papercut/a1b2c3d4",
    worktreePath: "/tmp/wt-1",
    previousFailure: "tests failed: 3 assertions in read.test.ts",
  });

  assert.match(prompt, /RETRY/);
  assert.match(prompt, /3 assertions in read\.test\.ts/);
});

test("the verifier prompt is blind: the note and the branch, never the fixer's story", () => {
  const prompt = buildVerifierPrompt({
    note: note(),
    branch: "papercut/a1b2c3d4",
    worktreePath: "/tmp/wt-verify",
  });

  assert.match(prompt, /independent verifier/);
  assert.match(prompt, /tried: read shot\.png/);
  assert.match(prompt, /papercut\/a1b2c3d4/);
  assert.match(prompt, /VERDICT: PASS/);
  assert.match(prompt, /Change nothing/);
  assert.match(prompt, /Never spawn, resume, or message another agent/);
  assert.equal(/root cause with the smallest change/.test(prompt), false);
  assert.equal(prompt.includes("Commit"), false);
});

test("parseVerdict only accepts an explicit pass", () => {
  assert.equal(parseVerdict("all good\nVERDICT: PASS"), "pass");
  assert.equal(parseVerdict("VERDICT: FAIL"), "fail");
  assert.equal(parseVerdict("verdict: pass"), "pass");
  assert.equal(parseVerdict("it works, trust me"), "fail");
  assert.equal(parseVerdict(""), "fail");
  assert.equal(parseVerdict("I would say VERDICT: PASS is close"), "fail");
  // The last explicit verdict wins, so a summary cannot be pre-empted.
  assert.equal(parseVerdict("VERDICT: PASS\nactually no\nVERDICT: FAIL"), "fail");
});

// ============================================================================
// Dispatch state machine
// ============================================================================

interface FakePort extends PapercutPort {
  calls: {
    create: Array<{ branch: string; create: boolean; detach?: boolean }>;
    remove: string[];
    spawn: Array<{ role: PapercutRole; cwd: string; prompt: string; branch: string }>;
    notify: string[];
    deleted: string[];
  };
}

function fakePort(
  overrides: Partial<PapercutPort> = {},
  worktrees: WorktreeInfo[] = [],
  merged: string[] = [],
  uncommitted: Set<string> = new Set(),
): FakePort {
  const calls: FakePort["calls"] = { create: [], remove: [], spawn: [], notify: [], deleted: [] };
  let created = 0;
  let spawned = 0;
  const port: FakePort = {
    calls,
    repoRoot: "/repo",
    worktrees: {
      async create(input) {
        calls.create.push(input);
        created += 1;
        return `/tmp/wt-${created}`;
      },
      async remove(path) {
        calls.remove.push(path);
      },
      async diffStat() {
        return " 2 files changed, 10 insertions(+), 3 deletions(-)";
      },
      async listPapercutWorktrees() {
        return worktrees;
      },
      async mergedPapercutBranches() {
        return merged;
      },
      async deleteBranch(branch) {
        calls.deleted.push(branch);
      },
      async hasNoCommits(branch) {
        return uncommitted.has(branch);
      },
    },
    async spawn(input) {
      calls.spawn.push(input);
      spawned += 1;
      return `child-${spawned}`;
    },
    notify(summary) {
      calls.notify.push(summary);
    },
    ...overrides,
  };
  return port;
}

function outcome(childId: string, text: string, status = "completed"): ChildOutcome {
  return { childId, status, text };
}

test("a config papercut runs fixer then blind verifier and resolves with undo paths", async () => {
  const port = fakePort();
  const dispatcher = new PapercutDispatcher({ port });

  await dispatcher.file(note());

  assert.deepEqual(port.calls.create[0], { branch: "papercut/a1b2c3d4", create: true });
  assert.equal(port.calls.spawn[0].role, "fixer");
  assert.equal(port.calls.spawn[0].cwd, "/tmp/wt-1");
  assert.equal(dispatcher.get("a1b2c3d4")?.phase, "fixing");
  assert.equal(dispatcher.ownsChild("child-1"), true);

  assert.equal(await dispatcher.handleChildOutcome(outcome("child-1", "fixed the decoder")), true);

  // The verifier gets a detached checkout so it cannot commit and does not
  // contend with the fixer's worktree for the branch.
  assert.deepEqual(port.calls.create[1], { branch: "papercut/a1b2c3d4", create: false, detach: true });
  assert.equal(port.calls.spawn[1].role, "verifier");
  assert.equal(port.calls.spawn[1].prompt.includes("fixed the decoder"), false);
  assert.equal(dispatcher.get("a1b2c3d4")?.phase, "verifying");

  await dispatcher.handleChildOutcome(outcome("child-2", "reproduced, now clean\nVERDICT: PASS"));

  const job = dispatcher.get("a1b2c3d4");
  assert.equal(job?.phase, "resolved");
  assert.equal(job?.attempts, 1);
  assert.equal(port.calls.remove.includes("/tmp/wt-2"), true);
  assert.equal(port.calls.notify.length, 1);
  const summary = port.calls.notify[0];
  assert.match(summary, /passed an independent check/);
  assert.match(summary, /papercut\/a1b2c3d4/);
  assert.match(summary, /2 files changed/);
  assert.match(summary, /git -C \/repo merge --no-ff papercut\/a1b2c3d4/);
  assert.match(summary, /worktree remove --force \/tmp\/wt-1 && git -C \/repo branch -D papercut\/a1b2c3d4/);
  assert.match(summary, /Nothing was merged/);
});

test("a failed verdict retries the fixer exactly once, then hands over to a human", async () => {
  const port = fakePort();
  const dispatcher = new PapercutDispatcher({ port });

  await dispatcher.file(note());
  await dispatcher.handleChildOutcome(outcome("child-1", "first attempt"));
  await dispatcher.handleChildOutcome(outcome("child-2", "still broken\nVERDICT: FAIL"));

  // Retry reuses the same worktree and feeds the rejection back to the fixer.
  assert.equal(dispatcher.get("a1b2c3d4")?.phase, "fixing");
  assert.equal(dispatcher.get("a1b2c3d4")?.attempts, 2);
  assert.equal(port.calls.spawn[2].role, "fixer");
  assert.equal(port.calls.spawn[2].cwd, "/tmp/wt-1");
  assert.match(port.calls.spawn[2].prompt, /RETRY/);
  assert.match(port.calls.spawn[2].prompt, /still broken/);
  assert.equal(port.calls.notify.length, 0);

  await dispatcher.handleChildOutcome(outcome("child-3", "second attempt"));
  await dispatcher.handleChildOutcome(outcome("child-4", "nope\nVERDICT: FAIL"));

  const job = dispatcher.get("a1b2c3d4");
  assert.equal(job?.phase, "needs-human");
  assert.equal(job?.attempts, 2);
  assert.equal(port.calls.spawn.length, 4);
  const summary = port.calls.notify[0];
  assert.match(summary, /needs a human/);
  assert.match(summary, /second attempt/);
  assert.match(summary, /nope/);
  assert.match(summary, /branch -D papercut\/a1b2c3d4/);
});

test("a verifier that dies without a verdict counts as a failure", async () => {
  const port = fakePort();
  const dispatcher = new PapercutDispatcher({ port });

  await dispatcher.file(note());
  await dispatcher.handleChildOutcome(outcome("child-1", "done"));
  await dispatcher.handleChildOutcome(outcome("child-2", "VERDICT: PASS", "error"));

  assert.equal(dispatcher.get("a1b2c3d4")?.phase, "fixing");
  assert.equal(port.calls.notify.length, 0);
});

test("a fixer that ends abnormally goes straight to a human", async () => {
  const port = fakePort();
  const dispatcher = new PapercutDispatcher({ port });

  await dispatcher.file(note());
  await dispatcher.handleChildOutcome(outcome("child-1", "crashed", "error"));

  assert.equal(dispatcher.get("a1b2c3d4")?.phase, "needs-human");
  assert.match(port.calls.notify[0], /the fixer ended with status error/);
});

test("only one fixer runs at a time and the rest wait their turn", async () => {
  const port = fakePort();
  const dispatcher = new PapercutDispatcher({ port });

  await dispatcher.file(note({ id: "aaaaaaaa" }));
  await dispatcher.file(note({ id: "bbbbbbbb" }));
  await dispatcher.file(note({ id: "cccccccc" }));

  assert.equal(port.calls.spawn.length, 1);
  assert.equal(dispatcher.get("aaaaaaaa")?.phase, "fixing");
  assert.equal(dispatcher.get("bbbbbbbb")?.phase, "queued");
  assert.equal(dispatcher.get("cccccccc")?.phase, "queued");

  await dispatcher.handleChildOutcome(outcome("child-1", "done"));
  await dispatcher.handleChildOutcome(outcome("child-2", "VERDICT: PASS"));

  assert.equal(dispatcher.get("aaaaaaaa")?.phase, "resolved");
  assert.equal(dispatcher.get("bbbbbbbb")?.phase, "fixing");
  assert.equal(dispatcher.get("cccccccc")?.phase, "queued");
});

test("a blocked note creates no worktree and spawns nothing", async () => {
  const port = fakePort();
  const dispatcher = new PapercutDispatcher({ port });

  const decision = await dispatcher.file(note({ owner: "pi" }));

  assert.equal(decision.dispatch, false);
  assert.equal(dispatcher.get("a1b2c3d4")?.phase, "blocked");
  assert.deepEqual(port.calls.create, []);
  assert.deepEqual(port.calls.spawn, []);
});

test("filing the same papercut twice does not start a second repair", async () => {
  const port = fakePort();
  const dispatcher = new PapercutDispatcher({ port });

  await dispatcher.file(note());
  await dispatcher.file(note());

  assert.equal(port.calls.spawn.length, 1);
  assert.equal(dispatcher.list().length, 1);
});

test("manual dispatch starts a queued owner-env note but still refuses a self-referencing one", async () => {
  const port = fakePort();
  const dispatcher = new PapercutDispatcher({ port });

  await dispatcher.file(note({ id: "eeeeeeee", owner: "env" }));
  assert.equal(dispatcher.get("eeeeeeee")?.phase, "blocked");

  const allowed = await dispatcher.dispatchById("eeeeeeee");
  assert.equal(allowed.dispatch, true);
  assert.equal(dispatcher.get("eeeeeeee")?.phase, "fixing");

  await dispatcher.file(note({ id: "ffffffff", suspects: ["pi/modules/pi-codrive/src/fork.ts"] }));
  const refused = await dispatcher.dispatchById("ffffffff");
  assert.equal(refused.dispatch, false);
  assert.match(refused.reason, /repair mechanism/);

  const unknown = await dispatcher.dispatchById("00000000");
  assert.equal(unknown.dispatch, false);
  assert.match(unknown.reason, /no papercut 00000000/);
});

test("manual dispatch refuses to double-start a running job", async () => {
  const port = fakePort();
  const dispatcher = new PapercutDispatcher({ port });

  await dispatcher.file(note());
  const again = await dispatcher.dispatchById("a1b2c3d4");

  assert.equal(again.dispatch, false);
  assert.match(again.reason, /already fixing/);
  assert.equal(port.calls.spawn.length, 1);
});

test("a worktree that cannot be created hands the papercut to a human instead of failing silently", async () => {
  const port = fakePort();
  port.worktrees.create = async () => {
    throw new Error("disk full");
  };
  const dispatcher = new PapercutDispatcher({ port });

  await dispatcher.file(note());

  assert.equal(dispatcher.get("a1b2c3d4")?.phase, "needs-human");
  assert.match(port.calls.notify[0], /could not start the fixer: disk full/);
});

test("cleanup removes merged papercut worktrees and leaves unmerged ones alone", async () => {
  const port = fakePort(
    {},
    [
      { path: "/tmp/wt-merged", branch: "papercut/aaaaaaaa" },
      { path: "/tmp/wt-open", branch: "papercut/bbbbbbbb" },
    ],
    ["papercut/aaaaaaaa"],
  );
  const dispatcher = new PapercutDispatcher({ port });

  const removed = await dispatcher.cleanupMerged();

  assert.deepEqual(removed, ["papercut/aaaaaaaa"]);
  assert.deepEqual(port.calls.remove, ["/tmp/wt-merged"]);
  assert.deepEqual(port.calls.deleted, ["papercut/aaaaaaaa"]);
});

test("cleanup never removes a branch that has no commits yet", async () => {
  // A branch created at HEAD is trivially an ancestor of HEAD, so git calls it
  // merged from the moment the fixer's worktree exists. Removing it there would
  // delete a running child's checkout.
  const port = fakePort(
    {},
    [{ path: "/tmp/wt-fresh", branch: "papercut/cccccccc" }],
    ["papercut/cccccccc"],
    new Set(["papercut/cccccccc"]),
  );
  const dispatcher = new PapercutDispatcher({ port });

  assert.deepEqual(await dispatcher.cleanupMerged(), []);
  assert.deepEqual(port.calls.remove, []);
  assert.deepEqual(port.calls.deleted, []);
});

test("cleanup skips a branch whose job is still active", async () => {
  const listing: WorktreeInfo[] = [];
  const merged: string[] = [];
  const port = fakePort({}, listing, merged);
  const dispatcher = new PapercutDispatcher({ port });
  await dispatcher.file(note());
  const job = dispatcher.list()[0];
  assert.equal(job.phase, "fixing");

  // The fixer has committed, so hasNoCommits is false, but the job is live.
  listing.push({ path: "/tmp/wt-active", branch: job.branch });
  merged.push(job.branch);

  assert.deepEqual(await dispatcher.cleanupMerged(), []);
  assert.deepEqual(port.calls.remove, []);
});

test("cleanup does nothing when no papercut branch is merged", async () => {
  const port = fakePort({}, [{ path: "/tmp/wt-open", branch: "papercut/bbbbbbbb" }], []);
  const dispatcher = new PapercutDispatcher({ port });

  assert.deepEqual(await dispatcher.cleanupMerged(), []);
  assert.deepEqual(port.calls.remove, []);
});

test("formatJobs summarizes phase, owner, and branch per papercut", async () => {
  const port = fakePort();
  const dispatcher = new PapercutDispatcher({ port });
  await dispatcher.file(note());
  await dispatcher.file(note({ id: "bbbbbbbb", owner: "model" }));

  const output = formatJobs(dispatcher.list());

  assert.match(output, /2 in this session/);
  assert.match(output, /a1b2c3d4\s+fixing\s+owner=config\s+papercut\/a1b2c3d4/);
  assert.match(output, /bbbbbbbb\s+blocked\s+owner=model/);
  assert.match(output, /reason: owner model is not auto-repaired/);
  assert.equal(formatJobs([]), "papercuts: none filed in this session");
});

test("an unrelated child is not consumed by the dispatcher", async () => {
  const port = fakePort();
  const dispatcher = new PapercutDispatcher({ port });
  await dispatcher.file(note());

  assert.equal(dispatcher.ownsChild("someone-else"), false);
  assert.equal(await dispatcher.handleChildOutcome(outcome("someone-else", "hi")), false);
  assert.equal(dispatcher.get("a1b2c3d4")?.phase, "fixing");
});
