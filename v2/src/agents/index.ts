import { writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { playwrightMcpUrl } from "./playwright-mcp.js";
import {
  buildClaudePlan,
  buildClaudeRestorePlan,
  buildClaudeResumePlan,
  claudeCommand,
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
  scanCodexRolloutForMessage,
} from "./codex.js";
import {
  buildCursorPlan,
  buildCursorRestorePlan,
  buildCursorResumePlan,
  cursorCommand,
  cursorConfigDirForSession,
  ensureCursorWorkspaceTrust,
  findCursorSessionId,
} from "./cursor.js";
import { captureCursorSubmitBaseline, scanCursorJsonlForMessage } from "./cursor-submit-ack.js";
import type { AgentName } from "../types.js";
import type { AgentLaunchPlan, AgentResumePlan } from "./types.js";

export type { AgentLaunchPlan, AgentResumePlan } from "./types.js";

interface AgentPlanOptions {
  claudeSettingsPath?: string;
  claudeMcpConfigPath?: string;
  codexHomePath?: string;
  codexArgs?: string[];
  cursorConfigDir?: string;
  planMode?: boolean;
  startupImagePaths?: string[];
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
const CURSOR_SUBMIT_ACK_WINDOW_MS = 1_500;
const CURSOR_SUBMIT_MAX_RESENDS = 6;

export interface AgentSubmitAckContext {
  worktreePath: string;
  codexSessionsDir: string;
}

export interface SubmitAckScanResult {
  found: boolean;
  lastScannedFile: string | null;
}

export interface SubmitAckBinding {
  scan(text: string): Promise<SubmitAckScanResult>;
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
  setup(args: { worktreePath: string; sessionToolDir: string; playwrightPort?: number }): Promise<{
    claudeSettingsPath?: string;
    claudeMcpConfigPath?: string;
    codexHomePath?: string;
  }>;
  sessionConfig?(args: { dataDir: string; sessionId: string }): AgentSessionConfig;
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
} {
  return {
    ...(options?.claudeSettingsPath ? { settingsPath: options.claudeSettingsPath } : {}),
    ...(options?.planMode ? { planMode: true } : {}),
    ...(options?.claudeMcpConfigPath ? { mcpConfigPath: options.claudeMcpConfigPath } : {}),
  };
}

function codexPlanOptions(options?: AgentPlanOptions): {
  codexHomePath?: string;
  codexArgs?: string[];
  startupImagePaths?: string[];
} {
  return {
    ...(options?.codexHomePath ? { codexHomePath: options.codexHomePath } : {}),
    ...(options?.codexArgs ? { codexArgs: options.codexArgs } : {}),
    ...(options?.startupImagePaths ? { startupImagePaths: options.startupImagePaths } : {}),
  };
}

function cursorPlanOptions(options?: AgentPlanOptions): {
  cursorConfigDir?: string;
  planMode?: boolean;
} {
  return {
    ...(options?.cursorConfigDir ? { cursorConfigDir: options.cursorConfigDir } : {}),
    ...(options?.planMode ? { planMode: true } : {}),
  };
}

function defaultProcessMatchers(launchCommand: string, fallbackBinary: string): string[] {
  const binary = basename(extractCommandBinary(launchCommand, fallbackBinary));
  return binary ? [binary] : [];
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
    setup: async ({ sessionToolDir, playwrightPort }) => {
      if (playwrightPort === undefined) {
        return {};
      }
      const mcpConfigPath = join(sessionToolDir, "mcp-config.json");
      const mcpConfig = {
        mcpServers: {
          playwright: { type: "http", url: playwrightMcpUrl(playwrightPort) },
        },
      };
      await writeFile(mcpConfigPath, JSON.stringify(mcpConfig, null, 2) + "\n", "utf8");
      return { claudeMcpConfigPath: mcpConfigPath };
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
      const baseline = await captureClaudeSubmitBaseline(ctx.worktreePath);
      if (!baseline) {
        return null;
      }
      return {
        async scan(text) {
          const found = await scanClaudeJsonlForMessage(baseline, text, ctx.worktreePath);
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
    setup: async ({ sessionToolDir, worktreePath, playwrightPort }) => ({
      codexHomePath: await ensureCodexHooksConfig(sessionToolDir, [worktreePath], playwrightPort),
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
    setup: async ({ worktreePath }) => {
      await ensureCursorWorkspaceTrust(worktreePath);
      return {};
    },
    sessionConfig: ({ dataDir, sessionId }) => {
      const cursorConfigDir = cursorConfigDirForSession(dataDir, sessionId);
      return {
        env: {
          CURSOR_CONFIG_DIR: cursorConfigDir,
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

export async function setupAgentHooks(args: {
  agent: AgentName;
  worktreePath: string;
  sessionToolDir: string;
  playwrightPort?: number;
}): Promise<{
  claudeSettingsPath?: string;
  claudeMcpConfigPath?: string;
  codexHomePath?: string;
}> {
  return agentAdapter(args.agent).setup(args);
}

export function agentSessionConfig(
  agent: AgentName,
  args: { dataDir: string; sessionId: string },
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
