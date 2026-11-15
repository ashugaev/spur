import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "spur-auth-launch-home-"));
    directories.push(home);
    vi.stubEnv("HOME", home);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    for (const directory of directories.splice(0))
      rmSync(directory, { recursive: true, force: true });
  });

  it("shares host Claude user config and user MCP servers without credentials", () => {
    mkdirSync(join(home, ".claude", "skills"), { recursive: true });
    writeFileSync(join(home, ".claude", "CLAUDE.md"), "rules\n");
    writeFileSync(join(home, ".claude", "settings.json"), "{}\n");
    writeFileSync(join(home, ".claude", ".credentials.json"), '{"fixture":"host-secret"}\n');
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: { docs: { command: "docs-mcp" } },
        primaryApiKey: "host-secret",
        oauthAccount: { emailAddress: "host-secret" },
      }),
    );
    const directory = mkdtempSync(join(tmpdir(), "spur-auth-launch-"));
    directories.push(directory);
    const { claudeConfigDir } = managedAuthLaunch(registration, directory);
    for (const name of ["CLAUDE.md", "settings.json", "skills"]) {
      expect(lstatSync(join(claudeConfigDir!, name)).isSymbolicLink()).toBe(true);
      expect(readlinkSync(join(claudeConfigDir!, name))).toBe(join(home, ".claude", name));
    }
    expect(existsSync(join(claudeConfigDir!, "agents"))).toBe(false);
    expect(existsSync(join(claudeConfigDir!, ".credentials.json"))).toBe(false);
    const onboarding = readFileSync(join(claudeConfigDir!, ".claude.json"), "utf8");
    expect(JSON.parse(onboarding)).toEqual({
      hasCompletedOnboarding: true,
      mcpServers: { docs: { command: "docs-mcp" } },
    });
    managedAuthLaunch(registration, directory);
    expect(JSON.parse(readFileSync(join(claudeConfigDir!, ".claude.json"), "utf8"))).toEqual(
      JSON.parse(onboarding),
    );
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
