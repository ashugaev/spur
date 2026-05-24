import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", () => ({
  readdir: vi.fn(),
  stat: vi.fn(),
  realpath: vi.fn(),
  mkdir: vi.fn(),
  writeFile: vi.fn(),
}));

vi.mock("../../src/agents/worktree-path.js", () => ({
  resolveWorktreePathCandidates: vi.fn(),
}));

vi.mock("node:os", () => ({
  homedir: vi.fn(() => "/home/testuser"),
}));

import { readdir, stat, mkdir, writeFile } from "node:fs/promises";
import { resolveWorktreePathCandidates } from "../../src/agents/worktree-path.js";
import {
  buildClaudePlan,
  buildClaudeResumePlan,
  buildClaudeRestorePlan,
  claudeCommand,
  ensureClaudeRestrictWritesSettings,
  findLatestSessionFile,
  findClaudeSessionId,
} from "../../src/agents/claude.js";

const mockReaddir = readdir as ReturnType<typeof vi.fn>;
const mockStat = stat as ReturnType<typeof vi.fn>;
const mockMkdir = mkdir as ReturnType<typeof vi.fn>;
const mockWriteFile = writeFile as ReturnType<typeof vi.fn>;
const mockResolveWorktreePathCandidates = resolveWorktreePathCandidates as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env["SPUR_CLAUDE_BIN"];
});

afterEach(() => {
  delete process.env["SPUR_CLAUDE_BIN"];
});

describe("claudeCommand", () => {
  it("returns 'claude' by default", () => {
    expect(claudeCommand()).toBe("claude");
  });

  it("returns SPUR_CLAUDE_BIN when set", () => {
    process.env["SPUR_CLAUDE_BIN"] = "/custom/claude";
    expect(claudeCommand()).toBe("/custom/claude");
  });
});

describe("buildClaudePlan", () => {
  it("returns default plan with no options", () => {
    const plan = buildClaudePlan("do something");
    expect(plan.launchCommand).toBe("claude --dangerously-skip-permissions");
    expect(plan.initialMessage).toBe("do something");
    expect(plan.readyMarkers).toEqual(["Claude Code", "❯"]);
  });

  it("includes --settings when settingsPath is provided", () => {
    const plan = buildClaudePlan("prompt", { settingsPath: "/path/to/settings.json" });
    expect(plan.launchCommand).toContain("--settings '/path/to/settings.json'");
    expect(plan.launchCommand).toContain("--dangerously-skip-permissions");
  });

  it("includes --permission-mode plan when planMode is true", () => {
    const plan = buildClaudePlan("prompt", { planMode: true });
    expect(plan.launchCommand).toContain("--permission-mode plan");
    expect(plan.launchCommand).toContain("--dangerously-skip-permissions");
  });

  it("includes both settingsPath and planMode flags", () => {
    const plan = buildClaudePlan("prompt", {
      settingsPath: "/settings.json",
      planMode: true,
    });
    expect(plan.launchCommand).toContain("--permission-mode plan");
    expect(plan.launchCommand).toContain("--settings '/settings.json'");
    expect(plan.launchCommand).toContain("--dangerously-skip-permissions");
  });

  it("uses SPUR_CLAUDE_BIN override", () => {
    process.env["SPUR_CLAUDE_BIN"] = "/opt/claude-bin";
    const plan = buildClaudePlan("prompt");
    expect(plan.launchCommand).toContain("/opt/claude-bin");
    expect(plan.launchCommand).not.toContain("'claude'");
  });

  it("shell-escapes settingsPath with single quotes in the path", () => {
    const plan = buildClaudePlan("prompt", { settingsPath: "/path/with'quote/settings.json" });
    expect(plan.launchCommand).toContain("--settings '/path/with'\\''quote/settings.json'");
  });
});

