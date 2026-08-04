import type * as FsModule from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

const { readFileSyncMock } = vi.hoisted(() => ({
  readFileSyncMock: vi.fn(),
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof FsModule>("node:fs");
  return { ...actual, readFileSync: readFileSyncMock };
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
});
