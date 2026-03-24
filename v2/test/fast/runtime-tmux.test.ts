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

    const [file, args] = execFileAsyncMock.mock.calls[0] ?? [];
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

  it("registers status-right link click handling when syncing tmux status", async () => {
    execFileAsyncMock.mockResolvedValue({ stdout: "ok", stderr: "" });

    const { syncTmuxStatus } = await import("../../src/runtime-tmux.js");

    await syncTmuxStatus("api-1", {
      links: [{ label: "pr", url: "https://github.com/org/repo/pull/42" }],
    });

    const bindCall = execFileAsyncMock.mock.calls.find(
      (call) => call[1]?.[0] === "bind-key" && call[1]?.[2] === "MouseUp1StatusRight",
    );
    expect(bindCall?.[0]).toBe("tmux");
    expect(bindCall?.[1]?.slice(0, 6)).toEqual([
      "bind-key",
      "-n",
      "MouseUp1StatusRight",
      "if-shell",
      "-F",
      "#{mouse_hyperlink}",
    ]);
    expect(bindCall?.[1]?.[6]).toContain("run-shell -b");
    expect(bindCall?.[1]?.[6]).toContain(process.execPath);
    expect(bindCall?.[1]?.[6]).toContain("open-link.js");
    expect(bindCall?.[1]?.[6]).toContain("q:mouse_hyperlink");
  });
});
