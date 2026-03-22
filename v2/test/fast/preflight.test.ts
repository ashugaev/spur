import { writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectConfig } from "../../src/types.js";

const { mockExecFileAsync } = vi.hoisted(() => ({
  mockExecFileAsync: vi.fn(),
}));

vi.mock("node:child_process", () => {
  const fn = Object.assign((..._args: unknown[]) => {}, {
    [Symbol.for("nodejs.util.promisify.custom")]: mockExecFileAsync,
  });
  return { execFile: fn };
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
  sources: {},
  triggers: {},
};
const PROJECT_PREFLIGHT_PROMPT = PROJECT.preflight?.prompt ?? "";

describe("runSpawnPreflight", () => {
  beforeEach(() => {
    mockExecFileAsync.mockReset();
  });

  afterEach(() => {
    delete process.env.CLAUDECODE;
  });

  it("runs claude in print mode and parses a branch suggestion", async () => {
    mockExecFileAsync.mockResolvedValueOnce({
      stdout: '{"type":"result","structured_output":{"branch":"feature/login-rate-limit"}}\n',
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
        "--output-format",
        "json",
        "--json-schema",
        "--no-session-persistence",
        "--dangerously-skip-permissions",
      ]),
    );
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

  it("runs codex exec with a schema file and reads the structured output file", async () => {
    mockExecFileAsync.mockImplementationOnce(async (_command: string, args: string[]) => {
      const outputIndex = args.indexOf("--output-last-message");
      const outputPath = args[outputIndex + 1];
      if (!outputPath) {
        throw new Error("Expected codex preflight to receive --output-last-message <path>");
      }
      writeFileSync(outputPath, '{"branch":"feature/runtime-preflight"}\n', "utf8");
      return { stdout: "", stderr: "" };
    });

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
        "--dangerously-bypass-approvals-and-sandbox",
        "--output-schema",
        "--output-last-message",
      ]),
    );
    expect((args as string[]).at(-1)).toContain("Fix runtime regression from INT-42");
    expect((args as string[]).at(-1)).toContain(PROJECT_PREFLIGHT_PROMPT);
    expect(options).toEqual(
      expect.objectContaining({
        cwd: PROJECT.path,
        timeout: 60_000,
      }),
    );
  });

  it("fails fast when the agent returns invalid JSON", async () => {
    mockExecFileAsync.mockResolvedValueOnce({
      stdout: "not-json\n",
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
    ).rejects.toThrow("Spawn preflight returned invalid JSON");
  });

  it("treats a null branch as an explicit defer to Spur default naming", async () => {
    mockExecFileAsync.mockResolvedValueOnce({
      stdout: '{"branch":null}\n',
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
