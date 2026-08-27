import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { isHostChangedFailureKind, type HostChangedFailureKind } from "./deploy-switch-state.js";
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

export interface BlockedLedgerEntry {
  kind: "blocked";
  version: string;
  failureKind: HostChangedFailureKind;
  at: string;
}

export interface DisarmedLedgerEntry {
  kind: "disarmed";
  version: string;
  at: string;
}

export type UpdateLedgerEntry = BlockedLedgerEntry | DisarmedLedgerEntry;

// Keyed by version, valued by the line that put it there, so `failureKind` and
// `at` survive the read instead of being written and dropped: `.has` answers
// the tick's question, the value answers "which kind, and since when".
export interface UpdateLedger {
  blocked: Map<string, BlockedLedgerEntry>;
  disarmed: Map<string, DisarmedLedgerEntry>;
}

export function updateLedgerPath(dataDir: string): string {
  return join(dataDir, UPDATE_LEDGER_FILE);
}

export function appendUpdateLedgerLine(path: string, entry: UpdateLedgerEntry): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(entry)}\n`, { encoding: "utf-8", mode: 0o600 });
}

// `parseJsonLine` casts without validating, so admit a line only when every
// field of the entry type is there: a truncated or corrupt line must never
// enter the never-retry set nor fake a disarm. `at` is checked as a parseable
// date and a `blocked` line's `failureKind` against the host-changed subset,
// narrower than what the tick asks of the status record: interrupted_unknown
// never installed provably, so it must never permanently block a version.
function isLedgerLine(value: unknown): value is UpdateLedgerEntry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const line = value as Record<string, unknown>;
  if (typeof line.version !== "string" || line.version.length === 0) return false;
  if (typeof line.at !== "string" || Number.isNaN(Date.parse(line.at))) return false;
  if (line.kind === "disarmed") return true;
  return line.kind === "blocked" && isHostChangedFailureKind(line.failureKind);
}

export function readUpdateLedger(path: string): UpdateLedger {
  const blocked = new Map<string, BlockedLedgerEntry>();
  const disarmed = new Map<string, DisarmedLedgerEntry>();
  for (const line of iterLiveLines(path)) {
    const entry = parseJsonLine<unknown>(line);
    if (!isLedgerLine(entry)) continue;
    // First line for a version wins: the file is append-only history, so the
    // earliest line is when that version was blocked, or first disarmed.
    if (entry.kind === "blocked") {
      if (!blocked.has(entry.version)) blocked.set(entry.version, entry);
    } else if (!disarmed.has(entry.version)) {
      disarmed.set(entry.version, entry);
    }
  }
  return { blocked, disarmed };
}
