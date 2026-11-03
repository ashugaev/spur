import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { AutoPingMuteView } from "./types.js";

const HISTORY_DIR = "auto-ping-history";

interface MuteHistoryEvent {
  type: "muted" | "ended";
  record: AutoPingMuteView;
}

function historyPath(dataDir: string, sessionId: string): string {
  return join(dataDir, HISTORY_DIR, `${encodeURIComponent(sessionId)}.jsonl`);
}

// Append-only and daemon-owned. Records carry mute metadata only, never a handle.
export function appendMuteHistory(
  dataDir: string,
  sessionId: string,
  type: MuteHistoryEvent["type"],
  record: AutoPingMuteView,
): void {
  const path = historyPath(dataDir, sessionId);
  mkdirSync(join(dataDir, HISTORY_DIR), { recursive: true, mode: 0o700 });
  appendFileSync(path, `${JSON.stringify({ type, record } satisfies MuteHistoryEvent)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  chmodSync(path, 0o600);
}

function isHistoryEvent(value: unknown): value is MuteHistoryEvent {
  if (typeof value !== "object" || value === null) return false;
  const event = value as Record<string, unknown>;
  const record = event["record"];
  return (
    (event["type"] === "muted" || event["type"] === "ended") &&
    typeof record === "object" &&
    record !== null &&
    typeof (record as Record<string, unknown>)["suppressionId"] === "string"
  );
}

// Folds events by suppressionId: the latest event per id wins. Oldest first.
export function readMuteHistory(dataDir: string, sessionId: string): AutoPingMuteView[] {
  const path = historyPath(dataDir, sessionId);
  if (!existsSync(path)) return [];
  const byId = new Map<string, AutoPingMuteView>();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (isHistoryEvent(parsed)) byId.set(parsed.record.suppressionId, parsed.record);
  }
  return [...byId.values()].sort(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) ||
      left.suppressionId.localeCompare(right.suppressionId),
  );
}

export function deleteMuteHistory(dataDir: string, sessionId: string): void {
  rmSync(historyPath(dataDir, sessionId), { force: true });
}
