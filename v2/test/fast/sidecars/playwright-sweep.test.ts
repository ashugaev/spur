import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";

// Isolated from playwright.test.ts so this file can mock node:child_process
// module-wide (the shared-snapshot claim below needs full control over what
// `ps` returns) without perturbing that file's real-bin-resolution tests.
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

describe("sweepLeakedPlaywright ps snapshot sharing", () => {
  afterEach(() => {
    execFileAsyncMock.mockReset();
  });

  it("forks ps exactly once for the whole sweep, no matter how many leaked roots are found", async () => {
    const { resolvePlaywrightMcpBin, sweepLeakedPlaywright } = await import(
      "../../../src/sidecars/playwright.js"
    );
    const bin = resolvePlaywrightMcpBin();
    const row = (pid: number, port: number) =>
      `${pid} 1 node ${bin} --headless --isolated --host 127.0.0.1 --port ${port}`;
    // Neither pid exists on this host, so killProcessTree's identity reads
    // resolve to null (ENOENT) and no real signal is ever sent — this test
    // only asserts on the `ps` fork count, not on kill behavior.
    execFileAsyncMock.mockResolvedValue({
      stdout: `${row(999_901, 8750)}\n${row(999_902, 8751)}\n`,
      stderr: "",
    });

    const killed = await sweepLeakedPlaywright(new Set());

    expect(killed).toBe(2);
    expect(execFileAsyncMock).toHaveBeenCalledTimes(1);
  });
});
