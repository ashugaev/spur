import type {
  ListenerConfig,
  OrchestratorConfig,
  SessionManager,
  Session,
  ProjectConfig,
} from "@composio/ao-core";
import type { IntegrationHealthReporter, IntegrationIdentity } from "../integration-health.js";

export interface ListenerLogger {
  info?: (message: string) => void;
  warn: (message: string) => void;
}

export interface ListenerStartDeps {
  config: OrchestratorConfig;
  listenerId: string;
  listener: ListenerConfig;
  projectId: string;
  project: ProjectConfig;
  sessionManager: SessionManager;
  logger: ListenerLogger;
  healthReporter?: IntegrationHealthReporter;
  healthIdentity?: IntegrationIdentity;
}

export interface ListenerController {
  stop(): void;
}

export interface ListenerSource {
  source: string;
  start(deps: ListenerStartDeps): Promise<ListenerController>;
}

export interface IssueSessionSnapshot {
  latest: Session | null;
  blocking: boolean;
}
