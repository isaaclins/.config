import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  BRANCH_PREFIX,
  DEFAULT_ROOT_DIRNAME,
  WorktreeError,
  branchFor,
  createWorktree,
  excludeEntryFor,
  isGitRepo,
  listWorktrees,
  nextFreeSlug,
  parseWorktreeList,
  pruneStale,
  removeWorktree,
  repoRootOf,
  slugFromBranch,
  slugify,
  worktreesRoot,
} from "../lib/worktrees.ts";
import { formatEntries, formatPrune, parseWorktreeArgs } from "../extensions/worktrees.ts";

function run(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

const temps: string[] = [];

/** A throwaway repo with one commit on `main`. */
function makeRepo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "wt-test-")));
  temps.push(dir);
  run(dir, ["init", "-b", "main"]);
  run(dir, ["config", "user.email", "test@example.com"]);
  run(dir, ["config", "user.name", "Worktree Test"]);
  writeFileSync(join(dir, "README.md"), "seed\n");
  run(dir, ["add", "README.md"]);
  run(dir, ["commit", "-m", "seed"]);
  return dir;
}

function commitIn(dir: string, name: string): void {
  writeFileSync(join(dir, name), `${name}\n`);
  run(dir, ["add", name]);
  run(dir, ["commit", "-m", name]);
}

test.after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

test("slugify normalizes free-form labels and rejects empty ones", () => {
  assert.equal(slugify("Fix Login Bug"), "fix-login-bug");
  assert.equal(slugify("  feat/Worktree__Support!  "), "feat-worktree-support");
  assert.equal(slugify("already-fine"), "already-fine");
  assert.equal(slugify("a".repeat(80)).length, 48);
  assert.throws(() => slugify("   "), (error: unknown) => (error as WorktreeError).code === "invalid-slug");
  assert.throws(() => slugify("///"), (error: unknown) => (error as WorktreeError).code === "invalid-slug");
});

test("branch naming round-trips through the wt/ namespace only", () => {
  assert.equal(branchFor("login"), `${BRANCH_PREFIX}login`);
  assert.equal(slugFromBranch("wt/login"), "login");
  assert.equal(slugFromBranch("main"), undefined);
  assert.equal(slugFromBranch(undefined), undefined);
  assert.equal(slugFromBranch("wt/"), undefined);
});

test("parseWorktreeList reads main, linked, detached, locked, and prunable records", () => {
  const entries = parseWorktreeList(
    [
      "worktree /repo",
      "HEAD aaaa",
      "branch refs/heads/main",
      "",
      "worktree /repo/.worktrees/login",
      "HEAD bbbb",
      "branch refs/heads/wt/login",
      "locked",
      "",
      "worktree /repo/.worktrees/gone",
      "HEAD cccc",
      "detached",
      "prunable gitdir file points to non-existent location",
      "",
    ].join("\n"),
  );

  assert.equal(entries.length, 3);
  assert.equal(entries[0].isMain, true);
  assert.equal(entries[0].branch, "main");
  assert.equal(entries[0].slug, undefined);
  assert.equal(entries[1].isMain, false);
  assert.equal(entries[1].slug, "login");
  assert.equal(entries[1].locked, true);
  assert.equal(entries[2].detached, true);
  assert.equal(entries[2].prunable, true);
  assert.equal(entries[2].branch, undefined);
});

test("nextFreeSlug suffixes around collisions and gives up loudly", () => {
  assert.equal(nextFreeSlug("login", () => false), "login");
  const taken = new Set(["login", "login-2"]);
  assert.equal(nextFreeSlug("login", (candidate) => taken.has(candidate)), "login-3");
  assert.throws(
    () => nextFreeSlug("login", () => true, 3),
    (error: unknown) => (error as WorktreeError).code === "collision",
  );
});

test("excludeEntryFor covers in-repo roots only", () => {
  assert.equal(excludeEntryFor("/repo", "/repo/.worktrees"), "/.worktrees/");
  assert.equal(excludeEntryFor("/repo", "/repo/tmp/trees"), "/tmp/trees/");
  assert.equal(excludeEntryFor("/repo", "/elsewhere/trees"), undefined);
  assert.equal(excludeEntryFor("/repo", "/repo"), undefined);
});

test("repoRootOf and isGitRepo guard non-repo directories", () => {
  const repo = makeRepo();
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "wt-plain-")));
  temps.push(outside);

  const nested = join(repo, "src", "deep");
  mkdirSync(nested, { recursive: true });

  assert.equal(repoRootOf(repo), repo);
  assert.equal(repoRootOf(nested), repo);
  assert.equal(isGitRepo(repo), true);
  assert.equal(isGitRepo(outside), false);
  assert.throws(
    () => repoRootOf(outside),
    (error: unknown) => (error as WorktreeError).code === "not-a-repo",
  );
});

