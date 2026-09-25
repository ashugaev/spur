import { readFileSync, writeFileSync } from "node:fs";
import type * as FsPromises from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as CodexModule from "../../src/agents/codex.js";
import type * as ModelsModule from "../../src/agents/models.js";
import type * as OpenCodeModule from "../../src/agents/opencode.js";
import { PREFLIGHT_DEFER_SENTINEL } from "../../src/preflight-contract.js";
import type { ProjectConfig } from "../../src/types.js";

const { mockExecFileAsync, mockStdinEnd } = vi.hoisted(() => ({
  mockExecFileAsync: vi.fn(),
  mockStdinEnd: vi.fn(),
}));
const { mockRm } = vi.hoisted(() => ({
  mockRm: vi.fn<typeof FsPromises.rm>(),
}));
const { mockReadFile } = vi.hoisted(() => ({
  mockReadFile: vi.fn<typeof FsPromises.readFile>(),
}));
const { mockExportOpenCodeSession, mockDeleteOpenCodeSession } = vi.hoisted(() => ({
  mockExportOpenCodeSession: vi.fn(),
  mockDeleteOpenCodeSession: vi.fn(),
}));

vi.mock("node:child_process", () => {
  const fn = (
    command: string,
    args: string[],
    options: unknown,
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ) => {
    void mockExecFileAsync(command, args, options).then(
      ({ stdout, stderr }: { stdout: string; stderr: string }) => callback(null, stdout, stderr),
      (error: Error & { stdout?: string; stderr?: string }) =>
        callback(error, error.stdout ?? "", error.stderr ?? ""),
    );
    return { stdin: { end: mockStdinEnd } };
  };
  return { execFile: fn };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  const readFileImpl = (async (
    path: Parameters<typeof FsPromises.readFile>[0],
    options?: Parameters<typeof FsPromises.readFile>[1],
  ) => {
    if (typeof path === "string" && path.endsWith("/.codex/config.toml")) {
      return mockReadFile(path, options);
    }
    return actual.readFile(path, options);
  }) as typeof FsPromises.readFile;
  return {
    ...actual,
    rm: mockRm,
    readFile: readFileImpl,
  };
});

vi.mock("../../src/agents/claude.js", () => ({
  claudeCommand: () => "/mock/bin/claude",
}));

vi.mock("../../src/agents/codex.js", async (importOriginal) => {
  const actual = await importOriginal<typeof CodexModule>();
  return {
    ...actual,
    codexCommand: () => "/mock/bin/codex",
  };
});

vi.mock("../../src/agents/cursor.js", () => ({
  cursorCommand: () => "/mock/bin/cursor-agent",
}));

vi.mock("../../src/agents/models.js", async (importOriginal) => {
  const actual = await importOriginal<typeof ModelsModule>();
  return {
    ...actual,
    resolveCursorLaunchModel: vi.fn(async () => "composer-2.5"),
  };
});

vi.mock("../../src/agents/opencode.js", async (importOriginal) => {
  const actual = await importOriginal<typeof OpenCodeModule>();
  return {
    ...actual,
    opencodeCommand: () => "/mock/bin/opencode",
    exportOpenCodeSession: mockExportOpenCodeSession,
    deleteOpenCodeSession: mockDeleteOpenCodeSession,
  };
});

import {
  PreflightBranchValidationError,
  parseClaudePreflightOutput,
  parseCodexPreflightUsage,
  parseCursorPreflightOutput,
  runSpawnPreflight,
} from "../../src/preflight.js";

const PROJECT: ProjectConfig = {
  path: "/repo/api",
  defaultBranch: "main",
  sessionPrefix: "api",
  worktree: true,
  restoreAfterReboot: false,
  symlinks: [".env"],
  preflight: {
    prompt: "Suggest a branch from the task and repo rules.",
  },
  sidecars: {},
  sources: {},
  backlog: {},
  triggers: {},
};
const PROJECT_PREFLIGHT_PROMPT = PROJECT.preflight?.prompt ?? "";

