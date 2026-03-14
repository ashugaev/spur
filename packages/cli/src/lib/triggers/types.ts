import type {
  TriggerConfig,
  OrchestratorConfig,
  ProjectConfig,
  SessionManager,
} from "@composio/ao-core";
import type { IntegrationHealthReporter, IntegrationIdentity } from "../integration-health.js";

export interface TriggerLogger {
  info?: (message: string) => void;
  warn: (message: string) => void;
}

export interface TriggerStartDeps {
  config: OrchestratorConfig;
  triggerId: string;
  trigger: TriggerConfig;
  projectId: string;
  project: ProjectConfig;
  sessionManager: SessionManager;
  logger: TriggerLogger;
  healthReporter?: IntegrationHealthReporter;
  healthIdentity?: IntegrationIdentity;
}

export interface TriggerController {
  stop(): void;
}

export interface TriggerSource {
  event: string;
  start(deps: TriggerStartDeps): Promise<TriggerController>;
}