test("createWorktree places a stable path, branch, and exclude entry", () => {
  const repo = makeRepo();
  const created = createWorktree(repo, "Fix Login");

  assert.equal(created.slug, "fix-login");
  assert.equal(created.branch, "wt/fix-login");
  assert.equal(created.path, join(repo, DEFAULT_ROOT_DIRNAME, "fix-login"));
  assert.equal(existsSync(join(created.path, "README.md")), true);
  assert.equal(run(created.path, ["branch", "--show-current"]).trim(), "wt/fix-login");

  const exclude = readFileSync(join(repo, ".git", "info", "exclude"), "utf8");
  assert.match(exclude, /^\/\.worktrees\/$/m);

  // The root is excluded, so a fresh worktree leaves the main tree clean.
  assert.equal(run(repo, ["status", "--porcelain"]).trim(), "");
});

test("createWorktree suffixes on slug collisions instead of reusing a checkout", () => {
  const repo = makeRepo();
  const first = createWorktree(repo, "login");
  const second = createWorktree(repo, "login");
  const third = createWorktree(repo, "login");

  assert.equal(first.slug, "login");
  assert.equal(second.slug, "login-2");
  assert.equal(third.slug, "login-3");
  assert.notEqual(first.path, second.path);
  assert.equal(second.branch, "wt/login-2");
});

test("createWorktree honors a custom root and skips exclusion outside the repo", () => {
  const repo = makeRepo();
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "wt-root-")));
  temps.push(outside);

  const created = createWorktree(repo, "detached-root", { root: outside });
  assert.equal(created.path, join(outside, "detached-root"));

  const excludePath = join(repo, ".git", "info", "exclude");
  const exclude = existsSync(excludePath) ? readFileSync(excludePath, "utf8") : "";
  assert.equal(exclude.includes(DEFAULT_ROOT_DIRNAME), false);
  assert.equal(worktreesRoot(repo, outside), outside);
});

test("listWorktrees reports the main worktree first and tags managed slugs", () => {
  const repo = makeRepo();
  createWorktree(repo, "alpha");
  const entries = listWorktrees(repo);

  assert.equal(entries.length, 2);
  assert.equal(entries[0].isMain, true);
  assert.equal(entries[0].path, repo);
  assert.equal(entries[1].slug, "alpha");
  assert.equal(entries[1].branch, "wt/alpha");
  assert.equal(entries[1].prunable, false);
});

test("removeWorktree deletes a clean merged worktree and its branch", () => {
  const repo = makeRepo();
  const created = createWorktree(repo, "alpha");

  const removed = removeWorktree(repo, "alpha");

  assert.equal(removed.path, created.path);
  assert.equal(removed.branchDeleted, true);
  assert.equal(existsSync(created.path), false);
  assert.equal(listWorktrees(repo).length, 1);
  assert.equal(run(repo, ["branch", "--list", "wt/alpha"]).trim(), "");
});

test("removeWorktree refuses dirty worktrees unless forced", () => {
  const repo = makeRepo();
  const created = createWorktree(repo, "dirty");
  writeFileSync(join(created.path, "scratch.txt"), "in progress\n");

  assert.throws(
    () => removeWorktree(repo, "dirty"),
    (error: unknown) => (error as WorktreeError).code === "dirty",
  );
  assert.equal(existsSync(created.path), true);

  const removed = removeWorktree(repo, "dirty", { force: true });
  assert.equal(removed.branchDeleted, true);
  assert.equal(existsSync(created.path), false);
});

test("removeWorktree refuses unmerged branches unless forced", () => {
  const repo = makeRepo();
  const created = createWorktree(repo, "feature");
  commitIn(created.path, "feature.txt");

  assert.throws(
    () => removeWorktree(repo, "feature"),
    (error: unknown) => (error as WorktreeError).code === "unmerged",
  );
  assert.equal(existsSync(created.path), true);

  const removed = removeWorktree(repo, "feature", { force: true });
  assert.equal(removed.branchDeleted, true);
  assert.equal(run(repo, ["branch", "--list", "wt/feature"]).trim(), "");
});

test("removeWorktree can keep the branch for later review", () => {
  const repo = makeRepo();
  const created = createWorktree(repo, "review");
  commitIn(created.path, "work.txt");

  const removed = removeWorktree(repo, "review", { force: true, deleteBranch: false });

  assert.equal(removed.branchDeleted, false);
  assert.equal(existsSync(created.path), false);
  assert.match(run(repo, ["branch", "--list", "wt/review"]), /wt\/review/);
});

test("removeWorktree rejects unknown targets and the main worktree", () => {
  const repo = makeRepo();
  assert.throws(
    () => removeWorktree(repo, "nope"),
    (error: unknown) => (error as WorktreeError).code === "not-found",
  );
  assert.throws(
    () => removeWorktree(repo, repo),
    (error: unknown) => (error as WorktreeError).code === "not-found",
  );
});

