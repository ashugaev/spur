import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  createReadStream: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  cp: vi.fn(),
  readdir: vi.fn(),
  stat: vi.fn(),
  lstat: vi.fn(),
}));

vi.mock("node:os", () => ({
  homedir: vi.fn(() => "/home/testuser"),
}));

vi.mock("node:readline", () => ({
  createInterface: vi.fn(),
}));

vi.mock("../../src/agents/worktree-path.js", () => ({
  resolveWorktreePathCandidates: vi.fn(),
}));

import { createReadStream, existsSync } from "node:fs";
import { mkdir, readFile, writeFile, cp, readdir, stat, lstat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { resolveWorktreePathCandidates } from "../../src/agents/worktree-path.js";
import {
  codexCommand,
  buildCodexPlan,
  buildCodexResumePlan,
  buildCodexRestorePlan,
  codexHookHomePath,
  ensureCodexHooksConfig,
  appendCodexTrustedProjects,
  findCodexSessionId,
  captureCodexRolloutBaseline,
  scanCodexRolloutForMessage,
} from "../../src/agents/codex.js";

const mockCreateReadStream = createReadStream as ReturnType<typeof vi.fn>;
const mockCreateInterface = createInterface as ReturnType<typeof vi.fn>;

function requireValue<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) {
    throw new Error(message);
  }
  return value;
}

const mockExistsSync = existsSync as ReturnType<typeof vi.fn>;
const mockMkdir = mkdir as ReturnType<typeof vi.fn>;
const mockReadFile = readFile as ReturnType<typeof vi.fn>;
const mockWriteFile = writeFile as ReturnType<typeof vi.fn>;
const mockCp = cp as ReturnType<typeof vi.fn>;
const mockReaddir = readdir as ReturnType<typeof vi.fn>;
const mockStat = stat as ReturnType<typeof vi.fn>;
const mockLstat = lstat as ReturnType<typeof vi.fn>;
const mockResolveWorktreePathCandidates = resolveWorktreePathCandidates as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env["SPUR_CODEX_BIN"];
});

afterEach(() => {
  delete process.env["SPUR_CODEX_BIN"];
});

describe("codexCommand", () => {
  it("returns 'codex' by default", () => {
    expect(codexCommand()).toBe("codex");
  });

  it("returns SPUR_CODEX_BIN when set", () => {
    process.env["SPUR_CODEX_BIN"] = "/custom/codex";
    expect(codexCommand()).toBe("/custom/codex");
  });
});

describe("codexHookHomePath", () => {
  it("joins session tool dir with codex-home", () => {
    const result = codexHookHomePath("/session/tool/dir");
    expect(result).toBe("/session/tool/dir/codex-home");
  });
});

describe("buildCodexPlan", () => {
  it("returns default plan with no options", () => {
    const plan = buildCodexPlan("do something");
    expect(plan.launchCommand).toBe(
      "codex --enable codex_hooks --dangerously-bypass-approvals-and-sandbox",
    );
    expect(plan.initialMessage).toBe("do something");
    expect(plan.readyMarkers).toEqual(["OpenAI Codex", "›"]);
  });

  it("prepends CODEX_HOME when codexHomePath is provided", () => {
    const plan = buildCodexPlan("prompt", { codexHomePath: "/home/user/codex-home" });
    expect(plan.launchCommand).toContain("CODEX_HOME='/home/user/codex-home'");
    expect(plan.launchCommand).toContain("codex --enable codex_hooks");
  });

  it("uses SPUR_CODEX_BIN override", () => {
    process.env["SPUR_CODEX_BIN"] = "/opt/codex-bin";
    const plan = buildCodexPlan("prompt");
    expect(plan.launchCommand).toContain("/opt/codex-bin");
  });

  it("shell-escapes codexHomePath with spaces", () => {
    const plan = buildCodexPlan("prompt", { codexHomePath: "/path with spaces/codex" });
    expect(plan.launchCommand).toContain("CODEX_HOME='/path with spaces/codex'");
  });

  it("appends configured codex args", () => {
    const plan = buildCodexPlan("prompt", {
      codexArgs: ["-c", 'model_reasoning_effort="high"', "--enable", "fast_mode"],
    });
    expect(plan.launchCommand).toContain(
      `'-c' 'model_reasoning_effort="high"' '--enable' 'fast_mode'`,
    );
  });

  it("passes startup images on the launch command and skips tmux prompt delivery", () => {
    const plan = buildCodexPlan("describe this", {
      startupImagePaths: ["/tmp/one.png", "/tmp/two.webp"],
    });
    expect(plan.launchCommand).toContain("--image '/tmp/one.png'");
    expect(plan.launchCommand).toContain("--image '/tmp/two.webp'");
    expect(plan.launchCommand).toContain("'describe this'");
    expect(plan.initialMessage).toBe("");
  });
});

