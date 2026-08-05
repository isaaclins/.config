/**
 * Papercut self-repair dispatch.
 *
 * A papercut is a repro-shaped note filed by an agent that personally hit
 * harness friction. The tool-audit extension owns filing them and announces
 * each one on the shared event bus. This module owns what happens next:
 *
 *   gate -> worktree -> junior fixer -> blind verifier -> queued for a human
 *
 * Invariants, in order of importance:
 *   - Nothing is ever merged automatically. Fixes only exist as commits on a
 *     papercut/* branch inside a throwaway worktree.
 *   - The live working tree is never touched. Every child runs with its cwd
 *     inside its own worktree.
 *   - A note that points at this module is never auto-dispatched, because a
 *     bad fix must not be able to take out the repair mechanism.
 *   - The user is never interrupted. Results are queued.
 *   - The verifier is blind: it sees the branch and the original note, never
 *     the fixer's reasoning.
 *
 * Everything here is pure or port-driven so it can be tested without git,
 * tmux, or a live agent.
 */

import { sep } from "node:path";

/** Event-bus channel the tool-audit extension announces papercuts on. */
export const PAPERCUT_FILED_EVENT = "papercut:filed";

export type PapercutOwner = "config" | "pi" | "model" | "env";

const OWNERS: readonly string[] = ["config", "pi", "model", "env"];

/** The only owner eligible for automatic repair. */
export const AUTO_DISPATCH_OWNER: PapercutOwner = "config";

/**
 * Substrings that mean "this note is about the repair mechanism itself".
 * A false positive only costs a human review, while a false negative lets a
 * junior agent rewrite the machinery that supervises it.
 */
export const SELF_REFERENCE_MARKERS: readonly string[] = [
  "codrive",
  "spawn_agent",
  "agent_resume",
  "agent_pane",
  "agent_report",
  // The loop's own vocabulary. A note about papercut repair is a note about
  // this machinery even when it names none of the tools above.
  "papercut",
  "dispatcher",
];

/**
 * Every section except `workaround` decides self-reference.
 *
 * `workaround` is excluded because it describes how the agent coped, and it
 * names agent tooling in passing all the time ("polled with agent_report
 * instead"). Matching there refused most legitimate notes: on the first real
 * batch it blocked a note about a missing typecheck script purely because the
 * workaround mentioned a path under pi-codrive's node_modules.
 *
 * `repro` and `expected` must stay in. `repro` is the command the fixer runs
 * first, so a repro pointing into pi-codrive sends the fixer straight there,
 * and `expected` states the change being asked for.
 */
const PROBLEM_SECTIONS: readonly string[] = ["tried", "got", "expected", "repro"];
const SECTION_LINE = /^(tried|got|workaround|expected|repro):\s?(.*)$/;

/**
 * Split a formatted note back into its labelled sections.
 *
 * Values may span lines, so an unlabelled line continues the section above it.
 * Returns an empty map for a note that is not in the canonical shape, which
 * callers must treat as "cannot tell" rather than "nothing found".
 */
export function parseNoteSections(note: string): Record<string, string> {
  const sections: Record<string, string> = {};
  let current: string | undefined;
  for (const line of note.split("\n")) {
    const match = SECTION_LINE.exec(line);
    if (match) {
      current = match[1];
      sections[current] = match[2] ?? "";
      continue;
    }
    if (current) sections[current] = `${sections[current]}\n${line}`;
  }
  return sections;
}

export interface PapercutNote {
  /** The note's own audit call id. Identifies it and names its branch. */
  id: string;
  /** The repro-shaped body: tried / got / workaround / expected / repro. */
  note: string;
  owner?: PapercutOwner;
  /** Repo-relative paths the author suspects. */
  suspects: string[];
  /** The audit call the note is about, when known. */
  refCallId?: string;
  cwd: string;
  ts: string;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Validate an event-bus payload into a note.
 *
 * The payload crosses a module boundary and is therefore untrusted input, not
 * a typed call. Anything that is not a complete, identifiable papercut is
 * rejected rather than partially accepted.
 */
export function parsePapercutEvent(data: unknown): PapercutNote | undefined {
  if (!data || typeof data !== "object") return undefined;
  const raw = data as Record<string, unknown>;
  if (raw.tool !== "note") return undefined;
  const id = asString(raw.callId);
  const note = asString(raw.note);
  if (!id || !note) return undefined;
  const owner = typeof raw.owner === "string" && OWNERS.includes(raw.owner)
    ? (raw.owner as PapercutOwner)
    : undefined;
  const suspects = Array.isArray(raw.suspects)
    ? raw.suspects.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];
  return {
    id,
    note,
    owner,
    suspects: suspects.map((entry) => entry.trim()),
    refCallId: asString(raw.refCallId),
    cwd: asString(raw.cwd) ?? "",
    ts: asString(raw.ts) ?? new Date().toISOString(),
  };
}

