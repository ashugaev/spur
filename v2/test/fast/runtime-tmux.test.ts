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

  it("uses bracketed paste plus a real Enter for codex sends", async () => {
    execFileAsyncMock.mockResolvedValue({ stdout: "", stderr: "" });

    const { sendMessageToTmux } = await import("../../src/runtime-tmux.js");

    await sendMessageToTmux("api-1", "follow up", { agent: "codex" });

    const pasteCall = execFileAsyncMock.mock.calls.find(([, args]) => args[0] === "paste-buffer");
    expect(pasteCall?.[1]).toContain("-p");
    expect(pasteCall?.[1]).toContain("-d");
    const pasteIndex = execFileAsyncMock.mock.calls.findIndex(([, args]) => args[0] === "paste-buffer");
    const enterIndex = execFileAsyncMock.mock.calls.findIndex(([, args]) => args.includes("Enter"));
    expect(enterIndex).toBeGreaterThan(pasteIndex);
    expect(sleepMock).not.toHaveBeenCalled();
  });

  it("keeps multiline codex payloads inside bracketed paste before submit", async () => {
    execFileAsyncMock.mockResolvedValue({ stdout: "", stderr: "" });

    const { sendMessageToTmux } = await import("../../src/runtime-tmux.js");

    await sendMessageToTmux("api-1", "line one\nline two", { agent: "codex" });

    expect(execFileAsyncMock.mock.calls.some(([, args]) => args.includes("-l"))).toBe(false);
    const pasteIndex = execFileAsyncMock.mock.calls.findIndex(([, args]) => args[0] === "paste-buffer");
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
});
