import { existsSync } from "node:fs";
import {
  isStaleParked,
  type AgentName,
  type SessionRecord,
  type SourceConfig,
  type SourceType,
} from "../types.js";

export interface SpurEvent<T = unknown> {
  name: string;
  projectId: string;
  sourceId: string;
  data?: T;
}

export interface SourceLogger {
  info?: (message: string) => void;
  warn?: (message: string) => void;
}

export interface SourceSessionListItem {
  id: string;
  project: string;
  agent: string;
  state: string;
}

export interface SourceSpawnSessionRequest {
  project: string;
  prompt?: string;
  agent?: AgentName;
}

export interface SourceStartDeps<TConfig extends SourceConfig = SourceConfig> {
  sourceId: string;
  projectId: string;
  dataDir: string;
  config: TConfig;
  deferInitialSync?: boolean;
  listSessions?(): Promise<SourceSessionListItem[]>;
  emit<TEvent = unknown>(name: string, data?: TEvent): void;
  signal: AbortSignal;
  logger: SourceLogger;
  spawnSession?(request: SourceSpawnSessionRequest): Promise<SourceSessionListItem>;
}

export interface SourceHandle {
  stop(): void | Promise<void>;
  runOnStart?(): void;
}

export interface SourceModule<TConfig extends SourceConfig = SourceConfig> {
  type: SourceType;
  start(deps: SourceStartDeps<TConfig>): Promise<SourceHandle>;
}

export interface SourceGroupController {
  stop(): void | Promise<void>;
}

/**
 * Whether a session is eligible for a per-project source poll: it belongs to
 * the project, is either actively running or stale-parked (so a queued
 * replay can still land on it), and its worktree still exists on disk.
 */
export function isEligibleForSourcePoll(
  session: Pick<SessionRecord, "project" | "status" | "stopReason" | "worktreePath">,
  projectId: string,
): boolean {
  return (
    session.project === projectId &&
    (session.status === "running" || isStaleParked(session)) &&
    Boolean(session.worktreePath) &&
    existsSync(session.worktreePath)
  );
}
