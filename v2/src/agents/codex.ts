import type { AgentName } from "../types.js";

export const CODEX_FULL_ACCESS_COMMAND = "codex --dangerously-bypass-approvals-and-sandbox";

export interface AgentLaunchPlan {
  agent: AgentName;
  launchCommand: string;
  initialMessage: string;
  readyMarkers: string[];
}

export function buildCodexPlan(prompt: string): AgentLaunchPlan {
  return {
    agent: "codex",
    launchCommand: CODEX_FULL_ACCESS_COMMAND,
    initialMessage: prompt,
    readyMarkers: ["OpenAI Codex", "›"],
  };
}