/**
 * True when a note's problem statement or suspected paths point at the repair
 * mechanism itself.
 *
 * Suspects always count, because they are where a fixer would edit. A note in
 * an unrecognised shape is scanned whole, so an odd format fails closed.
 */
export function touchesRepairMechanism(note: PapercutNote): boolean {
  const sections = parseNoteSections(note.note);
  const problem = PROBLEM_SECTIONS.map((name) => sections[name] ?? "");
  const scanned = Object.keys(sections).length > 0 ? problem : [note.note];
  const haystack = [...scanned, ...note.suspects].join("\n").toLowerCase();
  return SELF_REFERENCE_MARKERS.some((marker) => haystack.includes(marker));
}

export interface GateDecision {
  dispatch: boolean;
  reason: string;
}

/** True when a note was filed somewhere other than the repo being repaired. */
export function isForeignNote(note: PapercutNote, repoRoot: string): boolean {
  if (!repoRoot || !note.cwd) return false;
  const root = repoRoot.endsWith(sep) ? repoRoot.slice(0, -1) : repoRoot;
  return note.cwd !== root && !note.cwd.startsWith(`${root}${sep}`);
}

/**
 * Decide whether a note may be repaired automatically.
 *
 * Self-protection is checked first and is absolute: it also blocks a manual
 * dispatch, because the danger is the change itself, not who asked for it.
 * The owner check is the softer gate and a human may override it by id.
 */
export function evaluateGate(
  note: PapercutNote,
  options: { manual?: boolean; repoRoot?: string } = {},
): GateDecision {
  if (touchesRepairMechanism(note)) {
    return {
      dispatch: false,
      reason: "the note points at pi-codrive, the repair mechanism itself; human review only",
    };
  }
  // The audit log is global, so a note filed in another project reaches this
  // dispatcher. Repairing it here would branch the wrong repo and hand a fixer
  // a problem that does not exist in it.
  if (options.repoRoot && isForeignNote(note, options.repoRoot)) {
    return {
      dispatch: false,
      reason: `the note was filed in ${note.cwd}, not this repo; human review only`,
    };
  }
  if (note.owner !== AUTO_DISPATCH_OWNER) {
    if (!options.manual) {
      return {
        dispatch: false,
        reason: `owner ${note.owner ?? "unassigned"} is not auto-repaired; queued for review`,
      };
    }
    return { dispatch: true, reason: `manual dispatch of an owner-${note.owner ?? "unassigned"} note` };
  }
  return { dispatch: true, reason: "owner config and no self-reference" };
}

/** Branch name for a note. Ids are audit call ids, so this stays collision-free. */
export function branchNameFor(noteId: string): string {
  const safe = noteId.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 32);
  return `papercut/${safe || "unknown"}`;
}

// ============================================================================
// Prompts
// ============================================================================

const NO_DELEGATION =
  "You have no delegation powers. Never spawn, resume, or message another agent. You are the only agent on this task.";

export interface FixerPromptInput {
  note: PapercutNote;
  branch: string;
  worktreePath: string;
  /** A previous verifier's rejection, appended verbatim on a retry. */
  previousFailure?: string;
}

