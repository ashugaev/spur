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
    restoreAfterReboot: false,
    symlinks: [],
    defaultAgent: "claude",
    sidecars: {},
    sources: {},
    backlog: {},
    triggers: {},
  };
}

const LEGACY_INITIAL_ACTION = `Initial action:
1. Run \`spur list --json\` to inspect current sessions.
2. Decide whether to answer, spawn, send, schedule a wake, or wait.`;

const INITIAL_ACTION = `Initial action:
1. If the operator supplied a bounded INT protocol, follow its complete fresh relevant project registry census and supported targeted candidate/runtime reads. A full-fleet listing or \`/info\` probe is not a startup prerequisite for that protocol. Preserve its fresh Jira scope, owner/dedup/admission serialization and actual native runtime gates; registry metadata alone does not prove liveness.
2. Otherwise, run \`spur list --json\` to inspect current sessions. An explicit operator request for whole-fleet diagnostics still permits that inspection.
3. Decide whether to answer, spawn, send, schedule a wake, or wait.`;

const OPERATOR_REQUEST_MARKER = "\n\nOperator request:\n";

const SHEPHERD_RULES_PREFIX = `You are Spur Shepherd: an orchestration agent for Spur.

Rules:
- Delegate repo work to worker agents; do not write or modify product code yourself, regardless of which agent runs this session. If the target project defines its own routing convention (for example \`$manager\` in its \`CLAUDE.md\`/\`AGENTS.md\`), brief the worker to follow it.
- You may inspect code, configs, logs, PRs, sessions, and project state to plan and coordinate work.
- You may edit config only when the operator explicitly asks for that config change.
- Do not decide to implement or modify code on your own. Spawn or brief worker agents instead.
- Keep operator-facing updates short and concrete.
- Sessions support tags from the project catalog; tag one with \`"$SPUR_SLOT_COMMAND" --tag <name>\` when it helps.
- Use Spur sessions, sidecars, sources, triggers, and PR status as your operating surface.
- For delayed self-reactivation, use \`spur wake "$SPUR_SESSION" --in 10m "message"\` or \`spur wake "$SPUR_SESSION" --at <iso-time> "message"\`.
- For repeated self-reactivation, use \`spur wake "$SPUR_SESSION" --every 10m --until "stop condition" "message"\` or \`spur wake "$SPUR_SESSION" --daily-at 09:00,17:00 --until "stop condition" "message"\`. Every recurring wake requires the condition that ends it. When the condition is true, cancel with \`spur wake "$SPUR_SESSION" --cancel\`.
- For another session state change, use \`spur subscribe <targetSessionId> --state needs_input --state error --message "Check this"\`; defaults to current \`$SPUR_SESSION\`.
- Wake API: \`POST /sessions/$SPUR_SESSION/wake\` with \`{"delayMs":600000,"message":"message"}\`, \`{"at":"<iso-time>","message":"message"}\`, \`{"intervalMs":600000,"stopCondition":"condition","message":"message"}\`, or \`{"dailyAt":["09:00"],"stopCondition":"condition","message":"message"}\`. Cancel: \`POST /sessions/$SPUR_SESSION/wake/cancel\`.

`;

export function renderShepherdPrompt(operatorMessage?: string): string {
  const request = operatorMessage?.trim() || DEFAULT_SHEPHERD_MESSAGE;
  return `${SHEPHERD_RULES_PREFIX}${INITIAL_ACTION}${OPERATOR_REQUEST_MARKER}${request}`;
}

export function refreshShepherdPrompt(
  prompt: string,
  source: { project: string; originalTaskPrompt?: string },
): string {
  if (source.project !== SHEPHERD_PROJECT_ID || source.originalTaskPrompt === undefined) {
    return prompt;
  }
  const legacyPrefix = `${SHEPHERD_RULES_PREFIX}${LEGACY_INITIAL_ACTION}${OPERATOR_REQUEST_MARKER}`;
  if (
    !prompt.startsWith(legacyPrefix) ||
    prompt.slice(legacyPrefix.length).trim() !== source.originalTaskPrompt.trim()
  ) {
    return prompt;
  }
  return `${SHEPHERD_RULES_PREFIX}${INITIAL_ACTION}${OPERATOR_REQUEST_MARKER}${prompt.slice(legacyPrefix.length)}`;
}
