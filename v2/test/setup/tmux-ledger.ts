// globalSetup for the runtime and smoke vitest configs (`pool: "forks"`):
// runs once in the MAIN process before any worker fork, so a `process.env`
// write here is inherited by every worker — that is the transport for the
// ledger path, no `provide()` needed. `setup()` writes the run-unique
// ledger path into SPUR_TEST_TMUX_LEDGER; `recordTmuxServer` (runtime.ts)
// appends one line per tmux server a worker actually confirmed live;
// `teardown()` kills only the servers this run recorded, identity-gated by
// the server's own live pid, then removes the ledger file.
//
// Never scans the process table, never matches a socket-name shape, never
// signals a pid directly — the only side effect on a live tmux server is
// `tmux -L <socket> kill-server`, and only after this run's own recorded pid
// is confirmed to still be that socket's live server pid.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

let ledgerPath: string | undefined;

export async function setup(): Promise<void> {
  const root = tmpdir();
  // TMPDIR may not exist yet (a fresh sandbox, a wiped scratch dir) — mkdir
  // -p its parent before creating the file (C2).
  mkdirSync(root, { recursive: true });
  ledgerPath = join(
    root,
    `spur-tmux-ledger-${process.pid}-${Math.random().toString(36).slice(2)}.jsonl`,
  );
  writeFileSync(ledgerPath, "", "utf8");
  process.env["SPUR_TEST_TMUX_LEDGER"] = ledgerPath;
}

interface LedgerEntry {
  socketName: string;
  serverPid: string;
}

function parseLedgerLine(line: string): LedgerEntry | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as Record<string, unknown>)["socketName"] === "string" &&
      typeof (parsed as Record<string, unknown>)["serverPid"] === "string"
    ) {
      return parsed as LedgerEntry;
    }
    return null;
  } catch {
    return null;
  }
}

// Exported for the runtime test: reads the ledger, keeps the LAST entry per
// socketName, and kills a socket's server ONLY when a live `display-message`
// probe on that exact socket returns the SAME pid this run recorded. Returns
// the socket names actually killed. Never throws — an unreadable/missing
// ledger (e.g. its TMPDIR was wiped before teardown ran) degrades to `[]`,
// because a throwing globalSetup teardown fails the whole tier (C1).
export async function sweepTmuxLedger(path: string): Promise<string[]> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch {
    return [];
  }

  const bySocket = new Map<string, string>();
  for (const line of content.split("\n")) {
    const entry = parseLedgerLine(line);
    if (entry) bySocket.set(entry.socketName, entry.serverPid);
  }

  const killed: string[] = [];
  for (const [socketName, recordedPid] of bySocket) {
    let livePid: string;
    try {
      const { stdout } = await execFileAsync("tmux", [
        "-L",
        socketName,
        "display-message",
        "-p",
        "#{pid}",
      ]);
      livePid = stdout.trim();
    } catch {
      continue;
    }
    if (!livePid || livePid !== recordedPid) continue;
    try {
      await execFileAsync("tmux", ["-L", socketName, "kill-server"]);
      killed.push(socketName);
    } catch {
      // Best effort only.
    }
  }
  return killed;
}

export async function teardown(): Promise<void> {
  const path = ledgerPath ?? process.env["SPUR_TEST_TMUX_LEDGER"];
  if (!path) return;
  try {
    await sweepTmuxLedger(path);
  } catch {
    // A throwing globalSetup teardown fails the whole tier — never let a
    // sweep failure propagate out of here.
  } finally {
    try {
      if (existsSync(path)) unlinkSync(path);
    } catch {
      // Best effort only.
    }
  }
}
