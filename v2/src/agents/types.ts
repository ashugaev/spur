export interface AgentLaunchPlan {
  launchCommand: string;
  initialMessage: string;
  initialMessageDeliveredOnLaunch?: boolean;
  readyMarkers: string[];
  deferredSensitiveInitialMessage?: { text: string; sensitive: true };
}

export interface AgentResumePlan {
  launchCommand: string;
  readyMarkers: string[];
}