describe("ensureClaudeRestrictWritesSettings", () => {
  beforeEach(() => {
    mockMkdir.mockResolvedValue(undefined);
    mockWriteFile.mockResolvedValue(undefined);
  });

  it("writes a PreToolUse deny hook for write tools", async () => {
    const settingsPath = await ensureClaudeRestrictWritesSettings("/session/tool");

    expect(settingsPath).toBe("/session/tool/claude/settings.json");
    const content = JSON.parse(mockWriteFile.mock.calls[0]?.[1] as string) as {
      hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }> };
    };
    expect(content.hooks.PreToolUse[0]?.matcher).toBe("Write|Edit|MultiEdit|NotebookEdit");
    expect(content.hooks.PreToolUse[0]?.hooks[0]?.command).toContain("exit 2");
  });
});

describe("buildClaudeResumePlan", () => {
  it("returns default resume plan with sessionId", () => {
    const plan = buildClaudeResumePlan("session-abc-123");
    expect(plan.launchCommand).toContain("--resume 'session-abc-123'");
    expect(plan.launchCommand).toContain("--dangerously-skip-permissions");
    expect(plan.readyMarkers).toEqual(["❯"]);
  });

  it("shell-escapes the binary", () => {
    const plan = buildClaudeResumePlan("session-123", "/path/to claude");
    expect(plan.launchCommand).toContain("'/path/to claude'");
  });

  it("shell-escapes the sessionId", () => {
    const plan = buildClaudeResumePlan("session'id", "claude");
    expect(plan.launchCommand).toContain("'session'\\''id'");
  });

  it("uses provided binary instead of default", () => {
    const plan = buildClaudeResumePlan("session-123", "/custom/claude");
    expect(plan.launchCommand).toContain("'/custom/claude'");
  });

  it("includes --settings when settingsPath provided", () => {
    const plan = buildClaudeResumePlan("session-123", "claude", { settingsPath: "/s.json" });
    expect(plan.launchCommand).toContain("--settings '/s.json'");
  });

  it("includes --permission-mode plan when planMode is true", () => {
    const plan = buildClaudeResumePlan("session-123", "claude", { planMode: true });
    expect(plan.launchCommand).toContain("--permission-mode plan");
  });

  it("does not include initialMessage", () => {
    const plan = buildClaudeResumePlan("session-123");
    expect(plan).not.toHaveProperty("initialMessage");
  });
});

describe("findLatestSessionFile", () => {
  it("returns null when no JSONL files exist", async () => {
    mockResolveWorktreePathCandidates.mockResolvedValue(["/worktree/path"]);
    mockReaddir.mockResolvedValue([]);

    const result = await findLatestSessionFile("/worktree/path");
    expect(result).toBeNull();
  });

  it("returns the most recent JSONL file by mtime", async () => {
    mockResolveWorktreePathCandidates.mockResolvedValue(["/worktree/path"]);
    mockReaddir.mockResolvedValue(["old.jsonl", "new.jsonl"]);
    mockStat.mockResolvedValueOnce({ mtimeMs: 1000 }).mockResolvedValueOnce({ mtimeMs: 2000 });

    const result = await findLatestSessionFile("/worktree/path");
    expect(result).toContain("new.jsonl");
  });

  it("skips agent-*.jsonl files", async () => {
    mockResolveWorktreePathCandidates.mockResolvedValue(["/worktree/path"]);
    mockReaddir.mockResolvedValue(["agent-state.jsonl", "session.jsonl"]);
    mockStat.mockResolvedValue({ mtimeMs: 1000 });

    const result = await findLatestSessionFile("/worktree/path");
    expect(result).toContain("session.jsonl");
    expect(result).not.toContain("agent-state.jsonl");
  });

  it("returns null when only agent-*.jsonl files exist", async () => {
    mockResolveWorktreePathCandidates.mockResolvedValue(["/worktree/path"]);
    mockReaddir.mockResolvedValue(["agent-state.jsonl"]);

    const result = await findLatestSessionFile("/worktree/path");
    expect(result).toBeNull();
  });

  it("tries next candidate when readdir throws", async () => {
    mockResolveWorktreePathCandidates.mockResolvedValue([
      "/worktree/path",
      "/canonical/worktree/path",
    ]);
    // First candidate's directory fails
    mockReaddir.mockRejectedValueOnce(new Error("ENOENT")).mockResolvedValueOnce(["session.jsonl"]);
    mockStat.mockResolvedValue({ mtimeMs: 1000 });

    const result = await findLatestSessionFile("/worktree/path");
    expect(result).not.toBeNull();
    expect(result).toContain("session.jsonl");
  });

  it("returns null when readdir throws for all candidates", async () => {
    mockResolveWorktreePathCandidates.mockResolvedValue(["/worktree/path"]);
    mockReaddir.mockRejectedValue(new Error("ENOENT"));

    const result = await findLatestSessionFile("/worktree/path");
    expect(result).toBeNull();
  });

  it("handles stat failure gracefully and still returns a file", async () => {
    mockResolveWorktreePathCandidates.mockResolvedValue(["/worktree/path"]);
    mockReaddir.mockResolvedValue(["session.jsonl"]);
    mockStat.mockRejectedValue(new Error("EACCES"));

    const result = await findLatestSessionFile("/worktree/path");
    // stat failure returns mtimeMs=0, still returns the path
    expect(result).toContain("session.jsonl");
  });

  it("uses toClaudeProjectPath transformation for the project dir", async () => {
    mockResolveWorktreePathCandidates.mockResolvedValue(["/home/user/project/path"]);
    mockReaddir.mockResolvedValue(["session.jsonl"]);
    mockStat.mockResolvedValue({ mtimeMs: 1000 });

    await findLatestSessionFile("/home/user/project/path");

    // The readdir should have been called with a path derived from the worktree path
    expect(mockReaddir).toHaveBeenCalledWith(expect.stringContaining("-home-user-project-path"));
  });
});

