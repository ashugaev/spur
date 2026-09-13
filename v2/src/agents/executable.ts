import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import type { AgentName } from "../types.js";

interface AgentExecutableSpec {
  command: string;
  env: string;
  processAliases?: readonly string[];
}

const AGENT_EXECUTABLES: Record<AgentName, AgentExecutableSpec> = {
  claude: { command: "claude", env: "SPUR_CLAUDE_BIN" },
  codex: { command: "codex", env: "SPUR_CODEX_BIN" },
  cursor: { command: "agent", env: "SPUR_CURSOR_BIN", processAliases: ["cursor-agent"] },
  opencode: { command: "opencode", env: "SPUR_OPENCODE_BIN" },
};

export interface AgentExecutableResolution {
  command: string;
  path: string | null;
  source: "environment" | "path";
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function agentExecutableCommand(agent: AgentName): string {
  const executable = AGENT_EXECUTABLES[agent];
  return process.env[executable.env] || executable.command;
}

// The canonical binary name(s) an agent's own process is known to run as,
// independent of any SPUR_*_BIN override — the fixed point defaultProcessMatchers
// appends to the launchCommand-derived basename so an exec'ing wrapper does not
// erase the agent from ps.
export function agentProcessNames(agent: AgentName): string[] {
  const executable = AGENT_EXECUTABLES[agent];
  return [executable.command, ...(executable.processAliases ?? [])];
}

export function resolveAgentExecutable(agent: AgentName): AgentExecutableResolution {
  const executable = AGENT_EXECUTABLES[agent];
  const override = process.env[executable.env];
  const command = override || executable.command;
  if (isAbsolute(command)) {
    return {
      command,
      path: isExecutable(command) ? command : null,
      source: override ? "environment" : "path",
    };
  }
  for (const directory of (process.env["PATH"] ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, command);
    if (isExecutable(candidate)) {
      return { command, path: candidate, source: override ? "environment" : "path" };
    }
  }
  return { command, path: null, source: override ? "environment" : "path" };
}

export function missingAgentExecutableMessage(agent: AgentName): string {
  const resolution = resolveAgentExecutable(agent);
  const env = AGENT_EXECUTABLES[agent].env;
  return `${agent} executable not found: ${resolution.command}; install it on PATH or set ${env} to an executable path`;
}
