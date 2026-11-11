import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { managedAuthLaunch, publicAuthSession } from "../../src/auth-launch.js";
import { buildCodexPlan } from "../../src/agents/codex.js";
import type { AuthRegistration } from "../../src/auth-proxy.js";

vi.mock("../../src/claude-accounts.js", () => ({
  ensureAccountProjectsLink: vi.fn(),
  sessionClaudeHome: (directory: string) => join(directory, "claude-home"),
}));

describe("managed native authorization launch", () => {
  const directories: string[] = [];
  const registration: AuthRegistration = {
    sessionId: "test-1",
    provider: "claude",
    mode: "pinned",
    accountId: "work",
    effectiveAccountId: "work",
    generation: 1,
    endpoint: "http://127.0.0.1:45678",
    token: "private-routing-token",
  };

  afterEach(() => {
    for (const directory of directories.splice(0))
      rmSync(directory, { recursive: true, force: true });
  });

  it("isolates Claude home and masks inherited provider credentials", () => {
    const directory = mkdtempSync(join(tmpdir(), "spur-auth-launch-"));
    directories.push(directory);
    const launch = managedAuthLaunch(registration, directory);
    expect(launch.env).toEqual({
      ANTHROPIC_BASE_URL: registration.endpoint,
      ANTHROPIC_AUTH_TOKEN: registration.token,
      ANTHROPIC_API_KEY: "",
      CLAUDE_CODE_OAUTH_TOKEN: "",
    });
    expect(existsSync(join(launch.claudeConfigDir!, ".credentials.json"))).toBe(false);
    expect(readFileSync(join(launch.claudeConfigDir!, ".claude.json"), "utf8")).not.toContain(
      registration.token,
    );
    expect(publicAuthSession(registration)).not.toHaveProperty("token");
    expect(publicAuthSession(registration)).not.toHaveProperty("endpoint");
  });

  it("uses Codex Responses SSE and keeps routing credentials out of launch commands", () => {
    const launch = managedAuthLaunch({ ...registration, provider: "codex" }, "/fixture", [
      "--no-alt-screen",
    ]);
    const plan = buildCodexPlan("task", {
      ...(launch.codexArgs !== undefined ? { codexArgs: launch.codexArgs } : {}),
    });
    expect(plan.launchCommand).toContain("supports_websockets=false");
    expect(plan.launchCommand).toContain("requires_openai_auth=false");
    expect(plan.launchCommand).toContain("--no-alt-screen");
    expect(plan.launchCommand).not.toContain(registration.token);
    expect(launch.env).toEqual({
      SPUR_AUTH_PROXY_TOKEN: registration.token,
      OPENAI_API_KEY: "",
      CODEX_API_KEY: "",
    });
  });
});
