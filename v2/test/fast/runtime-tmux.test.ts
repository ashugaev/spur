import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

type ExecFileAsync = (
  file: string,
  args: string[],
  options?: { env?: NodeJS.ProcessEnv },
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

  it("removes inherited auth before respawning the agent shell", async () => {
    execFileAsyncMock.mockResolvedValue({ stdout: "", stderr: "" });
    const { createTmuxSession } = await import("../../src/runtime-tmux.js");

    await createTmuxSession({
      sessionName: "api-auth",
      cwd: "/tmp/worktree",
      launchCommand: "claude --dangerously-skip-permissions",
      agent: "claude",
      env: { CLAUDE_CODE_OAUTH_TOKEN: "selected" },
      unsetEnv: ["ANTHROPIC_API_KEY", "CLAUDE_CONFIG_DIR"],
    });

    const calls = execFileAsyncMock.mock.calls.map(([, args]) => args);
    const firstUnset = calls.findIndex(
      (args) => args[0] === "set-environment" && args.includes("ANTHROPIC_API_KEY"),
    );
    const secondUnset = calls.findIndex(
      (args) => args[0] === "set-environment" && args.includes("CLAUDE_CONFIG_DIR"),
    );
    const respawn = calls.findIndex((args) => args[0] === "respawn-pane");
    const firstSend = calls.findIndex((args) => args[0] === "send-keys");
    expect(firstUnset).toBeGreaterThan(0);
    expect(secondUnset).toBeGreaterThan(firstUnset);
    expect(respawn).toBeGreaterThan(secondUnset);
    expect(firstSend).toBeGreaterThan(respawn);
    expect(calls.flat()).not.toContain("CLAUDE_CODE_OAUTH_TOKEN=selected");
    const newSessionCall = execFileAsyncMock.mock.calls.find(([, args]) =>
      args.includes("new-session"),
    );
    expect(newSessionCall?.[2]?.env?.["CLAUDE_CODE_OAUTH_TOKEN"]).toBe("selected");
    expect(newSessionCall?.[2]?.env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(newSessionCall?.[2]?.env).not.toHaveProperty("CLAUDE_CONFIG_DIR");
  });

  it("appends Claude token import without flattening tmux update-environment", async () => {
    execFileAsyncMock.mockImplementation(async (_file, args) => ({
      stdout: args[0] === "show-options" ? "DISPLAY SSH_AUTH_SOCK" : "",
      stderr: "",
    }));
    const { createTmuxSession } = await import("../../src/runtime-tmux.js");

    await createTmuxSession({
      sessionName: "api-auth",
      cwd: "/tmp/worktree",
      launchCommand: "claude",
      agent: "claude",
      env: { CLAUDE_CODE_OAUTH_TOKEN: "selected" },
    });

    expect(
      execFileAsyncMock.mock.calls.some(
        ([file, args]) =>
          file === "tmux" &&
          args.join("\0") ===
            ["set-option", "-ag", "update-environment", "CLAUDE_CODE_OAUTH_TOKEN"].join("\0"),
      ),
    ).toBe(true);
  });

  it("fails launch when Claude token import cannot be configured", async () => {
    execFileAsyncMock.mockImplementation(async (_file, args) => {
      if (args[0] === "show-options") throw new Error("tmux option unavailable");
      return { stdout: "", stderr: "" };
    });
    const { createTmuxSession } = await import("../../src/runtime-tmux.js");

    await expect(
      createTmuxSession({
        sessionName: "api-auth",
        cwd: "/tmp/worktree",
        launchCommand: "claude",
        agent: "claude",
        env: { CLAUDE_CODE_OAUTH_TOKEN: "selected" },
      }),
    ).rejects.toThrow("tmux option unavailable");
    expect(execFileAsyncMock.mock.calls.some(([, args]) => args.includes("new-session"))).toBe(
      false,
    );
  });

  it("asserts the imported Claude token by fingerprint without exposing the token", async () => {
    execFileAsyncMock.mockResolvedValue({
      stdout: "CLAUDE_CODE_OAUTH_TOKEN=selected",
      stderr: "",
    });
    const { assertTmuxClaudeTokenFingerprint } = await import("../../src/runtime-tmux.js");

    await expect(
      assertTmuxClaudeTokenFingerprint("api-auth", "sha256:d7cbbb688b2e506c"),
    ).resolves.toBeUndefined();
    await expect(assertTmuxClaudeTokenFingerprint("api-auth", "sha256:wrong")).rejects.toThrow(
      "selected setup-token",
    );
  });

  it("never exposes a selected token through failed tmux argv or errors", async () => {
    const sentinel = "setup-token-argv-sentinel";
    execFileAsyncMock.mockImplementation(async (_file, args) => {
      if (args.includes("new-session")) {
        throw new Error(`tmux failed: ${args.join(" ")}`);
      }
      return { stdout: "", stderr: "" };
    });
    const { createTmuxSession } = await import("../../src/runtime-tmux.js");

    const error = await createTmuxSession({
      sessionName: "api-auth",
      cwd: "/tmp/worktree",
      launchCommand: "claude",
      env: { CLAUDE_CODE_OAUTH_TOKEN: sentinel },
    }).catch((reason: unknown) => reason);

    expect(String(error)).not.toContain(sentinel);
    expect(execFileAsyncMock.mock.calls.flatMap(([, args]) => args).join(" ")).not.toContain(
      sentinel,
    );
  });

  it("makes required kill failures observable", async () => {
    execFileAsyncMock.mockRejectedValue(new Error("kill failed"));
    const { killTmuxSession } = await import("../../src/runtime-tmux.js");

    await expect(killTmuxSession("api-auth", { required: true })).rejects.toThrow("kill failed");
    await expect(killTmuxSession("api-auth")).resolves.toBeUndefined();
  });

  it("kills a new session when inherited-auth removal fails", async () => {
    execFileAsyncMock.mockImplementation(async (_file, args) => {
      if (args[0] === "set-environment") throw new Error("unset failed");
      return { stdout: "", stderr: "" };
    });
    const { createTmuxSession } = await import("../../src/runtime-tmux.js");

    await expect(
      createTmuxSession({
        sessionName: "api-auth",
        cwd: "/tmp/worktree",
        launchCommand: "claude",
        unsetEnv: ["ANTHROPIC_API_KEY"],
      }),
    ).rejects.toThrow("unset failed");
    expect(execFileAsyncMock.mock.calls.some(([, args]) => args[0] === "kill-session")).toBe(true);
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
    expect(respawnCommand).toBe("sh -lc 'cd front && yarn start'");
    // Regression: `exec cd ...` in dash fails with "exec: cd: not found".
    expect(respawnCommand).not.toContain("exec cd");
    expect(respawnCommand).not.toMatch(/sh -lc '?exec /);
    expect(respawnArgs).toContain("-k");
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
});
