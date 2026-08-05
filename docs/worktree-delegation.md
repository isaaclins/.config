# Worktree delegation

Status: specification. Part A of this branch (`pi/lib/worktrees.ts`,
`pi/extensions/worktrees.ts`, `pi/tests/worktrees.test.ts`) is implemented.
Everything below describes the changes that consume it inside
`pi/modules/pi-codrive` and the rest of the harness. No pi-codrive source is
modified on this branch.

## 1. Problem

Every delegated child today runs `pi` in a tmux pane opened with
`split-window -c <projectRoot>`, where `projectRoot` is the orchestrator's own
`ctx.cwd`. Two children that write files fight over one index, one set of
untracked files, and one HEAD. There is no per-child review artifact and no
undo other than the user's own git discipline.

A linked git worktree fixes all three: one checkout per child, one branch per
task, one object store shared with the main repo. Review becomes
`git diff main...wt/<slug>` and undo becomes `git worktree remove`.

## 2. Implemented foundation

`pi/lib/worktrees.ts` is the single owner of worktree naming, placement, and
safety. It shells out to plain `git` and has no dependencies.

```ts
export const DEFAULT_ROOT_DIRNAME = ".worktrees";
export const BRANCH_PREFIX = "wt/";
export const MAX_SLUG_ATTEMPTS = 100;

export type WorktreeErrorCode =
  | "not-a-repo" | "invalid-slug" | "collision"
  | "not-found" | "dirty" | "unmerged" | "git-failed";
export class WorktreeError extends Error { readonly code: WorktreeErrorCode }

export function runGit(cwd: string, args: string[]): GitResult;
export function slugify(raw: string): string;
export function branchFor(slug: string): string;
export function slugFromBranch(branch: string | undefined): string | undefined;
export function repoRootOf(cwd: string): string;
export function isGitRepo(cwd: string): boolean;
export function worktreesRoot(repoRoot: string, root?: string): string;
export function excludeEntryFor(repoRoot: string, root: string): string | undefined;
export function ensureExcluded(repoRoot: string, root: string): void;
export function parseWorktreeList(porcelain: string): WorktreeEntry[];
export function listWorktrees(repoRoot: string): WorktreeEntry[];
export function nextFreeSlug(slug: string, taken: (c: string) => boolean, maxAttempts?: number): string;
export function createWorktree(repoRoot: string, slug: string, options?: CreateWorktreeOptions): CreatedWorktree;
export function removeWorktree(repoRoot: string, slugOrPath: string, options?: RemoveWorktreeOptions): RemovedWorktree;
export function pruneStale(repoRoot: string, options?: PruneOptions): PruneReport;
```

Invariants the consumers below rely on:

- `createWorktree` returns the slug it actually used. It can differ from the
  requested one (`login` becomes `login-2`), so callers must use the returned
  `path` and never recompute it from the request.
- The default root `<repo>/.worktrees` is added to
  `$GIT_COMMON_DIR/info/exclude` as `/.worktrees/`, so checkouts never appear
  as untracked files in any worktree of the repo.
- `removeWorktree` throws `WorktreeError` with code `dirty` or `unmerged`
  rather than destroying the only copy of a child's work.

### 2.1 One helper still missing

Section 4 needs a way to map a worktree path back to the repo it belongs to.
Add to `pi/lib/worktrees.ts`:

```ts
/**
 * The main worktree's root for any checkout of the same repo.
 * Linked worktrees resolve to the repo that owns their object store.
 */
export function mainRepoRoot(cwd: string): string {
  const common = git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim();
  return dirname(common);
}
```

For a bare-repo setup `dirname($GIT_COMMON_DIR)` is not a work tree; guard with
`existsSync(join(root, ".git"))` and fall back to `repoRootOf(cwd)`.

## 3. spawn_agent grows a worktree option

### 3.1 Tool surface

`pi/modules/pi-codrive/extension.ts`, `spawn_agent` parameters:

```ts
parameters: Type.Object({
  prompt: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()),
  context: Type.Optional(Type.Union([Type.Literal("fresh"), Type.Literal("fork")])),
  cwd: Type.Optional(Type.String()),        // already pending, see 3.5
  worktree: Type.Optional(Type.String()),   // new: task slug
}),
```

