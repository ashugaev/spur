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
const AGENT_ISSUE_LOG_HOT_BYTES = 50 * 1024 * 1024;
const AGENT_ISSUE_LOG_RETAIN_ARCHIVES = 5;

interface AgentIssueQuery {
  limit?: number;
  projectId?: string;
  sessionId?: string;
}

export function agentIssueLogPath(dataDir: string): string {
  return join(dataDir, AGENT_ISSUE_LOG_FILE);
}

export function appendAgentIssue(dataDir: string, record: AgentIssueRecord): void {
  // CLI-user-invoked write, not a runtime hot path: let write failures propagate so
  // the CLI can surface them instead of silently losing the friction record.
  mkdirSync(dataDir, { recursive: true });
  const path = agentIssueLogPath(dataDir);
  appendFileSync(path, `${JSON.stringify(record)}\n`, { encoding: "utf-8", mode: 0o600 });
  tryRotate(path, AGENT_ISSUE_LOG_HOT_BYTES, AGENT_ISSUE_LOG_RETAIN_ARCHIVES);
}

export function readAgentIssueLog(
  dataDir: string,
  query: AgentIssueQuery = {},
): AgentIssueRecord[] {
  const cap = query.limit;
  const entries: AgentIssueRecord[] = [];
  for (const line of iterArchivedThenLive(
    agentIssueLogPath(dataDir),
    AGENT_ISSUE_LOG_RETAIN_ARCHIVES,
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
