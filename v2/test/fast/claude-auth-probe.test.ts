import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type ExecResult = { stdout: string; stderr: string };
type ExecFileOptions = {
  cwd?: string | URL;
  env?: NodeJS.ProcessEnv;
  timeout?: number;
};
type ExecFileAsync = (
  file: string,
  args: readonly string[],
  options: ExecFileOptions,
) => Promise<ExecResult>;

const execFileAsyncMock = vi.fn<ExecFileAsync>();
const execFileMock: ((...args: unknown[]) => void) & {
  [promisify.custom]: typeof execFileAsyncMock;
} = Object.assign(vi.fn(), {
  [promisify.custom]: execFileAsyncMock,
});

vi.mock("node:child_process", () => ({ execFile: execFileMock }));

describe("validateClaudeSetupToken", () => {
  const sentinel = "setup-token-probe-sentinel";
  const originalApiKey = process.env["ANTHROPIC_API_KEY"];

  beforeEach(() => {
    execFileAsyncMock.mockReset();
    process.env["ANTHROPIC_API_KEY"] = "higher-priority-key";
  });

  afterEach(() => {
    if (originalApiKey === undefined) delete process.env["ANTHROPIC_API_KEY"];
    else process.env["ANTHROPIC_API_KEY"] = originalApiKey;
    delete process.env["SPUR_CLAUDE_BIN"];
  });

  it("keeps the token in env, omits conflicting auth, and uses fixed probe args", async () => {
    execFileAsyncMock
      .mockResolvedValueOnce({
        stdout: '{"loggedIn":true,"authMethod":"oauth_token","apiProvider":"firstParty"}',
        stderr: "",
      })
      .mockResolvedValueOnce({ stdout: '{"result":"OK","is_error":false}', stderr: "" });
    const { validateClaudeSetupToken } = await import("../../src/agents/claude.js");

    await validateClaudeSetupToken(sentinel, { cwd: "/tmp/worktree", timeoutMs: 1234 });

    expect(execFileAsyncMock).toHaveBeenCalledTimes(2);
    for (const [, args, options] of execFileAsyncMock.mock.calls) {
      expect(args.join(" ")).not.toContain(sentinel);
      expect(options.env?.["CLAUDE_CODE_OAUTH_TOKEN"]).toBe(sentinel);
      expect(options.env).not.toHaveProperty("ANTHROPIC_API_KEY");
      expect(options.timeout).toBe(1234);
    }
    expect(execFileAsyncMock.mock.calls[0]?.[1]).toEqual(["auth", "status", "--json"]);
    expect(execFileAsyncMock.mock.calls[1]?.[1]).toContain("--no-session-persistence");
  });

  it("fails closed on invalid auth status without inference", async () => {
    execFileAsyncMock.mockResolvedValue({
      stdout: '{"loggedIn":true,"authMethod":"api_key","apiProvider":"firstParty"}',
      stderr: "",
    });
    const { validateClaudeSetupToken } = await import("../../src/agents/claude.js");

    await expect(validateClaudeSetupToken(sentinel)).rejects.toThrow(/authentication source/);
    expect(execFileAsyncMock).toHaveBeenCalledTimes(1);
  });

  it("returns a fixed error that cannot echo a subprocess secret", async () => {
    execFileAsyncMock.mockRejectedValue(new Error(`rejected ${sentinel}`));
    const { validateClaudeSetupToken } = await import("../../src/agents/claude.js");

    const error = await validateClaudeSetupToken(sentinel).catch((reason: unknown) => reason);
    expect(String(error)).toBe("Error: Claude setup token was rejected, expired, or rate limited");
    expect(String(error)).not.toContain(sentinel);
  });

  it("reports timeout and removes the disposable probe directory", async () => {
    let probeDir: string | undefined;
    execFileAsyncMock
      .mockResolvedValueOnce({
        stdout: '{"loggedIn":true,"authMethod":"oauth_token","apiProvider":"firstParty"}',
        stderr: "",
      })
      .mockImplementationOnce(async (_file, _args, options) => {
        probeDir = typeof options.cwd === "string" ? options.cwd : undefined;
        throw { code: "ETIMEDOUT", killed: true };
      });
    const { validateClaudeSetupToken } = await import("../../src/agents/claude.js");

    await expect(validateClaudeSetupToken(sentinel)).rejects.toThrow(/timed out/);
    expect(probeDir).toBeDefined();
    expect(existsSync(probeDir ?? "")).toBe(false);
  });
});
