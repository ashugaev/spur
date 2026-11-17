import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ensureAccountProjectsLink } from "./claude-accounts.js";
import type { AuthRegistration, AuthSession } from "./auth-proxy.js";

const MANAGED_CLAUDE_HOME = "managed-claude-home";

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

function lstatOrUndefined(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

// Settings that would replace the proxy endpoint or credentials of a managed session.
function steersAuthorization(key: string): boolean {
  return (
    (key.startsWith("ANTHROPIC_") && !key.endsWith("_MODEL")) ||
    key.startsWith("CLAUDE_CODE_USE_") ||
    /^CLAUDE_CODE_SKIP_[A-Z]+_AUTH$/.test(key) ||
    key === "CLAUDE_CODE_OAUTH_TOKEN" ||
    key === "AWS_BEARER_TOKEN_BEDROCK"
  );
}
const AUTH_SETTINGS = ["apiKeyHelper", "awsAuthRefresh", "awsCredentialExport"];

/** Host settings without authorization overrides, or undefined when none are present. */
function sanitizedHostSettings(path: string): Record<string, unknown> | undefined {
  const settings = readJsonObject(path);
  if (!settings) return undefined;
  const env = settings["env"];
  const envObject =
    typeof env === "object" && env !== null && !Array.isArray(env)
      ? (env as Record<string, unknown>)
      : undefined;
  const steeredEnv = Object.keys(envObject ?? {}).filter(steersAuthorization);
  const steeredKeys = AUTH_SETTINGS.filter((key) => key in settings);
  if (steeredEnv.length === 0 && steeredKeys.length === 0) return undefined;
  const sanitized = Object.fromEntries(
    Object.entries(settings).filter(([key]) => !steeredKeys.includes(key)),
  );
  if (envObject) {
    sanitized["env"] = Object.fromEntries(
      Object.entries(envObject).filter(([key]) => !steeredEnv.includes(key)),
    );
  }
  return sanitized;
}

/** Folders a managed session runs in: its cwd and the project repo it was cut from. */
export interface TrustFolders {
  cwd: string;
  repoPath: string;
}

// Host trust applies to the cwd, any parent folder, or the repo a worktree belongs to.
function hostTrustsFolders(folders: TrustFolders): boolean {
  const projects = readJsonObject(join(homedir(), ".claude.json"))?.["projects"];
  if (typeof projects !== "object" || projects === null) return false;
  const trusted = (dir: string): boolean =>
    (projects as Record<string, { hasTrustDialogAccepted?: unknown } | null>)[dir]
      ?.hasTrustDialogAccepted === true;
  for (let dir = folders.cwd; ; dir = dirname(dir)) {
    if (trusted(dir)) return true;
    if (dirname(dir) === dir) break;
  }
  return trusted(folders.repoPath);
}

function linkHostClaudeConfig(claudeConfigDir: string, trust?: TrustFolders): void {
  const hostHome = join(homedir(), ".claude");
  for (const name of HOST_CLAUDE_ENTRIES) {
    const target = join(hostHome, name);
    const link = join(claudeConfigDir, name);
    const existing = lstatOrUndefined(link);
    const sanitized = name === "settings.json" ? sanitizedHostSettings(target) : undefined;
    if (sanitized) {
      if (existing) unlinkSync(link);
      writeFileSync(link, `${JSON.stringify(sanitized, null, 2)}\n`, { mode: 0o600 });
      continue;
    }
    if (existing?.isSymbolicLink() && readlinkSync(link) === target && existsSync(target)) continue;
    // Replace only links and the sanitized settings copy; never a directory the agent created.
    if (existing && (existing.isSymbolicLink() || name === "settings.json")) unlinkSync(link);
    else if (existing) continue;
    if (existsSync(target)) symlinkSync(target, link);
  }
  // User-scope MCP servers live in ~/.claude.json next to host account state; copy only them.
  const onboarding = join(claudeConfigDir, ".claude.json");
  const hostServers = readJsonObject(join(homedir(), ".claude.json"))?.["mcpServers"];
  const { mcpServers: _staleServers, ...managedState } = readJsonObject(onboarding) ?? {};
  // Claude keeps trust per folder in ~/.claude.json; carry the host decision for this session only.
  const projects = managedState["projects"];
  const trustedProjects =
    trust && hostTrustsFolders(trust)
      ? {
          ...(typeof projects === "object" && projects !== null && !Array.isArray(projects)
            ? projects
            : {}),
          [trust.cwd]: {
            ...(projects as Record<string, object> | undefined)?.[trust.cwd],
            hasTrustDialogAccepted: true,
          },
        }
      : projects;
  writeFileSync(
    onboarding,
    `${JSON.stringify({
      ...managedState,
      ...(trustedProjects !== undefined ? { projects: trustedProjects } : {}),
      hasCompletedOnboarding: true,
      ...(hostServers !== undefined ? { mcpServers: hostServers } : {}),
    })}\n`,
    { mode: 0o600 },
  );
}

/** Drops host copies (user MCP servers, sanitized settings) once a managed session is torn down. */
export function scrubManagedClaudeHome(sessionToolDir: string): void {
  const claudeConfigDir = join(sessionToolDir, MANAGED_CLAUDE_HOME);
  const onboarding = join(claudeConfigDir, ".claude.json");
  const state = readJsonObject(onboarding);
  if (state) {
    const { mcpServers: _servers, projects, ...rest } = state;
    const kept =
      typeof projects === "object" && projects !== null && !Array.isArray(projects)
        ? Object.fromEntries(
            Object.entries(projects).map(([dir, entry]) => {
              if (typeof entry !== "object" || entry === null) return [dir, entry];
              const { hasTrustDialogAccepted: _trust, ...project } = entry as Record<
                string,
                unknown
              >;
              return [dir, project];
            }),
          )
        : projects;
    if ("mcpServers" in state || projects !== undefined) {
      writeFileSync(
        onboarding,
        `${JSON.stringify({ ...rest, ...(kept !== undefined ? { projects: kept } : {}) })}\n`,
        { mode: 0o600 },
      );
    }
  }
  const settings = join(claudeConfigDir, "settings.json");
  if (lstatOrUndefined(settings)?.isFile()) unlinkSync(settings);
}

export function managedAuthLaunch(
  registration: AuthRegistration | undefined,
  sessionToolDir: string,
  codexArgs: readonly string[] = [],
  trust?: TrustFolders,
): {
  env?: Record<string, string>;
  claudeConfigDir?: string;
  codexArgs?: string[];
} {
  if (!registration) return {};
  if (registration.provider === "claude") {
    const claudeConfigDir = join(sessionToolDir, MANAGED_CLAUDE_HOME);
    mkdirSync(claudeConfigDir, { recursive: true });
    linkHostClaudeConfig(claudeConfigDir, trust);
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
