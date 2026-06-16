// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from "node:child_process";
import {
  ghHeaders,
  getGitHubRateLimitError,
  handleGitHubRateLimit,
  resetGitHubApiStateForTests,
  resolveGhToken,
} from "@/lib/github-api";

const mockedExecFileSync = vi.mocked(execFileSync);

const ORIG_GITHUB_TOKEN = process.env["GITHUB_TOKEN"];
const ORIG_GH_TOKEN = process.env["GH_TOKEN"];

function makeResponse(status: number, headers: Record<string, string>): Response {
  return new Response(null, { status, headers });
}

describe("github-api", () => {
  beforeEach(() => {
    delete process.env["GITHUB_TOKEN"];
    delete process.env["GH_TOKEN"];
    resetGitHubApiStateForTests();
    mockedExecFileSync.mockReset();
  });

  afterEach(() => {
    if (ORIG_GITHUB_TOKEN === undefined) delete process.env["GITHUB_TOKEN"];
    else process.env["GITHUB_TOKEN"] = ORIG_GITHUB_TOKEN;
    if (ORIG_GH_TOKEN === undefined) delete process.env["GH_TOKEN"];
    else process.env["GH_TOKEN"] = ORIG_GH_TOKEN;
  });

  it("returns GITHUB_TOKEN env value when set", () => {
    process.env["GITHUB_TOKEN"] = "env-github";
    expect(resolveGhToken()).toBe("env-github");
    expect(mockedExecFileSync).not.toHaveBeenCalled();
  });

  it("falls back to GH_TOKEN env when GITHUB_TOKEN absent", () => {
    process.env["GH_TOKEN"] = "env-gh";
    expect(resolveGhToken()).toBe("env-gh");
    expect(mockedExecFileSync).not.toHaveBeenCalled();
  });

  it("shells to `gh auth token` when env vars empty", () => {
    mockedExecFileSync.mockReturnValueOnce("gh-cli-token\n" as unknown as Buffer);
    expect(resolveGhToken()).toBe("gh-cli-token");
    expect(mockedExecFileSync).toHaveBeenCalledWith("gh", ["auth", "token"], expect.any(Object));
  });

  it("returns null when env empty and gh throws", () => {
    mockedExecFileSync.mockImplementationOnce(() => {
      throw new Error("not authenticated");
    });
    expect(resolveGhToken()).toBeNull();
  });

  it("ghHeaders includes Authorization Bearer when token present", () => {
    process.env["GITHUB_TOKEN"] = "tok-abc";
    expect(ghHeaders()).toEqual({
      accept: "application/vnd.github+json",
      authorization: "Bearer tok-abc",
    });
  });

  it("ghHeaders omits Authorization when token absent", () => {
    mockedExecFileSync.mockImplementationOnce(() => {
      throw new Error("no auth");
    });
    expect(ghHeaders()).toEqual({ accept: "application/vnd.github+json" });
  });

  it.each([
    { status: 429, remaining: "10" },
    { status: 403, remaining: "0" },
  ])("handleGitHubRateLimit flips into wait state on $status", ({ status, remaining }) => {
    const reset = Math.floor(Date.now() / 1000) + 30;
    handleGitHubRateLimit(
      makeResponse(status, {
        "x-ratelimit-remaining": remaining,
        "x-ratelimit-reset": String(reset),
      }),
    );
    const now = reset * 1000 - 25_000;
    const error = getGitHubRateLimitError(now);
    expect(error).toMatch(/^GitHub rate limit - retry in \d+s$/);
    expect(getGitHubRateLimitError(reset * 1000 + 1)).toBeNull();
  });
});
