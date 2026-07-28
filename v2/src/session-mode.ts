import type { SessionModeConfig } from "./types.js";

// Pure resolution of the per-session `mode` behavior contract. No daemon
// imports: keep this module callable from config, service, and CLI code
// without pulling in session-service's runtime dependencies.

export interface ResolvedSessionMode {
  name: string;
  skill: string;
}

export function resolveSessionMode(
  requestMode: string | undefined,
  modes: Record<string, SessionModeConfig> | undefined,
): ResolvedSessionMode | undefined {
  if (requestMode !== undefined) {
    const entry = modes?.[requestMode];
    if (!entry) {
      const configured = Object.keys(modes ?? {});
      const known = configured.length > 0 ? configured.join(", ") : "none configured";
      throw new Error(`Unknown mode "${requestMode}"; configured modes: ${known}`);
    }
    return { name: requestMode, skill: entry.skill };
  }
  if (!modes) {
    return undefined;
  }
  const defaultEntry = Object.entries(modes).find(([, config]) => config.default === true);
  if (!defaultEntry) {
    return undefined;
  }
  const [name, config] = defaultEntry;
  return { name, skill: config.skill };
}

export function renderModeInstruction(mode: ResolvedSessionMode): string {
  return `Mode: ${mode.name}. Load the \`${mode.skill}\` skill and follow it as your behavior contract for this session.`;
}
