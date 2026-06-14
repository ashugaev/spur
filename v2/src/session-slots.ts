import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { agentStateStrategy } from "./agents/index.js";
import { shellEscape } from "./agents/shell-escape.js";
import type { AgentName, SessionLink, SessionSlots, UpdateSessionSlotsRequest } from "./types.js";

export const SLOT_LABEL_RE = /^[a-z0-9][a-z0-9_-]{0,15}$/;
const SLOT_TOOL_DIR = "session-tools";
const MODULE_PATH = fileURLToPath(import.meta.url);
const DIST_CLI_ENTRYPOINT = resolve(dirname(MODULE_PATH), "../dist/cli.js");
const CLI_ENTRYPOINT = existsSync(DIST_CLI_ENTRYPOINT)
  ? DIST_CLI_ENTRYPOINT
  : fileURLToPath(new URL("./cli.js", import.meta.url));

export const SLOT_TOOL_NAME = "spur-slots";
export const AGENT_STATE_TOOL_NAME = "spur-agent-state";
export const PROJECT_MEMORY_TOOL_NAME = "spur-project-memory";
const AGENT_STATE_UPDATER_NAME = "spur-agent-state-updater.mjs";
const PROJECT_MEMORY_UPDATER_NAME = "spur-project-memory-updater.mjs";
const SPUR_WRAPPER_NAME = "spur";
const GIT_WRAPPER_NAME = "git";
const BRANCH_TOOL_NAME = "spur-branch";

interface NormalizedSlotsUpdate {
  title?: string;
  clearTitle: boolean;
  setTitleIfAbsent?: boolean;
  links: SessionLink[];
  unlinkLabels: string[];
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeSlotLabel(label: string): string {
  const normalized = collapseWhitespace(label).toLowerCase();
  if (!SLOT_LABEL_RE.test(normalized)) {
    throw new Error("slot link labels must match ^[a-z0-9][a-z0-9_-]{0,15}$");
  }
  if (normalized === "github-pr" || normalized === "github_pr") {
    return "pr";
  }
  return normalized;
}

function normalizeSlotUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) {
    throw new Error("slot link URLs must be non-empty strings");
  }
  try {
    return new URL(trimmed).toString();
  } catch {
    throw new Error(`Invalid slot link URL: ${trimmed}`);
  }
}

function normalizeTitle(title: string): string {
  const normalized = collapseWhitespace(title);
  if (!normalized) {
    throw new Error("slot title must be a non-empty string");
  }
  return normalized;
}

export function normalizeSlotsUpdate(request: UpdateSessionSlotsRequest): NormalizedSlotsUpdate {
  if (request.title !== undefined && typeof request.title !== "string") {
    throw new Error("slot title must be a string");
  }
  if (request.clearTitle !== undefined && typeof request.clearTitle !== "boolean") {
    throw new Error("clearTitle must be a boolean");
  }
  if (request.setTitleIfAbsent !== undefined && typeof request.setTitleIfAbsent !== "boolean") {
    throw new Error("setTitleIfAbsent must be a boolean");
  }
  if (request.title !== undefined && request.clearTitle) {
    throw new Error("title and clearTitle cannot be used together");
  }
  if (request.setTitleIfAbsent === true && request.title === undefined) {
    throw new Error("setTitleIfAbsent requires a title");
  }

  const linksRaw: unknown = request.links ?? [];
  if (!Array.isArray(linksRaw)) {
    throw new Error("links must be an array");
  }
  const links = linksRaw.map((link: unknown, index) => {
    if (!link || typeof link !== "object") {
      throw new Error(`links[${index}] must be an object`);
    }
    const linkRecord = link as { label?: unknown; url?: unknown };
    if (typeof linkRecord.label !== "string") {
      throw new Error(`links[${index}].label must be a string`);
    }
    if (typeof linkRecord.url !== "string") {
      throw new Error(`links[${index}].url must be a string`);
    }
    return {
      label: normalizeSlotLabel(linkRecord.label),
      url: normalizeSlotUrl(linkRecord.url),
    } satisfies SessionLink;
  });

  const unlinkRaw: unknown = request.unlinkLabels ?? [];
  if (!Array.isArray(unlinkRaw)) {
    throw new Error("unlinkLabels must be an array");
  }
  const unlinkLabels = unlinkRaw.map((label: unknown, index) => {
    if (typeof label !== "string") {
      throw new Error(`unlinkLabels[${index}] must be a string`);
    }
    return normalizeSlotLabel(label);
  });

  if (
    request.title === undefined &&
    request.clearTitle !== true &&
    links.length === 0 &&
    unlinkLabels.length === 0
  ) {
    throw new Error("slot update requires at least one change");
  }

  return {
    ...(request.title !== undefined ? { title: normalizeTitle(request.title) } : {}),
    clearTitle: request.clearTitle === true,
    ...(request.setTitleIfAbsent === true ? { setTitleIfAbsent: true } : {}),
    links,
    unlinkLabels,
  };
}

