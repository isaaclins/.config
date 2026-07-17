import type { SpawnReportRecord } from "./codrive-state.ts";
import type { ForkResult } from "./codrive-fork.ts";

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function buildPiArguments(
  prompt: string | undefined,
  configuredModel: string | null,
  configuredThinking: string | null,
  overrideModel?: string,
  fork?: ForkResult,
): string[] {
  const args: string[] = [];
  const model = overrideModel ?? configuredModel;
  if (model) args.push("--model", model);
  const thinking = fork?.thinkingOverride ?? configuredThinking;
  if (thinking) args.push("--thinking", thinking);
  if (fork) args.push("--session", fork.sessionFile);
  if (prompt) args.push(prompt);
  return args;
}

export function buildLaunch(command: string, args: string[]): string {
  return [command, ...args].map(shellQuote).join(" ");
}

export function paneRoleArgs(
  pane: string,
  roleOption: string,
  role: "orchestrator" | "subagent" | null,
): string[] {
  return role
    ? ["set-option", "-p", "-t", pane, roleOption, role]
    : ["set-option", "-p", "-u", "-t", pane, roleOption];
}

export async function checkedPaneExec(
  pane: string,
  operation: string,
  args: string[],
  exec: (
    args: string[],
  ) => Promise<{ code: number; stdout: string; stderr: string }>,
  onDead: () => void,
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const result = await exec(args);
    if (result.code !== 0) {
      throw new Error(
        `${operation} failed for pane ${pane}: ${result.stderr || result.stdout || `tmux exit ${result.code}`}. Report history is preserved.`,
      );
    }
    return result;
  } catch (error) {
    onDead();
    if ((error as Error).message.includes("Report history is preserved"))
      throw error;
    throw new Error(
      `${operation} failed for pane ${pane}: ${(error as Error).message}. Report history is preserved.`,
    );
  }
}

export function markPaneDead(
  pane: string,
  live: Set<string>,
  waiting: Set<string>,
  histories: Map<string, SpawnReportRecord[]>,
): { wasWaiting: boolean; hasReports: boolean } {
  live.delete(pane);
  const wasWaiting = waiting.delete(pane);
  return { wasWaiting, hasReports: (histories.get(pane)?.length ?? 0) > 0 };
}
