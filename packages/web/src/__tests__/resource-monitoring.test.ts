import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const readFileMock = vi.fn();
const statfsMock = vi.fn();

vi.mock("node:fs/promises", () => {
  const readFile = (...args: unknown[]) => readFileMock(...args);
  const statfs = (...args: unknown[]) => statfsMock(...args);
  return { default: { readFile, statfs }, readFile, statfs };
});

import { readResourceSnapshot, resetResourceMonitoringForTests } from "@/lib/resource-monitoring";

const ORIGINAL_PLATFORM = process.platform;
const STAT_BASELINE = "cpu 100 0 0 100 0 0 0 0 0 0\n";
const STAT_NEXT = "cpu 200 0 0 150 0 0 0 0 0 0\n";
const MEMINFO = "MemTotal:        1000 kB\nMemAvailable:     250 kB\n";

function mockProc(statSequence: string[], meminfo = MEMINFO) {
  let stat = 0;
  readFileMock.mockImplementation(async (path: string) => {
    if (path === "/proc/stat") {
      stat += 1;
      return statSequence[Math.min(stat, statSequence.length) - 1];
    }
    if (path === "/proc/meminfo") return meminfo;
    throw new Error(`unexpected path ${path}`);
  });
}

beforeEach(() => {
  resetResourceMonitoringForTests();
  readFileMock.mockReset();
  statfsMock.mockReset();
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
});

afterEach(() => {
  Object.defineProperty(process, "platform", { value: ORIGINAL_PLATFORM, configurable: true });
});

describe("readResourceSnapshot", () => {
  it("returns unavailable on non-linux platforms", async () => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    expect(await readResourceSnapshot()).toEqual({ available: false });
  });

  it("returns unavailable on the first sample because no baseline exists", async () => {
    mockProc([STAT_BASELINE], "MemTotal:        1000 kB\nMemAvailable:     500 kB\n");
    statfsMock.mockResolvedValue({ blocks: 100, bavail: 50 });

    expect(await readResourceSnapshot()).toEqual({ available: false });
  });

  it("returns clamped cpu, memory, and disk percents on the second sample", async () => {
    mockProc([STAT_BASELINE, STAT_NEXT]);
    statfsMock.mockResolvedValue({ blocks: 100, bavail: 25 });

    await readResourceSnapshot();
    const snapshot = await readResourceSnapshot();

    expect(snapshot).toEqual({
      available: true,
      cpuPercent: expect.any(Number),
      memoryPercent: 75,
      diskPercent: 75,
    });
    if (snapshot.available) {
      expect(snapshot.cpuPercent).toBeGreaterThanOrEqual(0);
      expect(snapshot.cpuPercent).toBeLessThanOrEqual(100);
    }
  });

  it("returns unavailable when statfs throws", async () => {
    mockProc(
      [STAT_BASELINE, STAT_BASELINE],
      "MemTotal:        1000 kB\nMemAvailable:     500 kB\n",
    );
    statfsMock.mockRejectedValue(new Error("statfs failed"));

    await readResourceSnapshot();
    expect(await readResourceSnapshot()).toEqual({ available: false });
  });
});
