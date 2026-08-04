/**
 * Git worktree lifecycle for delegation.
 *
 * One owner for "where does a delegated agent write files". A delegated child
 * that shares the orchestrator's working directory can only ever collide with
 * it; a linked worktree gives the child its own checkout and its own branch
 * while keeping one object store, so review and undo stay `git diff` and
 * `git worktree remove`.
 *
 * Naming is stable and derived, never random: slug `foo` always means branch
 * `wt/foo` at `<root>/foo`, with `<root>` defaulting to `<repo>/.worktrees`
 * (excluded from the repo through `$GIT_COMMON_DIR/info/exclude`, so the
 * checkouts never show up as untracked noise). Collisions resolve by
 * suffixing (`foo-2`, `foo-3`), so a caller never silently reuses a worktree
 * another agent is already writing in.
 *
 * Everything runs plain `git` through `spawnSync`, with no shell and no
 * dependencies. Failures throw `WorktreeError` with a machine-readable code
 * so a UI layer can render an explanation instead of a stack trace.
 */

import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

/** Directory (relative to the repo root) holding worktrees by default. */
export const DEFAULT_ROOT_DIRNAME = ".worktrees";

/** Branch namespace owned by this module. */
export const BRANCH_PREFIX = "wt/";

/** Upper bound on collision suffixes before create gives up. */
export const MAX_SLUG_ATTEMPTS = 100;

const MAX_SLUG_LENGTH = 48;

export type WorktreeErrorCode =
  | "not-a-repo"
  | "invalid-slug"
  | "collision"
  | "not-found"
  | "dirty"
  | "unmerged"
  | "git-failed";

export class WorktreeError extends Error {
  readonly code: WorktreeErrorCode;

  constructor(code: WorktreeErrorCode, message: string) {
    super(message);
    this.name = "WorktreeError";
    this.code = code;
  }
}

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run one git command. Never throws on a non-zero exit; inspect `code`. */
export function runGit(cwd: string, args: string[]): GitResult {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error) {
    return { code: 1, stdout: "", stderr: result.error.message };
  }
  return {
    code: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function git(cwd: string, args: string[]): string {
  const result = runGit(cwd, args);
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
    throw new WorktreeError("git-failed", `git ${args.join(" ")} failed: ${detail}`);
  }
  return result.stdout;
}

/**
 * Normalize a free-form label into a filesystem- and ref-safe slug.
 *
 * The result is also the directory name and the branch suffix, so it has to
 * survive both. Anything outside [a-z0-9-] collapses to a single dash.
 */
export function slugify(raw: string): string {
  const slug = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, "");
  if (!slug) {
    throw new WorktreeError("invalid-slug", `Slug "${raw}" has no usable characters`);
  }
  return slug;
}

/** Branch name owned by a slug. */
export function branchFor(slug: string): string {
  return `${BRANCH_PREFIX}${slug}`;
}

/** Inverse of `branchFor`, or undefined for branches this module does not own. */
export function slugFromBranch(branch: string | undefined): string | undefined {
  if (!branch || !branch.startsWith(BRANCH_PREFIX)) return undefined;
  const slug = branch.slice(BRANCH_PREFIX.length);
  return slug || undefined;
}

/** Absolute repo root for `cwd`. Throws when `cwd` is not inside a work tree. */
export function repoRootOf(cwd: string): string {
  const inside = runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.code !== 0 || inside.stdout.trim() !== "true") {
    throw new WorktreeError("not-a-repo", `${cwd} is not inside a git work tree`);
  }
  return git(cwd, ["rev-parse", "--show-toplevel"]).trim();
}

/** True when `cwd` is inside a git work tree. */
export function isGitRepo(cwd: string): boolean {
  const inside = runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
  return inside.code === 0 && inside.stdout.trim() === "true";
}

/** Directory that holds worktrees for this repo. */
export function worktreesRoot(repoRoot: string, root?: string): string {
  if (!root) return join(repoRoot, DEFAULT_ROOT_DIRNAME);
  return isAbsolute(root) ? root : resolve(repoRoot, root);
}