Description addition, verbatim intent: "Set worktree to a short task slug when
the child will write files. The child gets its own checkout on branch
`wt/<slug>` and cannot collide with this session or with a sibling agent.
Review its work with `git diff HEAD...wt/<slug>`."

`promptGuidelines` addition:

```
"Pass worktree whenever the delegated child will create, edit, or delete files. Omit it only for read-only investigation."
```

### 3.2 Controller types

`pi/modules/pi-codrive/src/controller.ts`:

```ts
export interface WorktreeAssignment {
  path: string;
  branch: string;
  slug: string;
  /** false when the controller attached to a worktree the caller pre-created. */
  createdByController: boolean;
}

export interface SpawnRequest {
  prompt?: string;
  model?: string;
  context?: "fresh" | "fork";
  forkSessionFile?: string;
  cwd?: string;        // absolute working directory for the child
  worktree?: string;   // slug; mutually exclusive with cwd
}

export interface SpawnLaunch {
  /** Identity: the repo this delegation belongs to. Unchanged semantics. */
  projectRoot: string;
  /** Placement: where the child process actually runs. Defaults to projectRoot. */
  cwd: string;
  worktree?: WorktreeAssignment;
  // ...existing fields unchanged
}

export interface SpawnedChild {
  childId: string;
  paneId: string;
  model: string;
  piSessionId?: string;
  piSessionFile?: string;
  cwd: string;
  worktree?: WorktreeAssignment;
}

export interface ResumeRequest {
  childId: string;
  model: string;
  sessionId?: string;
  resumeSessionFile?: string;
  prompt?: string;
  /** Recorded placement. Resume must reuse it or the child loses its checkout. */
  cwd?: string;
  worktree?: WorktreeAssignment;
}

export interface CodriveControllerOptions {
  // ...existing fields
  /**
   * Injected so the controller stays testable without touching a real repo.
   * Production wiring: (repoRoot, slug) => createWorktree(repoRoot, slug, { root: config.worktreeRoot }).
   */
  createWorktree?: (repoRoot: string, slug: string) => WorktreeAssignment;
}
```

`projectRoot` keeps its current meaning everywhere (identity, accounting,
supervisor registration). The new `cwd` is the only field that decides where
the process runs. Splitting them is what keeps a worktree child recognizable as
belonging to the same repo.

### 3.3 Resolution rules in `CodriveController.spawn`

Exactly one placement wins, resolved before the backend call:

1. `request.worktree` set and `request.cwd` set: throw
   `new Error("Pass either worktree or cwd, not both")`. Silent precedence here
   would hide which checkout a child wrote into.
2. `request.worktree` set: `slug = slugify(request.worktree)`, then
   `assignment = options.createWorktree(this.session.projectRoot, slug)`. Set
   `cwd = assignment.path`, `worktree = assignment`.
3. `request.cwd` set: `cwd = realpathSync(request.cwd)`. Validate with
   `mainRepoRoot(cwd) === this.session.projectRoot`, else throw
   `"cwd must be inside the delegating repository"`. If
   `listWorktrees(projectRoot)` contains that path, populate `worktree` from
   the entry with `createdByController: false`.
4. Neither: `cwd = this.session.projectRoot`, `worktree = undefined`.

Failure of `createWorktree` must fail the spawn. A child silently falling back
to the shared tree is the exact bug this feature removes.

Ordering inside `spawn`: resolve placement after `assertCanDelegate` and after
the model/policy checks, but before `forkResolver()`. A rejected policy must
not leave an orphan checkout behind, and the fork copy is the expensive step.

### 3.4 Backend

`pi/modules/pi-codrive/src/tmux-backend.ts`, one line:

```ts
const args = ["split-window", this.split === "horizontal" ? "-h" : "-v",
  "-c", launch.cwd ?? launch.projectRoot,
  "-P", "-F", "#{pane_id}"];
```

No pi CLI flag is involved: tmux owns the child's working directory. Any future
non-tmux backend must honor `launch.cwd` the same way, which is why the field
lives on `SpawnLaunch` and not on the tmux options.

### 3.5 Consuming the pending `SpawnRequest.cwd`

`cwd` is being added concurrently as a raw escape hatch. This spec does not
remove it; it constrains it:

