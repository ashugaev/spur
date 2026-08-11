import type { SessionModeConfig } from "./types.js";

// Pure resolution of the per-session `mode` behavior contract. No daemon
// imports: keep this module callable from config, service, and CLI code
// without pulling in session-service's runtime dependencies.

export interface ResolvedSessionMode {
  name: string;
  skill: string;
}

function lookupMode(
  modes: Record<string, SessionModeConfig> | undefined,
  name: string,
): SessionModeConfig | undefined {
  return modes && Object.hasOwn(modes, name) ? modes[name] : undefined;
}

// Strict resolution: used at the spawn boundary, where the mode name came
// from a human/caller-supplied request (CLI --mode, API body, trigger
// block.mode). An unknown name is a caller mistake and must fail fast.
export function resolveSessionMode(
  requestMode: string | undefined,
  modes: Record<string, SessionModeConfig> | undefined,
): ResolvedSessionMode | undefined {
  if (requestMode !== undefined) {
    const entry = lookupMode(modes, requestMode);
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

// Lenient resolution: used for recovery/teardown paths that carry a
// persisted mode forward (respawn, handoff, restore) instead of letting the
// caller pick one. Config drift between when the mode was persisted and now
// (renamed/removed mode, stale config path) must degrade the session back to
// no-mode rather than block recovery or blow up mid-teardown. Never applies
// the project default here — an unmoded session must stay unmoded.
export function resolveCarriedSessionMode(
  carriedMode: string | undefined,
  modes: Record<string, SessionModeConfig> | undefined,
  warn: (message: string) => void,
): ResolvedSessionMode | undefined {
  if (carriedMode === undefined) {
    return undefined;
  }
  const entry = lookupMode(modes, carriedMode);
  if (!entry) {
    warn(
      `Mode "${carriedMode}" is no longer configured; carrying the session forward without a mode.`,
    );
    return undefined;
  }
  return { name: carriedMode, skill: entry.skill };
}

export function renderModeInstruction(mode: ResolvedSessionMode): string {
  return `Mode: ${mode.name}. Load the \`${mode.skill}\` skill and follow it as your behavior contract for this session.`;
}
