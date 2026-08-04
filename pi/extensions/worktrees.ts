import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_ROOT_DIRNAME,
  WorktreeError,
  createWorktree,
  isGitRepo,
  listWorktrees,
  pruneStale,
  removeWorktree,
  repoRootOf,
  type PruneReport,
  type WorktreeEntry,
} from "../lib/worktrees.ts";

/**
 * Worktree surface for delegation.
 *
 * `/worktree` is the human affordance (list, add, remove, prune) and
 * `worktree_create` is the model-facing seam: an orchestrator calls it to get
 * an isolated checkout before delegating, then launches the child with its
 * cwd set to the returned path. Both are thin wrappers, since lib/worktrees.ts
 * owns every naming, safety, and cleanup rule.
 *
 * Every entry point is guarded on being inside a git work tree, because the
 * whole feature is meaningless otherwise and a raw git error is worse than a
 * one-line explanation.
 */

const USAGE = "Usage: /worktree [list | add <slug> | remove <slug> [--force] | prune [--dry-run] [--force]]";

interface ParsedArgs {
  command: string;
  target?: string;
  force: boolean;
  dryRun: boolean;
}

export function parseWorktreeArgs(raw: string | undefined): ParsedArgs {
  const parts = (raw ?? "").trim().split(/\s+/).filter(Boolean);
  const flags = new Set(parts.filter((part) => part.startsWith("-")));
  const positional = parts.filter((part) => !part.startsWith("-"));
  return {
    command: (positional[0] ?? "list").toLowerCase(),
    target: positional[1],
    force: flags.has("--force") || flags.has("-f"),
    dryRun: flags.has("--dry-run") || flags.has("-n"),
  };
}

export function formatEntries(entries: WorktreeEntry[]): string {
  const lines = entries.map((entry) => {
    const marker = entry.isMain ? "*" : " ";
    const label = entry.branch ?? (entry.detached ? `(detached ${entry.head.slice(0, 8)})` : "(bare)");
    const flags: string[] = [];
    if (entry.locked) flags.push("locked");
    if (entry.prunable) flags.push("prunable");
    const suffix = flags.length > 0 ? `  [${flags.join(", ")}]` : "";
    return `${marker} ${label}\t${entry.path}${suffix}`;
  });
  return lines.join("\n");
}

export function formatPrune(report: PruneReport, dryRun: boolean): string {
  const parts: string[] = [dryRun ? "worktree prune (dry run)" : "worktree prune"];
  const section = (title: string, values: string[]): void => {
    if (values.length === 0) return;
    parts.push(`${title}:\n  ${values.join("\n  ")}`);
  };
  section("stale records", report.prunedWorktrees);
  section("deleted branches", report.deletedBranches);
  section("kept (unmerged) branches", report.keptBranches);
  section("orphan directories", report.orphanDirectories);
  if (parts.length === 1) parts.push("nothing stale");
  return parts.join("\n");
}

function describeError(error: unknown): string {
  if (error instanceof WorktreeError) return `worktree: ${error.message}`;
  return `worktree: ${(error as Error).message}`;
}

export default function (pi: ExtensionAPI) {
  function requireRepo(ctx: ExtensionContext): string | undefined {
    if (isGitRepo(ctx.cwd)) return repoRootOf(ctx.cwd);
    ctx.ui.notify("worktree: not inside a git repository", "warning");
    return undefined;
  }

  pi.registerCommand("worktree", {
    description: "Manage delegation worktrees: list, add <slug>, remove <slug>, prune",
    getArgumentCompletions(prefix) {
      const options = ["list", "add", "remove", "prune"];
      const matches = options
        .filter((option) => option.startsWith(prefix.toLowerCase()))
        .map((option) => ({ value: option, label: option }));
      return matches.length > 0 ? matches : null;
    },
    handler: async (args, ctx) => {
      const repoRoot = requireRepo(ctx);
      if (!repoRoot) return;

      const parsed = parseWorktreeArgs(args);
      try {
        if (parsed.command === "list") {
          const entries = listWorktrees(repoRoot);
          ctx.ui.notify(formatEntries(entries), "info");
          return;
        }

        if (parsed.command === "add") {
          if (!parsed.target) {
            ctx.ui.notify(USAGE, "warning");
            return;
          }
          const created = createWorktree(repoRoot, parsed.target);
          ctx.ui.notify(`worktree: ${created.branch} at ${created.path}`, "info");
          return;
        }

        if (parsed.command === "remove") {
          if (!parsed.target) {
            ctx.ui.notify(USAGE, "warning");
            return;
          }
          const removed = removeWorktree(repoRoot, parsed.target, { force: parsed.force });
          const branchNote = removed.branchDeleted
            ? "branch deleted"
            : `branch ${removed.branch ?? "(none)"} kept`;
          ctx.ui.notify(`worktree: removed ${removed.path} (${branchNote})`, "info");
          return;
        }

        if (parsed.command === "prune") {
          const report = pruneStale(repoRoot, { force: parsed.force, dryRun: parsed.dryRun });
          ctx.ui.notify(formatPrune(report, parsed.dryRun), "info");
          return;
        }

        ctx.ui.notify(USAGE, "warning");
      } catch (error) {
        ctx.ui.notify(describeError(error), "error");
      }
    },
  });

  pi.registerTool({
    name: "worktree_create",
    label: "Create Worktree",
    description:
      `Create an isolated git worktree so a delegated agent can write files without sharing this working directory. Returns the checkout path and its branch wt/<slug>; launch the child with its cwd set to that path and review the result with 'git diff <base>...wt/<slug>'. The checkout lives under ${DEFAULT_ROOT_DIRNAME}/ and is excluded from git status. The returned slug can differ from the requested one when the name is taken, so always use the returned path.`,
    promptGuidelines: [
      "Create a worktree before delegating any child that writes files; keep read-only investigation in the shared tree.",
      "Name the slug after the task, not the agent, so the branch reads like a change and not like a process.",
    ],
    parameters: {
      type: "object",
      properties: {
        slug: {
          type: "string",
          description: "Short task label, normalized to [a-z0-9-], e.g. 'fix-login-redirect'",
        },
        startPoint: {
          type: "string",
          description: "Optional commit-ish the new branch starts from (default: current HEAD)",
        },
      },
      required: ["slug"],
    },
    async execute(_id, params: { slug: string; startPoint?: string }, _signal, _onUpdate, ctx) {
      const cwd = ctx?.cwd ?? process.cwd();
      if (!isGitRepo(cwd)) throw new Error("worktree_create requires a git repository");

      const repoRoot = repoRootOf(cwd);
      const created = createWorktree(repoRoot, params.slug, { startPoint: params.startPoint });
      return {
        content: [
          {
            type: "text",
            text: `Created worktree ${created.path} on branch ${created.branch}. Launch the delegated agent with cwd ${created.path}; review with 'git diff HEAD...${created.branch}' and clean up with '/worktree remove ${created.slug}'.`,
          },
        ],
        details: { path: created.path, branch: created.branch, slug: created.slug, repoRoot },
      };
    },
  });
}
