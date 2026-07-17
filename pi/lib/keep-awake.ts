import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Refcounting for the machine-global `pmset -a disablesleep` toggle across
 * concurrent pi sessions (orchestrator plus spawned subagent panes). Each
 * session claims a pid file; sleep is only restored when the last live
 * session releases. Stale pid files from crashed sessions are pruned on
 * release, so a later clean shutdown always restores normal sleep.
 */

export function keepAwakeDir(env = process.env): string {
  return join(env.XDG_RUNTIME_DIR || tmpdir(), "pi-keep-awake");
}

export function caffeinateArgs(pid: number): string[] {
  // -d display, -i idle, -m disk, -s system (AC power), -u user-active,
  // -w exit when the watched pid exits, so a pi crash never leaks caffeinate.
  return ["-dimsu", "-w", String(pid)];
}

export function claimKeepAwake(dir: string, pid: number): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${pid}.pid`), String(pid), "utf-8");
}

/**
 * Release this session's claim and prune claims of dead processes.
 * Returns true when no live claim remains, i.e. sleep may be restored.
 */
export function releaseKeepAwake(
  dir: string,
  pid: number,
  isAlive: (pid: number) => boolean = defaultIsAlive,
): boolean {
  rmSync(join(dir, `${pid}.pid`), { force: true });
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return true;
  }
  let liveClaims = 0;
  for (const entry of entries) {
    const match = /^(\d+)\.pid$/.exec(entry);
    if (!match) continue;
    const claimedPid = Number(match[1]);
    if (claimedPid !== pid && isAlive(claimedPid)) {
      liveClaims++;
      continue;
    }
    rmSync(join(dir, entry), { force: true });
  }
  return liveClaims === 0;
}

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