/** The junior fixer's entire prompt: the note plus hard boundaries. */
export function buildFixerPrompt(input: FixerPromptInput): string {
  const lines = [
    "You are a repair agent. You work alone, in one isolated git worktree, on one small problem.",
    "",
    `WORKTREE: ${input.worktreePath}`,
    `BRANCH:   ${input.branch}`,
    "",
    "That worktree is a disposable copy of the repository. It is not the user's working tree.",
    "Every command you run must stay inside it. Never edit, stage, or commit anything outside it.",
    "Never touch another worktree or the main checkout, never merge, never push, never force anything.",
    NO_DELEGATION,
    "",
    "PAPERCUT, filed by an agent that hit this for real:",
    input.note.note,
  ];
  if (input.note.suspects.length > 0) {
    lines.push("", `Suspected files: ${input.note.suspects.join(", ")}`);
  }
  lines.push(
    "",
    "DO THIS IN ORDER:",
    "1. Reproduce it FIRST, inside the worktree, before you change any code. Run the repro command or the",
    "   closest equivalent. If you cannot reproduce it, stop, change nothing, and report COULD NOT REPRODUCE",
    "   with exactly what you ran and what you saw.",
    "2. Find the root cause. Read the code that produced the wrong behavior.",
    "3. Fix the root cause with the smallest change that works. Do not paper over the symptom, do not add a",
    "   fallback that hides it, and do not widen a catch to swallow it.",
    "4. Verify. Run the repro again and confirm the behavior is now correct, then run the owning module's",
    "   checks: for pi/lib or pi/extensions run `npm --prefix pi test`; for pi/modules/<name> run",
    "   `npm --prefix pi/modules/<name> test` and its typecheck script when it has one.",
    "5. Commit on the current branch with a message that names the root cause. Do not create other branches.",
    "6. Report what you reproduced, the root cause, the change you made, and every command you ran with its",
    "   result. An independent verifier will re-check your work from scratch, so do not overstate it.",
    "",
    "If the fix would require touching something outside this worktree, stop and report that instead.",
  );
  if (input.previousFailure) {
    lines.push(
      "",
      "RETRY. An independent verifier rejected the previous attempt on this branch. Its report:",
      input.previousFailure,
      "",
      "The earlier commits are still on the branch. Fix what the verifier found and commit again.",
    );
  }
  return lines.join("\n");
}

export interface VerifierPromptInput {
  note: PapercutNote;
  branch: string;
  worktreePath: string;
}

/**
 * The verifier's entire prompt. It gets the branch and the original note and
 * nothing else: no fixer report, no reasoning, no diff summary. A verifier
 * that reads the fixer's story stops being a second opinion.
 */
export function buildVerifierPrompt(input: VerifierPromptInput): string {
  return [
    "You are an independent verifier. You did not write this change and you must not trust it.",
    "",
    `WORKTREE: ${input.worktreePath}`,
    `BRANCH:   ${input.branch} (checked out detached, so you cannot commit here and must not try)`,
    "",
    "PAPERCUT, the original report from the agent that hit the problem:",
    input.note.note,
    "",
    "DO THIS IN ORDER:",
    "1. Reproduce the papercut against this checkout. Run the repro command or the closest equivalent.",
    "2. Decide whether the problem is actually gone. Judge only what you observe. Ignore commit messages,",
    "   code comments, and any claim made in the diff.",
    "3. Run the owning module's checks: for pi/lib or pi/extensions run `npm --prefix pi test`; for",
    "   pi/modules/<name> run `npm --prefix pi/modules/<name> test` and its typecheck script when present.",
    "4. Change nothing. Do not edit files, do not commit, do not amend, do not stash.",
    NO_DELEGATION,
    "",
    "End your report with exactly one of these lines and nothing after it:",
    "VERDICT: PASS",
    "VERDICT: FAIL",
    "",
    "Use PASS only if you confirmed the original problem no longer happens AND every check you ran passed.",
    "Otherwise use FAIL and say precisely what failed.",
  ].join("\n");
}

export type Verdict = "pass" | "fail";

/**
 * Read the verifier's verdict. Anything that is not an explicit PASS is a
 * failure: a missing, garbled, or hedged verdict must never merge-eligible a
 * change.
 */
export function parseVerdict(text: string): Verdict {
  const matches = [...text.matchAll(/^\s*VERDICT:\s*(PASS|FAIL)\s*$/gim)];
  if (matches.length === 0) return "fail";
  return matches[matches.length - 1][1].toUpperCase() === "PASS" ? "pass" : "fail";
}

// ============================================================================
// Dispatch state machine
// ============================================================================

export type PapercutPhase =
  | "queued"
  | "fixing"
  | "verifying"
  | "resolved"
  | "needs-human"
  | "blocked";

