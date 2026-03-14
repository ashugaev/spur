/**
 * Configuration loader — reads agent-orchestrator.yaml and validates with Zod.
 *
 * Minimal config that just works:
 *   projects:
 *     my-app:
 *       repo: org/repo
 *       path: ~/my-app
 *
 * Everything else has sensible defaults.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, join, basename } from "node:path";
import { homedir } from "node:os";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { OrchestratorConfig } from "./types.js";
import { generateSessionPrefix } from "./paths.js";

// =============================================================================
// ZOD SCHEMAS
// =============================================================================

const ReactionConfigSchema = z.object({
  auto: z.boolean().default(true),
  action: z.enum(["send-to-agent", "notify", "auto-merge", "restore"]).default("notify"),
  mergeMethod: z.enum(["merge", "squash", "rebase"]).optional(),
  message: z.string().optional(),
  kind: z.enum(["any", "tagged", "reply"]).optional(),
  priority: z.enum(["urgent", "action", "warning", "info"]).optional(),
  retries: z.number().optional(),
  escalateAfter: z.union([z.number(), z.string()]).optional(),
  threshold: z.string().optional(),
  includeSummary: z.boolean().optional(),
});

const TrackerConfigSchema = z
  .object({
    plugin: z.string(),
    statusMapping: z.record(z.string()).optional(),
    ignoreStatuses: z.array(z.string()).optional(),
  })
  .passthrough();

const SCMConfigSchema = z
  .object({
    plugin: z.string(),
    prDraft: z.boolean().default(false),
  })
  .passthrough();

const NotifierConfigSchema = z
  .object({
    plugin: z.string(),
  })
  .passthrough();

const TranscriberConfigSchema = z
  .object({
    plugin: z.string().optional(),
    enabled: z.boolean().optional(),
    binaryPath: z.string().min(1).optional(),
    modelPath: z.string().min(1).optional(),
    ffmpegPath: z.string().min(1).optional(),
    language: z.string().min(1).optional(),
    timeoutMs: z.number().positive().optional(),
    maxAudioBytes: z.number().positive().optional(),
    maxDurationSec: z.number().positive().optional(),
  })
  .passthrough();

const ServicesConfigSchema = z
  .object({
    transcriber: TranscriberConfigSchema.optional(),
  })
  .passthrough();

const ListenerTriggerConfigSchema = z
  .object({
    type: z.string(),
    agent: z.string().optional(),
  })
  .passthrough();

const ListenerConfigBaseSchema = z
  .object({
    source: z.string(),
    projectId: z.string(),
    intervalMs: z.number().positive().optional(),
    mode: z.enum(["spawn", "observe"]).default("spawn"),
    filters: z
      .object({
        state: z.enum(["open", "closed", "all"]).optional(),
        labels: z.array(z.string().min(1)).optional(),
        assignee: z.string().min(1).optional(),
        iteration: z.string().min(1).optional(),
        limit: z.number().positive().optional(),
      })
      .optional(),
    lockStaleMs: z.number().positive().optional(),
    trigger: ListenerTriggerConfigSchema.default({ type: "spawn-session" }),
  })
  .passthrough();

function validateLegacyListenerFields(value: Record<string, unknown>, ctx: z.RefinementCtx): void {
  const legacyFields = ["enabled", "jql", "backlogStatus"] as const;
  for (const field of legacyFields) {
    if (Object.prototype.hasOwnProperty.call(value, field)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          `Listener field "${field}" is no longer supported. ` +
          `Use source: tracker-task with filters.{state,labels,assignee,limit}.`,
      });
    }
  }
}

const ProjectListenerConfigSchema = ListenerConfigBaseSchema.omit({ projectId: true }).superRefine(
  validateLegacyListenerFields,
);

const TriggerSpawnConfigSchema = z.object({
  prompt: z.string().optional(),
  skill: z.string().optional(),
  agent: z.string().optional(),
  branch: z.string().optional(),
});

const TriggerConfigSchema = z
  .object({
    event: z.string(),
    schedule: z.string().optional(),
    filter: z.record(z.unknown()).optional(),
    spawn: TriggerSpawnConfigSchema,
    runOnStart: z.boolean().default(false),
  })
  .superRefine((val, ctx) => {
    if (val.event === "cron:tick" && !val.schedule) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'triggers with event "cron:tick" require a "schedule" field (cron expression)',
        path: ["schedule"],
      });
    }
  });

const AgentSpecificConfigSchema = z
  .object({
    permissions: z.enum(["skip", "default"]).default("skip"),
    model: z.string().optional(),
  })
  .passthrough();

const RemoteConfigSchema = z.object({
  tailscaleHost: z.string().optional(),
});

const ProjectConfigSchema = z.object({
  name: z.string().optional(),
  repo: z.string().default(""),
  path: z.string().default(""),
  defaultBranch: z.string().default("main"),
  sessionPrefix: z
    .string()
    .regex(/^[a-zA-Z0-9_-]+$/, "sessionPrefix must match [a-zA-Z0-9_-]+")
    .optional(),
  runtime: z.string().optional(),
  agent: z.string().optional(),
  workspace: z.string().optional(),
  tracker: TrackerConfigSchema.optional(),
  scm: SCMConfigSchema.optional(),
  symlinks: z.array(z.string()).optional(),
  postCreate: z.array(z.string()).optional(),
  agentConfig: AgentSpecificConfigSchema.default({}),
  reactions: z.record(ReactionConfigSchema.partial()).optional(),
  agentRules: z.string().optional(),
  agentRulesFile: z.string().optional(),
  orchestratorRules: z.string().optional(),
  listeners: z.record(ProjectListenerConfigSchema).optional(),
  triggers: z.record(TriggerConfigSchema).optional(),
});

const DefaultPluginsSchema = z.object({
  runtime: z.string().default("tmux"),
  agent: z.string().default("claude-code"),
  workspace: z.string().default("worktree"),
  notifiers: z.array(z.string()).default(["composio", "desktop"]),
});

const OrchestratorConfigSchema = z.object({
  port: z.number().default(3000),
  terminalPort: z.number().optional(),
  directTerminalPort: z.number().optional(),
  readyThresholdMs: z.number().nonnegative().default(300_000),
  defaults: DefaultPluginsSchema.default({}),
  projects: z.record(ProjectConfigSchema),
  notifiers: z.record(NotifierConfigSchema).default({}),
  notificationRouting: z.record(z.array(z.string())).default({
    urgent: ["desktop", "composio"],
    action: ["desktop", "composio"],
    warning: ["composio"],
    info: ["composio"],
  }),
  reactions: z.record(ReactionConfigSchema).default({}),
  services: ServicesConfigSchema.optional(),
  remote: RemoteConfigSchema.optional(),
});

// =============================================================================
// CONFIG LOADING
// =============================================================================

/** Expand ~ to home directory */
function expandHome(filepath: string): string {
  if (filepath.startsWith("~/")) {
    return join(homedir(), filepath.slice(2));
  }
  return filepath;
}

