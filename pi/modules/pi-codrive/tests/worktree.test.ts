import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  GitWorktrees,
  PAPERCUT_BRANCH_PREFIX,
  isGitRepository,
  parseWorktreeList,
  type GitRunResult,
  type GitRunner,
} from "../src/index.ts";

function recordingRunner(
  responses: Record<string, GitRunResult> = {},
): { run: GitRunner; calls: string[][] } {
  const calls: string[][] = [];
  const run: GitRunner = async (args) => {
    calls.push(args);
    const key = args.slice(0, 2).join(" ");
    return responses[key] ?? { code: 0, stdout: "", stderr: "" };
  };
  return { run, calls };
}

function makeWorktrees(responses?: Record<string, GitRunResult>) {
  const { run, calls } = recordingRunner(responses);
  const baseDir = mkdtempSync(join(tmpdir(), "pi-papercut-base-"));
  return {
    calls,
    baseDir,
    worktrees: new GitWorktrees({ repoRoot: "/repo", baseDir, run }),
  };
}

test("create opens a new papercut branch at HEAD inside the base directory", async () => {
  const { worktrees, calls, baseDir } = makeWorktrees();

  const path = await worktrees.create({ branch: "papercut/a1b2c3d4", create: true });

  assert.equal(path.startsWith(baseDir), true);
  assert.deepEqual(calls[0], ["worktree", "add", "-b", "papercut/a1b2c3d4", path, "HEAD"]);
});

test("verification checkouts are detached so the branch is never held twice", async () => {
  const { worktrees, calls } = makeWorktrees();

  const path = await worktrees.create({ branch: "papercut/a1b2c3d4", create: false, detach: true });

  assert.deepEqual(calls[0], ["worktree", "add", "--detach", path, "papercut/a1b2c3d4"]);
});

test("remove and diffStat use the branch's divergence from HEAD", async () => {
  const { worktrees, calls } = makeWorktrees({
    "diff --shortstat": { code: 0, stdout: " 1 file changed, 2 insertions(+)\n", stderr: "" },
  });

  await worktrees.remove("/tmp/wt-1");
  const stat = await worktrees.diffStat("papercut/a1b2c3d4");

  assert.deepEqual(calls[0], ["worktree", "remove", "--force", "/tmp/wt-1"]);
  assert.deepEqual(calls[1], ["diff", "--shortstat", "HEAD...papercut/a1b2c3d4"]);
  assert.equal(stat, "1 file changed, 2 insertions(+)");
});

test("diffStat reports no changes rather than an empty string", async () => {
  const { worktrees } = makeWorktrees();
  assert.equal(await worktrees.diffStat("papercut/a1b2c3d4"), "no changes");
});

test("a failing git command raises an actionable error instead of a silent empty result", async () => {
  const { worktrees } = makeWorktrees({
    "worktree add": { code: 128, stdout: "", stderr: "fatal: branch already exists" },
  });

  await assert.rejects(
    () => worktrees.create({ branch: "papercut/a1b2c3d4", create: true }),
    /git worktree failed: fatal: branch already exists/,
  );
});

test("deleteBranch uses the safe flag and refuses branches outside the papercut namespace", async () => {
  const { worktrees, calls } = makeWorktrees();

  await worktrees.deleteBranch("papercut/a1b2c3d4");
  assert.deepEqual(calls[0], ["branch", "-d", "papercut/a1b2c3d4"]);

  await assert.rejects(() => worktrees.deleteBranch("main"), /refusing to delete non-papercut branch main/);
  assert.equal(calls.length, 1);
});

test("only papercut branches are listed as candidates for cleanup", async () => {
  const { worktrees } = makeWorktrees({
    "worktree list": {
      code: 0,
      stdout: [
        "worktree /repo",
        "HEAD abc",
        "branch refs/heads/main",
        "",
        "worktree /tmp/wt-1",
        "HEAD def",
        "branch refs/heads/papercut/a1b2c3d4",
        "",
        "worktree /tmp/wt-detached",
        "HEAD ghi",
        "detached",
        "",
      ].join("\n"),
      stderr: "",
    },
    "branch --merged": {
      code: 0,
      stdout: "main\npapercut/a1b2c3d4\nfeature/x\n",
      stderr: "",
    },
  });

  assert.deepEqual(await worktrees.listPapercutWorktrees(), [
    { path: "/tmp/wt-1", branch: "papercut/a1b2c3d4" },
  ]);
  assert.deepEqual(await worktrees.mergedPapercutBranches(), ["papercut/a1b2c3d4"]);
});

