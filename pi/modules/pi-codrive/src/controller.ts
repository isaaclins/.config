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
  prompt?: string;
  model: string;
  context: "fresh" | "fork";
  forkSessionFile?: string;
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
}

export interface SpawnedChild {
  childId: string;
  paneId: string;
  model: string;
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
    const model = request.model ?? this.policy.defaultModel;
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
    const launched = await this.backend.spawn({
      projectRoot: this.session.projectRoot,
      prompt: request.prompt,
      model,
      context,
      forkSessionFile,
      thinking: this.policy.defaultThinking,
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
    return { childId, paneId: launched.paneId, model };
  }
}
