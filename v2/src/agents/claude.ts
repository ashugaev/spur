import type { AgentName } from "../types.js";

export const CLAUDE_FULL_ACCESS_COMMAND = "claude --dangerously-skip-permissions";

export interface AgentLaunchPlan {
  agent: AgentName;
  launchCommand: string;
  initialMessage: string;
  readyMarkers: string[];
}

export function buildClaudePlan(prompt: string): AgentLaunchPlan {
  return {
    agent: "claude",
    launchCommand: CLAUDE_FULL_ACCESS_COMMAND,
    initialMessage: prompt,
    readyMarkers: ["Claude Code", "❯"],
  };
}