/** Phases where a child may still be writing inside the worktree. */
const ACTIVE_PHASES: ReadonlySet<PapercutPhase> = new Set<PapercutPhase>([
  "queued",
  "fixing",
  "verifying",
]);

export interface PapercutJob {
  note: PapercutNote;
  branch: string;
  phase: PapercutPhase;
  /** Fixer attempts started so far. */
  attempts: number;
  worktreePath?: string;
  verifyPath?: string;
  activeChildId?: string;
  lastFixerReport?: string;
  lastVerifierReport?: string;
  /** Why the job is blocked, needs a human, or resolved. */
  reason?: string;
  diffStat?: string;
}

export type PapercutRole = "fixer" | "verifier";

export interface WorktreeInfo {
  path: string;
  branch?: string;
}

/** Git operations the dispatcher needs. Implemented by src/worktree.ts. */
export interface PapercutWorktreeOps {
  /** Create a worktree; `detach` checks out the branch tip without holding it. */
  create(input: { branch: string; create: boolean; detach?: boolean }): Promise<string>;
  remove(path: string): Promise<void>;
  diffStat(branch: string): Promise<string>;
  listPapercutWorktrees(): Promise<WorktreeInfo[]>;
  mergedPapercutBranches(): Promise<string[]>;
  deleteBranch(branch: string): Promise<void>;
  /** True when the branch has no commits of its own yet, so its tip is HEAD. */
  hasNoCommits(branch: string): Promise<boolean>;
}

export interface PapercutPort {
  worktrees: PapercutWorktreeOps;
  /** Launch a background child in `cwd` and return its childId. */
  spawn(input: { role: PapercutRole; cwd: string; prompt: string; branch: string }): Promise<string>;
  /** Queue a non-interrupting summary for the user. */
  notify(summary: string): void;
  /** Repository root, used only to render copy-pasteable undo commands. */
  repoRoot: string;
}

export interface ChildOutcome {
  childId: string;
  /** The child's terminal status; anything but "completed" is a failure. */
  status: string;
  text: string;
}

export interface PapercutDispatcherOptions {
  port: PapercutPort;
  /** How many fixers may run at once. One, so a bad loop stays cheap. */
  maxConcurrent?: number;
  /** Fixer attempts before a job is handed to a human. */
  maxAttempts?: number;
}

export class PapercutDispatcher {
  private readonly port: PapercutPort;
  private readonly maxConcurrent: number;
  private readonly maxAttempts: number;
  private readonly jobs = new Map<string, PapercutJob>();
  private readonly childToJob = new Map<string, string>();
  private pumping = false;

  constructor(options: PapercutDispatcherOptions) {
    this.port = options.port;
    this.maxConcurrent = options.maxConcurrent ?? 1;
    this.maxAttempts = options.maxAttempts ?? 2;
  }

  list(): PapercutJob[] {
    return [...this.jobs.values()];
  }

  get(noteId: string): PapercutJob | undefined {
    return this.jobs.get(noteId);
  }

  ownsChild(childId: string): boolean {
    return this.childToJob.has(childId);
  }

  /** Record a freshly filed papercut and start repairing it when allowed. */
  async file(note: PapercutNote): Promise<GateDecision> {
    const decision = evaluateGate(note, { repoRoot: this.port.repoRoot });
    if (this.jobs.has(note.id)) return decision;
    this.jobs.set(note.id, {
      note,
      branch: branchNameFor(note.id),
      phase: decision.dispatch ? "queued" : "blocked",
      attempts: 0,
      reason: decision.dispatch ? undefined : decision.reason,
    });
    if (decision.dispatch) await this.pump();
    return decision;
  }

  /** Human-triggered dispatch of a known note, bypassing only the owner gate. */
  async dispatchById(noteId: string): Promise<GateDecision> {
    const job = this.jobs.get(noteId);
    if (!job) return { dispatch: false, reason: `no papercut ${noteId} in this session` };
    if (job.phase === "fixing" || job.phase === "verifying") {
      return { dispatch: false, reason: `papercut ${noteId} is already ${job.phase}` };
    }
    const decision = evaluateGate(job.note, { manual: true, repoRoot: this.port.repoRoot });
    if (!decision.dispatch) {
      job.phase = "blocked";
      job.reason = decision.reason;
      return decision;
    }
    job.phase = "queued";
    job.reason = undefined;
    await this.pump();
    return decision;
  }

