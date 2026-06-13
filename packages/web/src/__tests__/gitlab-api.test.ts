// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from "node:child_process";
import { glabHeaders, resetGitLabApiStateForTests, resolveGlabToken } from "@/lib/gitlab-api";

const mockedExecFileSync = vi.mocked(execFileSync);

const ORIG_GITLAB_TOKEN = process.env["GITLAB_TOKEN"];
const ORIG_GLAB_TOKEN = process.env["GLAB_TOKEN"];

describe("gitlab-api", () => {
  beforeEach(() => {
    delete process.env["GITLAB_TOKEN"];
    delete process.env["GLAB_TOKEN"];
    resetGitLabApiStateForTests();
    mockedExecFileSync.mockReset();
  });

  afterEach(() => {
    if (ORIG_GITLAB_TOKEN === undefined) delete process.env["GITLAB_TOKEN"];
    else process.env["GITLAB_TOKEN"] = ORIG_GITLAB_TOKEN;
    if (ORIG_GLAB_TOKEN === undefined) delete process.env["GLAB_TOKEN"];
    else process.env["GLAB_TOKEN"] = ORIG_GLAB_TOKEN;
  });

  it("honors per-hostname cache", () => {
    mockedExecFileSync.mockReturnValueOnce("cached-tok\n" as unknown as Buffer);
    expect(resolveGlabToken("gitlab.example.com")).toBe("cached-tok");
    expect(resolveGlabToken("gitlab.example.com")).toBe("cached-tok");
    expect(mockedExecFileSync).toHaveBeenCalledTimes(1);
  });

  it("returns GITLAB_TOKEN env value when set", () => {
    process.env["GITLAB_TOKEN"] = "env-gitlab";
    expect(resolveGlabToken()).toBe("env-gitlab");
    expect(mockedExecFileSync).not.toHaveBeenCalled();
  });

  it("falls back to `glab config get` for non-cached hosts", () => {
    mockedExecFileSync.mockReturnValueOnce("glab-cli-token\n" as unknown as Buffer);
    expect(resolveGlabToken("gitlab.example.com")).toBe("glab-cli-token");
    expect(mockedExecFileSync).toHaveBeenCalledWith(
      "glab",
      ["config", "get", "--host", "gitlab.example.com", "token"],
      expect.any(Object),
    );
  });

  it("glabHeaders includes private-token when token present", () => {
    process.env["GITLAB_TOKEN"] = "tok-xyz";
    expect(glabHeaders()).toEqual({
      accept: "application/json",
      "private-token": "tok-xyz",
    });
  });

  it("glabHeaders omits private-token when execFileSync throws", () => {
    mockedExecFileSync.mockImplementationOnce(() => {
      throw new Error("no auth");
    });
    expect(glabHeaders()).toEqual({ accept: "application/json" });
  });
});
