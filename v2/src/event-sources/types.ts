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
  title?: string;
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
  /**
   * Resolves this instance's own web UI base URL, lazily — called at the
   * moment a source actually needs it (voice transcription today), not at
   * source start. Returns `null` when this instance's web UI port cannot yet
   * be determined (an isolated daemon whose `isolated-ui` sidecar has no
   * reservation yet — see `resolveWebBaseUrl` in `ports.ts`); a source must
   * treat that as "disabled for now", never fall back to a guessed or
   * default port. `event-sources/index.ts` caches the first successful
   * resolution so every source module reads the same value and this isn't
   * re-resolved on every call.
   */
  resolveWebBaseUrl(): Promise<string | null>;
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
