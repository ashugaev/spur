import {
  buildClaudePlan,
  buildClaudeRestorePlan,
  getClaudeActivityAt,
} from "./claude.js";
import { buildCodexPlan, buildCodexRestorePlan, getCodexActivityAt } from "./codex.js";
import type { AgentName } from "../types.js";
import type { AgentLaunchPlan } from "./types.js";
export type { AgentLaunchPlan } from "./types.js";

export function parseAgentName(agent: string): AgentName {
  if (agent === "claude" || agent === "codex") {
    return agent;
  }

  throw new Error(`Unsupported agent: ${agent}`);
}

export function buildAgentLaunchPlan(agent: AgentName, prompt: string) {
  if (agent === "claude") {
    return buildClaudePlan(prompt);
  }
  return buildCodexPlan(prompt);
}

export async function buildAgentRestorePlan(
  agent: AgentName,
  worktreePath: string,
  prompt: string,
): Promise<AgentLaunchPlan | null> {
  if (agent === "claude") {
    return buildClaudeRestorePlan(worktreePath, prompt);
  }
  return buildCodexRestorePlan(worktreePath, prompt);
}

export async function getAgentActivityAt(
  agent: AgentName,
  worktreePath: string,
): Promise<Date | null> {
  if (agent === "claude") {
    return getClaudeActivityAt(worktreePath);
  }
  return getCodexActivityAt(worktreePath);
}