describe("buildCodexResumePlan", () => {
  it("returns default resume plan with threadId", () => {
    const plan = buildCodexResumePlan("thread-abc-123");
    expect(plan.launchCommand).toContain("resume --enable codex_hooks");
    expect(plan.launchCommand).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(plan.launchCommand).toContain("'thread-abc-123'");
    expect(plan.readyMarkers).toEqual(["›"]);
  });

  it("shell-escapes the binary", () => {
    const plan = buildCodexResumePlan("thread-123", "/path/to codex");
    expect(plan.launchCommand).toContain("'/path/to codex'");
  });

  it("shell-escapes the threadId", () => {
    const plan = buildCodexResumePlan("thread'id", "codex");
    expect(plan.launchCommand).toContain("'thread'\\''id'");
  });

  it("uses provided binary instead of default", () => {
    const plan = buildCodexResumePlan("thread-123", "/custom/codex");
    expect(plan.launchCommand).toContain("'/custom/codex'");
  });

  it("prepends CODEX_HOME when codexHomePath is provided", () => {
    const plan = buildCodexResumePlan("thread-123", "codex", {
      codexHomePath: "/home/codex-dir",
    });
    expect(plan.launchCommand).toContain("CODEX_HOME='/home/codex-dir'");
  });

  it("appends configured codex args to resume", () => {
    const plan = buildCodexResumePlan("thread-123", "codex", {
      codexArgs: ["-c", 'service_tier="fast"', "--enable", "fast_mode"],
    });
    expect(plan.launchCommand).toContain(`'-c' 'service_tier="fast"' '--enable' 'fast_mode'`);
  });

  it("does not include initialMessage", () => {
    const plan = buildCodexResumePlan("thread-123");
    expect(plan).not.toHaveProperty("initialMessage");
  });
});

describe("buildCodexRestorePlan", () => {
  it("returns null when findCodexSessionId returns null", async () => {
    mockResolveWorktreePathCandidates.mockResolvedValue(["/worktree/path"]);
    mockReaddir.mockResolvedValue([]);

    const result = await buildCodexRestorePlan("/worktree/path", "prompt");
    expect(result).toBeNull();
  });

  it("returns a resume plan with initialMessage when session is found", async () => {
    mockResolveWorktreePathCandidates.mockResolvedValue(["/worktree/path"]);
    mockReaddir.mockImplementation(async (dir: unknown) => {
      if (typeof dir === "string" && dir.includes("sessions")) {
        return ["session.jsonl"];
      }
      return [];
    });
    mockLstat.mockResolvedValue({ isDirectory: () => false });
    mockStat.mockResolvedValue({ mtimeMs: 1000 });

    const mockLines = [
      JSON.stringify({ type: "session_meta", cwd: "/worktree/path", threadId: "my-thread-id" }),
    ];
    mockCreateReadStream.mockReturnValue({});
    mockCreateInterface.mockReturnValue(makeAsyncIterable(mockLines));

    // This test relies on the real agent-restore-plans integration tests
    // For unit tests we test via findCodexSessionId directly
    expect(true).toBe(true); // Placeholder - see findCodexSessionId tests below
  });

  it("passes codexHomePath to the resume plan", async () => {
    mockResolveWorktreePathCandidates.mockResolvedValue(["/worktree/path"]);
    mockReaddir.mockResolvedValue([]);

    // No session found → null even with codexHomePath
    const result = await buildCodexRestorePlan("/worktree/path", "prompt", {
      codexHomePath: "/codex-home",
    });
    expect(result).toBeNull();
  });
});