test("parseWorktreeList handles detached entries and a trailing record", () => {
  const parsed = parseWorktreeList(
    ["worktree /a", "branch refs/heads/main", "", "worktree /b", "detached"].join("\n"),
  );

  assert.deepEqual(parsed, [
    { path: "/a", branch: "main" },
    { path: "/b" },
  ]);
  assert.deepEqual(parseWorktreeList(""), []);
});

test("the papercut branch prefix is the namespace everything else keys on", () => {
  assert.equal(PAPERCUT_BRANCH_PREFIX, "papercut/");
});

test("isGitRepository reports what git says", async () => {
  const yes: GitRunner = async () => ({ code: 0, stdout: "true\n", stderr: "" });
  const no: GitRunner = async () => ({ code: 128, stdout: "", stderr: "not a git repository" });

  assert.equal(await isGitRepository("/repo", yes), true);
  assert.equal(await isGitRepository("/tmp", no), false);
});

function hasGit(): boolean {
  try {
    execFileSync("git", ["--version"], { timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

test("against real git: a repair worktree isolates commits from the live checkout", async (t) => {
  if (!hasGit()) {
    t.skip("git not available");
    return;
  }

  const repo = mkdtempSync(join(tmpdir(), "pi-papercut-repo-"));
  const baseDir = mkdtempSync(join(tmpdir(), "pi-papercut-wt-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8", timeout: 15000 }).trim();

  t.after(() => {
    try {
      for (const entry of parseWorktreeList(git("worktree", "list", "--porcelain"))) {
        if (entry.path !== repo) execFileSync("git", ["worktree", "remove", "--force", entry.path], { cwd: repo });
      }
    } catch {
      // Best effort: the temp directories are removed regardless.
    }
    rmSync(repo, { recursive: true, force: true });
    rmSync(baseDir, { recursive: true, force: true });
  });

  git("init", "-b", "main");
  git("config", "user.email", "papercut@example.test");
  git("config", "user.name", "Papercut Test");
  mkdirSync(join(repo, "pi"), { recursive: true });
  writeFileSync(join(repo, "pi", "thing.txt"), "broken\n");
  git("add", ".");
  git("commit", "-m", "initial");

  assert.equal(await isGitRepository(repo), true);

  const worktrees = new GitWorktrees({ repoRoot: repo, baseDir });
  const fixPath = await worktrees.create({ branch: "papercut/a1b2c3d4", create: true });

  // The fixer commits in its worktree; the live checkout must not move.
  writeFileSync(join(fixPath, "pi", "thing.txt"), "fixed\n");
  execFileSync("git", ["add", "."], { cwd: fixPath });
  execFileSync("git", ["commit", "-m", "fix the thing"], { cwd: fixPath });

  assert.equal(git("rev-parse", "--abbrev-ref", "HEAD"), "main");
  assert.equal(git("status", "--porcelain"), "");
  assert.match(await worktrees.diffStat("papercut/a1b2c3d4"), /1 file changed/);

  // A detached verification checkout of the same branch can coexist with it.
  const verifyPath = await worktrees.create({
    branch: "papercut/a1b2c3d4",
    create: false,
    detach: true,
  });
  assert.equal(
    execFileSync("git", ["rev-parse", "HEAD"], { cwd: verifyPath, encoding: "utf8" }).trim(),
    git("rev-parse", "papercut/a1b2c3d4"),
  );

  const listed = await worktrees.listPapercutWorktrees();
  assert.deepEqual(listed.map((entry) => entry.branch), ["papercut/a1b2c3d4"]);

  // Unmerged work is never a cleanup candidate.
  assert.deepEqual(await worktrees.mergedPapercutBranches(), []);

  await worktrees.remove(verifyPath);
  assert.equal(existsSync(verifyPath), false);
  assert.equal(existsSync(fixPath), true);

  // After a merge it becomes a cleanup candidate and can be deleted safely.
  git("merge", "--no-ff", "-m", "merge papercut", "papercut/a1b2c3d4");
  assert.deepEqual(await worktrees.mergedPapercutBranches(), ["papercut/a1b2c3d4"]);
  await worktrees.remove(fixPath);
  await worktrees.deleteBranch("papercut/a1b2c3d4");
  assert.equal(git("branch", "--list", "papercut/a1b2c3d4"), "");
});