  private activeCount(): number {
    let active = 0;
    for (const job of this.jobs.values()) {
      if (job.phase === "fixing" || job.phase === "verifying") active += 1;
    }
    return active;
  }

  /** Start queued jobs up to the concurrency cap, oldest first. */
  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.activeCount() < this.maxConcurrent) {
        const next = [...this.jobs.values()].find((job) => job.phase === "queued");
        if (!next) return;
        await this.startFixer(next);
      }
    } finally {
      this.pumping = false;
    }
  }

  private fail(job: PapercutJob, reason: string): void {
    job.phase = "needs-human";
    job.reason = reason;
    job.activeChildId = undefined;
    this.port.notify(this.formatNeedsHuman(job));
  }

  private async startFixer(job: PapercutJob): Promise<void> {
    try {
      if (!job.worktreePath) {
        job.worktreePath = await this.port.worktrees.create({
          branch: job.branch,
          create: true,
        });
      }
      const childId = await this.port.spawn({
        role: "fixer",
        cwd: job.worktreePath,
        branch: job.branch,
        prompt: buildFixerPrompt({
          note: job.note,
          branch: job.branch,
          worktreePath: job.worktreePath,
          previousFailure: job.lastVerifierReport,
        }),
      });
      job.attempts += 1;
      job.phase = "fixing";
      job.activeChildId = childId;
      this.childToJob.set(childId, job.note.id);
    } catch (error) {
      this.fail(job, `could not start the fixer: ${message(error)}`);
    }
  }

  private async startVerifier(job: PapercutJob): Promise<void> {
    try {
      job.verifyPath = await this.port.worktrees.create({
        branch: job.branch,
        create: false,
        detach: true,
      });
      const childId = await this.port.spawn({
        role: "verifier",
        cwd: job.verifyPath,
        branch: job.branch,
        prompt: buildVerifierPrompt({
          note: job.note,
          branch: job.branch,
          worktreePath: job.verifyPath,
        }),
      });
      job.phase = "verifying";
      job.activeChildId = childId;
      this.childToJob.set(childId, job.note.id);
    } catch (error) {
      this.fail(job, `could not start the verifier: ${message(error)}`);
    }
  }

  private async dropVerifyWorktree(job: PapercutJob): Promise<void> {
    if (!job.verifyPath) return;
    const path = job.verifyPath;
    job.verifyPath = undefined;
    try {
      await this.port.worktrees.remove(path);
    } catch {
      // A leftover verification checkout is inert; /papercuts cleanup sweeps it.
    }
  }

  /**
   * Advance the state machine for one of our children. Returns false when the
   * child is not ours, so the caller can deliver its report normally.
   */
  async handleChildOutcome(outcome: ChildOutcome): Promise<boolean> {
    const noteId = this.childToJob.get(outcome.childId);
    if (!noteId) return false;
    this.childToJob.delete(outcome.childId);
    const job = this.jobs.get(noteId);
    if (!job) return true;
    job.activeChildId = undefined;

    if (job.phase === "fixing") {
      job.lastFixerReport = outcome.text;
      if (outcome.status !== "completed") {
        this.fail(job, `the fixer ended with status ${outcome.status}`);
        await this.pump();
        return true;
      }
      await this.startVerifier(job);
      await this.pump();
      return true;
    }

    if (job.phase === "verifying") {
      job.lastVerifierReport = outcome.text;
      const verdict = outcome.status === "completed" ? parseVerdict(outcome.text) : "fail";
      await this.dropVerifyWorktree(job);
      if (verdict === "pass") {
        await this.resolve(job);
        await this.pump();
        return true;
      }
      if (job.attempts < this.maxAttempts) {
        job.phase = "queued";
        await this.pump();
        return true;
      }
      this.fail(job, `an independent verifier rejected ${job.attempts} attempts`);
      await this.pump();
      return true;
    }

    return true;
  }

  private async resolve(job: PapercutJob): Promise<void> {
    try {
      job.diffStat = (await this.port.worktrees.diffStat(job.branch)).trim();
    } catch {
      job.diffStat = "(diffstat unavailable)";
    }
    job.phase = "resolved";
    job.reason = "verified by an independent check";
    this.port.notify(this.formatResolved(job));
  }

  private undoLines(job: PapercutJob): string[] {
    const root = this.port.repoRoot;
    const worktree = job.worktreePath ?? "(worktree already removed)";
    return [
      `  inspect: git -C ${root} diff HEAD...${job.branch}`,
      `  merge:   git -C ${root} merge --no-ff ${job.branch}`,
      `  discard: git -C ${root} worktree remove --force ${worktree} && git -C ${root} branch -D ${job.branch}`,
    ];
  }

  private formatResolved(job: PapercutJob): string {
    return [
      `Papercut ${job.note.id} has a candidate fix that passed an independent check.`,
      "",
      `  branch:   ${job.branch}`,
      `  worktree: ${job.worktreePath ?? "(none)"}`,
      `  diff:     ${job.diffStat || "(no changes reported)"}`,
      `  attempts: ${job.attempts}`,
      "",
      indent(job.note.note),
      "",
      ...this.undoLines(job),
      "",
      "Nothing was merged and the working tree was never touched.",
    ].join("\n");
  }

  private formatNeedsHuman(job: PapercutJob): string {
    const lines = [
      `Papercut ${job.note.id} needs a human: ${job.reason ?? "unknown reason"}.`,
      "",
      `  branch:   ${job.branch}`,
      `  worktree: ${job.worktreePath ?? "(none)"}`,
      `  attempts: ${job.attempts}`,
      "",
      indent(job.note.note),
    ];
    if (job.lastFixerReport) {
      lines.push("", "Fixer report:", indent(job.lastFixerReport));
    }
    if (job.lastVerifierReport) {
      lines.push("", "Verifier report:", indent(job.lastVerifierReport));
    }
    lines.push("", ...this.undoLines(job), "", "Nothing was merged.");
    return lines.join("\n");
  }

  /**
   * Remove worktrees whose papercut branch is already merged, and delete those
   * branches. Unmerged work is left alone: cleanup must never destroy a fix a
   * human has not looked at yet.
   *
   * "Merged" alone is not enough to be safe. A branch created at HEAD with no
   * commits on it yet is trivially an ancestor of HEAD, so git reports it as
   * merged, and that is exactly the state a fixer is in from the moment its
   * worktree exists until its first commit. Cleaning that up would delete the
   * checkout out from under a running child. Active jobs are skipped by phase,
   * and any branch with no commits is skipped regardless of phase, because a
   * detached background fixer can outlive the session that started it.
   */
  async cleanupMerged(): Promise<string[]> {
    const merged = new Set(await this.port.worktrees.mergedPapercutBranches());
    if (merged.size === 0) return [];
    const active = new Set(
      [...this.jobs.values()]
        .filter((job) => ACTIVE_PHASES.has(job.phase))
        .map((job) => job.branch),
    );
    const removed: string[] = [];
    for (const worktree of await this.port.worktrees.listPapercutWorktrees()) {
      if (!worktree.branch || !merged.has(worktree.branch)) continue;
      if (active.has(worktree.branch)) continue;
      if (await this.port.worktrees.hasNoCommits(worktree.branch)) continue;
      await this.port.worktrees.remove(worktree.path);
      await this.port.worktrees.deleteBranch(worktree.branch);
      removed.push(worktree.branch);
      const job = [...this.jobs.values()].find((entry) => entry.branch === worktree.branch);
      if (job) {
        job.worktreePath = undefined;
        job.phase = "resolved";
        job.reason = "merged and cleaned up";
      }
    }
    return removed;
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}

/** One line per job for the /papercuts list view. */
export function formatJobs(jobs: PapercutJob[]): string {
  if (jobs.length === 0) return "papercuts: none filed in this session";
  const lines = [`papercuts: ${jobs.length} in this session`, ""];
  for (const job of jobs) {
    const owner = job.note.owner ?? "unassigned";
    lines.push(`${job.note.id}  ${job.phase.padEnd(11)} owner=${owner.padEnd(10)} ${job.branch}`);
    const first = job.note.note.split("\n")[0] ?? "";
    lines.push(`  ${first}`);
    if (job.reason) lines.push(`  reason: ${job.reason}`);
    if (job.diffStat) lines.push(`  diff: ${job.diffStat}`);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}