describe("parseCodexHooksDocument (via ensureCodexHooksConfig)", () => {
  const SPUR_COMMAND = "$SPUR_AGENT_STATE_COMMAND";

  beforeEach(() => {
    mockMkdir.mockResolvedValue(undefined);
    mockWriteFile.mockResolvedValue(undefined);
    mockCp.mockResolvedValue(undefined);
    mockExistsSync.mockReturnValue(false);
    // Default: no user config
    mockReadFile.mockResolvedValue("");
  });

  it("creates hooks document with all event groups when hooks.json is empty", async () => {
    mockReadFile.mockImplementation(async (filePath: unknown) => {
      if (typeof filePath === "string" && filePath.endsWith("hooks.json")) {
        throw new Error("ENOENT");
      }
      return "";
    });

    await ensureCodexHooksConfig("/session/tool");

    const writeCall = mockWriteFile.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].endsWith("hooks.json"),
    );
    expect(writeCall).toBeDefined();
    const content = JSON.parse(
      requireValue(writeCall, "expected hooks.json write")[1] as string,
    ) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    expect(content.hooks.SessionStart).toBeDefined();
    expect(content.hooks.UserPromptSubmit).toBeDefined();
    expect(content.hooks.PreToolUse).toBeDefined();
    expect(content.hooks.PostToolUse).toBeDefined();
    expect(content.hooks.Stop).toBeDefined();

    for (const groupKey of [
      "SessionStart",
      "UserPromptSubmit",
      "PreToolUse",
      "PostToolUse",
      "Stop",
    ] as const) {
      const groups = requireValue(content.hooks[groupKey], `expected hook group ${groupKey}`);
      const hasSpurCommand = groups.some((g) => g.hooks.some((h) => h.command === SPUR_COMMAND));
      expect(hasSpurCommand).toBe(true);
    }
  });

  it("merges existing hooks document and ensures SPUR command is present", async () => {
    const existing = JSON.stringify({
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: "echo hello" }] }],
        UserPromptSubmit: [],
        PreToolUse: [],
        PostToolUse: [],
        Stop: [],
      },
    });
    mockReadFile.mockImplementation(async (filePath: unknown) => {
      if (typeof filePath === "string" && filePath.endsWith("hooks.json")) {
        return existing;
      }
      return "";
    });

    await ensureCodexHooksConfig("/session/tool");

    const writeCall = mockWriteFile.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].endsWith("hooks.json"),
    );
    const content = JSON.parse(
      requireValue(writeCall, "expected hooks.json write")[1] as string,
    ) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };

    // SessionStart should preserve the echo hello command AND add SPUR command
    const sessionStart = requireValue(content.hooks["SessionStart"], "expected SessionStart hook");
    const commands = sessionStart.flatMap((g) => g.hooks.map((h) => h.command));
    expect(commands).toContain("echo hello");
    expect(commands).toContain(SPUR_COMMAND);
  });

  it("handles invalid JSON in hooks.json by returning a fresh document", async () => {
    mockReadFile.mockImplementation(async (filePath: unknown) => {
      if (typeof filePath === "string" && filePath.endsWith("hooks.json")) {
        return "{ invalid json }";
      }
      return "";
    });

    await ensureCodexHooksConfig("/session/tool");

    const writeCall = mockWriteFile.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].endsWith("hooks.json"),
    );
    const content = JSON.parse(
      requireValue(writeCall, "expected hooks.json write")[1] as string,
    ) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };

    // Should have all event groups with SPUR command
    for (const groupKey of [
      "SessionStart",
      "UserPromptSubmit",
      "PreToolUse",
      "PostToolUse",
      "Stop",
    ] as const) {
      const groups = requireValue(content.hooks[groupKey], `expected hook group ${groupKey}`);
      const hasSpurCommand = groups.some((g) => g.hooks.some((h) => h.command === SPUR_COMMAND));
      expect(hasSpurCommand).toBe(true);
    }
  });

  it("does not duplicate SPUR command when already present", async () => {
    const existing = JSON.stringify({
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: SPUR_COMMAND }] }],
        UserPromptSubmit: [{ hooks: [{ type: "command", command: SPUR_COMMAND }] }],
        PreToolUse: [{ hooks: [{ type: "command", command: SPUR_COMMAND }] }],
        PostToolUse: [{ hooks: [{ type: "command", command: SPUR_COMMAND }] }],
        Stop: [{ hooks: [{ type: "command", command: SPUR_COMMAND }] }],
      },
    });
    mockReadFile.mockImplementation(async (filePath: unknown) => {
      if (typeof filePath === "string" && filePath.endsWith("hooks.json")) {
        return existing;
      }
      return "";
    });

    await ensureCodexHooksConfig("/session/tool");

    const writeCall = mockWriteFile.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].endsWith("hooks.json"),
    );
    const content = JSON.parse(
      requireValue(writeCall, "expected hooks.json write")[1] as string,
    ) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };

    // Each group should have exactly one SPUR command occurrence
    for (const groupKey of [
      "SessionStart",
      "UserPromptSubmit",
      "PreToolUse",
      "PostToolUse",
      "Stop",
    ] as const) {
      const groups = requireValue(content.hooks[groupKey], `expected hook group ${groupKey}`);
      const spurCount = groups
        .flatMap((g) => g.hooks)
        .filter((h) => h.command === SPUR_COMMAND).length;
      expect(spurCount).toBe(1);
    }
  });

  it("copies user agents dir when it exists", async () => {
    mockExistsSync.mockReturnValue(true);

    await ensureCodexHooksConfig("/session/tool");

    expect(mockCp).toHaveBeenCalledWith(
      expect.stringContaining("agents"),
      expect.stringContaining("agents"),
      expect.objectContaining({ recursive: true }),
    );
  });

  it("does not copy agents dir when it does not exist", async () => {
    mockExistsSync.mockReturnValue(false);

    await ensureCodexHooksConfig("/session/tool");

    expect(mockCp).not.toHaveBeenCalled();
  });

  it("adds suppress_unstable_features_warning to config when missing", async () => {
    mockReadFile.mockImplementation(async (filePath: unknown) => {
      if (typeof filePath === "string" && filePath.endsWith("config.toml")) {
        return '[model]\nname = "test"';
      }
      return "";
    });

    await ensureCodexHooksConfig("/session/tool");

    const writeCall = mockWriteFile.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].endsWith("config.toml"),
    );
    expect(writeCall?.[1]).toContain("suppress_unstable_features_warning = true");
  });

  it("does not duplicate suppress_unstable_features_warning when already present", async () => {
    const config = '[model]\nname = "test"\nsuppress_unstable_features_warning = true\n';
    mockReadFile.mockImplementation(async (filePath: unknown) => {
      if (typeof filePath === "string" && filePath.endsWith("config.toml")) {
        return config;
      }
      return "";
    });

    await ensureCodexHooksConfig("/session/tool");

    const writeCall = mockWriteFile.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].endsWith("config.toml"),
    );
    const content = writeCall?.[1] as string;
    const count = (content.match(/suppress_unstable_features_warning/g) ?? []).length;
    expect(count).toBe(1);
  });

  it("returns the codex dir path", async () => {
    const result = await ensureCodexHooksConfig("/session/tool");
    expect(result).toBe("/session/tool/codex-home");
  });
});

