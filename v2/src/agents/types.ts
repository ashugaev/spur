import type { SessionStatus } from "../types.js";

export interface AgentLaunchPlan {
  launchCommand: string;
  initialMessage: string;
  readyMarkers: string[];
}

export interface AgentResumePlan {
  launchCommand: string;
  readyMarkers: string[];
}

export interface AgentStatusObservation {
  status: Extract<SessionStatus, "working" | "waiting" | "needs_input" | "exited" | "error">;
  signalAt: Date;
}
