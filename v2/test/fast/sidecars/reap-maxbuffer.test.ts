import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";

// Isolated from reap.test.ts (which forks real processes for its ps-based
// assertions) so this file can mock node:child_process module-wide without
// breaking those real forks.
type ExecFileAsync = (
  file: string,
  args: string[],
  options?: { timeout?: number; maxBuffer?: number },
) => Promise<{ stdout: string; stderr: string }>;

const execFileAsyncMock = vi.fn<ExecFileAsync>();
const execFileMock: ((...args: unknown[]) => void) & {
  [promisify.custom]: typeof execFileAsyncMock;
} = Object.assign(vi.fn(), {
  [promisify.custom]: execFileAsyncMock,
});

vi.mock("node:child_process", () => ({
  execFile: execFileMock,
}));

describe("snapshotProcesses maxBuffer", () => {
  afterEach(() => {
    execFileAsyncMock.mockReset();
  });

  it("passes an explicit maxBuffer above the 1 MiB execFile default to the ps snapshot", async () => {
    execFileAsyncMock.mockResolvedValue({ stdout: "1 1 1 0 0 node\n", stderr: "" });

    const { snapshotProcesses, PS_MAX_BUFFER_BYTES } =
      await import("../../../src/sidecars/reap.js");
    await snapshotProcesses();

    expect(execFileAsyncMock).toHaveBeenCalledTimes(1);
    const [, , options] = execFileAsyncMock.mock.calls[0] ?? [];
    expect(options?.maxBuffer).toBe(PS_MAX_BUFFER_BYTES);
    expect(options?.maxBuffer).toBeGreaterThan(1024 * 1024);
  });

  it("degrades to an unusable snapshot, never a thrown error, when ps exceeds maxBuffer (ENOBUFS)", async () => {
    const enobufs = Object.assign(new Error("stdout maxBuffer length exceeded"), {
      code: "ENOBUFS",
    });
    execFileAsyncMock.mockRejectedValue(enobufs);

    const { snapshotProcesses } = await import("../../../src/sidecars/reap.js");
    const snapshot = await snapshotProcesses();

    expect(snapshot.ok).toBe(false);
    expect(snapshot.byPid.size).toBe(0);
  });
});