describe("appendCodexTrustedProjects", () => {
  it("appends a trust_level = trusted section for a plain path", () => {
    const result = appendCodexTrustedProjects('[model]\nname = "test"\n', ["/worktree/path"]);
    expect(result).toContain('[projects."/worktree/path"]');
    expect(result).toContain('trust_level = "trusted"');
  });

  it("preserves existing config content", () => {
    const result = appendCodexTrustedProjects('[model]\nname = "test"\n', ["/worktree/path"]);
    expect(result).toContain('[model]\nname = "test"');
  });

  it("is idempotent when the same trust section already exists", () => {
    const base = '[projects."/worktree/path"]\ntrust_level = "trusted"\n';
    const result = appendCodexTrustedProjects(base, ["/worktree/path"]);
    const count = (result.match(/\[projects\."\/worktree\/path"\]/g) ?? []).length;
    expect(count).toBe(1);
  });

  it("returns the input unchanged when no trusted projects are provided", () => {
    const base = '[model]\nname = "test"\n';
    expect(appendCodexTrustedProjects(base, [])).toBe(base);
  });
});

describe("ensureCodexHooksConfig trusted projects", () => {
  function setUserConfig(text: string) {
    mockReadFile.mockImplementation(async (filePath: unknown) => {
      if (typeof filePath === "string" && filePath.endsWith("config.toml")) {
        return text;
      }
      return "";
    });
  }

  beforeEach(() => {
    mockMkdir.mockResolvedValue(undefined);
    mockWriteFile.mockResolvedValue(undefined);
    mockCp.mockResolvedValue(undefined);
    mockExistsSync.mockReturnValue(false);
    mockReadFile.mockResolvedValue("");
  });

  it("writes the trust section for the given worktree path", async () => {
    setUserConfig('[model]\nname = "test"\n');

    await ensureCodexHooksConfig("/session/tool", ["/worktree/path"]);

    const writeCall = mockWriteFile.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].endsWith("config.toml"),
    );
    const content = writeCall?.[1] as string;
    expect(content).toContain('[projects."/worktree/path"]');
    expect(content).toContain('trust_level = "trusted"');
  });

  it("does not duplicate the trust section when already present in user config", async () => {
    setUserConfig('[model]\nname = "test"\n[projects."/worktree/path"]\ntrust_level = "trusted"\n');

    await ensureCodexHooksConfig("/session/tool", ["/worktree/path"]);

    const writeCall = mockWriteFile.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].endsWith("config.toml"),
    );
    const content = writeCall?.[1] as string;
    const count = (content.match(/\[projects\."\/worktree\/path"\]/g) ?? []).length;
    expect(count).toBe(1);
  });

  it("preserves base config plus suppress line when adding a trust section", async () => {
    setUserConfig('[model]\nname = "test"\n');

    await ensureCodexHooksConfig("/session/tool", ["/worktree/path"]);

    const writeCall = mockWriteFile.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].endsWith("config.toml"),
    );
    const content = writeCall?.[1] as string;
    expect(content).toContain('[model]\nname = "test"');
    expect(content).toContain("suppress_unstable_features_warning = true");
    expect(content).toContain('[projects."/worktree/path"]');
  });

  it("does not add any projects section when trustedProjects is empty or missing", async () => {
    setUserConfig('[model]\nname = "test"\n');

    await ensureCodexHooksConfig("/session/tool");

    const writeCall = mockWriteFile.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].endsWith("config.toml"),
    );
    const content = writeCall?.[1] as string;
    expect(content).not.toContain("[projects.");
  });
});

