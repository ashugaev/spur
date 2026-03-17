import { buildClaudePlan } from "./claude.js";
import { buildCodexPlan } from "./codex.js";
import type { AgentName } from "../types.js";

export function parseAgentName(agent: string): AgentName {
  if (agent === "claude" || agent === "codex") {
    return agent;
  }

  throw new Error(`Unsupported agent: ${agent}`);
}

export function buildAgentLaunchPlan(agent: string, prompt: string) {
  const parsedAgent = parseAgentName(agent);
  if (parsedAgent === "claude") {
    return buildClaudePlan(prompt);
  }
  return buildCodexPlan(prompt);
}