export function applySlotsUpdate(
  current: SessionSlots | undefined,
  request: UpdateSessionSlotsRequest,
): SessionSlots | undefined {
  const update = normalizeSlotsUpdate(request);
  const links = new Map((current?.links ?? []).map((link) => [link.label, link] as const));
  for (const label of update.unlinkLabels) {
    links.delete(label);
  }
  for (const link of update.links) {
    links.set(link.label, link);
  }

  let title = current?.title;
  if (update.clearTitle) {
    title = undefined;
  }
  if (update.title !== undefined) {
    const hasExistingTitle = (current?.title?.trim().length ?? 0) > 0;
    if (!update.setTitleIfAbsent || !hasExistingTitle) {
      title = update.title;
    }
  }

  const nextLinks = [...links.values()];
  if (!title && nextLinks.length === 0) {
    return undefined;
  }

  return {
    ...(title ? { title } : {}),
    links: nextLinks,
  };
}

export function withSessionSlotInstructions(prompt: string): string {
  if (prompt.includes("SPUR_SLOT_COMMAND") || prompt.includes(SLOT_TOOL_NAME)) {
    return prompt;
  }
  return `${prompt}

Session metadata:
- Set the session title once at task start using \`"$SPUR_SLOT_COMMAND" --title-if-absent "..." --link tracker=https://... --link pr=https://...\`. The title must describe the whole task end-to-end, not the current step. After it is set, the title is locked — further \`--title-if-absent\` calls are silently ignored.
- Update links any time with \`"$SPUR_SLOT_COMMAND" --link tracker=https://... --link pr=https://...\`. Use \`"$SPUR_SLOT_COMMAND" --link label=https://...\` for any other useful links.
- \`$SPUR_SLOT_COMMAND\` points to this session's \`${SLOT_TOOL_NAME}\` helper.
- Use \`spur service logs\` to inspect service and sidecar logs when you need to debug local runtimes.`;
}

export function withProjectMemoryInstructions(prompt: string): string {
  if (prompt.includes("SPUR_PROJECT_MEMORY_COMMAND") || prompt.includes(PROJECT_MEMORY_TOOL_NAME)) {
    return prompt;
  }
  return `${prompt}

Project memory:
- Read shared project memory before final checks with \`"$SPUR_PROJECT_MEMORY_COMMAND" read\`.
- When the user corrects your repo rules, workflow, style, or repeated mistake, add one short rule with \`"$SPUR_PROJECT_MEMORY_COMMAND" add "rule text"\`.
- Store only user-feedback-derived rules that reduce future user corrections. Do not store research findings, task facts, secrets, or temporary instructions.
- Remove wrong rules with \`"$SPUR_PROJECT_MEMORY_COMMAND" remove <id>\`.
- \`$SPUR_PROJECT_MEMORY_COMMAND\` points to this session's \`${PROJECT_MEMORY_TOOL_NAME}\` helper and writes \`.spur/memory.tsv\` in the project root. Format: \`id<TAB>text\`, no headings, no Markdown.`;
}

function slotToolDir(dataDir: string, sessionId: string): string {
  return join(dataDir, SLOT_TOOL_DIR, sessionId);
}