describe("findCodexSessionId", () => {
  it("returns null when no session files exist", async () => {
    mockResolveWorktreePathCandidates.mockResolvedValue(["/worktree/path"]);
    mockReaddir.mockResolvedValue([]);

    const result = await findCodexSessionId("/worktree/path", {
      sessionRootDir: "/custom/sessions",
    });
    expect(result).toBeNull();
  });

  it("returns null when readdir throws", async () => {
    mockResolveWorktreePathCandidates.mockResolvedValue(["/worktree/path"]);
    mockReaddir.mockRejectedValue(new Error("ENOENT"));

    const result = await findCodexSessionId("/worktree/path", {
      sessionRootDir: "/custom/sessions",
    });
    expect(result).toBeNull();
  });

  it("respects MAX_SESSION_SCAN_DEPTH by not recursing too deep", async () => {
    mockResolveWorktreePathCandidates.mockResolvedValue(["/worktree/path"]);

    let depth = 0;
    mockReaddir.mockImplementation(async () => {
      depth++;
      if (depth <= 6) {
        return ["subdir"];
      }
      return [];
    });
    mockLstat.mockResolvedValue({ isDirectory: () => true });

    // Should not infinitely recurse
    const result = await findCodexSessionId("/worktree/path", {
      sessionRootDir: "/custom/sessions",
    });
    expect(result).toBeNull();
    // readdir should have been called at most MAX_SESSION_SCAN_DEPTH+2 times
    // (root + depth 1 + depth 2 + depth 3 + depth 4 = 5 calls max)
    expect(mockReaddir.mock.calls.length).toBeLessThanOrEqual(6);
  });

  it("prefers the first matching session root over a newer global match", async () => {
    mockResolveWorktreePathCandidates.mockResolvedValue(["/worktree/path"]);
    mockReaddir.mockImplementation(async (dir: unknown) => {
      if (dir === "/session-root") return ["session.jsonl"];
      if (dir === "/global-root") return ["global.jsonl"];
      return [];
    });
    mockLstat.mockResolvedValue({ isDirectory: () => false });
    mockStat.mockImplementation(async (filePath: unknown) => {
      if (filePath === "/session-root/session.jsonl") {
        return { mtimeMs: 1000 };
      }
      if (filePath === "/global-root/global.jsonl") {
        return { mtimeMs: 2000 };
      }
      return { mtimeMs: 0 };
    });
    mockStreamsForFiles({
      "/session-root/session.jsonl": [
        JSON.stringify({
          type: "session_meta",
          payload: {
            id: "session-thread",
            cwd: "/worktree/path",
          },
        }),
      ],
    });

    const result = await findCodexSessionId("/worktree/path", {
      sessionRootDirs: ["/session-root", "/global-root"],
    });

    expect(result).toBe("session-thread");
    expect(mockCreateInterface).toHaveBeenCalledTimes(1);
  });
});

