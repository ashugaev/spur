import { basename } from "node:path";
import {
  buildClaudePlan,
  buildClaudeRestorePlan,
  buildClaudeResumePlan,
  claudeCommand,
  findClaudeSessionId,
} from "./claude.js";
import {
  buildCodexPlan,
  buildCodexRestorePlan,
  buildCodexResumePlan,
  codexCommand,
  ensureCodexHooksConfig,
  findCodexSessionId,
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
import type { AgentName } from "../types.js";
import type { AgentLaunchPlan, AgentResumePlan } from "./types.js";
export type { AgentLaunchPlan, AgentResumePlan } from "./types.js";

interface AgentPlanOptions {
  claudeSettingsPath?: string;
  codexHomePath?: string;
  cursorConfigDir?: string;
  planMode?: boolean;
}

interface AgentSessionConfig {
  env?: Record<string, string>;
  planOptions?: AgentPlanOptions;
}

export type AgentStateStrategy = "claude_jsonl" | "hook" | "cursor_pane";
export type AgentSendMode = "default" | "bracketed_paste";

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
  findSessionId(worktreePath: string, options?: AgentPlanOptions): Promise<string | null>;
  setup(args: {
    worktreePath: string;
    sessionToolDir: string;
  }): Promise<{ claudeSettingsPath?: string; codexHomePath?: string }>;
  sessionConfig?(args: { dataDir: string; sessionId: string }): AgentSessionConfig;
  processMatchers(launchCommand: string): string[];
  stateStrategy: AgentStateStrategy;
  sendMode: AgentSendMode;
  waitsForSubmitAck: boolean;
}

function claudePlanOptions(options?: AgentPlanOptions): {
  settingsPath?: string;
  planMode?: boolean;
} {
  return {
    ...(options?.claudeSettingsPath ? { settingsPath: options.claudeSettingsPath } : {}),
    ...(options?.planMode ? { planMode: true } : {}),
  };
}

function codexPlanOptions(options?: AgentPlanOptions): { codexHomePath?: string } {
  return options?.codexHomePath ? { codexHomePath: options.codexHomePath } : {};
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
    setup: async () => ({}),
    processMatchers: (launchCommand) => defaultProcessMatchers(launchCommand, claudeCommand()),
    stateStrategy: "claude_jsonl",
    sendMode: "default",
    waitsForSubmitAck: false,
  },
  codex: {
    command: codexCommand,
    buildLaunchPlan: (prompt, options) => buildCodexPlan(prompt, codexPlanOptions(options)),
    buildRestorePlan: (worktreePath, prompt, options) =>
      buildCodexRestorePlan(worktreePath, prompt, codexPlanOptions(options)),
    buildResumePlan: (agentSessionId, binary, options) =>
      buildCodexResumePlan(agentSessionId, binary, codexPlanOptions(options)),
    findSessionId: (worktreePath) => findCodexSessionId(worktreePath),
    setup: async ({ sessionToolDir }) => ({
      codexHomePath: await ensureCodexHooksConfig(sessionToolDir),
    }),
    processMatchers: (launchCommand) => defaultProcessMatchers(launchCommand, codexCommand()),
    stateStrategy: "hook",
    sendMode: "bracketed_paste",
    waitsForSubmitAck: true,
  },
  cursor: {
    command: cursorCommand,
    buildLaunchPlan: (prompt, options) => buildCursorPlan(prompt, options),
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
    stateStrategy: "cursor_pane",
    sendMode: "default",
    waitsForSubmitAck: false,
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
  options?: AgentPlanOptions,
): Promise<string | null> {
  return agentAdapter(agent).findSessionId(worktreePath, options);
}

export async function setupAgentHooks(args: {
  agent: AgentName;
  worktreePath: string;
  sessionToolDir: string;
}): Promise<{ claudeSettingsPath?: string; codexHomePath?: string }> {
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
