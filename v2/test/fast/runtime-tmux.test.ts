import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const execFileMock = vi.fn();
const execFileAsyncMock = vi.fn<
  (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>
>();

execFileMock[promisify.custom] = execFileAsyncMock;

vi.mock("node:child_process", () => ({
  execFile: execFileMock,
}));

vi.mock("node:timers/promises", () => ({
  setTimeout: vi.fn().mockResolvedValue(undefined),
}));

const expectedConfigPath = fileURLToPath(new URL("../../tmux.conf", import.meta.url));

describe("runtime-tmux", () => {
  afterEach(() => {
    execFileAsyncMock.mockReset();
    vi.resetModules();
  });

  it("starts tmux sessions with the Spur config and reapplies it to live servers", async () => {
    execFileAsyncMock.mockResolvedValue({ stdout: "", stderr: "" });

    const { createTmuxSession } = await import("../../src/runtime-tmux.js");

    await createTmuxSession({
      sessionName: "api-1",
      cwd: "/tmp/worktree",
      launchCommand: "codex --dangerously-bypass-approvals-and-sandbox",
    });

    const [newSessionFile, newSessionArgs] = execFileAsyncMock.mock.calls[0] ?? [];
    expect(newSessionFile).toBe("tmux");
    expect(newSessionArgs.slice(0, 8)).toEqual([
      "-f",
      expectedConfigPath,
      "new-session",
      "-d",
      "-s",
      "api-1",
      "-c",
      "/tmp/worktree",
    ]);

    const [sourceFileExec, sourceFileArgs] = execFileAsyncMock.mock.calls[1] ?? [];
    expect(sourceFileExec).toBe("tmux");
    expect(sourceFileArgs).toEqual(["source-file", expectedConfigPath]);
  });

  it("kills the new session if sourcing the config fails", async () => {
    execFileAsyncMock.mockImplementation(async (_file, args) => {
      if (args[0] === "-f") {
        return { stdout: "", stderr: "" };
      }
      if (args[0] === "source-file") {
        throw new Error("source boom");
      }
      return { stdout: "", stderr: "" };
    });

    const { createTmuxSession } = await import("../../src/runtime-tmux.js");

    await expect(
      createTmuxSession({
        sessionName: "api-1",
        cwd: "/tmp/worktree",
        launchCommand: "claude --dangerously-skip-permissions",
      }),
    ).rejects.toThrow("source boom");

    const [killExec, killArgs] = execFileAsyncMock.mock.calls[2] ?? [];
    expect(killExec).toBe("tmux");
    expect(killArgs).toEqual(["kill-session", "-t", "=api-1"]);
  });
});
