import { readFile, statfs } from "node:fs/promises";

export interface ResourceSnapshotUnavailable {
  available: false;
}

export interface ResourceSnapshotAvailable {
  available: true;
  cpuPercent: number;
  memoryPercent: number;
  diskPercent: number;
}

export type ResourceSnapshot = ResourceSnapshotUnavailable | ResourceSnapshotAvailable;

interface CpuSample {
  idle: number;
  total: number;
}

const MEMINFO_FIELDS = new Set(["MemAvailable", "MemTotal"]);

let previousCpuSample: CpuSample | null = null;

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function parseCpuSample(input: string): CpuSample {
  const cpuLine = input.split("\n").find((line) => line.startsWith("cpu "));
  if (!cpuLine) {
    throw new Error("Missing cpu sample");
  }

  const values = cpuLine
    .trim()
    .split(/\s+/)
    .slice(1)
    .map((part) => Number(part));

  if (values.length < 4 || values.some((value) => !Number.isFinite(value))) {
    throw new Error("Invalid cpu sample");
  }

  const idle = (values[3] ?? 0) + (values[4] ?? 0);
  const total = values.reduce((sum, value) => sum + value, 0);
  return { idle, total };
}

async function readCpuSample(): Promise<CpuSample> {
  return parseCpuSample(await readFile("/proc/stat", "utf8"));
}

function cpuPercentBetween(previous: CpuSample, current: CpuSample): number | null {
  const totalDelta = current.total - previous.total;
  const idleDelta = current.idle - previous.idle;
  if (totalDelta <= 0 || idleDelta < 0) {
    return null;
  }
  return clampPercent(((totalDelta - idleDelta) / totalDelta) * 100);
}

async function readCpuPercent(): Promise<number | null> {
  const current = await readCpuSample();
  const baseline = previousCpuSample;
  previousCpuSample = current;

  if (!baseline) {
    return null;
  }

  return cpuPercentBetween(baseline, current);
}

function parseMeminfo(input: string): number {
  const values = new Map<string, number>();

  for (const line of input.split("\n")) {
    const match = line.match(/^([A-Za-z()_]+):\s+(\d+)\s+kB$/);
    if (!match || !match[1] || !match[2] || !MEMINFO_FIELDS.has(match[1])) {
      continue;
    }
    values.set(match[1], Number(match[2]));
  }

  const total = values.get("MemTotal");
  const available = values.get("MemAvailable");
  if (!total || available === undefined || total <= 0 || available < 0 || available > total) {
    throw new Error("Invalid memory sample");
  }

  return clampPercent(((total - available) / total) * 100);
}

async function readMemoryPercent(): Promise<number> {
  return parseMeminfo(await readFile("/proc/meminfo", "utf8"));
}

async function readDiskPercent(): Promise<number> {
  const stats = await statfs("/");
  const blocks = Number(stats.blocks);
  const freeBlocks = Number(stats.bavail);
  if (!Number.isFinite(blocks) || !Number.isFinite(freeBlocks) || blocks <= 0 || freeBlocks < 0) {
    throw new Error("Invalid disk sample");
  }

  return clampPercent(((blocks - freeBlocks) / blocks) * 100);
}

export async function readResourceSnapshot(): Promise<ResourceSnapshot> {
  if (process.platform !== "linux") {
    return { available: false };
  }

  try {
    const [cpuPercent, memoryPercent, diskPercent] = await Promise.all([
      readCpuPercent(),
      readMemoryPercent(),
      readDiskPercent(),
    ]);

    if (cpuPercent === null) {
      return { available: false };
    }

    return {
      available: true,
      cpuPercent,
      memoryPercent,
      diskPercent,
    };
  } catch {
    return { available: false };
  }
}

export function resetResourceMonitoringForTests() {
  previousCpuSample = null;
}
