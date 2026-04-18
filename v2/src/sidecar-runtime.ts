import type { StartSidecarRequest } from "./types.js";

export const SPUR_SIDECAR_NAME_ENV = "SPUR_SIDECAR_NAME";
export const SPUR_SIDECAR_DEPTH_ENV = "SPUR_SIDECAR_DEPTH";
export const ROOT_SIDECAR_DEPTH = 1;
export const MAX_SIDECAR_DEPTH = 2;

export interface SidecarCallerContext {
  name?: string;
  depth: number;
}

function parseSidecarDepth(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= ROOT_SIDECAR_DEPTH ? value : undefined;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    return undefined;
  }
  const parsed = Number.parseInt(trimmed, 10);
  return parsed >= ROOT_SIDECAR_DEPTH ? parsed : undefined;
}

export function sidecarCallerContextFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): SidecarCallerContext {
  const name = env[SPUR_SIDECAR_NAME_ENV]?.trim();
  if (!name) {
    return { depth: 0 };
  }
  return {
    name,
    depth: parseSidecarDepth(env[SPUR_SIDECAR_DEPTH_ENV]) ?? ROOT_SIDECAR_DEPTH,
  };
}

export function sidecarCallerContextFromRequest(
  request: StartSidecarRequest = {},
): SidecarCallerContext {
  const name = request.callerSidecarName?.trim();
  if (!name) {
    return { depth: 0 };
  }
  return {
    name,
    depth: parseSidecarDepth(request.callerSidecarDepth) ?? ROOT_SIDECAR_DEPTH,
  };
}

export function startSidecarRequestFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): StartSidecarRequest {
  const caller = sidecarCallerContextFromEnv(env);
  return caller.name ? { callerSidecarName: caller.name, callerSidecarDepth: caller.depth } : {};
}

export function nextSidecarDepth(caller: SidecarCallerContext): number {
  return caller.name ? caller.depth + 1 : ROOT_SIDECAR_DEPTH;
}

export function formatNestedSidecarStartError(
  sidecarName: string,
  callerSidecarName: string,
): string {
  return `Cannot start sidecar "${sidecarName}" from nested sidecar "${callerSidecarName}". Sidecars can nest only one level deep, and nested sidecars must always be started manually.`;
}
