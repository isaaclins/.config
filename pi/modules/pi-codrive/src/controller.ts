import { randomUUID } from "node:crypto";
import { assertCanDelegate, type HarnessSession, type TrustMode } from "./session.ts";
import type { ForkResult } from "./fork.ts";

export interface ChildIdentity {
  childId: string;
  parentSessionId: string;
  role: "subagent";
  delegationDepth: number;
  trust: TrustMode;
}

export interface SpawnLaunch {
  projectRoot: string;
  /**
   * Working directory for the child pane, overriding projectRoot. Used to run
   * a child inside a git worktree instead of the live tree, so its edits can
   * never touch the directory the user is working in.
   */
  cwd?: string;
  /**
   * Launch invisibly: a detached tmux window instead of a split of the user's
   * current view. The pane id stays real, so isAlive/read/send keep working.
   */
  background?: boolean;
  prompt?: string;
  model: string;
  context: "fresh" | "fork";
  forkSessionFile?: string;
  /** Pre-assigned pi session id emitted as `--session-id` for a fresh launch or resume. */
  sessionId?: string;
  /** A recorded session file to resume, emitted as `--session <file>`. */
  resumeSessionFile?: string;
  thinking?: string;
  thinkingOverride?: "off";
  identity: ChildIdentity;
  reportSocket?: string;
  reportNonce?: string;
}

export interface BackendSpawnResult {
  paneId: string;
}

export interface CodriveBackend {
  readonly name: string;
  spawn(launch: SpawnLaunch): Promise<BackendSpawnResult>;
  isAlive(paneId: string): Promise<boolean>;
  read(paneId: string, maxLines: number): Promise<string>;
  send(paneId: string, text: string): Promise<void>;
}

export interface DelegationAccountingEvent {
  sessionId: string;
  childId: string;
  backend: string;
  model: string;
  context: "fresh" | "fork";
  timestamp: string;
}

export interface CodrivePolicy {
  defaultModel: string;
  defaultThinking?: string;
  allowedModels?: string[];
  account(event: DelegationAccountingEvent): void | Promise<void>;
}

export interface SpawnRequest {
  prompt?: string;
  model?: string;
  context?: "fresh" | "fork";
  forkSessionFile?: string;
  /** Run the child here instead of the session's project root. */
  cwd?: string;
  /** Spawn into a detached window so the user's view is never taken over. */
  background?: boolean;
}

export interface SpawnedChild {
  childId: string;
  paneId: string;
  model: string;
  /** Where the child was actually launched: its cwd override or the project root. */
  cwd: string;
  /** True when the child was launched into a detached, invisible window. */
  background: boolean;
  /** The pi session id pre-assigned to this child (fresh launches). */
  piSessionId?: string;
  /** The recorded session file the child was launched with (fork launches). */
  piSessionFile?: string;
}

export interface ResumeRequest {
  childId: string;
  model: string;
  /** Relaunch here; a worktree child must come back inside its worktree. */
  cwd?: string;
  /** Relaunch invisibly, as the original background spawn was. */
  background?: boolean;
  /** Resume by exact pi session id, emitted as `--session-id <id>`. */
  sessionId?: string;
  /** Resume by session file, emitted as `--session <file>`. */
  resumeSessionFile?: string;
  prompt?: string;
}

export interface CodriveControllerOptions {
  session: HarnessSession;
  backend: CodriveBackend;
  policy: CodrivePolicy;
  /**
   * Resolves a forked session at spawn time. Called only when a spawn
   * request uses context "fork". Returning a ForkResult attaches the
   * branched session file (and any thinking override) to the launch.
   */
  forkResolver?: () => ForkResult;
  /**
   * The parent's authenticated report-transport socket path and nonce
   * (from ReportServer.start()). Every spawned child receives these as
   * env vars so it can call sendReport() back to this exact parent. If
   * omitted (for example the platform has no IPC support), children are
   * spawned without report credentials and can never report home
   * automatically.
   */
  reportSocket?: string;
  reportNonce?: string;
}

export class CodriveController {
  readonly session: HarnessSession;
  private readonly backend: CodriveBackend;
  private readonly policy: CodrivePolicy;
  private readonly forkResolver?: () => ForkResult;
  private readonly reportSocket?: string;
  private readonly reportNonce?: string;