test("removeWorktree resolves a target by path as well as by slug", () => {
  const repo = makeRepo();
  const created = createWorktree(repo, "by-path");

  const removed = removeWorktree(repo, created.path);
  assert.equal(removed.path, created.path);
  assert.equal(existsSync(created.path), false);
});

test("pruneStale clears records whose checkout vanished and deletes merged branches", () => {
  const repo = makeRepo();
  const created = createWorktree(repo, "vanished");
  rmSync(created.path, { recursive: true, force: true });

  const report = pruneStale(repo);

  assert.deepEqual(report.prunedWorktrees, [created.path]);
  assert.deepEqual(report.deletedBranches, ["wt/vanished"]);
  assert.deepEqual(report.keptBranches, []);
  assert.equal(listWorktrees(repo).length, 1);
  assert.equal(run(repo, ["branch", "--list", "wt/vanished"]).trim(), "");
});

test("pruneStale keeps orphan branches that still hold unmerged work", () => {
  const repo = makeRepo();
  const created = createWorktree(repo, "unmerged");
  commitIn(created.path, "work.txt");
  rmSync(created.path, { recursive: true, force: true });

  const report = pruneStale(repo);

  assert.deepEqual(report.prunedWorktrees, [created.path]);
  assert.deepEqual(report.deletedBranches, []);
  assert.deepEqual(report.keptBranches, ["wt/unmerged"]);
  assert.match(run(repo, ["branch", "--list", "wt/unmerged"]), /wt\/unmerged/);
});

test("pruneStale reports orphan directories and only deletes them when forced", () => {
  const repo = makeRepo();
  createWorktree(repo, "kept");
  const stray = join(repo, DEFAULT_ROOT_DIRNAME, "stray");
  mkdirSync(stray, { recursive: true });
  writeFileSync(join(stray, "leftover.txt"), "junk\n");

  const reported = pruneStale(repo);
  assert.deepEqual(reported.orphanDirectories, [stray]);
  assert.equal(existsSync(stray), true);

  const forced = pruneStale(repo, { force: true });
  assert.deepEqual(forced.orphanDirectories, [stray]);
  assert.equal(existsSync(stray), false);
});

test("parseWorktreeArgs defaults to list and separates flags from positionals", () => {
  assert.deepEqual(parseWorktreeArgs(undefined), {
    command: "list",
    target: undefined,
    force: false,
    dryRun: false,
  });
  assert.deepEqual(parseWorktreeArgs("  ADD   Fix Login "), {
    command: "add",
    target: "Fix",
    force: false,
    dryRun: false,
  });
  assert.deepEqual(parseWorktreeArgs("remove alpha --force"), {
    command: "remove",
    target: "alpha",
    force: true,
    dryRun: false,
  });
  assert.deepEqual(parseWorktreeArgs("prune -n"), {
    command: "prune",
    target: undefined,
    force: false,
    dryRun: true,
  });
});

test("formatEntries marks the main worktree and annotates state", () => {
  const rendered = formatEntries(
    parseWorktreeList(
      [
        "worktree /repo",
        "HEAD aaaa",
        "branch refs/heads/main",
        "",
        "worktree /repo/.worktrees/gone",
        "HEAD bbbbbbbbbbbb",
        "detached",
        "prunable gone",
        "",
      ].join("\n"),
    ),
  );

  const lines = rendered.split("\n");
  assert.match(lines[0], /^\* main\t\/repo$/);
  assert.match(lines[1], /^ {2}\(detached bbbbbbbb\)\t\/repo\/\.worktrees\/gone {2}\[prunable\]$/);
});

test("formatPrune renders only non-empty sections", () => {
  const empty = formatPrune(
    { prunedWorktrees: [], deletedBranches: [], keptBranches: [], orphanDirectories: [] },
    false,
  );
  assert.equal(empty, "worktree prune\nnothing stale");

  const full = formatPrune(
    {
      prunedWorktrees: ["/repo/.worktrees/gone"],
      deletedBranches: ["wt/gone"],
      keptBranches: ["wt/keep"],
      orphanDirectories: ["/repo/.worktrees/stray"],
    },
    true,
  );
  assert.match(full, /^worktree prune \(dry run\)$/m);
  assert.match(full, /^stale records:$/m);
  assert.match(full, /^kept \(unmerged\) branches:$/m);
  assert.match(full, /^orphan directories:$/m);
});

test("pruneStale dry run changes nothing", () => {
  const repo = makeRepo();
  const created = createWorktree(repo, "dry");
  rmSync(created.path, { recursive: true, force: true });

  const report = pruneStale(repo, { dryRun: true });

  assert.deepEqual(report.prunedWorktrees, [created.path]);
  assert.deepEqual(report.deletedBranches, ["wt/dry"]);
  assert.equal(listWorktrees(repo).length, 2);
  assert.match(run(repo, ["branch", "--list", "wt/dry"]), /wt\/dry/);
});
