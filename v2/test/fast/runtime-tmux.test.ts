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
  const originalSystemdScope = process.env["SPUR_TMUX_SYSTEMD_SCOPE"];

  afterEach(() => {
    execFileAsyncMock.mockReset();
    sleepMock.mockReset().mockResolvedValue(undefined);
    if (originalSystemdScope === undefined) {
      delete process.env["SPUR_TMUX_SYSTEMD_SCOPE"];
    } else {
      process.env["SPUR_TMUX_SYSTEMD_SCOPE"] = originalSystemdScope;
    }
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

  it("starts tmux sessions through a user systemd scope when auto is enabled", async () => {
    process.env["SPUR_TMUX_SYSTEMD_SCOPE"] = "auto";
    execFileAsyncMock.mockImplementation(async (_file, args) => ({
      stdout: args.includes("new-session") ? "" : "ok",
      stderr: "",
    }));

    const { createTmuxSession } = await import("../../src/runtime-tmux.js");

    await createTmuxSession({
      sessionName: "api-1",
      cwd: "/tmp/worktree",
      launchCommand: "claude --dangerously-skip-permissions",
      agent: "claude",
    });

    const firstCall = execFileAsyncMock.mock.calls[0];
    if (!firstCall) {
      throw new Error("Expected createTmuxSession to invoke systemd-run");
    }
    expect(firstCall[0]).toBe("systemd-run");
    expect(firstCall[1].slice(0, 6)).toEqual([
      "--user",
      "--scope",
      "--quiet",
      "--collect",
      "tmux",
      "-f",
    ]);
    expect(firstCall[1]).toContain("new-session");
    expect(execFileAsyncMock.mock.calls.some(([file]) => file === "tmux")).toBe(true);
  });

  it("falls back to direct tmux when auto systemd scope is unavailable", async () => {
    process.env["SPUR_TMUX_SYSTEMD_SCOPE"] = "auto";
    execFileAsyncMock.mockImplementation(async (file, args) => {
      if (file === "systemd-run") {
        throw Object.assign(new Error("spawn systemd-run ENOENT"), { code: "ENOENT" });
      }
      return {
        stdout: args.includes("new-session") ? "" : "ok",
        stderr: "",
      };
    });

    const { createTmuxSession } = await import("../../src/runtime-tmux.js");

    await createTmuxSession({
      sessionName: "api-1",
      cwd: "/tmp/worktree",
      launchCommand: "claude --dangerously-skip-permissions",
      agent: "claude",
    });

    expect(execFileAsyncMock.mock.calls[0]?.[0]).toBe("systemd-run");
    const fallbackCall = execFileAsyncMock.mock.calls.find(
      ([file, args]) => file === "tmux" && args.includes("new-session"),
    );
    expect(fallbackCall).toBeDefined();
  });

  it("warns once (not per call) when auto systemd scope falls back, and still falls back every time", async () => {
    process.env["SPUR_TMUX_SYSTEMD_SCOPE"] = "auto";
    execFileAsyncMock.mockImplementation(async (file, args) => {
      if (file === "systemd-run") {
        throw Object.assign(new Error("Failed to connect to bus"), { code: 1 });
      }
      return {
        stdout: args.includes("new-session") ? "" : "ok",
        stderr: "",
      };
    });
    const stderrWriteSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    const { createTmuxSession } = await import("../../src/runtime-tmux.js");

    const session = {
      sessionName: "api-1",
      cwd: "/tmp/worktree",
      launchCommand: "claude --dangerously-skip-permissions",
      agent: "claude" as const,
    };
    await createTmuxSession(session);
    await createTmuxSession({ ...session, sessionName: "api-2" });

    const killModeWarnings = stderrWriteSpy.mock.calls.filter(([chunk]) =>
      /KillMode=process/.test(String(chunk)),
    );
    expect(killModeWarnings).toHaveLength(1);
    const tmuxFallbackCalls = execFileAsyncMock.mock.calls.filter(
      ([file, args]) => file === "tmux" && args.includes("new-session"),
    );
    expect(tmuxFallbackCalls).toHaveLength(2);

    stderrWriteSpy.mockRestore();
  });

  it("fails when required systemd scope is unavailable", async () => {
    process.env["SPUR_TMUX_SYSTEMD_SCOPE"] = "1";
    execFileAsyncMock.mockImplementation(async (file) => {
      if (file === "systemd-run") {
        throw Object.assign(new Error("Failed to connect to bus"), { code: 1 });
      }
      return { stdout: "", stderr: "" };
    });

    const { createTmuxSession } = await import("../../src/runtime-tmux.js");

    await expect(
      createTmuxSession({
        sessionName: "api-1",
        cwd: "/tmp/worktree",
        launchCommand: "claude --dangerously-skip-permissions",
        agent: "claude",
      }),
    ).rejects.toThrow("Failed to connect to bus");
    expect(execFileAsyncMock.mock.calls).toHaveLength(1);
    expect(execFileAsyncMock.mock.calls[0]?.[0]).toBe("systemd-run");
  });

  it("starts command sessions through a user systemd scope when auto is enabled", async () => {
    process.env["SPUR_TMUX_SYSTEMD_SCOPE"] = "auto";
    execFileAsyncMock.mockResolvedValue({ stdout: "", stderr: "" });

    const { createTmuxCommandSession } = await import("../../src/runtime-tmux.js");

    await createTmuxCommandSession({
      sessionName: "api-1--dev",
      cwd: "/tmp/worktree",
      launchCommand: "pnpm dev",
    });

    expect(execFileAsyncMock.mock.calls[0]?.[0]).toBe("systemd-run");
    expect(execFileAsyncMock.mock.calls[0]?.[1]).toContain("new-session");
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
