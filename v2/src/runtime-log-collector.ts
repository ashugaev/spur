import type { AppConfig } from "./types.js";

export interface RuntimeLogCollector {
  stop(): void;
}

export function startRuntimeLogCollector(config: AppConfig): RuntimeLogCollector {
  void config;
  return {
    stop(): void {
      // Runtime logs stay available as a surface, but tmux pane capture is disabled.
    },
  };
}
