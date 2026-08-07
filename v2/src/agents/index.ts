import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import {
  buildClaudePlan,
  buildClaudeRestorePlan,
  buildClaudeResumePlan,
  claudeCommand,
  ensureClaudeRestrictWritesSettings,
  findClaudeSessionId,
} from "./claude.js";
import { captureClaudeSubmitBaseline, scanClaudeJsonlForMessage } from "./claude-submit-ack.js";
import {
  buildCodexPlan,
  buildCodexRestorePlan,
  buildCodexResumePlan,
  captureCodexRolloutBaseline,
  codexCommand,
  ensureCodexHooksConfig,
  findCodexSessionId,
  readCodexTranscriptEntries,
  scanCodexRolloutForMessage,
} from "./codex.js";
import {
  buildCursorPlan,
  buildCursorRestorePlan,
  buildCursorResumePlan,
  CURSOR_RESTRICT_WRITES_ENV,
  cursorCommand,
  cursorConfigDirForSession,
  ensureCursorRestrictWritesConfig,
  ensureCursorWorkspaceTrust,
  findCursorSessionId,
} from "./cursor.js";
import { captureCursorSubmitBaseline, scanCursorJsonlForMessage } from "./cursor-submit-ack.js";
import { readClaudeTranscriptEntries } from "../claude-jsonl-state.js";
import { readCursorTranscriptEntries } from "../cursor-jsonl-state.js";
import type {
  AgentName,
  ProviderReasoningEffort,
  TranscriptEntry,
  SidecarMcpBinding,
} from "../types.js";
import type { AgentLaunchPlan, AgentResumePlan } from "./types.js";

export type { AgentLaunchPlan, AgentResumePlan } from "./types.js";

interface AgentPlanOptions {
  claudeSettingsPath?: string;
  claudeMcpConfigPath?: string;
  claudeConfigDir?: string;
  codexHomePath?: string;
  codexArgs?: string[];
  reasoningEffort?: ProviderReasoningEffort;
  cursorConfigDir?: string;
  planMode?: boolean;
  restrictWrites?: boolean;
  startupImagePaths?: string[];
  model?: string;
  /** Pinned native session id (claude `--session-id <uuid>`). */
  agentSessionId?: string;
}

interface AgentSessionLookupOptions {
  codexSessionRootDir?: string;
  cursorConfigDir?: string;
}

interface AgentSessionConfig {
  env?: Record<string, string>;
  planOptions?: AgentPlanOptions;
}

export type AgentStateStrategy = "claude_jsonl" | "hook" | "cursor_jsonl";
export type AgentSendMode = "default" | "bracketed_paste";

// Submit-ack pacing. claude/codex submit reliably, so the ack window is long
// and Enter is resent at most twice as a safety net. Cursor can drop the Enter
// that should submit a queued message, leaving it stuck in the input, so it
// scans in short windows and resends Enter more often to flush it.
const DEFAULT_SUBMIT_ACK_WINDOW_MS = 300_000;
const DEFAULT_SUBMIT_MAX_RESENDS = 2;
const CURSOR_SUBMIT_ACK_WINDOW_MS = 5_000;
const CURSOR_SUBMIT_MAX_RESENDS = 12;

export interface AgentSubmitAckContext {
  worktreePath: string;
  codexSessionsDir: string;
  /** Pinned native session id, used to bind claude ack scanning by id. */
  agentSessionId?: string;
}

export interface SubmitAckScanResult {
  found: boolean;
  lastScannedFile: string | null;
}

export interface SubmitAckBinding {
  scan(text: string): Promise<SubmitAckScanResult>;
}

export interface ConversationReadContext {
  worktreePath: string;
  codexSessionsDir?: string;
  agentSessionId?: string;
}

