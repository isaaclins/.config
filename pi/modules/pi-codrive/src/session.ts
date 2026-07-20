import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";

export type HarnessRole = "orchestrator" | "subagent";
export type TrustMode = "trusted" | "untrusted" | "inherit";

export interface HarnessSession {
  sessionId: string;
  projectRoot: string;
  role: HarnessRole;
  delegationDepth: number;
  trust: TrustMode;
  childIds: string[];
}

export interface CreateHarnessSessionInput {
  sessionId?: string;
  projectRoot: string;
  role: HarnessRole;
  delegationDepth: number;
  trust: TrustMode;
  childIds?: string[];
}

export function createHarnessSession(
  input: CreateHarnessSessionInput,
): HarnessSession {
  if (!Number.isInteger(input.delegationDepth) || input.delegationDepth < 0) {
    throw new Error("delegationDepth must be a non-negative integer");
  }
  return {
    sessionId: input.sessionId ?? randomUUID(),
    projectRoot: realpathSync(input.projectRoot),
    role: input.role,
    delegationDepth: input.delegationDepth,
    trust: input.trust,
    childIds: [...(input.childIds ?? [])],
  };
}

export function assertCanDelegate(session: HarnessSession): void {
  if (session.delegationDepth >= 1) {
    throw new Error("Codrive permits only one delegation level");
  }
}