function getCodexOutputPath(args: string[]): string {
  const outputFlagIndex = args.indexOf("--output-last-message");
  const outputPath = outputFlagIndex === -1 ? undefined : args[outputFlagIndex + 1];
  if (!outputPath) {
    throw new Error("Expected codex preflight to receive --output-last-message <path>");
  }
  return outputPath;
}

describe("structured preflight usage", () => {
  it("counts Claude aggregate once and adds advisor usage once", () => {
    const raw = readFileSync(
      new URL("../fixtures/preflight/claude-result.json", import.meta.url),
      "utf8",
    );
    expect(parseClaudePreflightOutput(raw)).toEqual({
      text: "feature/token-ledger",
      providerIterationCount: 2,
      usage: {
        inputTokens: 155,
        outputTokens: 43,
        totalTokens: 198,
        cacheReadInputTokens: 20,
        cacheWriteInputTokens: 30,
      },
    });
  });

  it("falls back to Claude's flat cache write total when nested TTLs are absent", () => {
    const raw = JSON.stringify({
      result: "feature/cache-fallback",
      usage: {
        input_tokens: 10,
        cache_creation_input_tokens: 7,
        cache_read_input_tokens: 3,
        cache_creation: {},
        output_tokens: 2,
      },
    });
    expect(parseClaudePreflightOutput(raw).usage).toMatchObject({
      inputTokens: 20,
      cacheWriteInputTokens: 7,
      totalTokens: 22,
    });
  });

  it("accepts Claude nested cache writes without a flat duplicate and rejects malformed details", () => {
    const usage = {
      input_tokens: 5,
      cache_read_input_tokens: 2,
      cache_creation: { ephemeral_5m_input_tokens: 3 },
      output_tokens: 1,
    };
    expect(
      parseClaudePreflightOutput(JSON.stringify({ result: "feature/x", usage })).usage,
    ).toMatchObject({
      inputTokens: 10,
      cacheWriteInputTokens: 3,
      totalTokens: 11,
    });
    expect(
      parseClaudePreflightOutput(
        JSON.stringify({ result: "feature/x", usage: { ...usage, cache_creation: "3" } }),
      ).usage,
    ).toBeUndefined();
  });

  it("counts nested Claude advisor iterations and rejects a malformed nested sample", () => {
    const payload = {
      result: "feature/advisor",
      usage: {
        input_tokens: 10,
        cache_creation_input_tokens: 2,
        cache_read_input_tokens: 3,
        output_tokens: 4,
        iterations: [
          {
            type: "advisor_message",
            model: "advisor",
            input_tokens: 5,
            cache_creation_input_tokens: 1,
            cache_read_input_tokens: 1,
            output_tokens: 2,
          },
        ],
      },
    };
    expect(parseClaudePreflightOutput(JSON.stringify(payload))).toMatchObject({
      providerIterationCount: 2,
      usage: {
        inputTokens: 22,
        outputTokens: 6,
        totalTokens: 28,
      },
    });
    const iteration = payload.usage.iterations[0];
    if (!iteration) throw new Error("missing advisor fixture");
    iteration.input_tokens = -1;
    expect(parseClaudePreflightOutput(JSON.stringify(payload)).usage).toBeUndefined();
  });

  it("rejects conflicting Codex aliases instead of choosing the first", () => {
    expect(
      parseCodexPreflightUsage(
        JSON.stringify({ usage: { input: 10, input_tokens: 11, output: 1 } }),
      ),
    ).toBeUndefined();
    expect(
      parseCodexPreflightUsage(
        [
          JSON.stringify({ usage: { input: 10, output: 1, total: 11 } }),
          JSON.stringify({ usage: { input: 12, output: 1, total: 99 } }),
        ].join("\n"),
      ),
    ).toBeUndefined();
  });

  it("reads Codex terminal JSON usage without disabling ephemeral mode", () => {
    const raw = readFileSync(
      new URL("../fixtures/preflight/codex-result.jsonl", import.meta.url),
      "utf8",
    );
    expect(parseCodexPreflightUsage(raw)).toEqual({
      inputTokens: 120,
      outputTokens: 30,
      totalTokens: 150,
      cacheReadInputTokens: 40,
      cacheWriteInputTokens: 10,
      reasoningOutputTokens: 12,
    });
  });

  it("normalizes Cursor fresh and cached input from terminal JSON", () => {
    const raw = readFileSync(
      new URL("../fixtures/preflight/cursor-result.json", import.meta.url),
      "utf8",
    );
    expect(parseCursorPreflightOutput(raw)).toEqual({
      text: "feature/cursor-ledger",
      usage: {
        inputTokens: 90,
        outputTokens: 20,
        totalTokens: 110,
        cacheReadInputTokens: 15,
        cacheWriteInputTokens: 5,
        reasoningOutputTokens: 4,
      },
    });
  });

  it("rejects malformed and overlapping structured token subsets", () => {
    expect(
      parseCodexPreflightUsage(
        JSON.stringify({ usage: { input: 10, cached: 8, cache_write: 3, output: 1 } }),
      ),
    ).toBeUndefined();
    expect(
      parseCursorPreflightOutput(
        JSON.stringify({
          result: "feature/x",
          usage: { inputTokens: "10", outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        }),
      ).usage,
    ).toBeUndefined();
    expect(
      parseCursorPreflightOutput(
        JSON.stringify({
          result: "feature/x",
          usage: {
            inputTokens: 10,
            outputTokens: 1,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            totalTokens: 99,
          },
        }),
      ).usage,
    ).toBeUndefined();
  });
});

describe("runSpawnPreflight", () => {
  beforeEach(() => {
    mockExecFileAsync.mockReset();
    mockStdinEnd.mockReset();
    mockRm.mockReset();
    mockRm.mockResolvedValue(undefined);
    mockReadFile.mockReset();
    mockReadFile.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    mockExportOpenCodeSession.mockReset();
    mockDeleteOpenCodeSession.mockReset();
    mockDeleteOpenCodeSession.mockResolvedValue(undefined);
  });

  afterEach(() => {
    delete process.env.CLAUDECODE;
  });

  it("runs claude in print mode and parses a branch suggestion", async () => {
    mockExecFileAsync.mockResolvedValueOnce({
      stdout: "feature/login-rate-limit\n",
      stderr: "",
    });

    const result = await runSpawnPreflight({
      agent: "claude",
      projectId: "api",
      project: PROJECT,
      baseBranch: "main",
      worktree: true,
      prompt: "Fix login rate limiting for PR #42",
    });

    expect(result).toEqual({ branch: "feature/login-rate-limit" });
    expect(mockExecFileAsync).toHaveBeenCalledTimes(1);
    expect(mockStdinEnd).toHaveBeenCalledTimes(1);
    const [command, args, options] = mockExecFileAsync.mock.calls[0] ?? [];
    expect(command).toBe("/mock/bin/claude");
    expect(args).toEqual(
      expect.arrayContaining([
        "--print",
        "--no-session-persistence",
        "--dangerously-skip-permissions",
      ]),
    );
    expect(args).not.toContain("--permission-mode");
    expect(args).not.toContain("plan");
    expect((args as string[]).at(-1)).toContain("Fix login rate limiting for PR #42");
    expect((args as string[]).at(-1)).toContain(PROJECT_PREFLIGHT_PROMPT);
    expect(options).toEqual(
      expect.objectContaining({
        cwd: PROJECT.path,
        env: expect.objectContaining({ CLAUDECODE: "" }),
        timeout: 60_000,
      }),
    );
  });

  it("passes retry feedback to the preflight prompt", async () => {
    mockExecFileAsync.mockResolvedValueOnce({
      stdout: "feature/login-rate-limit\n",
      stderr: "",
    });

    await runSpawnPreflight({
      agent: "claude",
      projectId: "api",
      project: PROJECT,
      baseBranch: "main",
      worktree: true,
      prompt: "Fix login rate limiting for PR #42",
      feedback: 'preflight branch "bad-name" must match ^feature/[a-z]+(-[a-z]+){0,3}$',
    });

    const [, args] = mockExecFileAsync.mock.calls[0] ?? [];
    expect((args as string[]).at(-1)).toContain("Previous attempt feedback:");
    expect((args as string[]).at(-1)).toContain(
      'preflight branch "bad-name" must match ^feature/[a-z]+(-[a-z]+){0,3}$',
    );
  });

  it("runs codex exec with output-last-message and reads the branch line", async () => {
    mockExecFileAsync.mockImplementationOnce(
      async (
        _command: string,
        args: string[],
        _options?: { env?: Record<string, string | undefined> },
      ) => {
        writeFileSync(getCodexOutputPath(args), "feature/runtime-preflight\n", "utf8");
        return { stdout: "", stderr: "" };
      },
    );

    const result = await runSpawnPreflight({
      agent: "codex",
      projectId: "api",
      project: PROJECT,
      baseBranch: "main",
      worktree: true,
      prompt: "Fix runtime regression from INT-42",
    });

    expect(result).toEqual({ branch: "feature/runtime-preflight" });
    expect(mockExecFileAsync).toHaveBeenCalledTimes(1);
    const [command, args, options] = mockExecFileAsync.mock.calls[0] ?? [];
    expect(command).toBe("/mock/bin/codex");
    expect(args).toEqual(
      expect.arrayContaining([
        "exec",
        "--ephemeral",
        "--disable",
        "hooks",
        "--disable",
        "apps",
        "--disable",
        "plugins",
        "--dangerously-bypass-approvals-and-sandbox",
        "--output-last-message",
      ]),
    );
    expect(args).not.toContain("--permission-mode");
    expect(args).not.toContain("plan");
    expect(args).not.toContain("--dangerously-bypass-hook-trust");
    expect((args as string[]).at(-1)).toContain("Fix runtime regression from INT-42");
    expect((args as string[]).at(-1)).toContain(PROJECT_PREFLIGHT_PROMPT);
    expect(options?.env?.["CODEX_HOME"]).toMatch(/spur-preflight-[^/]+\/codex-home$/);
    expect(options).toEqual(
      expect.objectContaining({
        cwd: PROJECT.path,
        timeout: 60_000,
      }),
    );
  });

  it("appends configured codex args to codex preflight", async () => {
    mockExecFileAsync.mockImplementationOnce(
      async (
        _command: string,
        args: string[],
        _options?: { env?: Record<string, string | undefined> },
      ) => {
        writeFileSync(getCodexOutputPath(args), "feature/runtime-preflight\n", "utf8");
        return { stdout: "", stderr: "" };
      },
    );

    await runSpawnPreflight({
      agent: "codex",
      projectId: "api",
      project: {
        ...PROJECT,
        codexArgs: ["-c", 'model_reasoning_effort="high"', "--enable", "fast_mode"],
      },
      baseBranch: "main",
      worktree: true,
      prompt: "Fix runtime regression from INT-42",
    });

    const [, args] = mockExecFileAsync.mock.calls[0] ?? [];
    expect(args).toEqual(
      expect.arrayContaining(["-c", 'model_reasoning_effort="high"', "--enable", "fast_mode"]),
    );
  });

  it("writes ephemeral codex config with trusted project for cwd", async () => {
    let observedConfig: string | null = null;
    mockExecFileAsync.mockImplementationOnce(
      async (
        _command: string,
        args: string[],
        options?: { env?: Record<string, string | undefined> },
      ) => {
        const codexHome = options?.env?.["CODEX_HOME"];
        if (codexHome) {
          observedConfig = readFileSync(`${codexHome}/config.toml`, "utf8");
        }
        writeFileSync(getCodexOutputPath(args), "feature/runtime-preflight\n", "utf8");
        return { stdout: "", stderr: "" };
      },
    );

    await runSpawnPreflight({
      agent: "codex",
      projectId: "api",
      project: PROJECT,
      baseBranch: "main",
      worktree: true,
      prompt: "Fix runtime regression from INT-42",
    });

    expect(observedConfig).not.toBeNull();
    expect(observedConfig).toContain('[projects."/repo/api"]');
    expect(observedConfig).toContain('trust_level = "trusted"');
  });

  it("keeps a successful codex preflight result when temp cleanup races", async () => {
    mockExecFileAsync.mockImplementationOnce(
      async (
        _command: string,
        args: string[],
        _options?: { env?: Record<string, string | undefined> },
      ) => {
        writeFileSync(getCodexOutputPath(args), "feature/runtime-preflight\n", "utf8");
        return { stdout: "", stderr: "" };
      },
    );
    mockRm.mockImplementation(async (path: Parameters<typeof FsPromises.rm>[0]) => {
      if (
        typeof path === "string" &&
        path.includes("spur-preflight-") &&
        !path.includes("/codex-home/")
      ) {
        throw Object.assign(new Error("directory not empty"), { code: "ENOTEMPTY" });
      }
      return undefined;
    });

    await expect(
      runSpawnPreflight({
        agent: "codex",
        projectId: "api",
        project: PROJECT,
        baseBranch: "main",
        worktree: true,
        prompt: "Fix runtime regression from INT-42",
      }),
    ).resolves.toEqual({ branch: "feature/runtime-preflight" });
    expect(mockRm).toHaveBeenCalledWith(
      expect.stringContaining("spur-preflight-"),
      expect.objectContaining({
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      }),
    );
  });

  it("runs cursor in print mode with trust and workspace flags", async () => {
    mockExecFileAsync.mockResolvedValueOnce({
      stdout: "feature/cursor-preflight\n",
      stderr: "",
    });

    const result = await runSpawnPreflight({
      agent: "cursor",
      projectId: "api",
      project: PROJECT,
      baseBranch: "main",
      worktree: true,
      prompt: "Fix Cursor runtime integration",
    });

    expect(result).toEqual({ branch: "feature/cursor-preflight" });
    expect(mockExecFileAsync).toHaveBeenCalledTimes(1);
    const [command, args, options] = mockExecFileAsync.mock.calls[0] ?? [];
    expect(command).toBe("/mock/bin/cursor-agent");
    expect(args).toEqual(
      expect.arrayContaining([
        "-p",
        "--output-format",
        "json",
        "--force",
        "--sandbox",
        "disabled",
        "--trust",
        "--workspace",
        PROJECT.path,
        "--model",
        "composer-2.5",
      ]),
    );
    expect((args as string[]).at(-1)).toContain("Fix Cursor runtime integration");
    expect((args as string[]).at(-1)).toContain(PROJECT_PREFLIGHT_PROMPT);
    expect(options).toEqual(
      expect.objectContaining({
        cwd: PROJECT.path,
        env: expect.objectContaining({
          CURSOR_CONFIG_DIR: expect.stringContaining("spur-preflight-cursor-"),
        }),
        timeout: 60_000,
      }),
    );
    expect(mockRm).toHaveBeenCalledWith(
      expect.stringContaining("spur-preflight-cursor-"),
      expect.objectContaining({
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      }),
    );
  });

  it("rejects prose instead of one branch line", async () => {
    mockExecFileAsync.mockResolvedValueOnce({
      stdout: "branch one branch two\n",
      stderr: "",
    });

    await expect(
      runSpawnPreflight({
        agent: "claude",
        projectId: "api",
        project: PROJECT,
        baseBranch: "main",
        worktree: true,
        prompt: "Fix login rate limiting for PR #42",
      }),
    ).rejects.toThrow("Spawn preflight must return exactly one branch name or NO_PROJECT_RULES");
  });

  it("rejects multi-line prose around a branch", async () => {
    mockExecFileAsync.mockResolvedValueOnce({
      stdout:
        "Sure, based on the task and repo rules the branch should be:\nfeature/login-rate-limit\n",
      stderr: "",
    });

    await expect(
      runSpawnPreflight({
        agent: "claude",
        projectId: "api",
        project: PROJECT,
        baseBranch: "main",
        worktree: true,
        prompt: "Fix login rate limiting for PR #42",
      }),
    ).rejects.toThrow("Spawn preflight must return exactly one branch name or NO_PROJECT_RULES");
  });

  it("rejects prose after a branch", async () => {
    mockExecFileAsync.mockResolvedValueOnce({
      stdout: "feature/login-rate-limit\nLet me know if you want a different name.\n",
      stderr: "",
    });

    await expect(
      runSpawnPreflight({
        agent: "claude",
        projectId: "api",
        project: PROJECT,
        baseBranch: "main",
        worktree: true,
        prompt: "Fix login rate limiting for PR #42",
      }),
    ).rejects.toThrow("Spawn preflight must return exactly one branch name or NO_PROJECT_RULES");
  });

  it("rejects sentinel wrapped in prose", async () => {
    mockExecFileAsync.mockResolvedValueOnce({
      stdout: "The project has no branch-naming rules\nNO_PROJECT_RULES\n",
      stderr: "",
    });

    await expect(
      runSpawnPreflight({
        agent: "claude",
        projectId: "api",
        project: PROJECT,
        baseBranch: "main",
        worktree: true,
        prompt: "Fix login rate limiting for PR #42",
      }),
    ).rejects.toThrow("Spawn preflight must return exactly one branch name or NO_PROJECT_RULES");
  });

  it("rejects a preflight branch that misses project branch naming", async () => {
    mockExecFileAsync.mockResolvedValueOnce({
      stdout: "bad-name\n",
      stderr: "",
    });

    await expect(
      runSpawnPreflight({
        agent: "claude",
        projectId: "api",
        project: {
          ...PROJECT,
          branchNaming: { regex: "^feature/[a-z]+(-[a-z]+){0,3}$" },
        },
        baseBranch: "main",
        worktree: true,
        prompt: "Fix login rate limiting for PR #42",
      }),
    ).rejects.toThrow('preflight branch "bad-name" must match ^feature/[a-z]+(-[a-z]+){0,3}$');
  });

  it("rejects with PreflightBranchValidationError carrying the proposed branch", async () => {
    mockExecFileAsync.mockResolvedValueOnce({
      stdout: "bad-name\n",
      stderr: "",
    });

    const error = await runSpawnPreflight({
      agent: "claude",
      projectId: "api",
      project: {
        ...PROJECT,
        branchNaming: { regex: "^feature/[a-z]+(-[a-z]+){0,3}$" },
      },
      baseBranch: "main",
      worktree: true,
      prompt: "Fix login rate limiting for PR #42",
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PreflightBranchValidationError);
    expect((error as PreflightBranchValidationError).branch).toBe("bad-name");
  });

  it("rejects empty output", async () => {
    mockExecFileAsync.mockResolvedValueOnce({
      stdout: "\n",
      stderr: "",
    });

    await expect(
      runSpawnPreflight({
        agent: "claude",
        projectId: "api",
        project: PROJECT,
        baseBranch: "main",
        worktree: true,
        prompt: "Fix login rate limiting for PR #42",
      }),
    ).rejects.toThrow("Spawn preflight must return exactly one branch name or NO_PROJECT_RULES");
  });

  it("rejects an empty codex output file", async () => {
    mockExecFileAsync.mockImplementationOnce(async (_command: string, args: string[]) => {
      writeFileSync(getCodexOutputPath(args), "", "utf8");
      return { stdout: "", stderr: "" };
    });

    await expect(
      runSpawnPreflight({
        agent: "codex",
        projectId: "api",
        project: PROJECT,
        baseBranch: "main",
        worktree: true,
        prompt: "Fix runtime regression from INT-42",
      }),
    ).rejects.toThrow("Spawn preflight must return exactly one branch name or NO_PROJECT_RULES");
  });

  it("accepts the exact no-project-rules sentinel", async () => {
    mockExecFileAsync.mockResolvedValueOnce({
      stdout: `${PREFLIGHT_DEFER_SENTINEL}\n`,
      stderr: "",
    });

    await expect(
      runSpawnPreflight({
        agent: "claude",
        projectId: "api",
        project: PROJECT,
        baseBranch: "main",
        worktree: true,
        prompt: "Fix login rate limiting for PR #42",
      }),
    ).resolves.toEqual({ noProjectBranchRequirements: true });
  });

  it.each([
    '{"branch":"feature/login","noProjectBranchRequirements":true}',
    '{"branch":"feature/login","branch":"feature/other"}',
    '{"noProjectBranchRequirements":false}',
    '{"branch":null}',
    '{"branch":""}',
    "[]",
  ])("rejects a non-line result: %s", async (stdout) => {
    mockExecFileAsync.mockResolvedValueOnce({ stdout, stderr: "" });

    await expect(
      runSpawnPreflight({
        agent: "claude",
        projectId: "api",
        project: PROJECT,
        baseBranch: "main",
        worktree: true,
        prompt: "Fix login rate limiting for PR #42",
      }),
    ).rejects.toThrow("Spawn preflight must return exactly one branch name or NO_PROJECT_RULES");
  });

  it("surfaces cursor exit code and stderr on a non-zero exit", async () => {
    mockExecFileAsync.mockRejectedValueOnce(
      Object.assign(new Error("Command failed"), {
        code: 1,
        stderr: "cursor-agent: update in progress\n",
        stdout: "",
      }),
    );

    await expect(
      runSpawnPreflight({
        agent: "cursor",
        projectId: "api",
        project: PROJECT,
        baseBranch: "main",
        worktree: true,
        prompt: "Fix Cursor runtime integration",
      }),
    ).rejects.toThrow(/cursor preflight failed \(exit code 1\): cursor-agent: update in progress/);
  });

  it("uses the exact OpenCode run session for export accounting and cleanup", async () => {
    const exported = JSON.parse(
      readFileSync(
        new URL("../fixtures/agent-history/opencode/token-components.json", import.meta.url),
        "utf8",
      ),
    ) as unknown;
    mockExecFileAsync.mockResolvedValueOnce({
      stdout: [
        JSON.stringify({ sessionID: "session-sanitized", part: { type: "step_start" } }),
        JSON.stringify({
          sessionID: "session-sanitized",
          part: { type: "text", text: "feature/opencode-ledger" },
        }),
      ].join("\n"),
      stderr: "",
    });
    mockExportOpenCodeSession.mockResolvedValueOnce(exported);

    const result = await runSpawnPreflight({
      agent: "opencode",
      projectId: "api",
      project: PROJECT,
      baseBranch: "main",
      worktree: true,
      prompt: "Account for preflight tokens",
    });

    expect(result).toEqual({
      branch: "feature/opencode-ledger",
      usage: {
        inputTokens: 50,
        outputTokens: 29,
        totalTokens: 79,
        cacheReadInputTokens: 34,
        cacheWriteInputTokens: 4,
        reasoningOutputTokens: 6,
      },
    });
    expect(mockExportOpenCodeSession).toHaveBeenCalledWith("session-sanitized");
    expect(mockDeleteOpenCodeSession).toHaveBeenCalledWith("session-sanitized");
  });

  it("exports partial OpenCode usage after a failed run and retries export and cleanup", async () => {
    const exported = JSON.parse(
      readFileSync(
        new URL("../fixtures/agent-history/opencode/token-components.json", import.meta.url),
        "utf8",
      ),
    ) as unknown;
    mockExecFileAsync.mockRejectedValueOnce(
      Object.assign(new Error("failed"), {
        code: 1,
        stdout: JSON.stringify({ sessionID: "partial-session", part: { type: "step_start" } }),
        stderr: "failed",
      }),
    );
    mockExportOpenCodeSession.mockRejectedValueOnce(new Error("export busy"));
    mockExportOpenCodeSession.mockResolvedValueOnce(exported);
    mockDeleteOpenCodeSession.mockRejectedValueOnce(new Error("delete busy"));
    await expect(
      runSpawnPreflight({
        agent: "opencode",
        projectId: "api",
        project: PROJECT,
        baseBranch: "main",
        worktree: true,
        prompt: "Account for partial preflight tokens",
      }),
    ).rejects.toMatchObject({ usage: { totalTokens: 79 } });
    expect(mockExportOpenCodeSession).toHaveBeenCalledTimes(2);
    expect(mockDeleteOpenCodeSession).toHaveBeenCalledTimes(2);
    expect(mockExecFileAsync).toHaveBeenCalledTimes(1);
  });

  it("retains measured OpenCode usage when cleanup fails after retries", async () => {
    const exported = JSON.parse(
      readFileSync(
        new URL("../fixtures/agent-history/opencode/token-components.json", import.meta.url),
        "utf8",
      ),
    ) as unknown;
    mockExecFileAsync.mockResolvedValueOnce({
      stdout: [
        JSON.stringify({ sessionID: "cleanup-session", part: { type: "step_start" } }),
        JSON.stringify({ sessionID: "cleanup-session", part: { type: "text", text: "feature/x" } }),
      ].join("\n"),
      stderr: "",
    });
    mockExportOpenCodeSession.mockResolvedValueOnce(exported);
    mockDeleteOpenCodeSession.mockRejectedValue(new Error("delete failed"));
    await expect(
      runSpawnPreflight({
        agent: "opencode",
        projectId: "api",
        project: PROJECT,
        baseBranch: "main",
        worktree: true,
        prompt: "Account for cleanup failure",
      }),
    ).rejects.toMatchObject({ usage: { totalTokens: 79 } });
    expect(mockDeleteOpenCodeSession).toHaveBeenCalledTimes(3);
    expect(mockExecFileAsync).toHaveBeenCalledTimes(1);
  });

  it("surfaces a missing claude binary as command not found", async () => {
    mockExecFileAsync.mockRejectedValueOnce(
      Object.assign(new Error("spawn claude ENOENT"), {
        code: "ENOENT",
        stderr: "",
        stdout: "",
      }),
    );

    await expect(
      runSpawnPreflight({
        agent: "claude",
        projectId: "api",
        project: PROJECT,
        baseBranch: "main",
        worktree: true,
        prompt: "Fix login rate limiting for PR #42",
      }),
    ).rejects.toThrow(/claude preflight failed \(command not found: .*\): no output/);
  });

  it("normalizes a codex Buffer stderr into the failure message", async () => {
    mockExecFileAsync.mockRejectedValueOnce(
      Object.assign(new Error("Command failed"), {
        code: 2,
        stderr: Buffer.from("codex auth error\n"),
        stdout: "",
      }),
    );

    await expect(
      runSpawnPreflight({
        agent: "codex",
        projectId: "api",
        project: PROJECT,
        baseBranch: "main",
        worktree: true,
        prompt: "Fix runtime regression from INT-42",
      }),
    ).rejects.toThrow(/codex preflight failed \(exit code 2\): codex auth error/);
  });

  it("surfaces a cursor timeout as a timed-out failure", async () => {
    mockExecFileAsync.mockRejectedValueOnce(
      Object.assign(new Error("Command failed"), {
        killed: true,
        signal: "SIGTERM",
        code: null,
        stderr: "",
        stdout: "",
      }),
    );

    await expect(
      runSpawnPreflight({
        agent: "cursor",
        projectId: "api",
        project: PROJECT,
        baseBranch: "main",
        worktree: true,
        prompt: "Fix Cursor runtime integration",
      }),
    ).rejects.toThrow(/cursor preflight failed \(timed out after 60s\): no output/);
  });
});