interface AgentAdapter {
  command(): string;
  buildLaunchPlan(prompt: string, options?: AgentPlanOptions): AgentLaunchPlan;
  buildRestorePlan(
    worktreePath: string,
    prompt: string,
    options?: AgentPlanOptions,
  ): Promise<AgentLaunchPlan | null>;
  buildResumePlan(
    agentSessionId: string,
    binary: string,
    options?: AgentPlanOptions,
  ): AgentResumePlan;
  findSessionId(worktreePath: string, options?: AgentSessionLookupOptions): Promise<string | null>;
  readConversation(ctx: ConversationReadContext): Promise<TranscriptEntry[] | null>;
  setup(args: {
    worktreePath: string;
    sessionToolDir: string;
    mcpBindings?: SidecarMcpBinding[];
    restrictWrites?: boolean;
    cursorConfigDir?: string;
    claudeConfigDir?: string;
    modelsCacheHome?: string;
  }): Promise<{
    claudeSettingsPath?: string;
    claudeMcpConfigPath?: string;
    codexHomePath?: string;
  }>;
  sessionConfig?(args: {
    dataDir: string;
    sessionId: string;
    restrictWrites?: boolean;
  }): AgentSessionConfig;
  processMatchers(launchCommand: string): string[];
  stateStrategy: AgentStateStrategy;
  sendMode: AgentSendMode;
  waitsForSubmitAck: boolean;
  submitAckWindowMs: number;
  submitAckMaxResends: number;
  busyQueuedSendAwaitsPrompt: boolean;
  queuedSendPromptGraceMs: number;
  /**
   * Capture a baseline before the message is sent, returning a binding whose
   * `scan` walks only new bytes appended after the send. Returns `null` when
   * no acknowledgment is required (for example, Claude on a fresh session
   * before any JSONL exists).
   */
  submitAck?(ctx: AgentSubmitAckContext): Promise<SubmitAckBinding | null>;
}