  constructor(options: CodriveControllerOptions) {
    this.session = options.session;
    this.backend = options.backend;
    this.policy = options.policy;
    this.forkResolver = options.forkResolver;
    this.reportSocket = options.reportSocket;
    this.reportNonce = options.reportNonce;
  }

  async spawn(request: SpawnRequest): Promise<SpawnedChild> {
    assertCanDelegate(this.session);
    const requestedModel = request.model?.trim();
    const usesDefaultModel = !requestedModel;
    const model = requestedModel || this.policy.defaultModel;
    if (
      this.policy.allowedModels &&
      !this.policy.allowedModels.includes(model)
    ) {
      throw new Error(`Model ${model} is not allowed by codrive policy`);
    }
    const childId = randomUUID();
    const context = request.context ?? "fresh";
    let forkSessionFile = request.forkSessionFile;
    let thinkingOverride: "off" | undefined;
    // A fresh child gets a pre-assigned pi session id so the parent knows its
    // session identity before it ever starts, and resume is deterministic.
    const piSessionId = context === "fresh" ? randomUUID() : undefined;
    if (context === "fork") {
      if (this.forkResolver) {
        const fork = this.forkResolver();
        forkSessionFile = fork.sessionFile;
        thinkingOverride = fork.thinkingOverride;
      }
      if (!forkSessionFile) {
        throw new Error(
          "Fork context requires a forkSessionFile or a configured fork source",
        );
      }
    }
    const cwd = request.cwd?.trim() || this.session.projectRoot;
    const background = request.background === true;
    const launched = await this.backend.spawn({
      projectRoot: this.session.projectRoot,
      cwd,
      background,
      prompt: request.prompt,
      model,
      context,
      forkSessionFile,
      sessionId: piSessionId,
      thinking: usesDefaultModel ? this.policy.defaultThinking : undefined,
      thinkingOverride,
      reportSocket: this.reportSocket,
      reportNonce: this.reportNonce,
      identity: {
        childId,
        parentSessionId: this.session.sessionId,
        role: "subagent",
        delegationDepth: this.session.delegationDepth + 1,
        trust: this.session.trust,
      },
    });
    await this.policy.account({
      sessionId: this.session.sessionId,
      childId,
      backend: this.backend.name,
      model,
      context,
      timestamp: new Date().toISOString(),
    });
    this.session.childIds.push(childId);
    return {
      childId,
      paneId: launched.paneId,
      model,
      cwd,
      background,
      piSessionId,
      piSessionFile: forkSessionFile,
    };
  }

  /**
   * Relaunch an existing child into a fresh tmux pane, reusing its childId and
   * resuming its recorded pi session. The session is opened non-interactively
   * via `--session-id` (or `--session <file>` for a recorded file), so no
   * interactive picker is involved and the orchestrator's own session can
   * never be resumed by accident.
   */
  async resume(request: ResumeRequest): Promise<SpawnedChild> {
    assertCanDelegate(this.session);
    if (!request.sessionId && !request.resumeSessionFile) {
      throw new Error("Resume requires a recorded session id or session file");
    }
    const cwd = request.cwd?.trim() || this.session.projectRoot;
    const background = request.background === true;
    const launched = await this.backend.spawn({
      projectRoot: this.session.projectRoot,
      cwd,
      background,
      prompt: request.prompt,
      model: request.model,
      context: "fresh",
      sessionId: request.sessionId,
      resumeSessionFile: request.resumeSessionFile,
      reportSocket: this.reportSocket,
      reportNonce: this.reportNonce,
      identity: {
        childId: request.childId,
        parentSessionId: this.session.sessionId,
        role: "subagent",
        delegationDepth: this.session.delegationDepth + 1,
        trust: this.session.trust,
      },
    });
    await this.policy.account({
      sessionId: this.session.sessionId,
      childId: request.childId,
      backend: this.backend.name,
      model: request.model,
      context: "fresh",
      timestamp: new Date().toISOString(),
    });
    return {
      childId: request.childId,
      paneId: launched.paneId,
      model: request.model,
      cwd,
      background,
      piSessionId: request.sessionId,
      piSessionFile: request.resumeSessionFile,
    };
  }
}
