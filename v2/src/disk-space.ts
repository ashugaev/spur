import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Same 2s ceiling as host-install.ts's DISK_SPACE_PROBE_TIMEOUT_MS: a probe,
// not a healthcheck, so a wedged `df` must never be allowed to stall a caller.
export const DISK_PROBE_TIMEOUT_MS = 2_000;

// `df -Pk`/`df -Pi` second line, 4th field (Available / IFree respectively,
// POSIX `-P` format). Any parse failure (missing `df`, a filesystem that
// reports `-` for inodes, etc.) is not itself an error — it just means this
// particular signal is unavailable on this host, not that the directory is
// unhealthy. Moved verbatim from host-install.ts so both the sync CLI
// consumer there and the async daemon consumer below share one parser.
export function parseDfField(output: string | undefined, fieldIndex: number): number | undefined {
  if (!output) return undefined;
  const dataLine = output.trim().split("\n")[1];
  if (!dataLine) return undefined;
  const raw = dataLine.trim().split(/\s+/)[fieldIndex];
  if (raw === undefined) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

// Async, non-throwing free-space probe for daemon call sites (SessionService).
// Never rejects: a wedged/absent `df` or unparsable output simply yields
// `undefined`, so callers never need a try/catch around it.
export async function readFreeKb(
  path: string,
  timeoutMs: number = DISK_PROBE_TIMEOUT_MS,
): Promise<number | undefined> {
  try {
    const { stdout } = await execFileAsync("df", ["-Pk", path], { timeout: timeoutMs });
    return parseDfField(stdout, 3);
  } catch {
    return undefined;
  }
}
