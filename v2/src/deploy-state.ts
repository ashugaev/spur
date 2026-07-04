import { readFileSync } from "node:fs";
import { join } from "node:path";

export type SwitchPhase = "installing" | "restarting" | "done" | "rolled_back" | "failed";

export interface SwitchState {
  phase: SwitchPhase;
  from: string;
  to: string;
  startedAt: string;
  finishedAt?: string;
  error?: string;
  pid?: number;
}

export type PublicSwitchState = Omit<SwitchState, "pid">;

// A crashed helper leaves a non-terminal state file; unblock switching after this window.
export const SWITCH_STALE_MS = 15 * 60 * 1000;

const PHASES: ReadonlySet<string> = new Set([
  "installing",
  "restarting",
  "done",
  "rolled_back",
  "failed",
]);

export function switchStatePath(dataDir: string): string {
  return join(dataDir, "deploy", "switch-state.json");
}

// Reads a bash-written file at a process boundary: any missing/invalid shape is null.
export function readSwitchState(dataDir: string): SwitchState | null {
  let raw: string;
  try {
    raw = readFileSync(switchStatePath(dataDir), "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const value = parsed as Record<string, unknown>;
  if (typeof value["phase"] !== "string" || !PHASES.has(value["phase"])) return null;
  if (typeof value["from"] !== "string") return null;
  if (typeof value["to"] !== "string") return null;
  if (typeof value["startedAt"] !== "string") return null;
  const state: SwitchState = {
    phase: value["phase"] as SwitchPhase,
    from: value["from"],
    to: value["to"],
    startedAt: value["startedAt"],
  };
  if (typeof value["finishedAt"] === "string") state.finishedAt = value["finishedAt"];
  if (typeof value["error"] === "string") state.error = value["error"];
  if (typeof value["pid"] === "number") state.pid = value["pid"];
  return state;
}

export function isSwitchInProgress(state: SwitchState, now: number = Date.now()): boolean {
  if (state.phase !== "installing" && state.phase !== "restarting") return false;
  const startedAt = Date.parse(state.startedAt);
  if (Number.isNaN(startedAt)) return false;
  return now - startedAt < SWITCH_STALE_MS;
}

export function publicSwitchState(state: SwitchState): PublicSwitchState {
  const { pid: _pid, ...rest } = state;
  return rest;
}
