import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PapercutWorktreeOps, WorktreeInfo } from "./papercut.ts";

/**
 * Git adapter for papercut repair worktrees.
 *
 * Every repair happens in a worktree under a temp directory, never in the
 * user's checkout. Worktrees are created from HEAD on a papercut/* branch;
 * verification uses a detached checkout of the same branch so two worktrees
 * never contend for it and the verifier structurally cannot commit.
 *
 * Nothing here merges, pushes, or deletes an unmerged branch.
 */

export const PAPERCUT_BRANCH_PREFIX = "papercut/";

export interface GitRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface GitRunner {
  (args: string[], cwd: string): Promise<GitRunResult>;
}

const execGit: GitRunner = (args, cwd) =>
  new Promise((resolve) => {
    execFile("git", args, { cwd, timeout: 60000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({
        code: error ? ((error as unknown as { code?: number }).code ?? 1) : 0,
        stdout: stdout ?? "",
        stderr: stderr ?? "",
      });
    });
  });

export interface GitWorktreesOptions {
  repoRoot: string;
  /** Parent directory for created worktrees. Defaults to a fresh temp dir. */
  baseDir?: string;
  run?: GitRunner;
}

export class GitWorktrees implements PapercutWorktreeOps {
  private readonly repoRoot: string;
  private readonly run: GitRunner;
  private baseDir: string | undefined;

  constructor(options: GitWorktreesOptions) {
    this.repoRoot = options.repoRoot;
    this.baseDir = options.baseDir;
    this.run = options.run ?? execGit;
  }

  /** Created on first use, so a session that files no papercut litters nothing. */
  private root(): string {
    if (!this.baseDir) this.baseDir = mkdtempSync(join(tmpdir(), "pi-papercut-"));
    return this.baseDir;
  }

  private async git(args: string[]): Promise<string> {
    const result = await this.run(args, this.repoRoot);
    if (result.code !== 0) {
      throw new Error(`git ${args[0]} failed: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`}`);
    }
    return result.stdout;
  }

  private pathFor(branch: string): string {
    const slug = branch.replace(PAPERCUT_BRANCH_PREFIX, "").replace(/[^A-Za-z0-9-]/g, "") || "papercut";
    return join(this.root(), `${slug}-${randomBytes(3).toString("hex")}`);
  }

  /**
   * Create a worktree. `create` opens a new branch at HEAD; otherwise the
   * existing branch is used, detached when asked so the branch stays free.
   */
  async create(input: { branch: string; create: boolean; detach?: boolean }): Promise<string> {
    const path = this.pathFor(input.branch);
    const args = input.create
      ? ["worktree", "add", "-b", input.branch, path, "HEAD"]
      : input.detach
        ? ["worktree", "add", "--detach", path, input.branch]
        : ["worktree", "add", path, input.branch];
    await this.git(args);
    return path;
  }

  async remove(path: string): Promise<void> {
    await this.git(["worktree", "remove", "--force", path]);
  }

  /** Changes the branch introduced since it diverged from HEAD. */
  async diffStat(branch: string): Promise<string> {
    const output = await this.git(["diff", "--shortstat", `HEAD...${branch}`]);
    return output.trim() || "no changes";
  }

  async listPapercutWorktrees(): Promise<WorktreeInfo[]> {
    const output = await this.git(["worktree", "list", "--porcelain"]);
    return parseWorktreeList(output).filter(
      (entry) => entry.branch?.startsWith(PAPERCUT_BRANCH_PREFIX) === true,
    );
  }

  /** Papercut branches already merged into HEAD, so removing them loses nothing. */
  async mergedPapercutBranches(): Promise<string[]> {
    const output = await this.git(["branch", "--merged", "HEAD", "--format=%(refname:short)"]);
    return output
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith(PAPERCUT_BRANCH_PREFIX));
  }

  /**
   * True when the branch points at the same commit as HEAD, meaning the fixer
   * has not committed anything yet. Such a branch is trivially "merged", so
   * cleanup has to ask this before believing that.
   */
  async hasNoCommits(branch: string): Promise<boolean> {
    const [tip, head] = await Promise.all([
      this.git(["rev-parse", branch]),
      this.git(["rev-parse", "HEAD"]),
    ]);
    return tip.trim() === head.trim();
  }

  /**
   * Delete a branch with the safe flag. Callers only reach this for branches
   * git itself confirms are merged, so an unreviewed fix can never be lost here.
   */
  async deleteBranch(branch: string): Promise<void> {
    if (!branch.startsWith(PAPERCUT_BRANCH_PREFIX)) {
      throw new Error(`refusing to delete non-papercut branch ${branch}`);
    }
    await this.git(["branch", "-d", branch]);
  }
}

/** Parse `git worktree list --porcelain` into path/branch pairs. */
export function parseWorktreeList(output: string): WorktreeInfo[] {
  const entries: WorktreeInfo[] = [];
  let current: WorktreeInfo | undefined;
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("worktree ")) {
      if (current) entries.push(current);
      current = { path: trimmed.slice("worktree ".length) };
      continue;
    }
    if (!current) continue;
    if (trimmed.startsWith("branch ")) {
      current.branch = trimmed.slice("branch ".length).replace(/^refs\/heads\//, "");
    }
  }
  if (current) entries.push(current);
  return entries;
}

/** True when `root` is inside a git working tree. */
export async function isGitRepository(root: string, run: GitRunner = execGit): Promise<boolean> {
  const result = await run(["rev-parse", "--is-inside-work-tree"], root);
  return result.code === 0 && result.stdout.trim() === "true";
}
