import { readFileSync, writeFileSync } from "node:fs";
import type * as FsPromises from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as CodexModule from "../../src/agents/codex.js";
import { PREFLIGHT_DEFER_SENTINEL } from "../../src/preflight-contract.js";
import type { ProjectConfig } from "../../src/types.js";

const { mockExecFileAsync } = vi.hoisted(() => ({
  mockExecFileAsync: vi.fn(),
}));
const { mockRm } = vi.hoisted(() => ({
  mockRm: vi.fn<typeof FsPromises.rm>(),
}));
const { mockReadFile } = vi.hoisted(() => ({
  mockReadFile: vi.fn<typeof FsPromises.readFile>(),
}));

vi.mock("node:child_process", () => {
  const fn = Object.assign((..._args: unknown[]) => {}, {
    [Symbol.for("nodejs.util.promisify.custom")]: mockExecFileAsync,
  });
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

import { runSpawnPreflight } from "../../src/preflight.js";

const PROJECT: ProjectConfig = {
  path: "/repo/api",
  defaultBranch: "main",
  sessionPrefix: "api",
  worktree: true,
  symlinks: [".env"],
  preflight: {
    prompt: "Suggest a branch from the task and repo rules.",
  },
  sidecars: {},
  sources: {},
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

describe("runSpawnPreflight", () => {
  beforeEach(() => {
    mockExecFileAsync.mockReset();
    mockRm.mockReset();
    mockRm.mockResolvedValue(undefined);
    mockReadFile.mockReset();
    mockReadFile.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
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
        !path.endsWith("auth.json")
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
        "text",
        "--force",
        "--sandbox",
        "disabled",
        "--trust",
        "--workspace",
        PROJECT.path,
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

  it("fails fast when the agent returns prose instead of one branch line", async () => {
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
    ).rejects.toThrow("Spawn preflight must return exactly one branch name");
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

  it("treats empty output as a fallback to Spur default naming", async () => {
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
    ).resolves.toEqual({});
  });

  it("treats an empty codex output file as a fallback to Spur default naming", async () => {
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
    ).resolves.toEqual({});
  });

  it("treats the defer sentinel as an explicit fallback to Spur default naming", async () => {
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
    ).resolves.toEqual({});
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