/**
 * The `info/exclude` line that hides a worktree root from git status, or
 * undefined when the root lives outside the repo and needs no exclusion.
 */
export function excludeEntryFor(repoRoot: string, root: string): string | undefined {
  const rel = relative(repoRoot, root);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return undefined;
  return `/${rel.split(sep).join("/")}/`;
}

/**
 * Append the worktree root to the repo's shared exclude file when missing.
 *
 * `$GIT_COMMON_DIR/info/exclude` is deliberate: `--git-dir` inside a linked
 * worktree points at `.git/worktrees/<name>`, while git reads excludes from
 * the common dir, so writing to `--git-dir` would create a file git ignores.
 */
export function ensureExcluded(repoRoot: string, root: string): void {
  const entry = excludeEntryFor(repoRoot, root);
  if (!entry) return;

  const common = runGit(repoRoot, ["rev-parse", "--git-common-dir"]);
  if (common.code !== 0) return;
  const gitCommonDir = resolve(repoRoot, common.stdout.trim());
  const infoDir = join(gitCommonDir, "info");
  const excludePath = join(infoDir, "exclude");

  let current = "";
  if (existsSync(excludePath)) current = readFileSync(excludePath, "utf8");
  else mkdirSync(infoDir, { recursive: true });

  if (current.split("\n").some((line) => line.trim() === entry)) return;
  const prefix = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
  appendFileSync(excludePath, `${prefix}${entry}\n`);
}

export interface WorktreeEntry {
  /** Absolute checkout path as git records it. */
  path: string;
  /** Commit the checkout is on, empty for a bare main worktree. */
  head: string;
  /** Short branch name, undefined when detached or bare. */
  branch?: string;
  /** Slug when the branch is inside this module's namespace. */
  slug?: string;
  /** The repo's primary checkout, which can never be removed. */
  isMain: boolean;
  bare: boolean;
  detached: boolean;
  locked: boolean;
  /** git considers the record removable (its directory is gone). */
  prunable: boolean;
}