- `worktree` is the ergonomic path and is what `promptGuidelines` recommends.
- `cwd` stays for callers that already own a directory (a pre-created worktree
  from `worktree_create`, a sibling clone, a subdirectory of a monorepo).
- Both funnel into the single `SpawnLaunch.cwd` field. There is exactly one
  code path that decides placement, and it is rule 1 to 4 above.
- The orchestrator flow through `worktree_create` is:
  `worktree_create({ slug })` returns `details.path`, then
  `spawn_agent({ cwd: details.path, prompt })`. This is what makes the tool in
  `pi/extensions/worktrees.ts` useful before pi-codrive lands `worktree`.

## 4. Child identity and trust

### 4.1 The realpath question

`createHarnessSession` normalizes with `realpathSync(input.projectRoot)`:

```ts
projectRoot: realpathSync(input.projectRoot),
```

The parent extension calls it with `ctx.cwd`. A child launched into
`<repo>/.worktrees/login` therefore has `ctx.cwd` equal to the worktree path,
so a naive reading says the child gets a distinct session identity.

It does not, today, for the delegation state machine: `piCodrive` returns early
in child mode (`if (isChild) { ...; return; }`) and never calls
`createHarnessSession`. Child identity for delegation is carried by the
environment (`PI_CODRIVE_CHILD_ID`, `PI_CODRIVE_SESSION_ID`), not by cwd. So
worktree placement does not break reporting, does not create a second
`ReportServer`, and does not open a depth-escape hole: a child in a worktree
still sees `isCodriveChildEnvironment() === true` and still cannot spawn.

Where the distinct identity does leak is everything else keyed by cwd:

| Consumer | Key today | Effect in a worktree | Correct behavior |
| --- | --- | --- | --- |
| pi project trust | project dir | fresh dir, possible trust prompt | normalize to main repo |
| pi session storage | project dir | child sessions filed under the worktree | acceptable, but resume must reuse cwd |
| `pi-memory` project store | `projectStorePath(process.cwd())` | project memory invisible to the child | normalize to main repo |
| repo-map (`.pi/repo-map.local.md`) | `git rev-parse --show-toplevel` | rebuilt per worktree | acceptable, it is per-branch data |
| `tool-audit` records | `ctx.cwd` | one agent per path, which is the point | keep, add a repo field |

Conclusion: normalize identity, keep placement. Concretely, in the parent
extension and in `pi-memory`:

```ts
session = createHarnessSession({
  projectRoot: mainRepoRoot(ctx.cwd),  // identity: the repo
  workdir: realpathSync(ctx.cwd),      // placement: this checkout
  role: "orchestrator",
  delegationDepth: 0,
  trust: "trusted",
});
```

`HarnessSession` gains `workdir: string` and `CreateHarnessSessionInput` gains
`workdir?: string` defaulting to `projectRoot`. `mainRepoRoot` is a no-op in a
normal repo, so existing behavior is unchanged and no migration is needed for
existing `RuntimeStore` records; treat a missing `workdir` as `projectRoot`
when recovering.

Without this normalization an orchestrator started inside a worktree would
delegate children into `<worktree>/.worktrees/...`, nesting checkouts inside
checkouts. `mainRepoRoot` collapses that to one flat root per repo.

### 4.2 Trust

`defaultProjectTrust` is `"always"` in `pi/settings.json`, so today a fresh
worktree path launches without a prompt. That is a setting, not a guarantee: a
modal trust dialog in a headless pane swallows input and looks exactly like a
hung child.

Seam: `loadCodriveConfig()` reads `defaultProjectTrust` from pi settings. When
it is not `"always"` and a spawn requests a worktree, throw before creating the
checkout:

```
Worktree delegation needs defaultProjectTrust "always" or a pre-trusted path;
set it in pi/settings.json or spawn without worktree.
```

Trust mode itself keeps inheriting from the parent through
`ChildIdentity.trust`, unchanged.

## 5. Report and merge-back flow

### 5.1 What the child already reports

`ChildReporter.announce` sends `cwd: ctx.cwd`. That value is now the worktree
path, so the parent can detect placement even for a child it did not place.

### 5.2 What the parent records

`ChildRecord` in `pi/modules/pi-codrive/src/runtime-store.ts` gains:

