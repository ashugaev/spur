import { existsSync, readFileSync } from "node:fs";

const MEMINFO_PATH = "/proc/meminfo";
const SELF_CGROUP_PATH = "/proc/self/cgroup";
const CGROUP_ROOT = "/sys/fs/cgroup";
const SYSTEMD_OOMD_SOCKET = "/run/systemd/io.systemd.oom";

export interface HostMemory {
  totalBytes: number;
  availableBytes: number;
  swapTotalBytes: number;
  swapFreeBytes: number;
}

export interface CgroupMemoryPressure {
  someAvg10: number;
  someAvg60: number;
  fullAvg10: number;
}

export interface CgroupMemoryLimits {
  path: string;
  highBytes: number | null;
  maxBytes: number | null;
}

// Deliberately reads /proc/meminfo, not os.freemem(): on Linux, freemem()
// excludes reclaimable page cache, so a healthy host with a large cache would
// report as critically low. MemAvailable already accounts for reclaimable
// cache. The admission and shedding guards use this host-level sample; session
// state still determines whether a particular candidate is safe to stop.
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
    const swapTotalBytes = parseMeminfoField(text, "SwapTotal") ?? 0;
    const swapFreeBytes = parseMeminfoField(text, "SwapFree");
    if (totalBytes === undefined || availableBytes === undefined || swapFreeBytes === undefined) {
      return null;
    }
    return { totalBytes, availableBytes, swapTotalBytes, swapFreeBytes };
  } catch {
    return null;
  }
}

function resolveCgroupMemoryPath(): { path: string; directory: string } | null {
  try {
    const line = readFileSync(SELF_CGROUP_PATH, "utf-8")
      .split("\n")
      .find((entry) => entry.startsWith("0::"));
    if (!line) return null;
    const path = line.slice(3).trim();
    if (!path.startsWith("/")) return null;
    return { path, directory: `${CGROUP_ROOT}${path}` };
  } catch {
    return null;
  }
}

function parsePressureValue(line: string, field: string): number | null {
  const match = new RegExp(`(?:^|\\s)${field}=([0-9]+(?:\\.[0-9]+)?)`).exec(line);
  if (!match?.[1]) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

export function readCgroupPressure(): CgroupMemoryPressure | null {
  const cgroup = resolveCgroupMemoryPath();
  if (!cgroup) return null;
  try {
    const lines = readFileSync(`${cgroup.directory}/memory.pressure`, "utf-8").split("\n");
    const some = lines.find((line) => line.startsWith("some "));
    const full = lines.find((line) => line.startsWith("full "));
    if (!some || !full) return null;
    const someAvg10 = parsePressureValue(some, "avg10");
    const someAvg60 = parsePressureValue(some, "avg60");
    const fullAvg10 = parsePressureValue(full, "avg10");
    if (someAvg10 === null || someAvg60 === null || fullAvg10 === null) return null;
    return { someAvg10, someAvg60, fullAvg10 };
  } catch {
    return null;
  }
}

function parseCgroupLimit(value: string): number | null | undefined {
  const trimmed = value.trim();
  if (trimmed === "max") return null;
  if (!/^\d+$/.test(trimmed)) return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function readCgroupMemoryLimits(): CgroupMemoryLimits | null {
  const cgroup = resolveCgroupMemoryPath();
  if (!cgroup) return null;
  try {
    const highBytes = parseCgroupLimit(readFileSync(`${cgroup.directory}/memory.high`, "utf-8"));
    const maxBytes = parseCgroupLimit(readFileSync(`${cgroup.directory}/memory.max`, "utf-8"));
    if (highBytes === undefined || maxBytes === undefined) return null;
    return { path: cgroup.path, highBytes, maxBytes };
  } catch {
    return null;
  }
}

export function isSystemdOomdPresent(): boolean {
  try {
    return existsSync(SYSTEMD_OOMD_SOCKET);
  } catch {
    return false;
  }
}