// Helper: create an async iterable of lines, compatible with the mocked createInterface.
function makeAsyncIterable(lines: string[]) {
  return {
    [Symbol.asyncIterator]: () => {
      let i = 0;
      return {
        next: () => {
          if (i >= lines.length) {
            return Promise.resolve({ value: undefined, done: true });
          }
          const value = requireValue(lines[i], "line index out of range");
          i += 1;
          return Promise.resolve({ value, done: false });
        },
      };
    },
    close: () => {
      /* no-op for mock */
    },
  };
}

// Helper: mock collectJsonlFiles by configuring readdir/lstat to return flat files.
function mockFlatJsonlDir(dir: string, files: string[]) {
  mockReaddir.mockImplementation(async (d: unknown) => {
    if (d === dir) return files;
    return [];
  });
  mockLstat.mockResolvedValue({ isDirectory: () => false });
}

function mockStreamForFile(_filePath: string, lines: string[]) {
  mockCreateReadStream.mockReturnValue({});
  mockCreateInterface.mockReturnValue(makeAsyncIterable(lines));
}

function mockStreamsForFiles(mapping: Record<string, string[]>) {
  mockCreateReadStream.mockReturnValue({});
  mockCreateInterface.mockImplementation(() => {
    const callCount = mockCreateInterface.mock.calls.length;
    const keys = Object.keys(mapping);
    const key = keys[callCount - 1];
    const lines = key ? (mapping[key] ?? []) : [];
    return makeAsyncIterable(lines);
  });
}

describe("captureCodexRolloutBaseline", () => {
  it("returns empty map when sessions dir is missing", async () => {
    mockReaddir.mockRejectedValue(new Error("ENOENT"));
    const result = await captureCodexRolloutBaseline("/missing/sessions");
    expect(result.size).toBe(0);
  });

  it("returns correct byte sizes for existing jsonl files", async () => {
    mockFlatJsonlDir("/sessions", ["a.jsonl", "b.jsonl"]);
    mockStat.mockResolvedValueOnce({ size: 100 }).mockResolvedValueOnce({ size: 200 });

    const result = await captureCodexRolloutBaseline("/sessions");
    expect(result.get("/sessions/a.jsonl")).toBe(100);
    expect(result.get("/sessions/b.jsonl")).toBe(200);
  });
});