```ts
cwd?: string;
worktree?: { path: string; branch: string; slug: string };
```

`DelegationSupervisor.registerSpawn` gains `cwd` and `worktree` and persists
them. This is load-bearing for resume, see 5.4.

### 5.3 Terminal report enrichment

When a terminal report arrives for a child with a `worktree`, the supervisor
appends a review block to the woken message, computed by a pure function so it
is testable without git:

```ts
export function formatWorktreeReview(input: {
  worktree: { path: string; branch: string; slug: string };
  base: string;          // usually the orchestrator's branch
  diffstat: string;      // git -C <repo> diff --stat <base>...<branch>
  commits: string;       // git -C <repo> log --oneline <base>..<branch>
  dirty: string;         // git -C <path> status --porcelain
}): string;
```

Rendered shape:

```
Worktree wt/login at /repo/.worktrees/login
  commits: 3
  diff:    4 files changed, 87 insertions(+), 12 deletions(-)
  review:  git diff main...wt/login
  merge:   git merge --no-ff wt/login
  discard: /worktree remove login --force
  WARNING: 2 uncommitted files left in the worktree
```

The uncommitted warning matters: work that is only in the working tree is
invisible to `git diff main...wt/login` and is destroyed by a forced removal.

### 5.4 Resume

`DelegationSupervisor.resume` must pass the recorded `cwd` and `worktree`
through `ResumeRequest` into `SpawnLaunch.cwd`. A resumed child that lands back
in the main tree would write half its work in the wrong checkout, which is
worse than not resuming at all. Before relaunching, verify the checkout still
exists; if it does not, fail with an actionable message rather than silently
falling back:

```
Cannot resume <childId>: its worktree /repo/.worktrees/login is gone.
Recreate it with /worktree add login or resume without a worktree.
```

### 5.5 Merging back

Never automatic. The orchestrator has no way to know whether a child's commits
are wanted, and an automatic merge destroys the one property that makes this
feature safe: the parent's tree is untouched until a human says so.

Supported closings, in the order the orchestrator should prefer them:

1. Leave the branch. Default. The user reviews with `git diff`.
2. `git merge --no-ff wt/<slug>` run by the user or on explicit instruction.
3. `git cherry-pick` a subset, for partially accepted work.
4. `/worktree remove <slug>` once merged; the library refuses while unmerged
   unless forced, so a mistaken cleanup cannot silently drop commits.

## 6. Cleanup versus retention

Default is retention. A completed child's checkout is the review artifact.

Configuration in `pi/pi-codrive/config.json` (loaded by `loadCodriveConfig`):

```ts
export interface CodriveConfig {
  model?: string;
  thinking?: string;
  /** Where delegated checkouts live. Default "<repo>/.worktrees". */
  worktreeRoot?: string;
  /** "keep" (default) | "on-merge" | "always" */
  worktreeCleanup?: "keep" | "on-merge" | "always";
}
```

Behavior at terminal report:

- `keep`: nothing happens. The pane can be closed; the branch survives.
- `on-merge`: call `removeWorktree(repoRoot, slug)` without `force`. The
  library's merged check is the gate, so an unmerged child is retained
  automatically and the refusal is surfaced as an info line, not an error.
- `always`: `removeWorktree(repoRoot, slug, { force: true })`. Documented as
  destructive and appropriate only for throwaway experiments.

At `session_shutdown` the parent removes nothing. Orphans are the user's
decision, made through `/worktree prune`, which deletes merged orphan branches,
clears stale records, and reports unmerged branches and untracked directories
instead of deleting them.

## 7. Interaction with fork context

`createForkedSession` copies the parent's session up to its leaf. The copy
contains file paths, tool results, and repo-map text that all refer to the main
checkout. A forked child placed in a worktree therefore starts with a history
describing paths that exist, but in the wrong tree.

Rules:

1. Fork first, place second. `forkResolver()` runs in the parent process
   against the parent's own session directory, so it must not observe the
   child's cwd. Keep the current call order in `spawn` and pass the absolute
   `sessionFile` through unchanged; the child receives it as
   `--session <absolute path>` regardless of its cwd.
2. When both `context: "fork"` and a worktree are used, the controller prepends
   a fixed preamble to `request.prompt`:

