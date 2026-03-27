import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

interface AgentHookStateRecord {
  state: "working" | "waiting";
  updatedAt: string;
}

function stateFilePath(dataDir: string, sessionId: string): string {
  return join(dataDir, "session-agent-state", `${sessionId}.json`);
}

export function readAgentHookState(dataDir: string, sessionId: string): AgentHookStateRecord | null {
  const path = stateFilePath(dataDir, sessionId);
  if (!existsSync(path)) {
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<AgentHookStateRecord>;
    if (
      (parsed.state === "working" || parsed.state === "waiting") &&
      typeof parsed.updatedAt === "string"
    ) {
      return {
        state: parsed.state,
        updatedAt: parsed.updatedAt,
      };
    }
  } catch {
    return null;
  }
  return null;
}

export function deleteAgentHookState(dataDir: string, sessionId: string): void {
  rmSync(stateFilePath(dataDir, sessionId), { force: true });
}
