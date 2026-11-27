// Where a launched claude writes its session registration (sessions/<pid>.json)
// and the session id that file must carry.
export interface ClaudeLaunchRegistration {
  sessionsDir: string;
  sessionId: string;
}

export interface AgentLaunchPlan {
  launchCommand: string;
  initialMessage: string;
  initialMessageDeliveredOnLaunch?: boolean;
  readyMarkers: string[];
  claudeRegistration?: ClaudeLaunchRegistration;
}

export interface AgentResumePlan {
  launchCommand: string;
  readyMarkers: string[];
  claudeRegistration?: ClaudeLaunchRegistration;
}
