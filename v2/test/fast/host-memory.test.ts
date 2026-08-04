import type * as FsModule from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

const { existsSyncMock, readFileSyncMock } = vi.hoisted(() => ({
  existsSyncMock: vi.fn(),
  readFileSyncMock: vi.fn(),
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof FsModule>("node:fs");
  return { ...actual, existsSync: existsSyncMock, readFileSync: readFileSyncMock };
});

const FIXTURE_MEMINFO = `MemTotal:       65000000 kB
MemFree:         1000000 kB
MemAvailable:   20000000 kB
SwapTotal:       2000000 kB
SwapFree:        2000000 kB
`;

describe("readHostMemory", () => {
  afterEach(() => {
    readFileSyncMock.mockReset();
  });

  it("parses a fixture /proc/meminfo to bytes", async () => {
    readFileSyncMock.mockReturnValue(FIXTURE_MEMINFO);

    const { readHostMemory } = await import("../../src/host-memory.js");

    expect(readHostMemory()).toEqual({
      totalBytes: 65_000_000 * 1024,
      availableBytes: 20_000_000 * 1024,
      swapTotalBytes: 2_000_000 * 1024,
      swapFreeBytes: 2_000_000 * 1024,
    });
  });

  it("returns null when the file is missing", async () => {
    readFileSyncMock.mockImplementation(() => {
      const error = new Error("ENOENT: no such file or directory") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    });

    const { readHostMemory } = await import("../../src/host-memory.js");

    expect(readHostMemory()).toBeNull();
  });

  it("returns null when MemAvailable is missing", async () => {
    readFileSyncMock.mockReturnValue(
      "MemTotal:       65000000 kB\nMemFree:         1000000 kB\nSwapFree:        2000000 kB\n",
    );

    const { readHostMemory } = await import("../../src/host-memory.js");

    expect(readHostMemory()).toBeNull();
  });

  it("treats missing swap fields as a host without swap", async () => {
    readFileSyncMock.mockReturnValue(
      "MemTotal:       65000000 kB\nMemAvailable:   20000000 kB\nSwapFree:              0 kB\n",
    );

    const { readHostMemory } = await import("../../src/host-memory.js");

    expect(readHostMemory()).toEqual({
      totalBytes: 65_000_000 * 1024,
      availableBytes: 20_000_000 * 1024,
      swapTotalBytes: 0,
      swapFreeBytes: 0,
    });
  });
});

describe("cgroup v2 memory", () => {
  afterEach(() => {
    existsSyncMock.mockReset();
    readFileSyncMock.mockReset();
  });

  it("reads PSI from the process cgroup", async () => {
    readFileSyncMock.mockImplementation((path: string) =>
      path === "/proc/self/cgroup"
        ? "0::/system.slice/spur-daemon.service\n"
        : "some avg10=20.50 avg60=3.25 avg300=1.00 total=10\nfull avg10=0.75 avg60=0.25 avg300=0.10 total=2\n",
    );
    const { readCgroupPressure } = await import("../../src/host-memory.js");
    expect(readCgroupPressure()).toEqual({ someAvg10: 20.5, someAvg60: 3.25, fullAvg10: 0.75 });
  });

  it("maps max limits to null", async () => {
    readFileSyncMock.mockImplementation((path: string) => {
      if (path === "/proc/self/cgroup") return "0::/user.slice/test.service\n";
      if (path.endsWith("memory.max")) return "max\n";
      return "123456\n";
    });
    const { readCgroupMemoryLimits } = await import("../../src/host-memory.js");
    expect(readCgroupMemoryLimits()).toEqual({
      path: "/user.slice/test.service",
      highBytes: 123456,
      maxBytes: null,
    });
  });

  it("fails open when a cgroup control file cannot be read", async () => {
    readFileSyncMock.mockImplementation((path: string) => {
      if (path === "/proc/self/cgroup") return "0::/user.slice/test.service\n";
      throw new Error("cgroup read failed");
    });
    const { readCgroupMemoryLimits, readCgroupPressure } = await import("../../src/host-memory.js");

    expect(readCgroupMemoryLimits()).toBeNull();
    expect(readCgroupPressure()).toBeNull();
  });

  it("fails open on cgroup v1", async () => {
    readFileSyncMock.mockReturnValue("12:memory:/test\n");
    const { readCgroupMemoryLimits, readCgroupPressure } = await import("../../src/host-memory.js");
    expect(readCgroupMemoryLimits()).toBeNull();
    expect(readCgroupPressure()).toBeNull();
  });

  it("detects only the systemd-oomd socket", async () => {
    existsSyncMock.mockImplementation((path: string) => path === "/run/systemd/io.systemd.oom");
    const { isSystemdOomdPresent } = await import("../../src/host-memory.js");
    expect(isSystemdOomdPresent()).toBe(true);
    expect(existsSyncMock).toHaveBeenCalledWith("/run/systemd/io.systemd.oom");
  });

  it("does not treat a ManagedOOM control file as proof that oomd is running", async () => {
    existsSyncMock.mockImplementation(
      (path: string) => path === "/run/systemd/system/systemd-oomd.service.d/ManagedOOM.conf",
    );
    const { isSystemdOomdPresent } = await import("../../src/host-memory.js");

    expect(isSystemdOomdPresent()).toBe(false);
    expect(existsSyncMock).toHaveBeenCalledTimes(1);
  });
});
