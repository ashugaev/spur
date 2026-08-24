export interface AgentLaunchPlan {
  launchCommand: string;
  initialMessage: string;
  initialMessageDeliveredOnLaunch?: boolean;
  readyMarkers: string[];
}

export interface AgentResumePlan {
  launchCommand: string;
  readyMarkers: string[];
}
