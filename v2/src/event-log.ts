import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export type EventLevel = "info" | "warn" | "error";

interface EventRecord {
  event: string;
  level: EventLevel;
  message: string;
  timestamp: string;
  pid: number;
  ppid: number;
  sessionId?: string;
  projectId?: string;
  details?: Record<string, unknown>;
}

export function appendEvent(
  dataDir: string,
  input: Omit<EventRecord, "timestamp" | "pid" | "ppid">,
): void {
  const path = join(dataDir, "events.jsonl");
  mkdirSync(dirname(path), { recursive: true });
  const record: EventRecord = {
    ...input,
    timestamp: new Date().toISOString(),
    pid: process.pid,
    ppid: process.ppid,
  };
  appendFileSync(path, JSON.stringify(record) + "\n", "utf-8");
}

export function errorDetails(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }

  return {
    message: String(error),
  };
}
