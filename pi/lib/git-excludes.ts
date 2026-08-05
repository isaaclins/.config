import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Single owner for writing entries into a repo's shared exclude file.
 *
 * Two rules make this worth centralising, because both are easy to get wrong
 * and were each got wrong once:
 *
 *   1. Ask for `--git-common-dir`, not `--git-dir`. Inside a linked worktree
 *      `--git-dir` points at `.git/worktrees/<name>`, whose `info/exclude` git
 *      does not read, so entries written there are silently ignored.
 *   2. Combine with `resolve`, not `join`. Git answers with a bare `.git` in a
 *      normal checkout but an absolute path inside a worktree, and `join` does
 *      not reset on an absolute segment, so it builds a nested junk path like
 *      `/repo/Users/me/repo/.git/...` and creates directories there.
 */

/** Absolute path to the exclude file git actually reads, or undefined. */
export function gitExcludePath(cwd: string): string | undefined {
  const common = runGit(cwd, ["rev-parse", "--git-common-dir"]);
  if (common === undefined) return undefined;
  // resolve, not join: `common` is relative in a checkout, absolute in a worktree.
  return join(resolve(cwd, common), "info", "exclude");
}

/**
 * Append any of `entries` the exclude file does not already list.
 *
 * Comparison is line-exact, so a path that appears only as a substring of a
 * longer rule still gets its own entry.
 */
export function ensureGitExcluded(cwd: string, entries: string[]): void {
  if (entries.length === 0) return;
  const excludePath = gitExcludePath(cwd);
  if (!excludePath) return;

  let current = "";
  if (existsSync(excludePath)) {
    current = readFileSync(excludePath, "utf8");
  } else {
    mkdirSync(join(excludePath, ".."), { recursive: true });
  }

  const present = new Set(current.split("\n").map((line) => line.trim()));
  const missing = entries.filter((entry) => !present.has(entry.trim()));
  if (missing.length === 0) return;

  const prefix = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
  appendFileSync(excludePath, `${prefix}${missing.join("\n")}\n`);
}

function runGit(cwd: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return undefined;
  }
}
