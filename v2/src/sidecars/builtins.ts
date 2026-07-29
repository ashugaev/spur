import type { SidecarConfig } from "../types.js";
import {
  PLAYWRIGHT_SIDECAR_CONFIG,
  PLAYWRIGHT_SIDECAR_NAME,
  sweepLeakedPlaywright,
  waitForPlaywrightReady,
} from "./playwright.js";

export interface BuiltinSidecarDef {
  config: SidecarConfig;
  /** Best-effort orphan reaper for this sidecar's managed processes, keyed by the reserved ports still owned by a live session. */
  sweepLeaked?(ownedPorts: ReadonlySet<number>): Promise<number>;
  /** Best-effort readiness probe, run once after the sidecar's tmux pane starts. */
  readiness?(port: number): Promise<boolean>;
}

// Code-only home for sidecar defs that YAML cannot express (a bundle-resolved
// bin path, MCP wiring, leak sweep). A project opts in with a one-line config
// entry: `sidecars: { <name>: { autoStart: true } }`.
export const BUILTIN_SIDECARS: Record<string, BuiltinSidecarDef> = {
  [PLAYWRIGHT_SIDECAR_NAME]: {
    config: PLAYWRIGHT_SIDECAR_CONFIG,
    sweepLeaked: sweepLeakedPlaywright,
    readiness: waitForPlaywrightReady,
  },
};