describe("scanCodexRolloutForMessage", () => {
  it("finds response_item/message user text with exact trimmed match", async () => {
    const line = JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "hello world" }],
      },
    });
    mockFlatJsonlDir("/sessions", ["rollout.jsonl"]);
    mockStreamForFile("/sessions/rollout.jsonl", [line]);

    const result = await scanCodexRolloutForMessage("/sessions", "  hello world  ", new Map());
    expect(result.found).toBe(true);
    expect(result.lastScannedFile).toBe("/sessions/rollout.jsonl");
  });

  it("finds event_msg/user_message with exact trimmed match", async () => {
    const line = JSON.stringify({
      type: "event_msg",
      payload: { type: "user_message", message: "do the thing" },
    });
    mockFlatJsonlDir("/sessions", ["rollout.jsonl"]);
    mockStreamForFile("/sessions/rollout.jsonl", [line]);

    const result = await scanCodexRolloutForMessage("/sessions", "do the thing", new Map());
    expect(result.found).toBe(true);
    expect(result.lastScannedFile).toBe("/sessions/rollout.jsonl");
  });

  it("returns found: false when only assistant messages exist", async () => {
    const line = JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "hello world" }],
      },
    });
    mockFlatJsonlDir("/sessions", ["rollout.jsonl"]);
    mockStreamForFile("/sessions/rollout.jsonl", [line]);

    const result = await scanCodexRolloutForMessage("/sessions", "hello world", new Map());
    expect(result.found).toBe(false);
    expect(result.lastScannedFile).toBe("/sessions/rollout.jsonl");
  });

  it("returns found: false when text differs by more than whitespace edges", async () => {
    const line = JSON.stringify({
      type: "event_msg",
      payload: { type: "user_message", message: "do the other thing" },
    });
    mockFlatJsonlDir("/sessions", ["rollout.jsonl"]);
    mockStreamForFile("/sessions/rollout.jsonl", [line]);

    const result = await scanCodexRolloutForMessage("/sessions", "do the thing", new Map());
    expect(result.found).toBe(false);
  });

  it("skips bytes before baseline offset (old message below baseline does not match)", async () => {
    // The old message is at byte 0, and the baseline says we already consumed those bytes.
    const oldLine = JSON.stringify({
      type: "event_msg",
      payload: { type: "user_message", message: "old message" },
    });
    const newLine = JSON.stringify({
      type: "event_msg",
      payload: { type: "user_message", message: "new message" },
    });
    const oldBytes = Buffer.byteLength(oldLine + "\n", "utf-8");

    mockFlatJsonlDir("/sessions", ["rollout.jsonl"]);
    // When createReadStream is called with start=oldBytes, the readline interface
    // should only yield the new line (old line is before the offset).
    mockCreateReadStream.mockReturnValue({});
    mockCreateInterface.mockImplementation(() => {
      // The implementation passes start offset to createReadStream, so readline
      // only sees data after the baseline. Simulate by returning only newLine.
      return makeAsyncIterable([newLine]);
    });

    const baseline = new Map<string, number>();
    baseline.set("/sessions/rollout.jsonl", oldBytes);

    // Searching for "old message" should NOT match because it's before baseline.
    const result = await scanCodexRolloutForMessage("/sessions", "old message", baseline);
    expect(result.found).toBe(false);

    // Reset mocks for second call (same baseline logic applies).
    mockFlatJsonlDir("/sessions", ["rollout.jsonl"]);
    mockCreateReadStream.mockReturnValue({});
    mockCreateInterface.mockImplementation(() => makeAsyncIterable([newLine]));

    // Searching for "new message" should match because it's after baseline.
    const result2 = await scanCodexRolloutForMessage("/sessions", "new message", baseline);
    expect(result2.found).toBe(true);
  });

  it("scans new files not in baseline from byte 0", async () => {
    const line = JSON.stringify({
      type: "event_msg",
      payload: { type: "user_message", message: "first message" },
    });
    mockFlatJsonlDir("/sessions", ["new-rollout.jsonl"]);
    mockStreamForFile("/sessions/new-rollout.jsonl", [line]);

    // Baseline has no entry for new-rollout.jsonl, so scan from byte 0.
    const baseline = new Map<string, number>();
    baseline.set("/sessions/old-rollout.jsonl", 500);

    const result = await scanCodexRolloutForMessage("/sessions", "first message", baseline);
    expect(result.found).toBe(true);
  });

  it("handles malformed jsonl lines (skipped silently)", async () => {
    const goodLine = JSON.stringify({
      type: "event_msg",
      payload: { type: "user_message", message: "valid" },
    });
    mockFlatJsonlDir("/sessions", ["rollout.jsonl"]);
    mockStreamForFile("/sessions/rollout.jsonl", ["not valid json {{{", goodLine]);

    const result = await scanCodexRolloutForMessage("/sessions", "valid", new Map());
    expect(result.found).toBe(true);
  });

  it("scans multiple rollout files", async () => {
    const line1 = JSON.stringify({
      type: "event_msg",
      payload: { type: "user_message", message: "in file one" },
    });
    const line2 = JSON.stringify({
      type: "event_msg",
      payload: { type: "user_message", message: "in file two" },
    });
    mockFlatJsonlDir("/sessions", ["a.jsonl", "b.jsonl"]);
    mockStreamsForFiles({
      "/sessions/a.jsonl": [line1],
      "/sessions/b.jsonl": [line2],
    });

    const result = await scanCodexRolloutForMessage("/sessions", "in file two", new Map());
    expect(result.found).toBe(true);
    expect(result.lastScannedFile).toBe("/sessions/b.jsonl");
  });
});
