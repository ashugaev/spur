import type { SessionState } from "../types.js";

export interface AgentLaunchPlan {
  launchCommand: string;
  initialMessage: string;
  readyMarkers: string[];
}

export interface AgentResumePlan {
  launchCommand: string;
  readyMarkers: string[];
}

export interface AgentStateProbe {
  state: Exclude<SessionState, "killed">;
  signalAt: Date;
}
