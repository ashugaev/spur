import { execFile } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const CLEAR_PORT_TIMEOUT_MS = 2_000;
const CLEAR_PORT_POLL_MS = 100;
// Bounds `lsof`/`ss` so a hung listener-lookup process can never make the
// "doctor never hangs" invariant depend on the OS tool completing.
const LISTENER_LOOKUP_TIMEOUT_MS = 2_000;

function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port > 0 && port <= 65_535;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

// A probe failure must stay visibly distinct from an empty/zero-row success
// — the sidecar reap veto (hasEstablishedConnections) treats "the probe
// could not run" as "unknown" (keep, never reap), not as "no connections"
// (which would authorize a reap), and findListenerPids below leans on the
// same distinction to avoid reading an unavailable probe as proof a port is
// free.
async function execFileTriState(
  file: string,
  args: string[],
): Promise<{ ok: true; stdout: string } | { ok: false }> {
  try {
    const { stdout } = await execFileAsync(file, args, { timeout: LISTENER_LOOKUP_TIMEOUT_MS });
    return { ok: true, stdout: stdout.toString() };
  } catch {
    return { ok: false };
  }
}

function parseLsofPids(output: string): number[] {
  const pids = new Set<number>();
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!/^\d+$/.test(trimmed)) continue;
    pids.add(Number.parseInt(trimmed, 10));
  }
  return [...pids];
}

function parseSsPids(output: string): number[] {
  const pids = new Set<number>();
  const pidPattern = /pid=(\d+)/g;
  for (const match of output.matchAll(pidPattern)) {
    const pid = Number.parseInt(match[1] ?? "", 10);
    if (Number.isInteger(pid) && pid > 0) {
      pids.add(pid);
    }
  }
  return [...pids];
}

export function isHostPortFree(port: number): Promise<boolean> {
  if (!isValidPort(port)) {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    const server = createServer();
    server.unref();
    let settled = false;
    const settle = (free: boolean) => {
      if (settled) return;
      settled = true;
      resolve(free);
    };
    server.once("error", () => settle(false));
    server.listen({ port, host: "0.0.0.0", exclusive: true }, () => {
      server.close(() => settle(true));
    });
  });
}

// A failed probe (both tools missing, or both timing out) must stay
// distinguishable from "genuinely zero listeners" — collapsing the two would
// let a host with neither `lsof` nor `ss` (or one that only times out)
// report an occupied port as free. Throws only when NEITHER tool produced a
// usable result; either one succeeding (even with zero rows) is a real
// answer.
export async function findListenerPids(port: number): Promise<number[]> {
  if (!isValidPort(port)) {
    throw new Error(`Invalid port: ${port}`);
  }

  const lsofResult = await execFileTriState("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]);
  if (lsofResult.ok) {
    const lsofPids = parseLsofPids(lsofResult.stdout);
    if (lsofPids.length > 0) {
      return lsofPids;
    }
  }

  const ssResult = await execFileTriState("ss", ["-ltnp", "sport", "=", `:${port}`]);
  if (ssResult.ok) {
    return parseSsPids(ssResult.stdout);
  }

  if (lsofResult.ok) {
    // lsof ran and found nothing; ss being unavailable doesn't erase that.
    return [];
  }

  throw new Error(`Port listener probe unavailable for port ${port}: neither lsof nor ss ran`);
}

// The sidecar reap veto: an established TCP connection on a sidecar's
// reserved port is treated as "a user is debugging this", regardless of the
// owner session's status. `ss` prints a header row even with zero matches,
// so more than one non-empty line proves a live connection; anything the
// probe itself could not resolve (missing `ss`, timeout, non-zero exit)
// must come back "unknown" — never "none" — so a probe failure can never be
// misread as proof of no connections. See execFileTriState above.
export async function hasEstablishedConnections(
  port: number,
): Promise<"established" | "none" | "unknown"> {
  if (!isValidPort(port)) {
    return "unknown";
  }
  const result = await execFileTriState("ss", [
    "-tn",
    "state",
    "established",
    "sport",
    "=",
    `:${port}`,
  ]);
  if (!result.ok) {
    return "unknown";
  }
  const lines = result.stdout.split("\n").filter((line) => line.trim().length > 0);
  return lines.length > 1 ? "established" : "none";
}

export async function clearPortListener(port: number): Promise<void> {
  if (!isValidPort(port)) {
    throw new Error(`Invalid port: ${port}`);
  }

  const pids = await findListenerPids(port);
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch (error) {
      if (errorCode(error) !== "ESRCH") {
        throw error;
      }
    }
  }

  const deadline = Date.now() + CLEAR_PORT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await isHostPortFree(port)) {
      return;
    }
    await sleep(CLEAR_PORT_POLL_MS);
  }

  throw new Error(`Port ${port} is still busy after clearing listener`);
}
