import {
  buildClaudePlan,
  buildClaudePlanWithHooks,
  buildClaudeRestorePlan,
  buildClaudeResumePlan,
  buildClaudeResumePlanWithHooks,
  ensureClaudeHookSettings,
  findClaudeSessionId,
  probeClaudeState,
} from "./claude.js";
import {
  buildCodexPlan,
  buildCodexRestorePlan,
  buildCodexResumePlan,
  ensureCodexHooksConfig,
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

export function buildAgentLaunchPlan(
  agent: AgentName,
  prompt: string,
  options?: { claudeSettingsPath?: string; codexHomePath?: string },
) {
  if (agent === "claude") {
    return options?.claudeSettingsPath
      ? buildClaudePlanWithHooks(prompt, options.claudeSettingsPath)
      : buildClaudePlan(prompt);
  }
  return buildCodexPlan(prompt, options);
}

export async function buildAgentRestorePlan(
  agent: AgentName,
  worktreePath: string,
  prompt: string,
  options?: { claudeSettingsPath?: string; codexHomePath?: string },
): Promise<AgentLaunchPlan | null> {
  if (agent === "claude") {
    return buildClaudeRestorePlan(worktreePath, prompt);
  }
  return buildCodexRestorePlan(worktreePath, prompt, options);
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
  options?: { claudeSettingsPath?: string; codexHomePath?: string },
): AgentResumePlan {
  const binary = extractCommandBinary(launchCommand, agent);
  if (agent === "claude") {
    return options?.claudeSettingsPath
      ? buildClaudeResumePlanWithHooks(agentSessionId, options.claudeSettingsPath, binary)
      : buildClaudeResumePlan(agentSessionId, binary);
  }
  return buildCodexResumePlan(agentSessionId, binary, options);
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

export async function setupAgentHooks(args: {
  agent: AgentName;
  worktreePath: string;
  sessionToolDir: string;
}): Promise<{ claudeSettingsPath?: string; codexHomePath?: string }> {
  if (args.agent === "claude") {
    return { claudeSettingsPath: await ensureClaudeHookSettings(args.sessionToolDir) };
  }
  return { codexHomePath: await ensureCodexHooksConfig(args.sessionToolDir) };
}
