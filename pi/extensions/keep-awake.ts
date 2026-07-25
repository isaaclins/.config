// Keep the Mac awake for the lifetime of every pi process (interactive TUI,
// -p runs, spawned subagent panes):
//   1. Automatic: caffeinate -dimsu -w <pi pid> blocks idle/system/display
//      sleep and dies with pi, so a crash never leaks an assertion.
//   2. Manual: /clam toggles lid-closed keep-awake (pmset -a disablesleep).
//      That setting is machine-global, so it is never armed by merely
//      starting Pi; you turn it on for a run and it is restored when the
//      last claiming session disarms or exits.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { spawn, type ChildProcess } from "node:child_process";
import { platform } from "node:os";
import {
  caffeinateArgs,
  claimKeepAwake,
  keepAwakeDir,
  releaseKeepAwake,
} from "../lib/keep-awake.ts";

const PMSET = "/usr/bin/pmset";
const SUDO_HINT =
  "run bootstrap/cli/shell/install-pmset-keepawake.sh once to grant passwordless pmset";

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

  const disarm = async (): Promise<void> => {
    if (!lidClosedArmed) return;
    lidClosedArmed = false;
    let lastClaim = true;
    try {
      lastClaim = releaseKeepAwake(keepAwakeDir(), process.pid);
    } catch {
      // Fall through and attempt to restore sleep anyway.
    }
    if (lastClaim) await setDisableSleep(0);
  };

  pi.on("session_start", async () => {
    try {
      caffeinate = spawn("caffeinate", caffeinateArgs(process.pid), {
        detached: true,
        stdio: "ignore",
      });
      caffeinate.unref();
    } catch {
      // Keep-awake must never break pi startup.
    }
  });

  pi.on("session_shutdown", async () => {
    try {
      caffeinate?.kill();
    } catch {
      // caffeinate -w exits on its own when pi dies.
    }
    caffeinate = undefined;
    await disarm();
  });

  pi.registerCommand("clam", {
    description: "Toggle lid-closed keep-awake (pmset disablesleep) for this session",
    handler: async (_args, ctx: ExtensionContext) => {
      if (lidClosedArmed) {
        await disarm();
        ctx.ui.notify("clam off: the Mac sleeps normally again", "info");
        return;
      }
      if (!(await setDisableSleep(1))) {
        ctx.ui.notify(`clam failed: no passwordless sudo for pmset (${SUDO_HINT})`, "error");
        return;
      }
      try {
        claimKeepAwake(keepAwakeDir(), process.pid);
      } catch {
        // The claim file is only used to refcount concurrent sessions.
      }
      lidClosedArmed = true;
      ctx.ui.notify("clam on: the Mac stays awake with the lid closed", "info");
    },
  });
}
