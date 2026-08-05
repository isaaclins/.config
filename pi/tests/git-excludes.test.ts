import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ensureGitExcluded, gitExcludePath } from "../lib/git-excludes.ts";

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

/** A repo with one commit, so worktrees can be created from it. */
function tempRepo(): string {
  // realpath because macOS symlinks /var to /private/var and git reports the
  // resolved path, which would otherwise fail an exact path comparison.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "git-excludes-")));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Test");
  writeFileSync(join(dir, "seed.txt"), "seed\n");
  git(dir, "add", "seed.txt");
  git(dir, "commit", "-q", "-m", "seed");
  return dir;
}

test("writes entries to the exclude file git actually reads", () => {
  const repo = tempRepo();
  ensureGitExcluded(repo, [".pi/memory.jsonl"]);

  const excludePath = join(repo, ".git", "info", "exclude");
  assert.equal(readFileSync(excludePath, "utf8").includes(".pi/memory.jsonl"), true);
});

test("git honours the written entry", () => {
  const repo = tempRepo();
  ensureGitExcluded(repo, ["ignored.txt"]);
  writeFileSync(join(repo, "ignored.txt"), "x\n");

  const status = execFileSync("git", ["status", "--porcelain"], { cwd: repo }).toString();
  assert.equal(status.includes("ignored.txt"), false);
});

test("resolves the shared exclude path from inside a linked worktree", () => {
  const repo = tempRepo();
  const worktree = join(mkdtempSync(join(tmpdir(), "git-excludes-wt-")), "wt");
  git(repo, "worktree", "add", "-q", "-b", "wt/probe", worktree);

  // The regression: --git-dir here is absolute, and join() does not reset on an
  // absolute segment, so the old code built a nested path under the worktree.
  const resolved = gitExcludePath(worktree);
  assert.equal(resolved, join(repo, ".git", "info", "exclude"));
  assert.equal(resolved?.includes(worktree), false);
});

test("writing from a worktree lands in the shared exclude, not a junk path", () => {
  const repo = tempRepo();
  const worktree = join(mkdtempSync(join(tmpdir(), "git-excludes-wt-")), "wt");
  git(repo, "worktree", "add", "-q", "-b", "wt/write", worktree);

  ensureGitExcluded(worktree, [".pi/repo-map.local.md"]);

  const shared = readFileSync(join(repo, ".git", "info", "exclude"), "utf8");
  assert.equal(shared.includes(".pi/repo-map.local.md"), true);
  assert.equal(existsSync(join(worktree, "Users")), false);
});

test("does not duplicate an entry that is already listed", () => {
  const repo = tempRepo();
  ensureGitExcluded(repo, [".pi/memory.jsonl"]);
  ensureGitExcluded(repo, [".pi/memory.jsonl"]);

  const body = readFileSync(join(repo, ".git", "info", "exclude"), "utf8");
  const hits = body.split("\n").filter((line) => line.trim() === ".pi/memory.jsonl");
  assert.equal(hits.length, 1);
});

test("adds only the missing entries and matches whole lines", () => {
  const repo = tempRepo();
  ensureGitExcluded(repo, ["build/"]);
  // Substring of an existing rule, but not the same rule, so it must be added.
  ensureGitExcluded(repo, ["build/", "build/cache"]);

  const lines = readFileSync(join(repo, ".git", "info", "exclude"), "utf8")
    .split("\n")
    .map((line) => line.trim());
  assert.equal(lines.filter((line) => line === "build/").length, 1);
  assert.equal(lines.filter((line) => line === "build/cache").length, 1);
});

test("returns undefined outside a repo instead of throwing", () => {
  const notARepo = mkdtempSync(join(tmpdir(), "git-excludes-bare-"));
  assert.equal(gitExcludePath(notARepo), undefined);
  ensureGitExcluded(notARepo, [".pi/memory.jsonl"]);
});
