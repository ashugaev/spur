import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as ClaudeModule from "../../src/agents/claude.js";

const {
  ensureCodexHooksConfigMock,
  ensureClaudeRestrictWritesSettingsMock,
  captureCodexRolloutBaselineMock,
  scanCodexRolloutForMessageMock,
  captureClaudeSubmitBaselineMock,
  scanClaudeJsonlForMessageMock,
  writeFileMock,
  readFileMock,
  captureCursorSubmitBaselineMock,
  scanCursorJsonlForMessageMock,
} = vi.hoisted(() => ({
  ensureCodexHooksConfigMock: vi.fn(),
  ensureClaudeRestrictWritesSettingsMock: vi.fn(),
  captureCodexRolloutBaselineMock: vi.fn(),
  scanCodexRolloutForMessageMock: vi.fn(),
  captureClaudeSubmitBaselineMock: vi.fn(),
  scanClaudeJsonlForMessageMock: vi.fn(),
  writeFileMock: vi.fn(),
  readFileMock: vi.fn(),
  captureCursorSubmitBaselineMock: vi.fn(),
  scanCursorJsonlForMessageMock: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  writeFile: writeFileMock,
  readFile: readFileMock,
}));

vi.mock("../../src/agents/claude.js", async (importOriginal) => {
  const actual = await importOriginal<typeof ClaudeModule>();
  return {
    ...actual,
    ensureClaudeRestrictWritesSettings: ensureClaudeRestrictWritesSettingsMock,
  };
});

vi.mock("../../src/agents/codex.js", () => ({
  buildCodexPlan: vi.fn(),
  buildCodexRestorePlan: vi.fn(),
  buildCodexResumePlan: vi.fn(),
  codexCommand: vi.fn(() => "codex"),
  ensureCodexHooksConfig: ensureCodexHooksConfigMock,
  findCodexSessionId: vi.fn(),
  captureCodexRolloutBaseline: captureCodexRolloutBaselineMock,
  scanCodexRolloutForMessage: scanCodexRolloutForMessageMock,
}));

vi.mock("../../src/agents/claude-submit-ack.js", () => ({
  captureClaudeSubmitBaseline: captureClaudeSubmitBaselineMock,
  scanClaudeJsonlForMessage: scanClaudeJsonlForMessageMock,
}));

vi.mock("../../src/agents/cursor-submit-ack.js", () => ({
  captureCursorSubmitBaseline: captureCursorSubmitBaselineMock,
  scanCursorJsonlForMessage: scanCursorJsonlForMessageMock,
}));

import {
  agentHasLaunchSubmitAck,
  agentSubmitAckPacing,
  buildAgentLaunchPlan,
  createAgentSubmitAckBinding,
  setupAgentHooks,
} from "../../src/agents/index.js";

beforeEach(() => {
  ensureCodexHooksConfigMock.mockReset();
  ensureClaudeRestrictWritesSettingsMock.mockReset();
  captureCodexRolloutBaselineMock.mockReset();
  scanCodexRolloutForMessageMock.mockReset();
  captureClaudeSubmitBaselineMock.mockReset();
  scanClaudeJsonlForMessageMock.mockReset();
  writeFileMock.mockReset().mockResolvedValue(undefined);
  readFileMock
    .mockReset()
    .mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
  captureCursorSubmitBaselineMock.mockReset();
  scanCursorJsonlForMessageMock.mockReset();
});

