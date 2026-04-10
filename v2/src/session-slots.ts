import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { shellEscape } from "./agents/shell-escape.js";
import type { AgentName, SessionLink, SessionSlots, UpdateSessionSlotsRequest } from "./types.js";

const SLOT_LABEL_RE = /^[a-z0-9][a-z0-9_-]{0,15}$/;
const SLOT_TOOL_DIR = "session-tools";
const MODULE_PATH = fileURLToPath(import.meta.url);
const DIST_CLI_ENTRYPOINT = resolve(dirname(MODULE_PATH), "../dist/cli.js");
const CLI_ENTRYPOINT = existsSync(DIST_CLI_ENTRYPOINT)
  ? DIST_CLI_ENTRYPOINT
  : fileURLToPath(new URL("./cli.js", import.meta.url));

export const SLOT_TOOL_NAME = "spur-slots";
export const AGENT_STATE_TOOL_NAME = "spur-agent-state";
const AGENT_STATE_UPDATER_NAME = "spur-agent-state-updater.mjs";
const SPUR_WRAPPER_NAME = "spur";

interface NormalizedSlotsUpdate {
  title?: string;
  clearTitle: boolean;
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
  if (request.title !== undefined && request.clearTitle) {
    throw new Error("title and clearTitle cannot be used together");
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
    title = update.title;
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
- Once you know the task title and any related URLs, prefer one combined call such as \`"$SPUR_SLOT_COMMAND" --title "..." --link tracker=https://... --link pr=https://...\`. \`$SPUR_SLOT_COMMAND\` points to this session's \`${SLOT_TOOL_NAME}\` helper.
- If you learn links later, use \`"$SPUR_SLOT_COMMAND" --link tracker=https://... --link pr=https://...\` to add them without changing the title.
- Use \`"$SPUR_SLOT_COMMAND" --link label=https://...\` for any other useful links.`;
}

function slotToolDir(dataDir: string, sessionId: string): string {
  return join(dataDir, SLOT_TOOL_DIR, sessionId);
}

export function ensureSessionSlotTool(args: {
  dataDir: string;
  sessionId: string;
  configPath: string;
  agentConfigPath: string;
  agent?: AgentName;
}): string {
  const toolDir = slotToolDir(args.dataDir, args.sessionId);
  const stateFilePath = join(args.dataDir, "session-agent-state", `${args.sessionId}.json`);
  mkdirSync(toolDir, { recursive: true });
  writeFileSync(
    join(toolDir, SPUR_WRAPPER_NAME),
    `#!/usr/bin/env bash
set -euo pipefail
exec ${shellEscape(process.execPath)} ${shellEscape(CLI_ENTRYPOINT)} --config ${shellEscape(args.agentConfigPath)} "$@"
`,
    { encoding: "utf8", mode: 0o755 },
  );
  writeFileSync(
    join(toolDir, SLOT_TOOL_NAME),
    `#!/usr/bin/env bash
set -euo pipefail
exec ${shellEscape(process.execPath)} ${shellEscape(CLI_ENTRYPOINT)} --config ${shellEscape(args.configPath)} slots --session ${shellEscape(args.sessionId)} "$@"
`,
    { encoding: "utf8", mode: 0o755 },
  );
  // Claude uses JSONL-based state classification — no hook state scripts needed.
  if (args.agent !== "claude") {
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
  if (normalized === "sessionstart" || normalized === "stop") {
    return "waiting";
  }
  return null;
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
const state = mapHookEventToState(eventName);
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
    join(toolDir, "spur-dev-server"),
    `#!/usr/bin/env bash
set -euo pipefail
exec ${shellEscape(process.execPath)} ${shellEscape(CLI_ENTRYPOINT)} --config ${shellEscape(args.configPath)} dev-server --session ${shellEscape(args.sessionId)} "$@"
`,
    { encoding: "utf8", mode: 0o755 },
  );
  return toolDir;
}

export function removeSessionSlotTool(dataDir: string, sessionId: string): void {
  rmSync(slotToolDir(dataDir, sessionId), { recursive: true, force: true });
}
