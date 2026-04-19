import {
  buildClaudePlan,
  buildClaudeRestorePlan,
  buildClaudeResumePlan,
  findClaudeSessionId,
} from "./claude.js";
import {
  buildCodexPlan,
  buildCodexRestorePlan,
  buildCodexResumePlan,
  ensureCodexHooksConfig,
  findCodexSessionId,
} from "./codex.js";
import type { AgentName } from "../types.js";
import type { AgentLaunchPlan, AgentResumePlan } from "./types.js";
export type { AgentLaunchPlan, AgentResumePlan } from "./types.js";

interface AgentPlanOptions {
  claudeSettingsPath?: string;
  codexHomePath?: string;
  codexArgs?: string[];
  planMode?: boolean;
}

function claudePlanOptions(options?: AgentPlanOptions): {
  settingsPath?: string;
  planMode?: boolean;
} {
  return {
    ...(options?.claudeSettingsPath ? { settingsPath: options.claudeSettingsPath } : {}),
    ...(options?.planMode ? { planMode: true } : {}),
  };
}

function codexPlanOptions(options?: AgentPlanOptions): {
  codexHomePath?: string;
  codexArgs?: string[];
} {
  return {
    ...(options?.codexHomePath ? { codexHomePath: options.codexHomePath } : {}),
    ...(options?.codexArgs ? { codexArgs: options.codexArgs } : {}),
  };
}

export function parseAgentName(agent: string): AgentName {
  if (agent === "claude" || agent === "codex") {
    return agent;
  }

  throw new Error(`Unsupported agent: ${agent}`);
}

export function buildAgentLaunchPlan(agent: AgentName, prompt: string, options?: AgentPlanOptions) {
  if (agent === "claude") {
    return buildClaudePlan(prompt, claudePlanOptions(options));
  }
  return buildCodexPlan(prompt, codexPlanOptions(options));
}

export async function buildAgentRestorePlan(
  agent: AgentName,
  worktreePath: string,
  prompt: string,
  options?: AgentPlanOptions,
): Promise<AgentLaunchPlan | null> {
  if (agent === "claude") {
    return buildClaudeRestorePlan(worktreePath, prompt, claudePlanOptions(options));
  }
  return buildCodexRestorePlan(worktreePath, prompt, codexPlanOptions(options));
}

export function extractCommandBinary(launchCommand: string, fallbackBinary: string): string {
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
  options?: AgentPlanOptions,
): AgentResumePlan {
  const binary = extractCommandBinary(launchCommand, agent);
  if (agent === "claude") {
    return buildClaudeResumePlan(agentSessionId, binary, claudePlanOptions(options));
  }
  return buildCodexResumePlan(agentSessionId, binary, codexPlanOptions(options));
}

export async function findAgentSessionId(
  agent: AgentName,
  worktreePath: string,
  options?: { codexSessionRootDir?: string },
): Promise<string | null> {
  if (agent === "claude") {
    return findClaudeSessionId(worktreePath);
  }
  return findCodexSessionId(worktreePath, {
    ...(options?.codexSessionRootDir ? { sessionRootDir: options.codexSessionRootDir } : {}),
  });
}

export async function setupAgentHooks(args: {
  agent: AgentName;
  worktreePath: string;
  sessionToolDir: string;
}): Promise<{ claudeSettingsPath?: string; codexHomePath?: string }> {
  if (args.agent === "claude") {
    // Claude uses JSONL-based state classification — no hook settings needed.
    return {};
  }
  return {
    codexHomePath: await ensureCodexHooksConfig(args.sessionToolDir, [args.worktreePath]),
  };
}