/** Expand all path fields in the config */
function expandPaths(config: OrchestratorConfig): OrchestratorConfig {
  for (const project of Object.values(config.projects)) {
    if (project.path) project.path = expandHome(project.path);
  }

  return config;
}

/** Apply defaults to project configs */
function applyProjectDefaults(config: OrchestratorConfig): OrchestratorConfig {
  for (const [id, project] of Object.entries(config.projects)) {
    // Derive name from project ID if not set
    if (!project.name) {
      project.name = id;
    }

    // For cron-only projects without a path, use a scratch directory
    if (!project.path) {
      project.path = expandHome(join("~/.agent-orchestrator", "scratch", id));
    }

    // Derive session prefix from project path basename (or config key) if not set
    if (!project.sessionPrefix) {
      const baseName = project.path ? basename(project.path) : id;
      project.sessionPrefix = generateSessionPrefix(baseName);
    }

    // Infer SCM from repo if not set (skip for repo-less/cron-only projects)
    if (!project.scm && project.repo?.includes("/")) {
      project.scm = { plugin: "github" };
    }

    // Infer tracker from repo if not set (skip for repo-less/cron-only projects)
    if (!project.tracker && project.repo) {
      project.tracker = { plugin: "github" };
    }
  }

  return config;
}

/** Validate project uniqueness and session prefix collisions */
function validateProjectUniqueness(config: OrchestratorConfig): void {
  // Check for duplicate project IDs (basenames)
  const projectIds = new Set<string>();
  const projectIdToPaths: Record<string, string[]> = {};

  for (const [configKey, project] of Object.entries(config.projects)) {
    const projectId = project.path ? basename(project.path) : configKey;

    if (!projectIdToPaths[projectId]) {
      projectIdToPaths[projectId] = [];
    }
    projectIdToPaths[projectId].push(project.path ?? configKey);

    if (projectIds.has(projectId)) {
      const paths = projectIdToPaths[projectId].join(", ");
      throw new Error(
        `Duplicate project ID detected: "${projectId}"\n` +
          `Multiple projects have the same directory basename:\n` +
          `  ${paths}\n\n` +
          `To fix this, ensure each project path has a unique directory name.\n` +
          `Alternatively, you can use the config key as a unique identifier.`,
      );
    }
    projectIds.add(projectId);
  }

  // Check for duplicate session prefixes
  const prefixes = new Set<string>();
  const prefixToProject: Record<string, string> = {};

  for (const [configKey, project] of Object.entries(config.projects)) {
    const projectId = project.path ? basename(project.path) : configKey;
    const prefix = project.sessionPrefix || generateSessionPrefix(projectId);

    if (prefixes.has(prefix)) {
      const firstProjectKey = prefixToProject[prefix];
      const firstProject = config.projects[firstProjectKey];
      throw new Error(
        `Duplicate session prefix detected: "${prefix}"\n` +
          `Projects "${firstProjectKey}" and "${configKey}" would generate the same prefix.\n\n` +
          `To fix this, add an explicit sessionPrefix to one of these projects:\n\n` +
          `projects:\n` +
          `  ${firstProjectKey}:\n` +
          `    path: ${firstProject?.path ?? "(no path)"}\n` +
          `    sessionPrefix: ${prefix}1  # Add explicit prefix\n` +
          `  ${configKey}:\n` +
          `    path: ${project.path ?? "(no path)"}\n` +
          `    sessionPrefix: ${prefix}2  # Add explicit prefix\n`,
      );
    }

    prefixes.add(prefix);
    prefixToProject[prefix] = configKey;
  }
}

