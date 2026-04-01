export interface AgentLaunchPlan {
  launchCommand: string;
  initialMessage: string;
  readyMarkers: string[];
}

export interface AgentResumePlan {
  launchCommand: string;
  readyMarkers: string[];
}
