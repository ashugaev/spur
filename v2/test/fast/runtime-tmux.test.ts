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
const sleepMock = vi.fn().mockResolvedValue(undefined);

vi.mock("node:child_process", () => ({
  execFile: execFileMock,
}));

vi.mock("node:timers/promises", () => ({
  setTimeout: sleepMock,
}));

const expectedConfigPath = fileURLToPath(new URL("../../tmux.conf", import.meta.url));

describe("runtime-tmux", () => {
  afterEach(() => {
    execFileAsyncMock.mockReset();
    sleepMock.mockReset().mockResolvedValue(undefined);
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
      agent: "codex",
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
    expect(sleepMock).toHaveBeenCalledWith(300);
  });

  it("hides the tmux status bar when no slot title exists", async () => {
    execFileAsyncMock.mockResolvedValue({ stdout: "ok", stderr: "" });

    const { syncTmuxStatus } = await import("../../src/runtime-tmux.js");

    await syncTmuxStatus("api-1", undefined);

    const statusLeftCall = execFileAsyncMock.mock.calls.find(
      ([, args]) => args[0] === "set-option" && args.includes("status-left"),
    );
    expect(statusLeftCall?.[1]?.at(-1)).toBe("");

    const statusCall = execFileAsyncMock.mock.calls.find(
      ([, args]) => args[0] === "set-option" && args.includes("status"),
    );
    expect(statusCall?.[1]?.at(-1)).toBe("off");
    const statusRightCall = execFileAsyncMock.mock.calls.find(
      ([, args]) => args[0] === "set-option" && args.includes("status-right"),
    );
    expect(statusRightCall?.[1]?.at(-1)).toBe("");
    expect(execFileAsyncMock.mock.calls).toContainEqual([
      "tmux",
      ["unbind-key", "-n", "MouseUp1StatusRight"],
    ]);
  });

  it("renders only the slot title in tmux status", async () => {
    execFileAsyncMock.mockResolvedValue({ stdout: "", stderr: "" });

    const { syncTmuxStatus } = await import("../../src/runtime-tmux.js");

    await syncTmuxStatus("api-1", {
      title: "Investigate session display cleanup",
      links: [
        { label: "pr", url: "https://github.com/acme/api/pull/42" },
        { label: "tracker", url: "https://tracker.example.com/browse/API-7" },
      ],
    });

    const statusLeftCall = execFileAsyncMock.mock.calls.find(
      ([, args]) => args[0] === "set-option" && args.includes("status-left"),
    );
    if (!statusLeftCall) {
      throw new Error("Expected syncTmuxStatus to set status-left");
    }
    const [, leftArgs] = statusLeftCall;
    expect(leftArgs.at(-1)).toContain("Investigate session display cleanup");
    expect(leftArgs.at(-1)).not.toContain("api-1");

    const statusCall = execFileAsyncMock.mock.calls.find(
      ([, args]) => args[0] === "set-option" && args.includes("status"),
    );
    if (!statusCall) {
      throw new Error("Expected syncTmuxStatus to set status");
    }
    const [, args] = statusCall;
    expect(args.at(-1)).toBe("on");
    const statusRightCall = execFileAsyncMock.mock.calls.find(
      ([, setArgs]) => setArgs[0] === "set-option" && setArgs.includes("status-right"),
    );
    expect(statusRightCall?.[1]?.at(-1)).toBe("");
    expect(execFileAsyncMock.mock.calls).toContainEqual([
      "tmux",
      ["unbind-key", "-n", "MouseUp1StatusRight"],
    ]);
  });

  it("keeps the default submit delay for non-codex sends", async () => {
    execFileAsyncMock.mockResolvedValue({ stdout: "", stderr: "" });

    const { sendMessageToTmux } = await import("../../src/runtime-tmux.js");

    await sendMessageToTmux("api-1", "follow up");

    expect(sleepMock).toHaveBeenCalledWith(300);
    expect(execFileAsyncMock.mock.calls.map(([, args]) => args.slice(-1)[0])).toEqual([
      "C-u",
      "follow up",
      "Enter",
    ]);
  });

  it("uses the default send path for cursor sends", async () => {
    execFileAsyncMock.mockResolvedValue({ stdout: "", stderr: "" });

    const { sendMessageToTmux } = await import("../../src/runtime-tmux.js");

    await sendMessageToTmux("api-1", "follow up", { agent: "cursor" });

    expect(sleepMock).toHaveBeenCalledWith(300);
    expect(execFileAsyncMock.mock.calls.map(([, args]) => args.slice(-1)[0])).toEqual([
      "C-u",
      "follow up",
      "Enter",
    ]);
  });

  it("uses bracketed paste plus a real Enter for codex sends", async () => {
    execFileAsyncMock.mockResolvedValue({ stdout: "", stderr: "" });

    const { sendMessageToTmux } = await import("../../src/runtime-tmux.js");

    await sendMessageToTmux("api-1", "follow up", { agent: "codex" });

    const pasteCall = execFileAsyncMock.mock.calls.find(([, args]) => args[0] === "paste-buffer");
    expect(pasteCall?.[1]).toContain("-p");
    expect(pasteCall?.[1]).toContain("-d");
    const pasteIndex = execFileAsyncMock.mock.calls.findIndex(
      ([, args]) => args[0] === "paste-buffer",
    );
    const enterIndex = execFileAsyncMock.mock.calls.findIndex(([, args]) => args.includes("Enter"));
    expect(enterIndex).toBeGreaterThan(pasteIndex);
    expect(sleepMock).not.toHaveBeenCalled();
  });

  it("keeps multiline codex payloads inside bracketed paste before submit", async () => {
    execFileAsyncMock.mockResolvedValue({ stdout: "", stderr: "" });

    const { sendMessageToTmux } = await import("../../src/runtime-tmux.js");

    await sendMessageToTmux("api-1", "line one\nline two", { agent: "codex" });

    expect(execFileAsyncMock.mock.calls.some(([, args]) => args.includes("-l"))).toBe(false);
    const pasteIndex = execFileAsyncMock.mock.calls.findIndex(
      ([, args]) => args[0] === "paste-buffer",
    );
    const enterIndex = execFileAsyncMock.mock.calls.findIndex(([, args]) => args.includes("Enter"));
    expect(pasteIndex).toBeGreaterThan(-1);
    expect(enterIndex).toBeGreaterThan(pasteIndex);
  });

  it("keeps interrupt behavior before codex atomic send", async () => {
    execFileAsyncMock.mockResolvedValue({ stdout: "", stderr: "" });

    const { sendMessageToTmux } = await import("../../src/runtime-tmux.js");

    await sendMessageToTmux("api-1", "follow up", { interrupt: true, agent: "codex" });

    expect(execFileAsyncMock.mock.calls.some(([, args]) => args.includes("C-c"))).toBe(true);
    expect(execFileAsyncMock.mock.calls.some(([, args]) => args.includes("C-u"))).toBe(true);
    const pasteCall = execFileAsyncMock.mock.calls.find(([, args]) => args[0] === "paste-buffer");
    expect(pasteCall?.[1]).toContain("-p");
    expect(execFileAsyncMock.mock.calls.some(([, args]) => args.includes("Enter"))).toBe(true);
    expect(sleepMock).toHaveBeenCalledWith(500);
  });

  it("auto-confirms the Cursor workspace trust prompt before reporting ready", async () => {
    let captureCount = 0;
    execFileAsyncMock.mockImplementation(async (_file, args) => {
      if (args[0] === "capture-pane") {
        captureCount += 1;
        return {
          stdout:
            captureCount === 1
              ? "Cursor Agent can execute code and access files.\nWorkspace Trust Required\nDo you trust the contents of this directory?"
              : "Cursor Agent\nComposer 2 Fast",
          stderr: "",
        };
      }
      return { stdout: "", stderr: "" };
    });

    const { waitForTmuxReady } = await import("../../src/runtime-tmux.js");

    await waitForTmuxReady("api-1", ["Cursor Agent", "Composer"], 5_000, { agent: "cursor" });

    expect(
      execFileAsyncMock.mock.calls.some(
        ([, args]) => args[0] === "send-keys" && args.includes("Enter"),
      ),
    ).toBe(true);
    expect(sleepMock).toHaveBeenCalledWith(1_000);
  });
});