/** Apply default reactions */
function applyDefaultReactions(config: OrchestratorConfig): OrchestratorConfig {
  const defaults: Record<string, (typeof config.reactions)[string]> = {
    "ci-failed": {
      auto: true,
      action: "send-to-agent",
      message:
        "CI is failing on your PR. Run `gh pr checks` to see the failures, fix them, and push.",
      retries: 2,
      escalateAfter: 2,
    },
    "changes-requested": {
      auto: true,
      action: "send-to-agent",
      message:
        "There are review comments on your PR. Check with `gh pr view --comments` and `gh api` for inline comments. Address each one, push fixes, and reply.",
      escalateAfter: "30m",
    },
    "review-comments": {
      auto: true,
      action: "send-to-agent",
      message:
        "There are unresolved review comments on your PR. Address each one, push fixes, and reply on GitHub.",
      escalateAfter: "30m",
    },
    "bugbot-comments": {
      auto: true,
      action: "send-to-agent",
      message: "Automated review comments found on your PR. Fix the issues flagged by the bot.",
      escalateAfter: "30m",
    },
    "merge-conflicts": {
      auto: true,
      action: "send-to-agent",
      message: "Your branch has merge conflicts. Merge the default branch into your branch and resolve them. Do not rebase. Do not force push.",
      escalateAfter: "15m",
    },
    "tracker-comment": {
      auto: true,
      action: "send-to-agent",
      kind: "reply",
      message: "A new tracker comment arrived. Review it and update your implementation.",
      escalateAfter: "30m",
    },
    "approved-and-green": {
      auto: false,
      action: "notify",
      mergeMethod: "merge",
      priority: "action",
      message: "PR is ready to merge",
    },
    "agent-stuck": {
      auto: true,
      action: "notify",
      priority: "urgent",
      threshold: "10m",
    },
    "agent-needs-input": {
      auto: true,
      action: "notify",
      priority: "urgent",
    },
    "agent-exited": {
      auto: true,
      action: "restore",
      message: "You were auto-restored after an unexpected exit. Check your task status: if the task is complete and PR is open, wait for review. If not complete, continue working on it.",
      retries: 2,
      escalateAfter: 3,
      priority: "urgent",
    },
    "all-complete": {
      auto: true,
      action: "notify",
      priority: "info",
      includeSummary: true,
    },
  };

  // Merge defaults with user-specified reactions field-by-field.
  // This keeps default message/escalation values when users override only
  // a subset of fields (e.g. action/auto) for built-in reaction keys.
  const mergedReactions: Record<string, (typeof config.reactions)[string]> = { ...defaults };
  for (const [reactionKey, reactionConfig] of Object.entries(config.reactions)) {
    const defaultReaction = defaults[reactionKey];
    mergedReactions[reactionKey] = defaultReaction
      ? { ...defaultReaction, ...reactionConfig }
      : reactionConfig;
  }
  config.reactions = mergedReactions;

  return config;
}

