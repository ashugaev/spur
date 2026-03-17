import type { SourceConfig, SourceType } from "../types.js";

export interface SpurEvent {
  name: string;
  projectId: string;
  sourceId: string;
}

export interface SourceLogger {
  info?: (message: string) => void;
}

export interface SourceStartDeps<TConfig extends SourceConfig = SourceConfig> {
  sourceId: string;
  projectId: string;
  config: TConfig;
  emit(name: string): void;
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