function shouldWriteAgentStateTools(agent: AgentName | undefined): boolean {
  if (!agent) {
    return true;
  }
  return agentStateStrategy(agent) === "hook";
}

export function ensureSessionSlotTool(args: {
  dataDir: string;
  sessionId: string;
  configPath: string;
  projectPath: string;
  projectId?: string;
  branchNamingRegex?: string;
  agent?: AgentName;
}): string {
  const toolDir = slotToolDir(args.dataDir, args.sessionId);
  const stateFilePath = join(args.dataDir, "session-agent-state", `${args.sessionId}.json`);
  mkdirSync(toolDir, { recursive: true });
  writeFileSync(
    join(toolDir, SPUR_WRAPPER_NAME),
    `#!/usr/bin/env bash
set -euo pipefail
exec ${shellEscape(process.execPath)} ${shellEscape(CLI_ENTRYPOINT)} --config ${shellEscape(args.configPath)} "$@"
`,
    { encoding: "utf8", mode: 0o755 },
  );
  writeFileSync(
    join(toolDir, SLOT_TOOL_NAME),
    `#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR=$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)
exec "$SCRIPT_DIR/${SPUR_WRAPPER_NAME}" slots --session ${shellEscape(args.sessionId)} "$@"
`,
    { encoding: "utf8", mode: 0o755 },
  );
  writeFileSync(
    join(toolDir, PROJECT_MEMORY_UPDATER_NAME),
    `#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const projectPath = process.argv[2];
const action = process.argv[3];
const value = process.argv[4];
const memoryPath = join(projectPath, ".spur", "memory.tsv");
const idRe = /^pm_\\d{8}_\\d{4}$/;

function fail(message) {
  console.error(message);
  process.exit(1);
}

function readLines() {
  if (!existsSync(memoryPath)) return [];
  const text = readFileSync(memoryPath, "utf8");
  return text.split(/\\r?\\n/).filter((line) => line.length > 0);
}

function writeLines(lines) {
  mkdirSync(dirname(memoryPath), { recursive: true });
  const tmpPath = \`\${memoryPath}.tmp.\${process.pid}.\${Date.now()}\`;
  writeFileSync(tmpPath, lines.length > 0 ? \`\${lines.join("\\n")}\\n\` : "", "utf8");
  renameSync(tmpPath, memoryPath);
}

function nextId(lines) {
  const day = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  const used = new Set(lines.map((line) => line.split("\\t", 1)[0]));
  for (let index = 1; index <= 9999; index += 1) {
    const id = \`pm_\${day}_\${String(index).padStart(4, "0")}\`;
    if (!used.has(id)) return id;
  }
  fail("project memory id space exhausted for today");
}

function normalizeText(raw) {
  const rawText = String(raw ?? "");
  if (rawText.includes("\\t") || rawText.includes("\\n") || rawText.includes("\\r")) {
    fail("project memory text must be one line without tabs");
  }
  const text = rawText.replace(/\\s+/g, " ").trim();
  if (!text) fail("project memory text must be non-empty");
  if (text.length > 160) fail("project memory text must be 160 characters or fewer");
  if (
    text.startsWith("#") ||
    text.startsWith("-") ||
    text.startsWith("*") ||
    text.startsWith(">") ||
    text.startsWith("\`") ||
    /^\\d+[.)]\\s/.test(text)
  ) {
    fail("project memory text must be plain text, not Markdown or a list item");
  }
  return text;
}

if (!projectPath) fail("project path is required");

if (action === "read") {
  const lines = readLines();
  process.stdout.write(lines.join("\\n"));
  if (lines.length > 0) process.stdout.write("\\n");
  process.exit(0);
}

if (action === "add") {
  const text = normalizeText(value);
  const lines = readLines();
  const duplicate = lines.find((line) => line.split("\\t").slice(1).join("\\t") === text);
  if (duplicate) {
    process.stdout.write(\`\${duplicate.split("\\t", 1)[0]}\\n\`);
    process.exit(0);
  }
  const id = nextId(lines);
  writeLines([...lines, \`\${id}\\t\${text}\`]);
  process.stdout.write(\`\${id}\\n\`);
  process.exit(0);
}

if (action === "remove") {
  if (!value || !idRe.test(value)) fail("project memory id is invalid");
  const lines = readLines();
  const kept = lines.filter((line) => line.split("\\t", 1)[0] !== value);
  if (kept.length === lines.length) fail(\`project memory id not found: \${value}\`);
  writeLines(kept);
  process.exit(0);
}

fail("usage: spur-project-memory read | add <text> | remove <id>");
`,
    { encoding: "utf8", mode: 0o755 },
  );
  writeFileSync(
    join(toolDir, PROJECT_MEMORY_TOOL_NAME),
    `#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR=$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)
exec ${shellEscape(process.execPath)} "$SCRIPT_DIR/${PROJECT_MEMORY_UPDATER_NAME}" ${shellEscape(args.projectPath)} "$@"
`,
    { encoding: "utf8", mode: 0o755 },
  );
  if (args.projectId && args.branchNamingRegex) {
    writeFileSync(
      join(toolDir, BRANCH_TOOL_NAME),
      `#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR=$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)
action="\${1-}"
case "$action" in
  check|create|rename) shift ;;
  *)
    echo "Usage: ${BRANCH_TOOL_NAME} check|create|rename <branch>" >&2
    exit 2
    ;;
esac
exec "$SCRIPT_DIR/${SPUR_WRAPPER_NAME}" branch "$action" --project ${shellEscape(args.projectId)} "$@"
`,
      { encoding: "utf8", mode: 0o755 },
    );
    writeFileSync(
      join(toolDir, GIT_WRAPPER_NAME),
      `#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR=$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)
path_without_wrapper=""
IFS=: read -r -a path_parts <<< "\${PATH:-}"
for path_part in "\${path_parts[@]}"; do
  if [[ "$path_part" == "$SCRIPT_DIR" ]]; then
    continue
  fi
  path_without_wrapper="\${path_without_wrapper:+$path_without_wrapper:}$path_part"
done
REAL_GIT=$(PATH="$path_without_wrapper" command -v git || true)
if [[ -z "$REAL_GIT" ]]; then
  echo "Spur git wrapper could not find git outside $SCRIPT_DIR" >&2
  exit 127
fi
git_command=""
git_prefix=()
expect_global_value=0
for arg in "$@"; do
  if [[ "$expect_global_value" == "1" ]]; then
    git_prefix+=("$arg")
    expect_global_value=0
    continue
  fi
  case "$arg" in
    -C|-c|--git-dir|--work-tree|--namespace|--config-env)
      git_prefix+=("$arg")
      expect_global_value=1
      ;;
    --git-dir=*|--work-tree=*|--namespace=*|--config-env=*)
      git_prefix+=("$arg")
      ;;
    --bare|--exec-path|--html-path|--info-path|--man-path|--no-pager|--paginate|--no-replace-objects|--literal-pathspecs|--glob-pathspecs|--noglob-pathspecs|--icase-pathspecs|--no-optional-locks)
      git_prefix+=("$arg")
      ;;
    -*)
      git_prefix+=("$arg")
      ;;
    *)
      git_command="$arg"
      break
      ;;
  esac
done
if [[ "$git_command" == "push" ]]; then
  branch=$("$REAL_GIT" "\${git_prefix[@]}" branch --show-current 2>/dev/null || true)
  case "$branch" in
    "") ;;
    *) "$SCRIPT_DIR/${BRANCH_TOOL_NAME}" check "$branch" >/dev/null ;;
  esac
fi
exec "$REAL_GIT" "$@"
`,
      { encoding: "utf8", mode: 0o755 },
    );
  }
  // Claude uses JSONL-based state classification — no hook state scripts needed.
  if (shouldWriteAgentStateTools(args.agent)) {
    writeFileSync(
      join(toolDir, AGENT_STATE_UPDATER_NAME),
      `#!/usr/bin/env node
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readHookPayload() {
  let input = "";
  try {
    input = readFileSync(0, "utf8");
  } catch {
    return null;
  }
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function mapHookEventToState(eventName) {
  if (!eventName) {
    return null;
  }
  const normalized = String(eventName).toLowerCase();
  if (normalized === "userpromptsubmit" || normalized === "pretooluse" || normalized === "posttooluse") {
    return "working";
  }
  if (
    normalized === "needsinput" ||
    normalized === "needs_input" ||
    normalized === "inputrequired" ||
    normalized === "requestuserinput" ||
    normalized === "request_user_input"
  ) {
    return "needs_input";
  }
  if (normalized === "sessionstart" || normalized === "stop") {
    return "waiting";
  }
  return null;
}

function readExplicitState(hookPayload) {
  if (!isRecord(hookPayload)) {
    return null;
  }
  const rawState =
    typeof hookPayload.state === "string"
      ? hookPayload.state
      : typeof hookPayload.session_state === "string"
        ? hookPayload.session_state
        : typeof hookPayload.sessionState === "string"
          ? hookPayload.sessionState
          : typeof hookPayload.agent_state === "string"
            ? hookPayload.agent_state
            : typeof hookPayload.agentState === "string"
              ? hookPayload.agentState
              : null;
  if (!rawState) {
    return null;
  }
  const normalized = String(rawState).toLowerCase();
  return normalized === "working" || normalized === "waiting" || normalized === "needs_input"
    ? normalized
    : null;
}

function readQuestionMetadataState(hookPayload) {
  if (!isRecord(hookPayload)) {
    return null;
  }
  if (Array.isArray(hookPayload.questions) && hookPayload.questions.length > 0) {
    return "needs_input";
  }
  return typeof hookPayload.question === "string" && hookPayload.question.trim().length > 0
    ? "needs_input"
    : null;
}

const stateFilePath = process.argv[2];
if (!stateFilePath) {
  process.exit(0);
}

const hookPayload = readHookPayload();
const eventName = isRecord(hookPayload) && typeof hookPayload.hook_event_name === "string"
  ? hookPayload.hook_event_name
  : isRecord(hookPayload) && typeof hookPayload.hookEventName === "string"
    ? hookPayload.hookEventName
    : null;
const state =
  readExplicitState(hookPayload) ??
  readQuestionMetadataState(hookPayload) ??
  mapHookEventToState(eventName);
if (!state) {
  process.exit(0);
}

const now = new Date().toISOString();
const turnId = isRecord(hookPayload) && typeof hookPayload.turn_id === "string"
  ? hookPayload.turn_id
  : isRecord(hookPayload) && typeof hookPayload.turnId === "string"
    ? hookPayload.turnId
    : undefined;
const nextRecord = {
  state,
  updatedAt: now,
  ...(eventName ? { hookEvent: eventName } : {}),
  ...(turnId ? { turnId } : {}),
};

const tmpPath = \`\${stateFilePath}.tmp.\${process.pid}.\${Date.now()}\`;
try {
  mkdirSync(dirname(stateFilePath), { recursive: true });
  writeFileSync(tmpPath, JSON.stringify(nextRecord, null, 2) + "\\n", "utf8");
  renameSync(tmpPath, stateFilePath);
} catch {
  process.exit(0);
}
`,
      { encoding: "utf8", mode: 0o755 },
    );
    writeFileSync(
      join(toolDir, AGENT_STATE_TOOL_NAME),
      `#!/usr/bin/env bash
set -euo pipefail
exec ${shellEscape(process.execPath)} ${shellEscape(join(toolDir, AGENT_STATE_UPDATER_NAME))} ${shellEscape(stateFilePath)}
`,
      { encoding: "utf8", mode: 0o755 },
    );
  }
  writeFileSync(
    join(toolDir, "spur-sidecar"),
    `#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR=$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)
action="start"
if [[ "\${1-}" == "start" || "\${1-}" == "stop" ]]; then
  action="$1"
  shift
fi
exec "$SCRIPT_DIR/${SPUR_WRAPPER_NAME}" sidecar "$action" --session ${shellEscape(args.sessionId)} "$@"
`,
    { encoding: "utf8", mode: 0o755 },
  );
  return toolDir;
}

export function removeSessionSlotTool(dataDir: string, sessionId: string): void {
  rmSync(slotToolDir(dataDir, sessionId), { recursive: true, force: true });
}