describe("setupAgentHooks", () => {
  it("does not configure hooks for claude", async () => {
    const result = await setupAgentHooks({
      agent: "claude",
      worktreePath: "/tmp/spur-worktrees/api/api-1",
      sessionToolDir: "/tmp/spur-data/session-tools/api-1",
    });

    expect(result).toEqual({});
    expect(ensureCodexHooksConfigMock).not.toHaveBeenCalled();
  });

  it("returns claude settings path when restrictWrites is enabled", async () => {
    ensureClaudeRestrictWritesSettingsMock.mockResolvedValue(
      "/tmp/spur-data/session-tools/api-1/claude/settings.json",
    );

    const result = await setupAgentHooks({
      agent: "claude",
      worktreePath: "/tmp/spur-worktrees/api/api-1",
      sessionToolDir: "/tmp/spur-data/session-tools/api-1",
      restrictWrites: true,
    });

    expect(ensureClaudeRestrictWritesSettingsMock).toHaveBeenCalledWith(
      "/tmp/spur-data/session-tools/api-1",
    );
    expect(result).toEqual({
      claudeSettingsPath: "/tmp/spur-data/session-tools/api-1/claude/settings.json",
    });
  });

  it("trusts the session worktree path for codex", async () => {
    ensureCodexHooksConfigMock.mockResolvedValue("/tmp/spur-data/session-tools/api-1/codex-home");

    const result = await setupAgentHooks({
      agent: "codex",
      worktreePath: "/tmp/spur-worktrees/api/api-1",
      sessionToolDir: "/tmp/spur-data/session-tools/api-1",
    });

    expect(ensureCodexHooksConfigMock).toHaveBeenCalledWith(
      "/tmp/spur-data/session-tools/api-1",
      ["/tmp/spur-worktrees/api/api-1"],
      {},
    );
    expect(result).toEqual({
      codexHomePath: "/tmp/spur-data/session-tools/api-1/codex-home",
    });
  });

  it("writes an http mcp-config.json and returns its path for claude when mcpBindings are set", async () => {
    const result = await setupAgentHooks({
      agent: "claude",
      worktreePath: "/tmp/spur-worktrees/api/api-1",
      sessionToolDir: "/tmp/spur-data/session-tools/api-1",
      mcpBindings: [{ server: "playwright", url: "http://localhost:8742/mcp" }],
    });

    expect(result).toEqual({
      claudeMcpConfigPath: "/tmp/spur-data/session-tools/api-1/mcp-config.json",
    });
    const [path, contents] = writeFileMock.mock.calls[0] ?? [];
    expect(path).toBe("/tmp/spur-data/session-tools/api-1/mcp-config.json");
    // Client-facing URL must use "localhost", not the bare IP: @playwright/mcp's
    // DNS-rebinding protection rejects "127.0.0.1:<port>" with HTTP 403.
    expect(JSON.parse(contents as string)).toEqual({
      mcpServers: {
        playwright: { type: "http", url: "http://localhost:8742/mcp" },
      },
    });
  });

  it("merges host/project MCP servers into mcp-config.json, stripping host playwright in favor of Spur's", async () => {
    readFileMock.mockImplementation(async (path: string) => {
      if (path === "/home/user/.claude.json") {
        return JSON.stringify({
          mcpServers: {
            digitalocean: { command: "npx", args: ["-y", "digitalocean-mcp"] },
            playwright: { command: "npx", args: ["-y", "@playwright/mcp"] },
          },
        });
      }
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });

    const result = await setupAgentHooks({
      agent: "claude",
      worktreePath: "/tmp/spur-worktrees/api/api-1",
      sessionToolDir: "/tmp/spur-data/session-tools/api-1",
      mcpBindings: [{ server: "playwright", url: "http://localhost:8742/mcp" }],
      claudeConfigDir: "/home/user",
    });

    expect(result).toEqual({
      claudeMcpConfigPath: "/tmp/spur-data/session-tools/api-1/mcp-config.json",
    });
    expect(readFileMock).toHaveBeenCalledWith("/home/user/.claude.json", "utf8");
    const [, contents] = writeFileMock.mock.calls[0] ?? [];
    expect(JSON.parse(contents as string)).toEqual({
      mcpServers: {
        digitalocean: { command: "npx", args: ["-y", "digitalocean-mcp"] },
        playwright: { type: "http", url: "http://localhost:8742/mcp" },
      },
    });
  });

  it("prefers the local-scope (projects[worktreePath]) server over .mcp.json on a name collision", async () => {
    readFileMock.mockImplementation(async (path: string) => {
      if (path === "/home/user/.claude.json") {
        return JSON.stringify({
          projects: {
            "/tmp/spur-worktrees/api/api-1": {
              mcpServers: {
                shared: { command: "npx", args: ["-y", "local-scope-mcp"] },
              },
            },
          },
        });
      }
      if (path === "/tmp/spur-worktrees/api/api-1/.mcp.json") {
        return JSON.stringify({
          mcpServers: {
            shared: { command: "npx", args: ["-y", "project-scope-mcp"] },
          },
        });
      }
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });

    const result = await setupAgentHooks({
      agent: "claude",
      worktreePath: "/tmp/spur-worktrees/api/api-1",
      sessionToolDir: "/tmp/spur-data/session-tools/api-1",
      mcpBindings: [{ server: "playwright", url: "http://localhost:8742/mcp" }],
      claudeConfigDir: "/home/user",
    });

    expect(result).toEqual({
      claudeMcpConfigPath: "/tmp/spur-data/session-tools/api-1/mcp-config.json",
    });
    const [, contents] = writeFileMock.mock.calls[0] ?? [];
    expect(JSON.parse(contents as string)).toEqual({
      mcpServers: {
        shared: { command: "npx", args: ["-y", "local-scope-mcp"] },
        playwright: { type: "http", url: "http://localhost:8742/mcp" },
      },
    });
  });

  it("emits one mcpServers entry per binding for claude", async () => {
    const result = await setupAgentHooks({
      agent: "claude",
      worktreePath: "/tmp/spur-worktrees/api/api-1",
      sessionToolDir: "/tmp/spur-data/session-tools/api-1",
      mcpBindings: [
        { server: "playwright", url: "http://localhost:8742/mcp" },
        { server: "widget", url: "http://localhost:9001/widget" },
      ],
    });

    expect(result).toEqual({
      claudeMcpConfigPath: "/tmp/spur-data/session-tools/api-1/mcp-config.json",
    });
    const [, contents] = writeFileMock.mock.calls[0] ?? [];
    expect(JSON.parse(contents as string)).toEqual({
      mcpServers: {
        playwright: { type: "http", url: "http://localhost:8742/mcp" },
        widget: { type: "http", url: "http://localhost:9001/widget" },
      },
    });
  });

  // Claude 2.1.221 ignores an "mcpServers" block in settings.json (verified
  // with a scratch CLAUDE_CONFIG_DIR: `claude mcp list` shows a probe planted
  // in .claude.json and not the same probe in settings.json). Merging it would
  // make Spur start servers the session would otherwise never load.
  it("ignores mcpServers in settings.json, which claude does not read", async () => {
    readFileMock.mockImplementation(async (path: string) => {
      if (path === "/home/user/settings.json") {
        return JSON.stringify({
          mcpServers: { sentry: { command: "npx", args: ["-y", "sentry-mcp"] } },
        });
      }
      if (path === "/home/user/.claude.json") {
        return JSON.stringify({
          mcpServers: { shared: { command: "npx", args: ["-y", "user-scope-mcp"] } },
        });
      }
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });

    await setupAgentHooks({
      agent: "claude",
      worktreePath: "/tmp/spur-worktrees/api/api-1",
      sessionToolDir: "/tmp/spur-data/session-tools/api-1",
      mcpBindings: [{ server: "playwright", url: "http://localhost:8742/mcp" }],
      claudeConfigDir: "/home/user",
    });

    const [, contents] = writeFileMock.mock.calls[0] ?? [];
    expect(JSON.parse(contents as string)).toEqual({
      mcpServers: {
        shared: { command: "npx", args: ["-y", "user-scope-mcp"] },
        playwright: { type: "http", url: "http://localhost:8742/mcp" },
      },
    });
  });

  // Suppression path: a project pays no RAM for a globally-configured server it
  // does not use. Needs no sidecar binding to take effect.
  it("writes an authoritative mcp-config.json for mcpExclude alone, dropping the excluded server", async () => {
    readFileMock.mockImplementation(async (path: string) => {
      if (path === "/home/user/.claude.json") {
        return JSON.stringify({
          mcpServers: {
            playwright: { command: "npx", args: ["-y", "@playwright/mcp@latest"] },
            sentry: { command: "npx", args: ["-y", "sentry-mcp"] },
          },
        });
      }
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });

    const result = await setupAgentHooks({
      agent: "claude",
      worktreePath: "/tmp/spur-worktrees/api/api-1",
      sessionToolDir: "/tmp/spur-data/session-tools/api-1",
      mcpExclude: ["playwright"],
      claudeConfigDir: "/home/user",
    });

    expect(result).toEqual({
      claudeMcpConfigPath: "/tmp/spur-data/session-tools/api-1/mcp-config.json",
    });
    const [, contents] = writeFileMock.mock.calls[0] ?? [];
    expect(JSON.parse(contents as string)).toEqual({
      mcpServers: { sentry: { command: "npx", args: ["-y", "sentry-mcp"] } },
    });
  });

  it("keeps Spur's sidecar binding when the same server name is also excluded", async () => {
    readFileMock.mockImplementation(async (path: string) => {
      if (path === "/home/user/.claude.json") {
        return JSON.stringify({
          mcpServers: { playwright: { command: "npx", args: ["-y", "@playwright/mcp@latest"] } },
        });
      }
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });

    await setupAgentHooks({
      agent: "claude",
      worktreePath: "/tmp/spur-worktrees/api/api-1",
      sessionToolDir: "/tmp/spur-data/session-tools/api-1",
      mcpBindings: [{ server: "playwright", url: "http://localhost:8742/mcp" }],
      mcpExclude: ["playwright"],
      claudeConfigDir: "/home/user",
    });

    const [, contents] = writeFileMock.mock.calls[0] ?? [];
    expect(JSON.parse(contents as string)).toEqual({
      mcpServers: { playwright: { type: "http", url: "http://localhost:8742/mcp" } },
    });
  });

  it("stays out of the way when there is nothing to inject and nothing to exclude", async () => {
    const result = await setupAgentHooks({
      agent: "claude",
      worktreePath: "/tmp/spur-worktrees/api/api-1",
      sessionToolDir: "/tmp/spur-data/session-tools/api-1",
      mcpExclude: [],
      claudeConfigDir: "/home/user",
    });

    expect(result).toEqual({});
    expect(writeFileMock).not.toHaveBeenCalled();
  });

  it("forwards mcpExclude to codex hook config", async () => {
    ensureCodexHooksConfigMock.mockResolvedValue("/tmp/spur-data/session-tools/api-1/codex-home");

    await setupAgentHooks({
      agent: "codex",
      worktreePath: "/tmp/spur-worktrees/api/api-1",
      sessionToolDir: "/tmp/spur-data/session-tools/api-1",
      mcpExclude: ["playwright"],
    });

    expect(ensureCodexHooksConfigMock).toHaveBeenCalledWith(
      "/tmp/spur-data/session-tools/api-1",
      ["/tmp/spur-worktrees/api/api-1"],
      { mcpExclude: ["playwright"] },
    );
  });

  it("forwards mcpBindings to codex hook config", async () => {
    ensureCodexHooksConfigMock.mockResolvedValue("/tmp/spur-data/session-tools/api-1/codex-home");
    const mcpBindings = [{ server: "playwright", url: "http://localhost:8742/mcp" }];

    await setupAgentHooks({
      agent: "codex",
      worktreePath: "/tmp/spur-worktrees/api/api-1",
      sessionToolDir: "/tmp/spur-data/session-tools/api-1",
      mcpBindings,
    });

    expect(ensureCodexHooksConfigMock).toHaveBeenCalledWith(
      "/tmp/spur-data/session-tools/api-1",
      ["/tmp/spur-worktrees/api/api-1"],
      { mcpBindings },
    );
  });

  it("forwards restrictWrites to codex hook setup", async () => {
    ensureCodexHooksConfigMock.mockResolvedValue("/tmp/spur-data/session-tools/api-1/codex-home");

    await setupAgentHooks({
      agent: "codex",
      worktreePath: "/tmp/spur-worktrees/api/api-1",
      sessionToolDir: "/tmp/spur-data/session-tools/api-1",
      restrictWrites: true,
    });

    expect(ensureCodexHooksConfigMock).toHaveBeenCalledWith(
      "/tmp/spur-data/session-tools/api-1",
      ["/tmp/spur-worktrees/api/api-1"],
      { restrictWrites: true },
    );
  });
});