```ts
export function worktreePreamble(assignment: WorktreeAssignment, projectRoot: string): string {
  return [
    `You are working in a git worktree at ${assignment.path} on branch ${assignment.branch}.`,
    `Earlier context in this conversation refers to paths under ${projectRoot}.`,
    `Translate them to ${assignment.path} before reading or writing.`,
    `Do not modify ${projectRoot}. Commit your work on ${assignment.branch}.`,
  ].join(" ");
}
```

   This is a pure function and is unit-testable. It is prepended for
   `context: "fork"` and for `context: "fresh"` alike, since even a fresh child
   inherits repo-map text describing the main tree.

3. A forked child's `piSessionFile` lives in the parent's session directory,
   not the worktree's. `agent_resume` already resumes by absolute file path, so
   this keeps working, provided 5.4 restores the cwd.

## 8. Harness-wide concerns

### 8.1 repo-map (`pi/extensions/repo-memory.ts`)

Two defects surface only inside a worktree:

1. `ensureGitExcludes` builds `join(cwd, gitDir, "info", "exclude")`. In a
   linked worktree `git rev-parse --git-dir` returns an absolute path
   (`/repo/.git/worktrees/login`), and `path.join` does not reset on an
   absolute segment, so the result is a nonexistent path under the worktree and
   the exclude entries are appended to the wrong file (or to a newly created
   junk tree).

   Fix, exactly:

```ts
const gitCommonDir = sh("git rev-parse --git-common-dir", cwd);
if (!gitCommonDir) return;
const excludePath = resolve(cwd, gitCommonDir, "info", "exclude");
```

   `--git-common-dir` is also semantically right: git reads
   `info/exclude` from the common dir, so a per-worktree copy would be ignored.

2. `piDir` resolves `.pi` from `--show-toplevel`, which in a worktree is the
   worktree root. The repo map is then cached per checkout. That is acceptable
   and arguably correct, since the map contains the branch name and recent
   commits, which differ per worktree. Keep it, but add `.worktrees/` to the
   `entries` array in `ensureGitExcludes` so the exclusion exists even in repos
   where no worktree has been created yet by this harness.

Additionally, the map's file tree is built from `git ls-files`, which never
lists worktree checkouts, so no exclusion is needed there.

### 8.2 tool-audit (`pi/lib/tool-audit.ts`)

`buildRecord` already stores `cwd`, which now distinguishes children. Add one
field so records from sibling worktrees can be aggregated per repo:

```ts
export interface AuditRecord {
  // ...existing
  /** Main repo root for the cwd, when it is inside a git repo. */
  repo?: string;
}
```

Populate it in `pi/extensions/tool-audit.ts` from `mainRepoRoot(ctx.cwd)`
wrapped in try/catch returning undefined, computed once per session rather than
per call, since it is a subprocess. `formatAgent` and `aggregate` need no
change; a new `/toolaudit repo` view can group by it later.

### 8.3 Session storage keyed by cwd

pi files sessions per project directory. Consequences, all acceptable:

- A worktree child's session does not appear in the main tree's session picker.
  This is a feature: those sessions are delegation artifacts, not the user's.
- `agent_resume` is unaffected because it uses `--session <absolute file>` or
  `--session-id`, never the picker.
- The requirement this creates is 5.4: resume must restore cwd. Without it, a
  resumed child opens a session id in a different project scope and silently
  starts a new session.

### 8.4 `.worktrees` and file-search tools

`find`, `grep`, and `rg` invoked by the model do not read `info/exclude`, so a
grep from the main tree will match inside every checkout and multiply results
by the number of active children.

Three layers, in order of reliability:

1. Ship a repo-level `.rgignore`/`.ignore` containing `.worktrees/`. `rg`
   honors it, and it costs one file.
2. Add `.worktrees` to whatever ignore list the harness's read/grep tools
   already consult (the same list that hides `node_modules` and `.git`).
3. Escape hatch for repos where in-repo checkouts are unacceptable: set
   `worktreeRoot` to a path outside the repo, for example
   `${XDG_STATE_HOME:-~/.local/state}/pi/worktrees/<repo-name>`.
   `createWorktree` already supports this through `CreateWorktreeOptions.root`
   and correctly skips the exclude entry when the root is outside the repo.

