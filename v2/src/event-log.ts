import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type SpurLogLevel = "info" | "warn" | "error";

export interface SpurLogEntry {
  timestamp: string;
  event: string;
  level: SpurLogLevel;
  message?: string;
  sessionId?: string;
  projectId?: string;
  sourceId?: string;
  triggerId?: string;
  method?: string;
  path?: string;
  details?: Record<string, unknown>;
}

const EVENT_LOG_FILE = "events.jsonl";
type SpurLogEntryInput = Omit<SpurLogEntry, "timestamp"> & { timestamp?: string };

export function eventLogPath(dataDir: string): string {
  return join(dataDir, EVENT_LOG_FILE);
}

export function appendEventLog(dataDir: string, entry: SpurLogEntryInput): void {
  mkdirSync(dataDir, { recursive: true });
  const record: SpurLogEntry = {
    ...entry,
    timestamp: entry.timestamp ?? new Date().toISOString(),
  };
  appendFileSync(eventLogPath(dataDir), `${JSON.stringify(record)}\n`, {
    encoding: "utf-8",
    mode: 0o600,
  });
}

export function logSpurEvent(dataDir: string, entry: SpurLogEntryInput): void {
  try {
    appendEventLog(dataDir, entry);
  } catch {
    // Logging must never block Spur runtime behavior.
  }
}

export function readEventLog(dataDir: string): SpurLogEntry[] {
  const path = eventLogPath(dataDir);
  if (!existsSync(path)) return [];

  return readFileSync(path, "utf-8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as SpurLogEntry];
      } catch {
        return [];
      }
    });
}

export function readSessionEventLog(
  dataDir: string,
  sessionId: string,
  limit?: number,
): SpurLogEntry[] {
  const entries = readEventLog(dataDir).filter((entry) => entry.sessionId === sessionId);
  return limit === undefined ? entries : entries.slice(-limit);
}
