import { existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ensureAccountProjectsLink } from "./claude-accounts.js";
import type { AuthRegistration, AuthSession } from "./auth-proxy.js";

// Host ~/.claude user configuration shared by managed homes. Never credentials.
const HOST_CLAUDE_ENTRIES = [
  "CLAUDE.md",
  "settings.json",
  "skills",
  "agents",
  "commands",
  "plugins",
  "hooks",
  "output-styles",
] as const;

export function publicAuthSession(registration: AuthRegistration): AuthSession {
  const { endpoint: _endpoint, token: _token, ...session } = registration;
  return session;
}

function readJsonObject(path: string): Record<string, unknown> | undefined {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function linkHostClaudeConfig(claudeConfigDir: string): void {
  const hostHome = join(homedir(), ".claude");
  for (const name of HOST_CLAUDE_ENTRIES) {
    const target = join(hostHome, name);
    const link = join(claudeConfigDir, name);
    if (!existsSync(target)) continue;
    try {
      lstatSync(link);
      continue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    symlinkSync(target, link);
  }
  // User-scope MCP servers live in ~/.claude.json next to host account state; copy only them.
  const onboarding = join(claudeConfigDir, ".claude.json");
  const hostServers = readJsonObject(join(homedir(), ".claude.json"))?.["mcpServers"];
  writeFileSync(
    onboarding,
    `${JSON.stringify({
      ...readJsonObject(onboarding),
      hasCompletedOnboarding: true,
      ...(hostServers !== undefined ? { mcpServers: hostServers } : {}),
    })}\n`,
    { mode: 0o600 },
  );
}

export function managedAuthLaunch(
  registration: AuthRegistration | undefined,
  sessionToolDir: string,
  codexArgs: readonly string[] = [],
): {
  env?: Record<string, string>;
  claudeConfigDir?: string;
  codexArgs?: string[];
} {
  if (!registration) return {};
  if (registration.provider === "claude") {
    const claudeConfigDir = join(sessionToolDir, "managed-claude-home");
    mkdirSync(claudeConfigDir, { recursive: true });
    linkHostClaudeConfig(claudeConfigDir);
    ensureAccountProjectsLink({ configDir: claudeConfigDir });
    return {
      claudeConfigDir,
      env: {
        ANTHROPIC_BASE_URL: registration.endpoint,
        ANTHROPIC_AUTH_TOKEN: registration.token,
        ANTHROPIC_API_KEY: "",
        CLAUDE_CODE_OAUTH_TOKEN: "",
      },
    };
  }
  return {
    env: { SPUR_AUTH_PROXY_TOKEN: registration.token, OPENAI_API_KEY: "", CODEX_API_KEY: "" },
    codexArgs: [
      ...codexArgs,
      "-c",
      'model_provider="spur_managed"',
      "-c",
      'model_providers.spur_managed.name="Spur"',
      "-c",
      `model_providers.spur_managed.base_url=${JSON.stringify(`${registration.endpoint}/v1`)}`,
      "-c",
      'model_providers.spur_managed.env_key="SPUR_AUTH_PROXY_TOKEN"',
      "-c",
      'model_providers.spur_managed.wire_api="responses"',
      "-c",
      "model_providers.spur_managed.requires_openai_auth=false",
      "-c",
      "model_providers.spur_managed.supports_websockets=false",
    ],
  };
}
