import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

export interface AgentHookStateRecord {
  state: "working" | "waiting" | "needs_input";
  updatedAt: string;
  hookEvent?: string;
  turnId?: string;
  fileMtimeMs?: number;
}

function hookStateFilePath(dataDir: string, sessionId: string): string {
  return join(dataDir, "session-agent-state", `${sessionId}.json`);
}

export function readAgentHookState(
  dataDir: string,
  sessionId: string,
): AgentHookStateRecord | null {
  const path = hookStateFilePath(dataDir, sessionId);
  if (!existsSync(path)) {
    return null;
  }
  try {
    const fileMtimeMs = statSync(path).mtimeMs;
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<AgentHookStateRecord>;
    if (
      (parsed.state === "working" ||
        parsed.state === "waiting" ||
        parsed.state === "needs_input") &&
      typeof parsed.updatedAt === "string"
    ) {
      return {
        state: parsed.state,
        updatedAt: parsed.updatedAt,
        ...(typeof parsed.hookEvent === "string" ? { hookEvent: parsed.hookEvent } : {}),
        ...(typeof parsed.turnId === "string" ? { turnId: parsed.turnId } : {}),
        ...(Number.isFinite(fileMtimeMs) ? { fileMtimeMs } : {}),
      };
    }
  } catch {
    return null;
  }
  return null;
}

export function deleteAgentHookState(dataDir: string, sessionId: string): void {
  rmSync(hookStateFilePath(dataDir, sessionId), { force: true });
}
