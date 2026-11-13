import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureAccountProjectsLink } from "./claude-accounts.js";
import type { AuthRegistration, AuthSession } from "./auth-proxy.js";

export function publicAuthSession(registration: AuthRegistration): AuthSession {
  const { endpoint: _endpoint, token: _token, ...session } = registration;
  return session;
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
    const onboarding = join(claudeConfigDir, ".claude.json");
    if (!existsSync(onboarding)) {
      writeFileSync(onboarding, `${JSON.stringify({ hasCompletedOnboarding: true })}\n`, {
        mode: 0o600,
      });
    }
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