/** Parse `git worktree list --porcelain` output. */
export function parseWorktreeList(porcelain: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let current: WorktreeEntry | undefined;

  for (const rawLine of porcelain.split("\n")) {
    const line = rawLine.trimEnd();
    if (!line) {
      current = undefined;
      continue;
    }
    const spaceAt = line.indexOf(" ");
    const key = spaceAt === -1 ? line : line.slice(0, spaceAt);
    const value = spaceAt === -1 ? "" : line.slice(spaceAt + 1);

    if (key === "worktree") {
      current = {
        path: value,
        head: "",
        isMain: entries.length === 0,
        bare: false,
        detached: false,
        locked: false,
        prunable: false,
      };
      entries.push(current);
      continue;
    }
    if (!current) continue;
    if (key === "HEAD") current.head = value;
    if (key === "bare") current.bare = true;
    if (key === "detached") current.detached = true;
    if (key === "locked") current.locked = true;
    if (key === "prunable") current.prunable = true;
    if (key === "branch") {
      current.branch = value.replace(/^refs\/heads\//, "");
      current.slug = slugFromBranch(current.branch);
    }
  }

  return entries;
}

/** All worktrees registered for this repo, main worktree first. */
export function listWorktrees(repoRoot: string): WorktreeEntry[] {
  return parseWorktreeList(git(repoRoot, ["worktree", "list", "--porcelain"]));
}

/**
 * First candidate the `taken` predicate rejects nothing for: `slug`, then
 * `slug-2`, `slug-3`, and so on.
 */
export function nextFreeSlug(
  slug: string,
  taken: (candidate: string) => boolean,
  maxAttempts: number = MAX_SLUG_ATTEMPTS,
): string {
  if (!taken(slug)) return slug;
  for (let suffix = 2; suffix <= maxAttempts; suffix++) {
    const candidate = `${slug}-${suffix}`;
    if (!taken(candidate)) return candidate;
  }
  throw new WorktreeError(
    "collision",
    `No free worktree slug for "${slug}" after ${maxAttempts} attempts`,
  );
}

function branchExists(repoRoot: string, branch: string): boolean {
  return runGit(repoRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).code === 0;
}

function localBranches(repoRoot: string): string[] {
  return git(repoRoot, ["for-each-ref", "--format=%(refname:short)", "refs/heads"])
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export interface CreateWorktreeOptions {
  /** Where checkouts live. Default `<repo>/.worktrees`. */
  root?: string;
  /** Commit-ish the new branch starts from. Default: current HEAD. */
  startPoint?: string;
  /** Set false to skip the `info/exclude` entry. Default true. */
  exclude?: boolean;
}

export interface CreatedWorktree {
  path: string;
  branch: string;
  slug: string;
}

/**
 * Create `<root>/<slug>` on a fresh branch `wt/<slug>`.
 *
 * The returned slug can differ from the requested one when the name was
 * already taken by a directory or a branch, so callers must use the returned
 * `path` rather than recomputing it.
 */
export function createWorktree(
  repoRoot: string,
  slug: string,
  options: CreateWorktreeOptions = {},
): CreatedWorktree {
  const repo = repoRootOf(repoRoot);
  const requested = slugify(slug);
  const root = worktreesRoot(repo, options.root);

  const free = nextFreeSlug(
    requested,
    (candidate) => existsSync(join(root, candidate)) || branchExists(repo, branchFor(candidate)),
  );

  mkdirSync(root, { recursive: true });
  if (options.exclude !== false) ensureExcluded(repo, root);

  const path = join(root, free);
  const branch = branchFor(free);
  const args = ["worktree", "add", "-b", branch, path];
  if (options.startPoint) args.push(options.startPoint);
  git(repo, args);

  return { path, branch, slug: free };
}

function resolveEntry(
  entries: WorktreeEntry[],
  target: string,
  root: string,
): WorktreeEntry | undefined {
  const bySlug = entries.find((entry) => entry.slug === target);
  if (bySlug) return bySlug;

  const wanted = isAbsolute(target) ? resolve(target) : resolve(root, target);
  const byPath = entries.find((entry) => resolve(entry.path) === wanted);
  if (byPath) return byPath;

  return entries.find((entry) => !entry.isMain && basename(entry.path) === target);
}

function isDirty(path: string): boolean {
  if (!existsSync(path)) return false;
  const status = runGit(path, ["status", "--porcelain"]);
  if (status.code !== 0) return false;
  return status.stdout.trim().length > 0;
}

function defaultBaseRef(entries: WorktreeEntry[]): string {
  const main = entries.find((entry) => entry.isMain);
  return main?.branch ?? main?.head ?? "HEAD";
}

function isMerged(repoRoot: string, branch: string, base: string): boolean {
  return runGit(repoRoot, ["merge-base", "--is-ancestor", branch, base]).code === 0;
}

export interface RemoveWorktreeOptions {
  root?: string;
  /** Discard uncommitted work and unmerged commits. Default false. */
  force?: boolean;
  /** Ref the branch must be merged into. Default: the main worktree's branch. */
  base?: string;
  /** Also delete `wt/<slug>`. Default true. */
  deleteBranch?: boolean;
}

export interface RemovedWorktree {
  path: string;
  branch?: string;
  branchDeleted: boolean;
}

/**
 * Remove a worktree and, by default, its branch.
 *
 * Refuses on uncommitted changes and on commits that are not reachable from
 * the base ref, because both are unrecoverable through git once the checkout
 * and the branch are gone. `force` is the single explicit override.
 */
export function removeWorktree(
  repoRoot: string,
  slugOrPath: string,
  options: RemoveWorktreeOptions = {},
): RemovedWorktree {
  const repo = repoRootOf(repoRoot);
  const root = worktreesRoot(repo, options.root);
  const entries = listWorktrees(repo);
  const entry = resolveEntry(entries, slugOrPath, root);

  if (!entry) throw new WorktreeError("not-found", `No worktree matches "${slugOrPath}"`);
  if (entry.isMain) {
    throw new WorktreeError("not-found", "Refusing to remove the main worktree");
  }

  const force = options.force === true;
  if (!force && isDirty(entry.path)) {
    throw new WorktreeError(
      "dirty",
      `Worktree ${entry.path} has uncommitted changes; commit them or pass force`,
    );
  }

  const base = options.base ?? defaultBaseRef(entries);
  if (!force && entry.branch && !isMerged(repo, entry.branch, base)) {
    throw new WorktreeError(
      "unmerged",
      `Branch ${entry.branch} is not merged into ${base}; merge it or pass force`,
    );
  }

  if (existsSync(entry.path)) {
    const args = ["worktree", "remove", entry.path];
    if (force) args.push("--force");
    git(repo, args);
  } else {
    git(repo, ["worktree", "prune"]);
  }

  const shouldDeleteBranch = options.deleteBranch !== false && Boolean(entry.branch);
  if (!shouldDeleteBranch) {
    return { path: entry.path, branch: entry.branch, branchDeleted: false };
  }

  const branch = entry.branch as string;
  const deleted = runGit(repo, ["branch", "-d", branch]);
  if (deleted.code === 0) return { path: entry.path, branch, branchDeleted: true };
  if (!force) return { path: entry.path, branch, branchDeleted: false };

  git(repo, ["branch", "-D", branch]);
  return { path: entry.path, branch, branchDeleted: true };
}

export interface PruneOptions {
  root?: string;
  /** Ref an orphan branch must be merged into to be deletable. */
  base?: string;
  /** Delete unmerged orphan branches and untracked directories too. */
  force?: boolean;
  /** Report what would change without touching anything. */
  dryRun?: boolean;
}

export interface PruneReport {
  /** Registered worktrees whose directory disappeared. */
  prunedWorktrees: string[];
  /** `wt/*` branches with no worktree that were deleted. */
  deletedBranches: string[];
  /** `wt/*` branches with no worktree that carry unmerged commits. */
  keptBranches: string[];
  /** Directories under the root that git does not know about. */
  orphanDirectories: string[];
}

/**
 * Reconcile the two halves of a worktree: the registration and the branch.
 *
 * Interrupted removals leave one without the other. A missing directory
 * leaves a stale admin record, a manual `git worktree remove` leaves the
 * branch, and a manual `rm -rf` plus prune can leave a directory git no
 * longer tracks. Unmerged branches and, without `force`, orphan directories
 * are reported rather than deleted, because they are the only copies left.
 */
export function pruneStale(repoRoot: string, options: PruneOptions = {}): PruneReport {
  const repo = repoRootOf(repoRoot);
  const root = worktreesRoot(repo, options.root);
  const dryRun = options.dryRun === true;
  const force = options.force === true;
  const entries = listWorktrees(repo);

  const prunedWorktrees = entries
    .filter((entry) => !entry.isMain && (entry.prunable || !existsSync(entry.path)))
    .map((entry) => entry.path);
  if (prunedWorktrees.length > 0 && !dryRun) git(repo, ["worktree", "prune"]);

  const live = new Set(
    entries.filter((entry) => existsSync(entry.path)).map((entry) => entry.branch),
  );
  const base = options.base ?? defaultBaseRef(entries);

  const deletedBranches: string[] = [];
  const keptBranches: string[] = [];
  for (const branch of localBranches(repo)) {
    if (!branch.startsWith(BRANCH_PREFIX) || live.has(branch)) continue;
    const removable = force || isMerged(repo, branch, base);
    if (!removable) {
      keptBranches.push(branch);
      continue;
    }
    if (!dryRun) git(repo, ["branch", force ? "-D" : "-d", branch]);
    deletedBranches.push(branch);
  }

  const orphanDirectories = findOrphanDirectories(root, entries);
  if (force && !dryRun) {
    for (const path of orphanDirectories) rmSync(path, { recursive: true, force: true });
  }

  return { prunedWorktrees, deletedBranches, keptBranches, orphanDirectories };
}

function findOrphanDirectories(root: string, entries: WorktreeEntry[]): string[] {
  if (!existsSync(root)) return [];
  const registered = new Set(entries.map((entry) => resolve(entry.path)));
  const orphans: string[] = [];
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    if (!statSync(path).isDirectory() || registered.has(resolve(path))) continue;
    orphans.push(path);
  }
  return orphans.sort();
}
