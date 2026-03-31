import { buildClaudePlan, buildClaudeResumePlan, findClaudeSessionId } from "./claude.js";
import { buildCodexPlan, buildCodexResumePlan, findCodexSessionId } from "./codex.js";
import type { AgentName } from "../types.js";
import type { AgentLaunchPlan, AgentResumePlan } from "./types.js";
export type { AgentLaunchPlan, AgentResumePlan } from "./types.js";

export function parseAgentName(agent: string): AgentName {
  if (agent === "claude" || agent === "codex") {
    return agent;
  }

  throw new Error(`Unsupported agent: ${agent}`);
}

export function buildAgentLaunchPlan(agent: AgentName, prompt: string): AgentLaunchPlan {
  return agent === "claude" ? buildClaudePlan(prompt) : buildCodexPlan(prompt);
}

function extractCommandBinary(launchCommand: string, fallbackBinary: string): string {
  const trimmed = launchCommand.trim();
  if (!trimmed) {
    return fallbackBinary;
  }
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  for (const token of tokens) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
      continue;
    }
    if (token.startsWith("'")) {
      const closing = token.indexOf("'", 1);
      if (closing > 1) {
        return token.slice(1, closing);
      }
    }
    if (token.startsWith('"')) {
      const closing = token.indexOf('"', 1);
      if (closing > 1) {
        return token.slice(1, closing);
      }
    }
    return token;
  }
  return fallbackBinary;
}

export function buildAgentResumePlan(
  agent: AgentName,
  agentSessionId: string,
  launchCommand = "",
): AgentResumePlan {
  const binary = extractCommandBinary(launchCommand, agent);
  return agent === "claude"
    ? buildClaudeResumePlan(agentSessionId, binary)
    : buildCodexResumePlan(agentSessionId, binary);
}

export async function findAgentSessionId(
  agent: AgentName,
  worktreePath: string,
): Promise<string | null> {
  return agent === "claude" ? findClaudeSessionId(worktreePath) : findCodexSessionId(worktreePath);
}
