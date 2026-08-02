import { execFile } from "node:child_process";
import type { BackendSpawnResult, CodriveBackend, SpawnLaunch } from "./controller.ts";
import { buildPiArguments } from "./fork.ts";
import { CHILD_ID_ENV, NONCE_ENV, SESSION_ID_ENV, SOCKET_ENV } from "./ipc-env.ts";

export interface TmuxBackendOptions {
  /** Override the tmux binary path */
  tmuxPath?: string;
  /** Override the tmux server socket name (for testing isolation) */
  serverSocket?: string;
  /** Split direction: horizontal or vertical */
  split?: "horizontal" | "vertical";
  /** Pane size (lines or percentage string) */
  size?: number | string;
  /** Pi command to launch (default: "pi") */
  piCommand?: string;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export class TmuxBackend implements CodriveBackend {
  readonly name = "tmux";
  private readonly tmux: string;
  private readonly serverArgs: string[];
  private readonly split: "horizontal" | "vertical";
  private readonly size?: number | string;
  private readonly piCommand: string;

  constructor(options: TmuxBackendOptions = {}) {
    this.tmux = options.tmuxPath ?? "tmux";
    this.serverArgs = options.serverSocket ? ["-L", options.serverSocket] : [];
    this.split = options.split ?? "vertical";
    this.size = options.size;
    this.piCommand = options.piCommand ?? "pi";
  }

  private exec(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    const fullArgs = [...this.serverArgs, ...args];
    return new Promise((resolve) => {
      execFile(this.tmux, fullArgs, { timeout: 10000 }, (error, stdout, stderr) => {
        resolve({
          code: error ? ((error as unknown as { status?: number }).status ?? 1) : 0,
          stdout: stdout ?? "",
          stderr: stderr ?? "",
        });
      });
    });
  }

  async spawn(launch: SpawnLaunch): Promise<BackendSpawnResult> {
    const piArgs = buildPiArguments({
      prompt: launch.prompt,
      model: launch.model,
      thinking: launch.thinking,
      sessionId: launch.sessionId,
      resumeSessionFile: launch.resumeSessionFile,
      fork: launch.forkSessionFile
        ? {
            sessionFile: launch.forkSessionFile,
            thinkingOverride: launch.thinkingOverride,
          }
        : undefined,
    });

    const launchCmd = [this.piCommand, ...piArgs].map(shellQuote).join(" ");

    const envParts: string[] = [];
    if (launch.reportSocket) envParts.push(`${SOCKET_ENV}=${shellQuote(launch.reportSocket)}`);
    if (launch.reportNonce) envParts.push(`${NONCE_ENV}=${shellQuote(launch.reportNonce)}`);
    envParts.push(`${SESSION_ID_ENV}=${shellQuote(launch.identity.parentSessionId)}`);
    envParts.push(`${CHILD_ID_ENV}=${shellQuote(launch.identity.childId)}`);

    const command = `${envParts.join(" ")} exec ${launchCmd}`;

    const args = [
      "split-window",
      this.split === "horizontal" ? "-h" : "-v",
      "-c", launch.projectRoot,
      "-P", "-F", "#{pane_id}",
    ];
    if (this.size) args.push("-l", String(this.size));
    args.push(command);

    const result = await this.exec(args);
    if (result.code !== 0) {
      throw new Error(`tmux split-window failed: ${result.stderr || result.stdout || `exit ${result.code}`}`);
    }
    const paneId = result.stdout.trim();
    if (!/^%\d+$/.test(paneId)) throw new Error("tmux returned an invalid pane ID");
    return { paneId };
  }

  async isAlive(paneId: string): Promise<boolean> {
    const result = await this.exec([
      "display-message", "-p", "-t", paneId, "#{pane_dead}",
    ]);
    return result.code === 0 && result.stdout.trim() === "0";
  }

  async read(paneId: string, maxLines: number): Promise<string> {
    const result = await this.exec([
      "capture-pane", "-p", "-t", paneId, "-S", `-${maxLines}`,
    ]);
    if (result.code !== 0) throw new Error(`capture-pane failed: ${result.stderr}`);
    return result.stdout;
  }

  async send(paneId: string, text: string): Promise<void> {
    const sendText = await this.exec(["send-keys", "-t", paneId, "-l", text]);
    if (sendText.code !== 0) throw new Error(`send-keys failed: ${sendText.stderr}`);
    const sendEnter = await this.exec(["send-keys", "-t", paneId, "Enter"]);
    if (sendEnter.code !== 0) throw new Error(`send Enter failed: ${sendEnter.stderr}`);
  }
}
