import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ProjectConfig } from "./types.js";

export const CONDUCTOR_PROJECT_ID = "spur-conductor";
export const CONDUCTOR_PROJECT_NAME = "Conductor";
export const CONDUCTOR_SESSION_PREFIX = "cond";

const DEFAULT_CONDUCTOR_MESSAGE =
  "Start conductor mode. Inspect current Spur state, then wait for operator direction.";

export function conductorWorkspacePath(dataDir: string): string {
  return join(dataDir, "conductor");
}

export function buildConductorProject(dataDir: string): ProjectConfig {
  const path = conductorWorkspacePath(dataDir);
  mkdirSync(path, { recursive: true });
  return {
    name: CONDUCTOR_PROJECT_NAME,
    path,
    defaultBranch: "main",
    sessionPrefix: CONDUCTOR_SESSION_PREFIX,
    worktree: false,
    symlinks: [],
    defaultAgent: "claude",
    sidecars: {},
    sources: {},
    triggers: {},
  };
}

export function renderConductorPrompt(operatorMessage?: string): string {
  const request = operatorMessage?.trim() || DEFAULT_CONDUCTOR_MESSAGE;
  return `You are Spur Conductor: a long-lived orchestration agent for Spur.

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
