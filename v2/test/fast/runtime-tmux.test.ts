import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

type ExecFileAsync = (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

const execFileAsyncMock = vi.fn<ExecFileAsync>();
const execFileMock: ((...args: unknown[]) => void) & {
  [promisify.custom]: typeof execFileAsyncMock;
} = Object.assign(vi.fn(), {
  [promisify.custom]: execFileAsyncMock,
});

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

  it("starts tmux sessions with the Spur-specific config", async () => {
    execFileAsyncMock.mockImplementation(async (_file, args) => ({
      stdout: args.includes("new-session") ? "" : "ok",
      stderr: "",
    }));

    const { createTmuxSession } = await import("../../src/runtime-tmux.js");

    await createTmuxSession({
      sessionName: "api-1",
      cwd: "/tmp/worktree",
      launchCommand: "codex --dangerously-bypass-approvals-and-sandbox",
    });

    const firstCall = execFileAsyncMock.mock.calls[0];
    if (!firstCall) {
      throw new Error("Expected createTmuxSession to invoke tmux");
    }
    const [file, args] = firstCall;
    expect(file).toBe("tmux");
    expect(args.slice(0, 8)).toEqual([
      "-f",
      expectedConfigPath,
      "new-session",
      "-d",
      "-s",
      "api-1",
      "-c",
      "/tmp/worktree",
    ]);
  });

  it("renders compact link ids in tmux status", async () => {
    execFileAsyncMock.mockResolvedValue({ stdout: "", stderr: "" });

    const { syncTmuxStatus } = await import("../../src/runtime-tmux.js");

    await syncTmuxStatus("api-1", {
      links: [
        { label: "pr", url: "https://github.com/acme/api/pull/42" },
        { label: "tracker", url: "https://tracker.example.com/browse/API-7" },
      ],
    });

    const statusRightCall = execFileAsyncMock.mock.calls.find(
      ([, args]) => args[0] === "set-option" && args.includes("status-right"),
    );
    if (!statusRightCall) {
      throw new Error("Expected syncTmuxStatus to set status-right");
    }
    const [, args] = statusRightCall;
    const rendered = args.at(-1);
    expect(rendered).toContain("]pr ##42#[");
    expect(rendered).toContain("tracker API-7");
  });
});
