import { writeFileSync } from "node:fs";
import type * as FsPromises from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PREFLIGHT_DEFER_SENTINEL } from "../../src/preflight-contract.js";
import type { ProjectConfig } from "../../src/types.js";

const { mockExecFileAsync } = vi.hoisted(() => ({
  mockExecFileAsync: vi.fn(),
}));
const { mockRm } = vi.hoisted(() => ({
  mockRm: vi.fn<typeof FsPromises.rm>(),
}));

vi.mock("node:child_process", () => {
  const fn = Object.assign((..._args: unknown[]) => {}, {
    [Symbol.for("nodejs.util.promisify.custom")]: mockExecFileAsync,
  });
  return { execFile: fn };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return {
    ...actual,
    rm: mockRm,
  };
});

vi.mock("../../src/agents/claude.js", () => ({
  claudeCommand: () => "/mock/bin/claude",
}));

vi.mock("../../src/agents/codex.js", () => ({
  codexCommand: () => "/mock/bin/codex",
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
        "codex_hooks",
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
    expect((args as string[]).at(-1)).toContain("Fix runtime regression from INT-42");
    expect((args as string[]).at(-1)).toContain(PROJECT_PREFLIGHT_PROMPT);
    expect(options?.env?.["CODEX_HOME"]).toBeUndefined();
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
    mockRm.mockRejectedValueOnce(
      Object.assign(new Error("directory not empty"), { code: "ENOTEMPTY" }),
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
});
