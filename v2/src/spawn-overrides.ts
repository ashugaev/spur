import type { SpawnOverrides } from "./types.js";

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function asOptionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new Error(`${label} must be a boolean`);
  }
  return value;
}

function asOptionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

export function parseSpawnOverrides(value: unknown, label: string): SpawnOverrides | undefined {
  if (value === undefined) return undefined;

  const raw = asObject(value, label);
  for (const key of Object.keys(raw)) {
    if (key !== "worktree" && key !== "defaultBranch") {
      throw new Error(`${label} uses unsupported override "${key}"`);
    }
  }

  const worktree = asOptionalBoolean(raw["worktree"], `${label}.worktree`);
  const defaultBranch = asOptionalString(raw["defaultBranch"], `${label}.defaultBranch`);
  if (worktree === undefined && defaultBranch === undefined) {
    return {};
  }
  return {
    ...(worktree === undefined ? {} : { worktree }),
    ...(defaultBranch === undefined ? {} : { defaultBranch }),
  };
}
