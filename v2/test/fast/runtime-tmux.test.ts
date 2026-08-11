import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CURSOR_RESUME_READY_MARKER } from "../../src/agents/cursor.js";

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

  it("does not confirm tree shutdown when the fresh fleet probe fails", async () => {
    execFileAsyncMock.mockImplementation(async (file, args) => {
      if (file === "tmux" && args.includes("list-panes")) {
        return { stdout: "", stderr: "" };
      }
      if (file === "tmux" && args.includes("kill-session")) {
        return { stdout: "", stderr: "" };
      }
      if (file === "tmux" && args.includes("list-windows")) {
        throw new Error("fleet probe failed");
      }
      throw new Error(`unexpected exec: ${file} ${args.join(" ")}`);
    });

    const { killTmuxSessionTree } = await import("../../src/runtime-tmux.js");

    await expect(killTmuxSessionTree("api-1--dev")).resolves.toBe(false);
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

  // Regression (status-verifier shp-a4bc, spur-9813): the spur daemon is
  // often itself a subprocess of a Claude Code session (e.g. an isolated
  // dev daemon a Spur agent spins up as a test sidecar). If that session's
  // CLAUDECODE/CLAUDE_CODE_SESSION_ID/CLAUDE_CODE_CHILD_SESSION env vars leak
  // into a brand-new tmux pane, the `claude` process launched there treats
  // itself as a *child* of that unrelated ancestor session — Claude Code
  // then writes neither a `<new-session-id>.jsonl` transcript at the
  // expected path nor a `~/.claude/sessions/<pid>.json` status file for it,
  // leaving Spur with no signal at all and stuck reporting `working` forever.
  it("never inherits the daemon's own Claude Code identity env vars into a new session", async () => {
    const originalClaudecode = process.env["CLAUDECODE"];
    const originalSessionId = process.env["CLAUDE_CODE_SESSION_ID"];
    const originalChildSession = process.env["CLAUDE_CODE_CHILD_SESSION"];
    process.env["CLAUDECODE"] = "1";
    process.env["CLAUDE_CODE_SESSION_ID"] = "stale-ancestor-session-id";
    process.env["CLAUDE_CODE_CHILD_SESSION"] = "1";
    try {
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
        throw new Error("Expected createTmuxSession to invoke tmux");
      }
      const [, args] = firstCall;
      expect(args).not.toContain("-e CLAUDECODE=1");
      expect(args.some((arg) => arg.startsWith("CLAUDECODE="))).toBe(false);
      expect(args.some((arg) => arg.startsWith("CLAUDE_CODE_SESSION_ID="))).toBe(false);
      expect(args.some((arg) => arg.startsWith("CLAUDE_CODE_CHILD_SESSION="))).toBe(false);
    } finally {
      if (originalClaudecode === undefined) delete process.env["CLAUDECODE"];
      else process.env["CLAUDECODE"] = originalClaudecode;
      if (originalSessionId === undefined) delete process.env["CLAUDE_CODE_SESSION_ID"];
      else process.env["CLAUDE_CODE_SESSION_ID"] = originalSessionId;
      if (originalChildSession === undefined) delete process.env["CLAUDE_CODE_CHILD_SESSION"];
      else process.env["CLAUDE_CODE_CHILD_SESSION"] = originalChildSession;
    }
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

  it("wraps sidecar launch commands without `exec` and sets remain-on-exit before launch", async () => {
    execFileAsyncMock.mockResolvedValue({ stdout: "", stderr: "" });

    const { createTmuxCommandSession } = await import("../../src/runtime-tmux.js");

    await createTmuxCommandSession({
      sessionName: "api-1--dev",
      cwd: "/tmp/worktree",
      launchCommand: "cd front && yarn start",
    });

    const calls = execFileAsyncMock.mock.calls;

    const newSession = calls.find(([, args]) => args.includes("new-session"));
    if (!newSession) throw new Error("expected new-session call");
    const [, newSessionArgs] = newSession;
    // new-session must NOT carry the user shell-command — otherwise a crash on
    // the first line tears the session down before remain-on-exit lands.
    expect(newSessionArgs.some((a) => typeof a === "string" && a.includes("sh -lc"))).toBe(false);
    expect(newSessionArgs.some((a) => typeof a === "string" && a.includes("yarn start"))).toBe(
      false,
    );

    const remainOnExitIndex = calls.findIndex(
      ([, args]) => args[0] === "set-option" && args.includes("remain-on-exit"),
    );
    const respawnIndex = calls.findIndex(([, args]) => args[0] === "respawn-pane");
    const newSessionIndex = calls.findIndex(([, args]) => args.includes("new-session"));

    expect(remainOnExitIndex).toBeGreaterThan(newSessionIndex);
    expect(respawnIndex).toBeGreaterThan(remainOnExitIndex);

    // `remain-on-exit` is a pane option — requires `-p`.
    const remainOnExitArgs = calls[remainOnExitIndex]?.[1] ?? [];
    expect(remainOnExitArgs).toContain("-p");

    const respawnArgs = calls[respawnIndex]?.[1] ?? [];
    const respawnCommand = respawnArgs.at(-1);
    // The sanitize wrap strips every env name either of nvm's own
    // incompatibility guards reacts to before the pane ever sources
    // `~/.nvm/nvm.sh` — see nvm-guard-sanitize.test.ts for the repro.
    expect(respawnCommand).toBe(
      "env -u NPM_CONFIG_PREFIX -u npm_config_prefix -u NPM_CONFIG_GLOBALCONFIG -u npm_config_globalconfig -u PREFIX sh -lc 'cd front && yarn start'",
    );
    // Regression: `exec cd ...` in dash fails with "exec: cd: not found".
    expect(respawnCommand).not.toContain("exec cd");
    expect(respawnCommand).not.toMatch(/sh -lc '?exec /);
    expect(respawnArgs).toContain("-k");
  });

  it("never sanitizes the npm prefix/globalconfig env names out of the createTmuxSession launch payload", async () => {
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

    // Only the launch payload itself (the literal text sent via
    // `send-keys -l`) must be unwrapped — unlike the earlier
    // `-e KEY=VALUE` new-session args, which legitimately carry the
    // session's own env (including the pin) and are exempt from this
    // assertion.
    const literalSendKeys = execFileAsyncMock.mock.calls.find(
      ([, args]) => args[0] === "send-keys" && args.includes("-l"),
    );
    expect(literalSendKeys?.[1]?.at(-1)).toBe("claude --dangerously-skip-permissions");

    const sanitizedNames = [
      "NPM_CONFIG_PREFIX",
      "npm_config_prefix",
      "NPM_CONFIG_GLOBALCONFIG",
      "npm_config_globalconfig",
      "PREFIX",
    ];
    const payload = String(literalSendKeys?.[1]?.at(-1));
    for (const name of sanitizedNames) {
      expect(payload).not.toContain(name);
    }
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

  it("resolves on a banner-less cursor resumed pane via the readyMarkers path", async () => {
    const resumedPane = "some replayed history line\nanother replayed line\n→ Add a follow-up";
    execFileAsyncMock.mockImplementation(async (_file, args) => {
      if (args[0] === "capture-pane") {
        return { stdout: resumedPane, stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });

    const { waitForTmuxReady } = await import("../../src/runtime-tmux.js");

    await expect(
      waitForTmuxReady("api-1", [CURSOR_RESUME_READY_MARKER], 5_000, { agent: "cursor" }),
    ).resolves.toBeUndefined();
  });

  it("throws PromptReadyTimeoutError when the pane never reaches the prompt", async () => {
    let now = 0;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    execFileAsyncMock.mockImplementation(async (_file, args) => {
      if (args[0] === "capture-pane") {
        now += 10_000;
        return { stdout: "Starting...", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });

    try {
      const { waitForTmuxReady, PromptReadyTimeoutError } =
        await import("../../src/runtime-tmux.js");

      await expect(
        waitForTmuxReady("api-1", ["Cursor Agent", "Composer"], 5_000, { agent: "cursor" }),
      ).rejects.toSatisfy((err: unknown) => {
        return (
          err instanceof PromptReadyTimeoutError &&
          err.message.startsWith(
            `Timed out waiting for tmux session "api-1" to reach the agent prompt`,
          ) &&
          err.elapsedMs > 0
        );
      });
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("waits past the previous 30-second cutoff for a slow agent prompt by default", async () => {
    let now = 0;
    let captureCount = 0;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    execFileAsyncMock.mockImplementation(async (_file, args) => {
      if (args[0] === "capture-pane") {
        captureCount += 1;
        now += 10_000;
        return {
          stdout: captureCount === 5 ? "Claude Code\n❯" : "Starting Claude Code...",
          stderr: "",
        };
      }
      return { stdout: "", stderr: "" };
    });

    try {
      const { waitForTmuxReady } = await import("../../src/runtime-tmux.js");

      await waitForTmuxReady("api-1", ["Claude Code", "❯"]);

      expect(captureCount).toBe(5);
      expect(sleepMock.mock.calls.slice(0, 4)).toEqual([[728], [1_228], [2_228], [2_228]]);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("sends a bare digit keystroke to select a menu option within the first nine", async () => {
    execFileAsyncMock.mockResolvedValue({ stdout: "", stderr: "" });

    const { sendMenuSelectionKeys } = await import("../../src/runtime-tmux.js");

    await sendMenuSelectionKeys("api-1", 1);

    expect(execFileAsyncMock.mock.calls).toHaveLength(1);
    const [file, args] = execFileAsyncMock.mock.calls[0] ?? [];
    expect(file).toBe("tmux");
    expect(args).toEqual(["send-keys", "-t", "=api-1:", "2"]);
  });

  it("navigates with Down then Enter for menu options past the ninth", async () => {
    execFileAsyncMock.mockResolvedValue({ stdout: "", stderr: "" });

    const { sendMenuSelectionKeys } = await import("../../src/runtime-tmux.js");

    await sendMenuSelectionKeys("api-1", 10);

    const keys = execFileAsyncMock.mock.calls.map(([, args]) => args.slice(-1)[0]);
    expect(keys).toEqual([...Array(10).fill("Down"), "Enter"]);
  });

  it("never issues a copy-mode cancel, C-u, or literal flag for menu selection", async () => {
    execFileAsyncMock.mockResolvedValue({ stdout: "", stderr: "" });

    const { sendMenuSelectionKeys } = await import("../../src/runtime-tmux.js");

    await sendMenuSelectionKeys("api-1", 10);

    expect(execFileAsyncMock.mock.calls.some(([, args]) => args.includes("-X"))).toBe(false);
    expect(execFileAsyncMock.mock.calls.some(([, args]) => args.includes("C-u"))).toBe(false);
    expect(execFileAsyncMock.mock.calls.some(([, args]) => args.includes("-l"))).toBe(false);
  });

  it("getTmuxPanePid fresh forks a second list-panes instead of reusing the cached fleet snapshot", async () => {
    execFileAsyncMock.mockImplementation(async (_file, args) => {
      if (args[0] === "list-panes") {
        return { stdout: "api-1 1 1 0 4242 /dev/pts/1", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });

    const { getTmuxPanePid } = await import("../../src/runtime-tmux.js");

    const first = await getTmuxPanePid("api-1");
    const second = await getTmuxPanePid("api-1", { fresh: true });

    expect(first).toBe(4242);
    expect(second).toBe(4242);
    const listPanesCalls = execFileAsyncMock.mock.calls.filter(
      ([, args]) => args[0] === "list-panes",
    );
    expect(listPanesCalls).toHaveLength(2);
  });

  it("passes an explicit maxBuffer above the 1 MiB execFile default to the ps snapshot", async () => {
    execFileAsyncMock.mockImplementation(async (file, args) => {
      if (file === "tmux" && args.includes("list-windows")) {
        return { stdout: "api-1 1700000000", stderr: "" };
      }
      if (file === "tmux" && args.includes("list-panes") && args.includes("-a")) {
        return { stdout: "api-1 1 1 0 1234 /dev/pts/0", stderr: "" };
      }
      if (file === "ps") {
        return { stdout: "1234 pts/0 node agent", stderr: "" };
      }
      throw new Error(`unexpected exec: ${file} ${args.join(" ")}`);
    });

    const { isProcessRunningInTmux } = await import("../../src/runtime-tmux.js");
    await isProcessRunningInTmux("api-1", ["node"]);

    const psCall = execFileAsyncMock.mock.calls.find(([file]) => file === "ps");
    if (!psCall) {
      throw new Error("Expected a ps invocation");
    }
    const [, , options] = psCall;
    expect(options?.maxBuffer).toBeGreaterThan(1024 * 1024);
    expect(options?.timeout).toBe(5_000);
  });
});