describe("findClaudeSessionId", () => {
  it("returns null when no session file exists", async () => {
    mockResolveWorktreePathCandidates.mockResolvedValue(["/worktree/path"]);
    mockReaddir.mockResolvedValue([]);

    const result = await findClaudeSessionId("/worktree/path");
    expect(result).toBeNull();
  });

  it("returns the session id (basename without .jsonl) when file exists", async () => {
    mockResolveWorktreePathCandidates.mockResolvedValue(["/worktree/path"]);
    mockReaddir.mockResolvedValue(["abc-def-123.jsonl"]);
    mockStat.mockResolvedValue({ mtimeMs: 1000 });

    const result = await findClaudeSessionId("/worktree/path");
    expect(result).toBe("abc-def-123");
  });
});

describe("buildClaudeRestorePlan", () => {
  it("returns null when findClaudeSessionId returns null", async () => {
    mockResolveWorktreePathCandidates.mockResolvedValue(["/worktree/path"]);
    mockReaddir.mockResolvedValue([]);

    const result = await buildClaudeRestorePlan("/worktree/path", "prompt");
    expect(result).toBeNull();
  });

  it("returns a resume plan with initialMessage when session is found", async () => {
    mockResolveWorktreePathCandidates.mockResolvedValue(["/worktree/path"]);
    mockReaddir.mockResolvedValue(["my-session-id.jsonl"]);
    mockStat.mockResolvedValue({ mtimeMs: 1000 });

    const result = await buildClaudeRestorePlan("/worktree/path", "restore me");
    expect(result).not.toBeNull();
    expect(result?.launchCommand).toContain("--resume 'my-session-id'");
    expect(result?.launchCommand).toContain("--dangerously-skip-permissions");
    expect(result?.initialMessage).toBe("restore me");
    expect(result?.readyMarkers).toEqual(["❯"]);
  });

  it("passes options to the resume plan", async () => {
    mockResolveWorktreePathCandidates.mockResolvedValue(["/worktree/path"]);
    mockReaddir.mockResolvedValue(["session-id.jsonl"]);
    mockStat.mockResolvedValue({ mtimeMs: 1000 });

    const result = await buildClaudeRestorePlan("/worktree/path", "prompt", {
      settingsPath: "/settings.json",
      planMode: true,
    });
    expect(result?.launchCommand).toContain("--settings '/settings.json'");
    expect(result?.launchCommand).toContain("--permission-mode plan");
  });
});
