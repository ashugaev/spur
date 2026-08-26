import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { HostChangedFailureKind } from "./deploy-switch-state.js";
import { iterLiveLines, parseJsonLine } from "./jsonl-log-io.js";

// Append-only policy memory for the update path, written by three processes
// (install-and-restart.sh's EXIT trap, the `spur update` monitor, the daemon's
// auto-update tick) and read by the tick. Two line kinds:
//   blocked  — this version installed and left the host changed; never attempt
//              it automatically again. Outlives the deploy-switch record,
//              which POST /deploy/auto-update and any Switch may clear.
//   disarmed — autoUpdate was already turned off once for this version, so a
//              hand-edited `autoUpdate: true` is never overwritten again.
// Never cleared, never pruned, never rotated: `iterLiveLines` alone is the
// read side, not `iterArchivedThenLive`.

const UPDATE_LEDGER_FILE = "update-ledger.jsonl";

export type UpdateLedgerEntry =
  | { kind: "blocked"; version: string; failureKind: HostChangedFailureKind; at: string }
  | { kind: "disarmed"; version: string; at: string };

export interface UpdateLedger {
  blocked: Set<string>;
  disarmed: Set<string>;
}

export function updateLedgerPath(dataDir: string): string {
  return join(dataDir, UPDATE_LEDGER_FILE);
}

export function appendUpdateLedgerLine(path: string, entry: UpdateLedgerEntry): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(entry)}\n`, { encoding: "utf-8", mode: 0o600 });
}

// `parseJsonLine` casts without validating, so admit a line only when it names
// a kind this module knows and a non-empty version: a truncated or corrupt
// line must never enter the never-retry set nor fake a disarm.
function isLedgerLine(value: unknown): value is { kind: "blocked" | "disarmed"; version: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const line = value as Record<string, unknown>;
  if (line.kind !== "blocked" && line.kind !== "disarmed") return false;
  return typeof line.version === "string" && line.version.length > 0;
}

export function readUpdateLedger(path: string): UpdateLedger {
  const blocked = new Set<string>();
  const disarmed = new Set<string>();
  for (const line of iterLiveLines(path)) {
    const entry = parseJsonLine<unknown>(line);
    if (!isLedgerLine(entry)) continue;
    (entry.kind === "blocked" ? blocked : disarmed).add(entry.version);
  }
  return { blocked, disarmed };
}