/**
 * Search for config file in standard locations.
 *
 * Search order:
 * 1. AO_CONFIG_PATH environment variable (if set)
 * 2. Search up directory tree from CWD (like git)
 * 3. Explicit startDir (if provided)
 * 4. Home directory locations
 */
export function findConfigFile(startDir?: string): string | null {
  // 1. Check environment variable override
  if (process.env["AO_CONFIG_PATH"]) {
    const envPath = resolve(process.env["AO_CONFIG_PATH"]);
    if (existsSync(envPath)) {
      return envPath;
    }
  }

  // 2. Search up directory tree from CWD (like git)
  const searchUpTree = (dir: string): string | null => {
    const configFiles = ["agent-orchestrator.yaml", "agent-orchestrator.yml"];

    for (const filename of configFiles) {
      const configPath = resolve(dir, filename);
      if (existsSync(configPath)) {
        return configPath;
      }
    }

    const parent = resolve(dir, "..");
    if (parent === dir) {
      // Reached root
      return null;
    }

    return searchUpTree(parent);
  };

  const cwd = process.cwd();
  const foundInTree = searchUpTree(cwd);
  if (foundInTree) {
    return foundInTree;
  }

  // 3. Check explicit startDir if provided
  if (startDir) {
    const files = ["agent-orchestrator.yaml", "agent-orchestrator.yml"];
    for (const filename of files) {
      const path = resolve(startDir, filename);
      if (existsSync(path)) {
        return path;
      }
    }
  }

  // 4. Check home directory locations
  const homePaths = [
    resolve(homedir(), ".agent-orchestrator.yaml"),
    resolve(homedir(), ".agent-orchestrator.yml"),
    resolve(homedir(), ".config", "agent-orchestrator", "config.yaml"),
  ];

  for (const path of homePaths) {
    if (existsSync(path)) {
      return path;
    }
  }

  return null;
}

// =============================================================================
// PUBLIC API
// =============================================================================

/** Find config file path (exported for use in hash generation) */
export function findConfig(startDir?: string): string | null {
  return findConfigFile(startDir);
}

/** Load and validate config from a YAML file */
export function loadConfig(configPath?: string): OrchestratorConfig {
  // Priority: 1. Explicit param, 2. Search (including AO_CONFIG_PATH env var)
  // findConfigFile handles AO_CONFIG_PATH validation, so delegate to it
  const path = configPath ?? findConfigFile();

  if (!path) {
    throw new Error("No agent-orchestrator.yaml found. Run `ao init` to create one.");
  }

  const raw = readFileSync(path, "utf-8");
  const parsed = parseYaml(raw);
  const config = validateConfig(parsed);

  // Set the config path in the config object for hash generation
  config.configPath = path;

  return config;
}

/** Load config and return both config and resolved path */
export function loadConfigWithPath(configPath?: string): {
  config: OrchestratorConfig;
  path: string;
} {
  const path = configPath ?? findConfigFile();

  if (!path) {
    throw new Error("No agent-orchestrator.yaml found. Run `ao init` to create one.");
  }

  const raw = readFileSync(path, "utf-8");
  const parsed = parseYaml(raw);
  const config = validateConfig(parsed);

  // Set the config path in the config object for hash generation
  config.configPath = path;

  return { config, path };
}

/** Validate a raw config object */
export function validateConfig(raw: unknown): OrchestratorConfig {
  // Warn about removed config keys (Zod silently strips unknown keys)
  if (raw && typeof raw === "object" && "vibeTunnel" in raw) {
    console.warn(
      "[config] vibeTunnel has been removed. Use `remote: { tailscaleHost: auto }` instead.",
    );
  }

  if (raw && typeof raw === "object" && Object.prototype.hasOwnProperty.call(raw, "listeners")) {
    throw new Error(
      'Top-level "listeners" is no longer supported. Move listeners under ' +
        '"projects.<projectId>.listeners" and remove "projectId" from each listener entry.',
    );
  }

  const validated = OrchestratorConfigSchema.parse(raw);

  let config = validated as OrchestratorConfig;
  config = expandPaths(config);
  config = applyProjectDefaults(config);
  config = applyDefaultReactions(config);

  // Validate project uniqueness and prefix collisions
  validateProjectUniqueness(config);

  return config;
}

/** Get the default config (useful for `ao init`) */
export function getDefaultConfig(): OrchestratorConfig {
  return validateConfig({
    projects: {},
  });
}
