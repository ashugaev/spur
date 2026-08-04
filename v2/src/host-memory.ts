import { readFileSync } from "node:fs";

const MEMINFO_PATH = "/proc/meminfo";

export interface HostMemory {
  totalBytes: number;
  availableBytes: number;
  swapFreeBytes: number;
}

// Deliberately reads /proc/meminfo, not os.freemem(): on Linux, freemem()
// excludes reclaimable page cache, so a healthy host with a large cache would
// report as critically low. MemAvailable already accounts for reclaimable
// cache. Report-only (see AdmissionConfig.memoryGuard) — never used to pick
// a candidate to kill, only to decide whether to admit a new session.
function parseMeminfoField(text: string, field: string): number | undefined {
  const match = text.match(new RegExp(`^${field}:\\s*(\\d+)\\s*kB$`, "m"));
  if (!match || match[1] === undefined) return undefined;
  const kb = Number.parseInt(match[1], 10);
  return Number.isFinite(kb) ? kb * 1024 : undefined;
}

export function readHostMemory(): HostMemory | null {
  try {
    const text = readFileSync(MEMINFO_PATH, "utf-8");
    const totalBytes = parseMeminfoField(text, "MemTotal");
    const availableBytes = parseMeminfoField(text, "MemAvailable");
    const swapFreeBytes = parseMeminfoField(text, "SwapFree");
    if (totalBytes === undefined || availableBytes === undefined || swapFreeBytes === undefined) {
      return null;
    }
    return { totalBytes, availableBytes, swapFreeBytes };
  } catch {
    return null;
  }
}