function claudePlanOptions(options?: AgentPlanOptions): {
  settingsPath?: string;
  planMode?: boolean;
  mcpConfigPath?: string;
  restrictWrites?: boolean;
  model?: string;
  claudeConfigDir?: string;
  sessionId?: string;
  reasoningEffort?: ProviderReasoningEffort;
} {
  return {
    ...(options?.claudeSettingsPath ? { settingsPath: options.claudeSettingsPath } : {}),
    ...(options?.planMode ? { planMode: true } : {}),
    ...(options?.claudeMcpConfigPath ? { mcpConfigPath: options.claudeMcpConfigPath } : {}),
    ...(options?.restrictWrites ? { restrictWrites: true } : {}),
    ...(options?.model ? { model: options.model } : {}),
    ...(options?.claudeConfigDir ? { claudeConfigDir: options.claudeConfigDir } : {}),
    ...(options?.agentSessionId ? { sessionId: options.agentSessionId } : {}),
    ...(options?.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
  };
}

function codexPlanOptions(options?: AgentPlanOptions): {
  codexHomePath?: string;
  codexArgs?: string[];
  startupImagePaths?: string[];
  restrictWrites?: boolean;
  model?: string;
  reasoningEffort?: ProviderReasoningEffort;
} {
  return {
    ...(options?.codexHomePath ? { codexHomePath: options.codexHomePath } : {}),
    ...(options?.codexArgs ? { codexArgs: options.codexArgs } : {}),
    ...(options?.startupImagePaths ? { startupImagePaths: options.startupImagePaths } : {}),
    ...(options?.restrictWrites ? { restrictWrites: true } : {}),
    ...(options?.model ? { model: options.model } : {}),
    ...(options?.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
  };
}

function cursorPlanOptions(options?: AgentPlanOptions): {
  cursorConfigDir?: string;
  planMode?: boolean;
  model?: string;
} {
  return {
    ...(options?.cursorConfigDir ? { cursorConfigDir: options.cursorConfigDir } : {}),
    ...(options?.planMode ? { planMode: true } : {}),
    ...(options?.model ? { model: options.model } : {}),
  };
}

function defaultProcessMatchers(launchCommand: string, fallbackBinary: string): string[] {
  const binary = basename(extractCommandBinary(launchCommand, fallbackBinary));
  return binary ? [binary] : [];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJsonFile(path: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function mergeMcpServers(
  target: Record<string, unknown>,
  servers: unknown,
): Record<string, unknown> {
  if (!isPlainObject(servers)) {
    return target;
  }
  for (const [name, value] of Object.entries(servers)) {
    if (isPlainObject(value)) {
      target[name] = value;
    }
  }
  return target;
}

// Merges the same MCP server sources Claude itself loads (user < project <
// local, later wins), so --strict-mcp-config only drops servers Claude
// wouldn't have loaded anyway rather than every host/project MCP server.
async function readHostClaudeMcpServers(args: {
  worktreePath: string;
  claudeConfigDir?: string;
}): Promise<Record<string, unknown>> {
  const merged: Record<string, unknown> = {};
  const userConfigPath = join(args.claudeConfigDir ?? homedir(), ".claude.json");
  const userConfig = await readJsonFile(userConfigPath);
  let localProject: unknown;
  if (isPlainObject(userConfig)) {
    mergeMcpServers(merged, userConfig.mcpServers);
    const projects = userConfig.projects;
    if (isPlainObject(projects)) {
      localProject = projects[args.worktreePath];
    }
  }
  const projectConfigPath = join(args.worktreePath, ".mcp.json");
  const projectConfig = await readJsonFile(projectConfigPath);
  if (isPlainObject(projectConfig)) {
    mergeMcpServers(merged, projectConfig.mcpServers);
  }
  if (isPlainObject(localProject)) {
    mergeMcpServers(merged, localProject.mcpServers);
  }
  return merged;
}

const AGENT_ADAPTERS: Record<AgentName, AgentAdapter> = {
  claude: {
    command: claudeCommand,
    buildLaunchPlan: (prompt, options) => buildClaudePlan(prompt, claudePlanOptions(options)),
    buildRestorePlan: (worktreePath, prompt, options) =>
      buildClaudeRestorePlan(worktreePath, prompt, claudePlanOptions(options)),
    buildResumePlan: (agentSessionId, binary, options) =>
      buildClaudeResumePlan(agentSessionId, binary, claudePlanOptions(options)),
    findSessionId: (worktreePath) => findClaudeSessionId(worktreePath),
    readConversation: (ctx) => readClaudeTranscriptEntries(ctx.worktreePath, ctx.agentSessionId),
    setup: async ({
      worktreePath,
      sessionToolDir,
      mcpBindings,
      restrictWrites,
      claudeConfigDir,
    }) => {
      const result: { claudeSettingsPath?: string; claudeMcpConfigPath?: string } = {};
      if (restrictWrites) {
        result.claudeSettingsPath = await ensureClaudeRestrictWritesSettings(sessionToolDir);
      }
      if (mcpBindings?.length) {
        const mcpConfigPath = join(sessionToolDir, "mcp-config.json");
        const mcpServers = await readHostClaudeMcpServers({
          worktreePath,
          ...(claudeConfigDir ? { claudeConfigDir } : {}),
        });
        for (const binding of mcpBindings) {
          mcpServers[binding.server] = { type: "http", url: binding.url };
        }
        const mcpConfig = { mcpServers };
        await writeFile(mcpConfigPath, JSON.stringify(mcpConfig, null, 2) + "\n", "utf8");
        result.claudeMcpConfigPath = mcpConfigPath;
      }
      return result;
    },
    processMatchers: (launchCommand) => defaultProcessMatchers(launchCommand, claudeCommand()),
    stateStrategy: "claude_jsonl",
    sendMode: "default",
    waitsForSubmitAck: true,
    submitAckWindowMs: DEFAULT_SUBMIT_ACK_WINDOW_MS,
    submitAckMaxResends: DEFAULT_SUBMIT_MAX_RESENDS,
    busyQueuedSendAwaitsPrompt: false,
    queuedSendPromptGraceMs: 15_000,
    submitAck: async (ctx) => {
      const baseline = await captureClaudeSubmitBaseline(ctx.worktreePath, ctx.agentSessionId);
      if (!baseline) {
        return null;
      }
      return {
        async scan(text) {
          const found = await scanClaudeJsonlForMessage(
            baseline,
            text,
            ctx.worktreePath,
            ctx.agentSessionId,
          );
          return { found, lastScannedFile: baseline.file };
        },
      };
    },
  },
  codex: {
    command: codexCommand,
    buildLaunchPlan: (prompt, options) => buildCodexPlan(prompt, codexPlanOptions(options)),
    buildRestorePlan: (worktreePath, prompt, options) =>
      buildCodexRestorePlan(worktreePath, prompt, codexPlanOptions(options)),
    buildResumePlan: (agentSessionId, binary, options) =>
      buildCodexResumePlan(agentSessionId, binary, codexPlanOptions(options)),
    findSessionId: (worktreePath, options) =>
      findCodexSessionId(worktreePath, {
        ...(options?.codexSessionRootDir ? { sessionRootDir: options.codexSessionRootDir } : {}),
      }),
    readConversation: (ctx) =>
      ctx.codexSessionsDir
        ? readCodexTranscriptEntries(ctx.codexSessionsDir)
        : Promise.resolve(null),
    setup: async ({
      sessionToolDir,
      worktreePath,
      mcpBindings,
      restrictWrites,
      modelsCacheHome,
    }) => ({
      codexHomePath: await ensureCodexHooksConfig(sessionToolDir, [worktreePath], {
        ...(restrictWrites ? { restrictWrites: true } : {}),
        ...(mcpBindings?.length ? { mcpBindings } : {}),
        ...(modelsCacheHome ? { modelsCacheHome } : {}),
      }),
    }),
    processMatchers: (launchCommand) => defaultProcessMatchers(launchCommand, codexCommand()),
    stateStrategy: "hook",
    sendMode: "bracketed_paste",
    waitsForSubmitAck: true,
    submitAckWindowMs: DEFAULT_SUBMIT_ACK_WINDOW_MS,
    submitAckMaxResends: DEFAULT_SUBMIT_MAX_RESENDS,
    busyQueuedSendAwaitsPrompt: false,
    queuedSendPromptGraceMs: 15_000,
    submitAck: async (ctx) => {
      const baseline = await captureCodexRolloutBaseline(ctx.codexSessionsDir);
      return {
        async scan(text) {
          return scanCodexRolloutForMessage(ctx.codexSessionsDir, text, baseline);
        },
      };
    },
  },
  cursor: {
    command: cursorCommand,
    buildLaunchPlan: (prompt, options) => buildCursorPlan(prompt, cursorPlanOptions(options)),
    buildRestorePlan: (worktreePath, prompt, options) =>
      buildCursorRestorePlan(worktreePath, prompt, cursorPlanOptions(options)),
    buildResumePlan: (agentSessionId, binary, options) =>
      buildCursorResumePlan(agentSessionId, binary, cursorPlanOptions(options)),
    findSessionId: (worktreePath, options) =>
      findCursorSessionId(
        worktreePath,
        options?.cursorConfigDir ? { configDir: options.cursorConfigDir } : undefined,
      ),
    readConversation: (ctx) => readCursorTranscriptEntries(ctx.worktreePath, ctx.agentSessionId),
    setup: async ({ worktreePath, restrictWrites, cursorConfigDir }) => {
      await ensureCursorWorkspaceTrust(worktreePath);
      if (restrictWrites && cursorConfigDir) {
        await ensureCursorRestrictWritesConfig(worktreePath, cursorConfigDir);
      }
      return {};
    },
    sessionConfig: ({ dataDir, sessionId, restrictWrites }) => {
      const cursorConfigDir = cursorConfigDirForSession(dataDir, sessionId);
      return {
        env: {
          CURSOR_CONFIG_DIR: cursorConfigDir,
          ...(restrictWrites ? { [CURSOR_RESTRICT_WRITES_ENV]: "1" } : {}),
        },
        planOptions: {
          cursorConfigDir,
        },
      };
    },
    processMatchers: (launchCommand) => {
      const derived = defaultProcessMatchers(launchCommand, cursorCommand());
      return [...new Set([...derived, "agent", "cursor-agent"])];
    },
    stateStrategy: "cursor_jsonl",
    sendMode: "default",
    waitsForSubmitAck: true,
    submitAckWindowMs: CURSOR_SUBMIT_ACK_WINDOW_MS,
    submitAckMaxResends: CURSOR_SUBMIT_MAX_RESENDS,
    busyQueuedSendAwaitsPrompt: true,
    queuedSendPromptGraceMs: 5_000,
    submitAck: async (ctx) => {
      const baseline = await captureCursorSubmitBaseline(ctx.worktreePath);
      if (!baseline) {
        return null;
      }
      return {
        async scan(text) {
          const found = await scanCursorJsonlForMessage(baseline, text, ctx.worktreePath);
          return { found, lastScannedFile: baseline.file };
        },
      };
    },
  },
};

function agentAdapter(agent: AgentName): AgentAdapter {
  return AGENT_ADAPTERS[agent];
}

export function parseAgentName(agent: string): AgentName {
  if (agent === "claude" || agent === "codex" || agent === "cursor") {
    return agent;
  }

  throw new Error(`Unsupported agent: ${agent}`);
}

export function buildAgentLaunchPlan(agent: AgentName, prompt: string, options?: AgentPlanOptions) {
  return agentAdapter(agent).buildLaunchPlan(prompt, options);
}

export async function buildAgentRestorePlan(
  agent: AgentName,
  worktreePath: string,
  prompt: string,
  options?: AgentPlanOptions,
): Promise<AgentLaunchPlan | null> {
  return agentAdapter(agent).buildRestorePlan(worktreePath, prompt, options);
}

export function extractCommandBinary(launchCommand: string, fallbackBinary: string): string {
  const trimmed = launchCommand.trim();
  if (!trimmed) {
    return fallbackBinary;
  }
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  for (const token of tokens) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
      continue;
    }
    if (token.startsWith("'")) {
      const closing = token.indexOf("'", 1);
      if (closing > 1) {
        return token.slice(1, closing);
      }
    }
    if (token.startsWith('"')) {
      const closing = token.indexOf('"', 1);
      if (closing > 1) {
        return token.slice(1, closing);
      }
    }
    return token;
  }
  return fallbackBinary;
}

export function buildAgentResumePlan(
  agent: AgentName,
  agentSessionId: string,
  launchCommand = "",
  options?: AgentPlanOptions,
): AgentResumePlan {
  const binary = extractCommandBinary(launchCommand, agentAdapter(agent).command());
  return agentAdapter(agent).buildResumePlan(agentSessionId, binary, options);
}

export async function findAgentSessionId(
  agent: AgentName,
  worktreePath: string,
  options?: AgentSessionLookupOptions,
): Promise<string | null> {
  return agentAdapter(agent).findSessionId(worktreePath, options);
}

export async function readAgentConversation(
  agent: AgentName,
  ctx: ConversationReadContext,
): Promise<TranscriptEntry[] | null> {
  return agentAdapter(agent).readConversation(ctx);
}

export async function setupAgentHooks(args: {
  agent: AgentName;
  worktreePath: string;
  sessionToolDir: string;
  mcpBindings?: SidecarMcpBinding[];
  restrictWrites?: boolean;
  cursorConfigDir?: string;
  claudeConfigDir?: string;
  modelsCacheHome?: string;
}): Promise<{
  claudeSettingsPath?: string;
  claudeMcpConfigPath?: string;
  codexHomePath?: string;
}> {
  return agentAdapter(args.agent).setup(args);
}

export function agentSessionConfig(
  agent: AgentName,
  args: { dataDir: string; sessionId: string; restrictWrites?: boolean },
): AgentSessionConfig {
  return agentAdapter(agent).sessionConfig?.(args) ?? {};
}

export function agentStateStrategy(agent: AgentName): AgentStateStrategy {
  return agentAdapter(agent).stateStrategy;
}

export function agentSendMode(agent: AgentName): AgentSendMode {
  return agentAdapter(agent).sendMode;
}

export function agentProcessMatchers(agent: AgentName, launchCommand: string): string[] {
  return agentAdapter(agent).processMatchers(launchCommand);
}

export function agentWaitsForSubmitAck(agent: AgentName): boolean {
  return agentAdapter(agent).waitsForSubmitAck;
}

export function agentSubmitAckWindowMs(agent: AgentName): number {
  return agentAdapter(agent).submitAckWindowMs;
}

export function agentSubmitAckMaxResends(agent: AgentName): number {
  return agentAdapter(agent).submitAckMaxResends;
}

export async function createAgentSubmitAckBinding(
  agent: AgentName,
  ctx: AgentSubmitAckContext,
): Promise<SubmitAckBinding | null> {
  const adapter = agentAdapter(agent);
  if (!adapter.submitAck) {
    return null;
  }
  return adapter.submitAck(ctx);
}

export function agentBusyQueuedSendAwaitsPrompt(agent: AgentName): boolean {
  return agentAdapter(agent).busyQueuedSendAwaitsPrompt;
}

export function agentQueuedSendPromptGraceMs(agent: AgentName): number {
  return agentAdapter(agent).queuedSendPromptGraceMs;
}
