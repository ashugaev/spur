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

  it("disables the tmux status bar in the Spur config", async () => {
    const { readFileSync } = await import("node:fs");
    const config = readFileSync(expectedConfigPath, "utf-8");
    expect(config).toMatch(/^set -g status off$/m);
  });

  it("keeps the default submit delay for non-codex sends", async () => {
    execFileAsyncMock.mockResolvedValue({ stdout: "", stderr: "" });

    const { sendMessageToTmux } = await import("../../src/runtime-tmux.js");

    await sendMessageToTmux("api-1", "follow up");

    expect(sleepMock).toHaveBeenCalledWith(300);
    expect(execFileAsyncMock.mock.calls.map(([, args]) => args.slice(-1)[0])).toEqual([
      "cancel",
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
      "cancel",
      "C-u",
      "follow up",
      "Enter",
    ]);
  });

  it("exits copy-mode before issuing edit keys for codex bracketed-paste sends", async () => {
    execFileAsyncMock.mockResolvedValue({ stdout: "", stderr: "" });

    const { sendMessageToTmux } = await import("../../src/runtime-tmux.js");

    await sendMessageToTmux("api-1", "follow up", { agent: "codex" });

    const cancelIndex = execFileAsyncMock.mock.calls.findIndex(
      ([, args]) => args[0] === "send-keys" && args.includes("-X") && args.includes("cancel"),
    );
    const cuIndex = execFileAsyncMock.mock.calls.findIndex(([, args]) => args.includes("C-u"));
    const pasteIndex = execFileAsyncMock.mock.calls.findIndex(
      ([, args]) => args[0] === "paste-buffer",
    );
    expect(cancelIndex).toBeGreaterThanOrEqual(0);
    expect(cuIndex).toBeGreaterThan(cancelIndex);
    expect(pasteIndex).toBeGreaterThan(cuIndex);
  });

  it("swallows tmux cancel failure and continues the send path", async () => {
    execFileAsyncMock.mockImplementation(async (_file, args) => {
      if (args[0] === "send-keys" && args.includes("-X") && args.includes("cancel")) {
        throw new Error("cancel not available");
      }
      return { stdout: "", stderr: "" };
    });

    const { sendMessageToTmux } = await import("../../src/runtime-tmux.js");

    await sendMessageToTmux("api-1", "follow up");

    expect(execFileAsyncMock.mock.calls.some(([, args]) => args.includes("C-u"))).toBe(true);
    expect(execFileAsyncMock.mock.calls.some(([, args]) => args.includes("Enter"))).toBe(true);
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
