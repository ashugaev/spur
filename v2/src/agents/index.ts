import {
  buildClaudePlan,
  buildClaudeRestorePlan,
  buildClaudeResumePlan,
  findClaudeSessionId,
  probeClaudeState,
} from "./claude.js";
import {
  buildCodexPlan,
  buildCodexRestorePlan,
  buildCodexResumePlan,
  findCodexSessionId,
  probeCodexState,
} from "./codex.js";
import type { AgentName } from "../types.js";
import type { AgentLaunchPlan, AgentResumePlan, AgentStateProbe } from "./types.js";
export type { AgentLaunchPlan, AgentResumePlan, AgentStateProbe } from "./types.js";

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

function extractCommandBinary(launchCommand: string, fallbackBinary: string): string {
  const trimmed = launchCommand.trim();
  if (!trimmed) {
    return fallbackBinary;
  }
  if (trimmed.startsWith("'")) {
    const closing = trimmed.indexOf("'", 1);
    if (closing > 1) {
      return trimmed.slice(1, closing);
    }
  }
  if (trimmed.startsWith('"')) {
    const closing = trimmed.indexOf('"', 1);
    if (closing > 1) {
      return trimmed.slice(1, closing);
    }
  }
  return trimmed.split(/\s+/, 1)[0] || fallbackBinary;
}

export function buildAgentResumePlan(
  agent: AgentName,
  agentSessionId: string,
  launchCommand = "",
): AgentResumePlan {
  const binary = extractCommandBinary(launchCommand, agent);
  if (agent === "claude") {
    return buildClaudeResumePlan(agentSessionId, binary);
  }
  return buildCodexResumePlan(agentSessionId, binary);
}

export async function findAgentSessionId(
  agent: AgentName,
  worktreePath: string,
): Promise<string | null> {
  if (agent === "claude") {
    return findClaudeSessionId(worktreePath);
  }
  return findCodexSessionId(worktreePath);
}

export async function probeAgentState(
  agent: AgentName,
  worktreePath: string,
  args: { processAlive: boolean; signalWindowMs: number },
): Promise<AgentStateProbe | null> {
  if (agent === "claude") {
    return probeClaudeState(worktreePath, args);
  }
  return probeCodexState(worktreePath, args);
}
