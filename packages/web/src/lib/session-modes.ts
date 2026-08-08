import type { SessionModeInfo } from "@/lib/types";

// Pure config-to-UI derivation for the spawn modal's session mode picker.
// No React. A modes map arriving over JSON loses its null prototype, so
// every lookup here goes through Object.hasOwn rather than `in` or bracket
// access, mirroring v2/src/session-mode.ts.

function defaultSessionModeName(modes: Record<string, SessionModeInfo> | undefined): string | null {
  if (!modes) return null;
  const entry = Object.entries(modes).find(([, config]) => config.default === true);
  return entry ? entry[0] : null;
}

export function sessionModeOptions(
  modes: Record<string, SessionModeInfo> | undefined,
): { value: string; label: string }[] {
  if (!modes) return [];
  const names = Object.keys(modes);
  if (names.length === 0) return [];
  const options = names.map((name) => ({ value: name, label: name }));
  if (defaultSessionModeName(modes) === null) {
    return [{ value: "", label: "No mode" }, ...options];
  }
  return options;
}

export function reconcileSessionMode(
  modes: Record<string, SessionModeInfo> | undefined,
  candidate: string | null,
): string | null {
  if (candidate !== null && modes && Object.hasOwn(modes, candidate)) {
    return candidate;
  }
  return defaultSessionModeName(modes);
}