describe("buildAgentLaunchPlan", () => {
  it("keeps --force for cursor when restrictWrites is enabled", () => {
    const plan = buildAgentLaunchPlan("cursor", "review only", { restrictWrites: true });
    expect(plan.launchCommand).toBe("agent --force --sandbox disabled --model 'auto'");
    expect(plan.launchCommand).toContain("--force");
    expect(plan.launchCommand).not.toContain("--plan");
  });
});

describe("createAgentSubmitAckBinding", () => {
  const ctx = {
    worktreePath: "/tmp/spur-worktrees/api/api-1",
    codexSessionsDir: "/tmp/spur-data/session-tools/api-1/codex-home/sessions",
  };

  it("returns null for claude when no JSONL baseline can be captured", async () => {
    captureClaudeSubmitBaselineMock.mockResolvedValue(null);
    const binding = await createAgentSubmitAckBinding("claude", ctx);
    expect(binding).toBeNull();
  });

  it("returns a binding for claude that scans the captured baseline", async () => {
    captureClaudeSubmitBaselineMock.mockResolvedValue({ file: "/some/file.jsonl", size: 42 });
    scanClaudeJsonlForMessageMock.mockResolvedValue(true);

    const binding = await createAgentSubmitAckBinding("claude", ctx);
    expect(binding).not.toBeNull();
    const result = await binding?.scan("hello");
    expect(result).toEqual({ found: true, lastScannedFile: "/some/file.jsonl" });
    expect(scanClaudeJsonlForMessageMock).toHaveBeenCalledWith(
      { file: "/some/file.jsonl", size: 42 },
      "hello",
      ctx.worktreePath,
      undefined,
    );
  });

  it("threads the pinned agentSessionId into claude baseline and scan", async () => {
    captureClaudeSubmitBaselineMock.mockResolvedValue({ file: "/some/file.jsonl", size: 42 });
    scanClaudeJsonlForMessageMock.mockResolvedValue(true);

    const pinnedCtx = { ...ctx, agentSessionId: "pinned-uuid" };
    const binding = await createAgentSubmitAckBinding("claude", pinnedCtx);
    await binding?.scan("hello");
    expect(captureClaudeSubmitBaselineMock).toHaveBeenCalledWith(ctx.worktreePath, "pinned-uuid", {
      freshLaunch: false,
    });
    expect(scanClaudeJsonlForMessageMock).toHaveBeenCalledWith(
      { file: "/some/file.jsonl", size: 42 },
      "hello",
      ctx.worktreePath,
      "pinned-uuid",
    );
  });

  it("passes fresh-launch into the claude baseline capture", async () => {
    captureClaudeSubmitBaselineMock.mockResolvedValue({ file: "/some/file.jsonl", size: 0 });

    await createAgentSubmitAckBinding("claude", {
      ...ctx,
      agentSessionId: "pinned-uuid",
      freshLaunch: true,
    });

    expect(captureClaudeSubmitBaselineMock).toHaveBeenCalledWith(ctx.worktreePath, "pinned-uuid", {
      freshLaunch: true,
    });
  });

  it("returns a binding for codex that scans the rollout dir", async () => {
    const baseline = new Map<string, number>([["/some/rollout.jsonl", 100]]);
    captureCodexRolloutBaselineMock.mockResolvedValue(baseline);
    scanCodexRolloutForMessageMock.mockResolvedValue({
      found: true,
      lastScannedFile: "/some/rollout.jsonl",
    });

    const binding = await createAgentSubmitAckBinding("codex", ctx);
    expect(binding).not.toBeNull();
    const result = await binding?.scan("hello");
    expect(result).toEqual({ found: true, lastScannedFile: "/some/rollout.jsonl" });
    expect(scanCodexRolloutForMessageMock).toHaveBeenCalledWith(
      ctx.codexSessionsDir,
      "hello",
      baseline,
    );
  });

  it("returns null for cursor when no transcript baseline can be captured", async () => {
    captureCursorSubmitBaselineMock.mockResolvedValue(null);
    const binding = await createAgentSubmitAckBinding("cursor", ctx);
    expect(binding).toBeNull();
  });

  it("threads the pinned agentSessionId into cursor capture and scan, and reports the rotated file actually scanned", async () => {
    captureCursorSubmitBaselineMock.mockResolvedValue({ file: "/some/chat.jsonl", size: 7 });
    scanCursorJsonlForMessageMock.mockResolvedValue({
      found: true,
      scannedFile: "/rotated/chat.jsonl",
    });

    const pinnedCtx = { ...ctx, agentSessionId: "sid-1" };
    const binding = await createAgentSubmitAckBinding("cursor", pinnedCtx);
    expect(binding).not.toBeNull();
    const result = await binding?.scan("hello");

    expect(captureCursorSubmitBaselineMock).toHaveBeenCalledWith(ctx.worktreePath, "sid-1");
    expect(scanCursorJsonlForMessageMock).toHaveBeenCalledWith(
      { file: "/some/chat.jsonl", size: 7 },
      "hello",
      ctx.worktreePath,
      "sid-1",
    );
    // The rotated path, not baseline.file: change (e) reports the file the scan
    // actually read, not a hardcoded baseline.
    expect(result).toEqual({ found: true, lastScannedFile: "/rotated/chat.jsonl" });
  });
});

describe("agentSubmitAckPacing", () => {
  it("shortens the claude window for a launch send only", () => {
    expect(agentSubmitAckPacing("claude")).toEqual({ windowMs: 300_000, maxResends: 2 });
    expect(agentSubmitAckPacing("claude", { freshLaunch: true })).toEqual({
      windowMs: 5_000,
      maxResends: 2,
    });
  });

  it("reports launch-send pacing for claude only", () => {
    // Callers scope launch-send handling by this flag, so it must track exactly
    // the agents whose short window and Enter resends justify it.
    expect(agentHasLaunchSubmitAck("claude")).toBe(true);
    expect(agentHasLaunchSubmitAck("codex")).toBe(false);
    expect(agentHasLaunchSubmitAck("cursor")).toBe(false);
  });

  it("keeps cursor and codex pacing on a launch send", () => {
    expect(agentSubmitAckPacing("cursor", { freshLaunch: true })).toEqual({
      windowMs: 5_000,
      maxResends: 12,
    });
    expect(agentSubmitAckPacing("codex", { freshLaunch: true })).toEqual({
      windowMs: 300_000,
      maxResends: 2,
    });
  });
});
