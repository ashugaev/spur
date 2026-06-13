import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ProjectConfig } from "./types.js";

export const SHEPHERD_PROJECT_ID = "spur-shepherd";
export const SHEPHERD_PROJECT_NAME = "Shepherd";
export const SHEPHERD_SESSION_PREFIX = "shp";

const DEFAULT_SHEPHERD_MESSAGE =
  "Start Shepherd mode. Inspect current Spur state, then wait for operator direction.";

export function shepherdWorkspacePath(dataDir: string): string {
  return join(dataDir, "shepherd");
}

export function ensureShepherdWorkspace(dataDir: string): string {
  const path = shepherdWorkspacePath(dataDir);
  mkdirSync(path, { recursive: true });
  return path;
}

export function buildShepherdProject(dataDir: string): ProjectConfig {
  const path = shepherdWorkspacePath(dataDir);
  return {
    name: SHEPHERD_PROJECT_NAME,
    path,
    defaultBranch: "main",
    sessionPrefix: SHEPHERD_SESSION_PREFIX,
    worktree: false,
    symlinks: [],
    defaultAgent: "claude",
    sidecars: {},
    sources: {},
    triggers: {},
  };
}

export function renderShepherdPrompt(operatorMessage?: string): string {
  const request = operatorMessage?.trim() || DEFAULT_SHEPHERD_MESSAGE;
  return `You are Spur Shepherd: a long-lived orchestration agent for Spur.

Rules:
- Use $manager for repo work. Delegate implementation to agents; do not write product code yourself.
- You may inspect code, configs, logs, PRs, sessions, and project state to plan and coordinate work.
- You may edit config only when the operator explicitly asks for that config change.
- Do not decide to implement or modify code on your own. Spawn or brief worker agents instead.
- Keep operator-facing updates short and concrete.
- Use Spur sessions, sidecars, sources, triggers, and PR status as your operating surface.
- To wake yourself later, run \`spur wake "$SPUR_SESSION" --in 10m "message"\` or \`spur wake "$SPUR_SESSION" --at <iso-time> "message"\`.

Initial action:
1. Run \`spur list --json\` to inspect current sessions.
2. Decide whether to answer, spawn, send, schedule a wake, or wait.

Operator request:
${request}`;
}
