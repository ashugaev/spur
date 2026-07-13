import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { iterArchivedThenLive, parseJsonLine, tryRotate } from "./jsonl-log-io.js";

export interface AgentIssueRecord {
  ts: string;
  text: string;
  sessionId?: string;
  projectId?: string;
}

const AGENT_ISSUE_LOG_FILE = "agent-issues.jsonl";

export const DEFAULT_AGENT_ISSUE_LOG_HOT_BYTES = 50 * 1024 * 1024;
export const DEFAULT_AGENT_ISSUE_LOG_RETAIN_ARCHIVES = 5;

export interface AgentIssueLogConfig {
  hotBytes: number;
  retainArchives: number;
}

export const DEFAULT_AGENT_ISSUE_LOG_CONFIG: AgentIssueLogConfig = {
  hotBytes: DEFAULT_AGENT_ISSUE_LOG_HOT_BYTES,
  retainArchives: DEFAULT_AGENT_ISSUE_LOG_RETAIN_ARCHIVES,
};

let agentIssueLogConfig: AgentIssueLogConfig = DEFAULT_AGENT_ISSUE_LOG_CONFIG;

export function setAgentIssueLogConfig(config: AgentIssueLogConfig): void {
  agentIssueLogConfig = config;
}

interface AgentIssueQuery {
  limit?: number;
  projectId?: string;
  sessionId?: string;
}

export function agentIssueLogPath(dataDir: string): string {
  return join(dataDir, AGENT_ISSUE_LOG_FILE);
}

export function appendAgentIssue(dataDir: string, record: AgentIssueRecord): void {
  try {
    mkdirSync(dataDir, { recursive: true });
    const path = agentIssueLogPath(dataDir);
    appendFileSync(path, `${JSON.stringify(record)}\n`, { encoding: "utf-8", mode: 0o600 });
    const cfg = agentIssueLogConfig;
    tryRotate(path, cfg.hotBytes, cfg.retainArchives);
  } catch {
    // Agent-issue logging must never block Spur runtime behavior.
  }
}

export function readAgentIssueLog(dataDir: string, query: AgentIssueQuery = {}): AgentIssueRecord[] {
  const cap = query.limit;
  const entries: AgentIssueRecord[] = [];
  for (const line of iterArchivedThenLive(
    agentIssueLogPath(dataDir),
    agentIssueLogConfig.retainArchives,
  )) {
    const entry = parseJsonLine<AgentIssueRecord>(line);
    if (!entry) continue;
    if (query.projectId !== undefined && entry.projectId !== query.projectId) continue;
    if (query.sessionId !== undefined && entry.sessionId !== query.sessionId) continue;
    entries.push(entry);
    if (cap !== undefined && entries.length > cap) entries.shift();
  }
  // Deliberate divergence from readUserActionLog: return newest-first so a human dev
  // triaging friction sees the most recent entries at the top.
  entries.reverse();
  return entries;
}