The default stays in-repo because a checkout next to the repo is discoverable,
and a checkout in `~/.local/state` is forgotten and then orphaned.

### 8.5 Orchestrator prompt policy

Add to the delegation guidance, phrased as a decision and not a preference:

- Delegate into a worktree whenever the child may create, edit, or delete
  files. That includes fixes, refactors, test writing, and documentation.
- Delegate into the shared tree only for read-only investigation: reading code,
  summarizing, searching, reviewing a diff.
- One worktree per task, named after the task. Two children on the same task
  share nothing; they get `login` and `login-2` and their branches are diffed
  against each other.
- Never delegate a merge into a worktree. Merging is the orchestrator's or the
  user's action in the main tree, after review.

## 9. Test matrix for the consuming change

Unit, no git required:

- `worktreePreamble` output contains both paths and the branch.
- `formatWorktreeReview` renders the uncommitted warning only when `dirty` is
  non-empty.
- `CodriveController.spawn` with a stub `createWorktree`: sets `launch.cwd` to
  the assignment path, rejects `worktree` plus `cwd`, rejects a `cwd` outside
  the repo, leaves `projectRoot` untouched in all cases.
- `CodriveController.spawn` propagates a `createWorktree` failure instead of
  falling back to the shared tree.

Integration, throwaway repo (same helpers as `pi/tests/worktrees.test.ts`):

- Spawn with a fake backend that records `launch.cwd`, assert the directory
  exists and is on `wt/<slug>`.
- Resume after a restart restores the recorded cwd.
- Resume with a deleted worktree fails with the actionable message from 5.4.
- `worktreeCleanup: "on-merge"` retains an unmerged child and removes a merged
  one.

## 10. Rollout order

1. `mainRepoRoot` in `pi/lib/worktrees.ts` (2.1).
2. `SpawnLaunch.cwd` plus the tmux `-c` change (3.2, 3.4). Behavior-preserving
   on its own, since `cwd` defaults to `projectRoot`.
3. `ChildRecord.cwd`/`worktree` and resume restoration (5.2, 5.4).
4. `SpawnRequest.worktree`, the resolution rules, and the preamble (3.3, 7).
5. Report enrichment and cleanup policy (5.3, 6).
6. Harness fixes: repo-map exclude path, `.rgignore`, tool-audit `repo` (8.1
   to 8.4). Independent of the rest and safe to land first.

## 11. Open questions

1. **Base ref.** `removeWorktree` and `pruneStale` default their merged check to
   the main worktree's current branch. In a repo where the orchestrator works on
   a feature branch, a child branched from it is "unmerged" relative to that
   branch, which is correct, but the report wording says "not merged into
   `<branch>`" and may read as an error. Should the default base be the branch
   the worktree was created from, recorded at creation time, instead of the
   current main-worktree branch?
2. **Uncommitted child work.** If a child ends its turn with uncommitted
   changes, should the parent auto-commit on the child's branch (`wip: <slug>`)
   so the work is visible to `git diff main...wt/<slug>`, or only warn? Auto
   commit makes review complete; warning keeps the child's history honest.
3. **Concurrency limit.** Nothing caps the number of live worktrees. Should
   `spawn_agent` refuse above N active checkouts, and is N a config value or
   derived from disk space?
4. **Submodules and LFS.** `git worktree add` does not initialize submodules
   and LFS filters run per checkout. Should `createWorktree` gain
   `options.postCreate: string[]` for repo-specific setup, or is that the
   orchestrator prompt's job?
5. **Existing branch reuse.** `createWorktree` always creates a new branch.
   Resuming review on an existing `wt/<slug>` after its checkout was removed
   currently requires manual `git worktree add <path> <branch>`. Worth an
   `attachWorktree(repoRoot, branch)` entry point?
6. **Untrusted-repo case.** Section 4.2 refuses worktree delegation when
   `defaultProjectTrust` is not `"always"`. Is there a pi API to pre-trust a
   path so the refusal can become a pre-trust step instead?
7. **Non-tmux backends.** The Ghostty fallback path is manual and user-driven.
   Does it get `cwd` support, or is worktree delegation documented as
   tmux-only?
