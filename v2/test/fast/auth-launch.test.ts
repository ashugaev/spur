import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  managedAuthLaunch,
  publicAuthSession,
  scrubManagedClaudeHome,
} from "../../src/auth-launch.js";
import { _buildPaneEnvForTests as buildPaneEnv } from "../../src/runtime-tmux.js";
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

  it("shares host Claude user config and user MCP servers without credentials", async () => {
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
    const { claudeConfigDir } = await managedAuthLaunch(registration, directory);
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
    await managedAuthLaunch(registration, directory);
    expect(JSON.parse(readFileSync(join(claudeConfigDir!, ".claude.json"), "utf8"))).toEqual(
      JSON.parse(onboarding),
    );
    rmSync(join(home, ".claude.json"));
    await managedAuthLaunch(registration, directory);
    expect(JSON.parse(readFileSync(join(claudeConfigDir!, ".claude.json"), "utf8"))).toEqual({
      hasCompletedOnboarding: true,
    });
  });

  it("replaces host settings that steer authorization with a sanitized private copy", async () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    const settingsPath = join(home, ".claude", "settings.json");
    writeFileSync(
      settingsPath,
      JSON.stringify({
        apiKeyHelper: "/bin/host-key",
        model: "opus",
        env: {
          ANTHROPIC_BASE_URL: "https://gateway",
          ANTHROPIC_API_KEY: "host-secret",
          ANTHROPIC_AUTH_TOKEN: "host-secret",
          ANTHROPIC_CUSTOM_HEADERS: "x: y",
          CLAUDE_CODE_USE_BEDROCK: "1",
          CLAUDE_CODE_USE_VERTEX: "1",
          ANTHROPIC_MODEL: "opus",
          DISABLE_TELEMETRY: "1",
        },
      }),
    );
    const directory = mkdtempSync(join(tmpdir(), "spur-auth-launch-"));
    directories.push(directory);
    const { claudeConfigDir } = await managedAuthLaunch(registration, directory);
    const managed = join(claudeConfigDir!, "settings.json");
    expect(lstatSync(managed).isSymbolicLink()).toBe(false);
    expect(lstatSync(managed).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(managed, "utf8"))).toEqual({
      model: "opus",
      env: { ANTHROPIC_MODEL: "opus", DISABLE_TELEMETRY: "1" },
    });
    writeFileSync(settingsPath, JSON.stringify({ model: "sonnet" }));
    await managedAuthLaunch(registration, directory);
    expect(lstatSync(managed).isSymbolicLink()).toBe(true);
    expect(readlinkSync(managed)).toBe(settingsPath);
  });

  it("scrubs host copies from a torn-down managed home and restores them on relaunch", async () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(
      join(home, ".claude", "settings.json"),
      JSON.stringify({ apiKeyHelper: "/bin/host-key", model: "opus" }),
    );
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { docs: {} } }));
    const directory = mkdtempSync(join(tmpdir(), "spur-auth-launch-"));
    directories.push(directory);
    const { claudeConfigDir } = await managedAuthLaunch(registration, directory);
    scrubManagedClaudeHome(directory);
    expect(JSON.parse(readFileSync(join(claudeConfigDir!, ".claude.json"), "utf8"))).toEqual({
      hasCompletedOnboarding: true,
    });
    expect(existsSync(join(claudeConfigDir!, "settings.json"))).toBe(false);
    scrubManagedClaudeHome(join(directory, "never-launched"));
    await managedAuthLaunch(registration, directory);
    expect(JSON.parse(readFileSync(join(claudeConfigDir!, ".claude.json"), "utf8"))).toEqual({
      hasCompletedOnboarding: true,
      mcpServers: { docs: {} },
    });
  });

  it("always trusts the session cwd and nothing else, and scrubs it on teardown", async () => {
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({
        oauthAccount: { emailAddress: "host-secret" },
        projects: {
          "/wt": { hasTrustDialogAccepted: true, history: ["host-secret"] },
          "/wt/feature/sub": { hasTrustDialogAccepted: true },
          "/other": { hasTrustDialogAccepted: true },
        },
      }),
    );
    const directory = mkdtempSync(join(tmpdir(), "spur-auth-launch-"));
    directories.push(directory);
    const stateOf = (dir: string) =>
      JSON.parse(readFileSync(join(dir, ".claude.json"), "utf8")) as Record<string, unknown>;

    const { claudeConfigDir } = await managedAuthLaunch(registration, directory, [], "/wt/feature");
    expect(stateOf(claudeConfigDir!)).toEqual({
      hasCompletedOnboarding: true,
      projects: { "/wt/feature": { hasTrustDialogAccepted: true } },
    });
    expect(readFileSync(join(claudeConfigDir!, ".claude.json"), "utf8")).not.toContain(
      "host-secret",
    );

    expect(statSync(join(claudeConfigDir!, ".claude.json")).mode & 0o777).toBe(0o600);

    scrubManagedClaudeHome(directory);
    expect(stateOf(claudeConfigDir!)).toEqual({
      hasCompletedOnboarding: true,
      projects: { "/wt/feature": {} },
    });
    expect(statSync(join(claudeConfigDir!, ".claude.json")).mode & 0o777).toBe(0o600);

    // Relaunch in the same home trusts again.
    await managedAuthLaunch(registration, directory, [], "/wt/feature");
    expect(stateOf(claudeConfigDir!)["projects"]).toEqual({
      "/wt/feature": { hasTrustDialogAccepted: true },
    });
  });

  describe("main repo root trust of a worktree session", () => {
    let root: string;
    let worktree: string;
    let directory: string;
    const stateOf = (dir: string) =>
      JSON.parse(readFileSync(join(dir, ".claude.json"), "utf8")) as Record<string, unknown>;
    const hostProjects = (projects: Record<string, unknown>) =>
      writeFileSync(join(home, ".claude.json"), JSON.stringify({ projects }));

    beforeEach(() => {
      const base = realpathSync(mkdtempSync(join(tmpdir(), "spur-auth-launch-repo-")));
      directories.push(base);
      root = join(base, "repo");
      worktree = join(base, "wt");
      mkdirSync(root);
      const git = (...args: string[]) =>
        execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], {
          cwd: root,
          stdio: "ignore",
        });
      git("init", "-q", "-b", "main");
      git("commit", "-q", "--allow-empty", "-m", "init");
      git("worktree", "add", "-q", "-b", "feature", worktree);
      directory = mkdtempSync(join(tmpdir(), "spur-auth-launch-"));
      directories.push(directory);
    });

    it("seeds the root only when the host already trusts it, and scrubs it on teardown", async () => {
      hostProjects({
        [root]: { hasTrustDialogAccepted: true, allowedTools: ["host-only"] },
        [worktree]: { history: ["host-secret"] },
      });
      const { claudeConfigDir } = await managedAuthLaunch(registration, directory, [], worktree);
      expect(stateOf(claudeConfigDir!)["projects"]).toEqual({
        [worktree]: { hasTrustDialogAccepted: true },
        [root]: { hasTrustDialogAccepted: true },
      });
      scrubManagedClaudeHome(directory);
      expect(stateOf(claudeConfigDir!)["projects"]).toEqual({ [worktree]: {}, [root]: {} });
    });

    it.each([
      ["absent", {}],
      ["false", { hasTrustDialogAccepted: false }],
      ["truthy non-boolean", { hasTrustDialogAccepted: "yes" }],
    ])("never grants root trust the host has %s", async (_label, rootEntry) => {
      hostProjects({ [root]: rootEntry, [worktree]: { hasTrustDialogAccepted: true } });
      const { claudeConfigDir } = await managedAuthLaunch(registration, directory, [], worktree);
      expect(stateOf(claudeConfigDir!)["projects"]).toEqual({
        [worktree]: { hasTrustDialogAccepted: true },
      });
    });
  });

  it("repoints stale links at the current host home", async () => {
    mkdirSync(join(home, ".claude", "skills"), { recursive: true });
    const directory = mkdtempSync(join(tmpdir(), "spur-auth-launch-"));
    directories.push(directory);
    const claudeConfigDir = join(directory, "managed-claude-home");
    mkdirSync(claudeConfigDir, { recursive: true });
    symlinkSync(join(directory, "old-home-skills"), join(claudeConfigDir, "skills"));
    await managedAuthLaunch(registration, directory);
    expect(readlinkSync(join(claudeConfigDir, "skills"))).toBe(join(home, ".claude", "skills"));
  });

  it("isolates Claude home and masks inherited provider credentials", async () => {
    const directory = mkdtempSync(join(tmpdir(), "spur-auth-launch-"));
    directories.push(directory);
    const launch = await managedAuthLaunch(registration, directory);
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

  it("blanks inherited provider selectors and credentials in the final pane env", async () => {
    const inherited = {
      CLAUDE_CODE_USE_BEDROCK: "1",
      CLAUDE_CODE_USE_VERTEX: "1",
      CLAUDE_CODE_SKIP_BEDROCK_AUTH: "1",
      AWS_BEARER_TOKEN_BEDROCK: "bearer",
      ANTHROPIC_FOUNDRY_API_KEY: "foundry",
      ANTHROPIC_MODEL: "kept-model",
      OPENAI_BASE_URL: "http://elsewhere",
      OPENAI_ORG_ID: "org",
      CODEX_API_KEY: "codex",
    };
    for (const [key, value] of Object.entries(inherited)) vi.stubEnv(key, value);
    const directory = mkdtempSync(join(tmpdir(), "spur-auth-launch-"));
    directories.push(directory);

    const claude = buildPaneEnv((await managedAuthLaunch(registration, directory)).env);
    expect(claude).toMatchObject({
      CLAUDE_CODE_USE_BEDROCK: "",
      CLAUDE_CODE_USE_VERTEX: "",
      CLAUDE_CODE_SKIP_BEDROCK_AUTH: "",
      AWS_BEARER_TOKEN_BEDROCK: "",
      ANTHROPIC_FOUNDRY_API_KEY: "",
      ANTHROPIC_MODEL: "kept-model",
      ANTHROPIC_BASE_URL: registration.endpoint,
      ANTHROPIC_AUTH_TOKEN: registration.token,
    });

    const codex = buildPaneEnv(
      (await managedAuthLaunch({ ...registration, provider: "codex" }, directory)).env,
    );
    expect(codex).toMatchObject({
      OPENAI_BASE_URL: "",
      OPENAI_ORG_ID: "",
      CODEX_API_KEY: "",
      SPUR_AUTH_PROXY_TOKEN: registration.token,
    });
  });

  it("uses Codex Responses SSE and keeps routing credentials out of launch commands", async () => {
    const launch = await managedAuthLaunch({ ...registration, provider: "codex" }, "/fixture", [
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
