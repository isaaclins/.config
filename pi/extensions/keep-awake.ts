// Keep the Mac awake for the lifetime of every pi process (interactive TUI,
// -p runs, spawned subagent panes), replacing the old claude-only `cc` fish
// wrapper behavior for the pi harness:
//   1. caffeinate -dimsu -w <pi pid>: blocks idle/system/display sleep and
//      dies with pi automatically, so crashes never leak an assertion.
//   2. Optional sudo -n pmset -a disablesleep 1 for lid-closed sleep. This is
//      machine-global and therefore requires PI_ALLOW_GLOBAL_DISABLESLEEP=1
//      in addition to the passwordless sudoers grant. It is never enabled by
//      merely starting Pi.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn, type ChildProcess } from "node:child_process";
import { platform } from "node:os";
import {
  caffeinateArgs,
  claimKeepAwake,
  keepAwakeDir,
  releaseKeepAwake,
} from "../lib/keep-awake.ts";

const PMSET = "/usr/bin/pmset";

export function shouldDisableLidSleep(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.PI_ALLOW_GLOBAL_DISABLESLEEP === "1";
}

export default function keepAwake(pi: ExtensionAPI): void {
  if (platform() !== "darwin") return;
  let caffeinate: ChildProcess | undefined;
  let lidClosedArmed = false;

  const setDisableSleep = async (value: 0 | 1): Promise<boolean> => {
    try {
      const result = await pi.exec(
        "sudo",
        ["-n", PMSET, "-a", "disablesleep", String(value)],
        { timeout: 5000 },
      );
      return result.code === 0;
    } catch {
      return false;
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    try {
      caffeinate = spawn("caffeinate", caffeinateArgs(process.pid), {
        detached: true,
        stdio: "ignore",
      });
      caffeinate.unref();
      claimKeepAwake(keepAwakeDir(), process.pid);
    } catch {
      // Keep-awake must never break pi startup.
    }
    const lidSleepRequested = shouldDisableLidSleep();
    lidClosedArmed = lidSleepRequested && (await setDisableSleep(1));
    if (lidSleepRequested && !lidClosedArmed && ctx.mode === "tui") {
      ctx.ui.notify(
        "keep-awake: idle sleep blocked; for lid-closed keep-awake run bootstrap/cli/shell/install-pmset-keepawake.sh once",
        "info",
      );
    }
  });

  pi.on("session_shutdown", async () => {
    try {
      caffeinate?.kill();
    } catch {
      // caffeinate -w exits on its own when pi dies.
    }
    caffeinate = undefined;
    let lastClaim = true;
    try {
      lastClaim = releaseKeepAwake(keepAwakeDir(), process.pid);
    } catch {
      // Fall through and attempt to restore sleep anyway.
    }
    if (lidClosedArmed && lastClaim) await setDisableSleep(0);
    lidClosedArmed = false;
  });
}
