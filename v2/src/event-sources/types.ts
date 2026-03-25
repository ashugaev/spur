import type { SourceConfig, SourceType } from "../types.js";

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

export interface SourceStartDeps<TConfig extends SourceConfig = SourceConfig> {
  sourceId: string;
  projectId: string;
  dataDir: string;
  config: TConfig;
  deferInitialSync?: boolean;
  emit<TEvent = unknown>(name: string, data?: TEvent): void;
  signal: AbortSignal;
  logger: SourceLogger;
}

export interface SourceHandle {
  stop(): void;
  runOnStart?(): void;
}

export interface SourceModule<TConfig extends SourceConfig = SourceConfig> {
  type: SourceType;
  start(deps: SourceStartDeps<TConfig>): Promise<SourceHandle>;
}

export interface SourceGroupController {
  stop(): void;
}
