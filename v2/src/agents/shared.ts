import type { AgentName } from "../types.js";

export interface AgentLaunchPlan {
  agent: AgentName;
  launchCommand: string;
  initialMessage: string;
  readyMarkers: string[];
}

export type AgentResumePlan = Omit<AgentLaunchPlan, "initialMessage">;

export function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
