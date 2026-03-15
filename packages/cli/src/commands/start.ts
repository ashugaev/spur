/**
 * `ao start`, `ao stop`, and `ao restart` commands — unified orchestrator lifecycle.
 *
 * Supports two modes:
 *   1. `ao start [project]` — start from existing config
 *   2. `ao start <url>` — clone repo, auto-generate config, then start
 *
 * The orchestrator prompt is passed to the agent via --append-system-prompt
 * (or equivalent flag) at launch time — no file writing required.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import chalk from "chalk";
import ora from "ora";
import type { Command } from "commander";
import {
  loadConfig,
  createLifecycleManager,
  createEventBus,
  createPipelineEngine,
  getSessionsDir,
  generateOrchestratorPrompt,
  isRepoUrl,
  parseRepoUrl,
  resolveCloneTarget,
  isRepoAlreadyCloned,
  generateConfigFromUrl,
  configToYaml,
  type OrchestratorConfig,
  type ProjectConfig,
  type ParsedRepoUrl,
} from "@composio/ao-core";
import { exec, execSilent } from "../lib/shell.js";
import { getPluginRegistry, getSessionManager } from "../lib/create-session-manager.js";
import { maybeStartTelegramLongPolling, type TelegramPollingController } from "../lib/telegram-polling.js";
import { maybeStartJiraCommentPolling, type JiraCommentPollingController } from "../lib/jira-comment-polling.js";
import {
  maybeStartConfiguredListeners,
  type ListenerGroupController,
} from "../lib/listeners/index.js";
import {
  maybeStartConfiguredTriggers,
  type TriggerGroupController,
} from "../lib/triggers/index.js";
import { createIntegrationHealthReporter, type IntegrationIdentity } from "../lib/integration-health.js";
import { findWebDir, buildDashboardEnv, waitForPortAndOpen, isPortAvailable, findFreePort, MAX_PORT_SCAN } from "../lib/web-dir.js";
import { cleanNextCache } from "../lib/dashboard-rebuild.js";
import { preflight } from "../lib/preflight.js";

const DEFAULT_PORT = 3000;
const START_RUNTIME_STATE_FILE = ".ao-start-runtime.json";
const START_RUNTIME_STATE_VERSION = 1;
const REACTION_ENGINE_HEALTH: IntegrationIdentity = {
  id: "reaction-engine",
  label: "Reaction engine",
  service: "orchestrator",
  kind: "reaction",
};

interface StartRuntimeState {
  version: number;
  pid: number;
  port: number;
  configPath: string;
  startedAt: string;
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Path for start runtime state associated with a config file.
 */
function getStartRuntimeStatePath(configPath: string | null): string | null {
  if (!configPath) return null;
  return resolve(dirname(configPath), START_RUNTIME_STATE_FILE);
}

/**
 * Check if a process is alive.
 */
function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read start runtime state from disk.
 */
function readStartRuntimeState(configPath: string | null): StartRuntimeState | null {
  const statePath = getStartRuntimeStatePath(configPath);
  if (!statePath || !existsSync(statePath)) return null;

  try {
    const raw = JSON.parse(readFileSync(statePath, "utf-8")) as Partial<StartRuntimeState>;
    if (
      raw.version !== START_RUNTIME_STATE_VERSION ||
      typeof raw.pid !== "number" ||
      typeof raw.port !== "number" ||
      typeof raw.configPath !== "string" ||
      typeof raw.startedAt !== "string"
    ) {
      return null;
    }
    return {
      version: raw.version,
      pid: raw.pid,
      port: raw.port,
      configPath: raw.configPath,
      startedAt: raw.startedAt,
    };
  } catch {
    return null;
  }
}

/**
 * Persist start runtime state.
 */
function writeStartRuntimeState(configPath: string | null, port: number): void {
  const statePath = getStartRuntimeStatePath(configPath);
  if (!statePath || !configPath) return;

  const state: StartRuntimeState = {
    version: START_RUNTIME_STATE_VERSION,
    pid: process.pid,
    port,
    configPath,
    startedAt: new Date().toISOString(),
  };
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
}

/**
 * Remove runtime state if owned by the current process, or if marked stale.
 */
function clearStartRuntimeState(configPath: string | null, opts?: { staleOnly?: boolean }): void {
  const statePath = getStartRuntimeStatePath(configPath);
  if (!statePath || !existsSync(statePath)) return;

  const safeUnlink = () => {
    try {
      unlinkSync(statePath);
    } catch {
      // Best effort cleanup
    }
  };

  const state = readStartRuntimeState(configPath);
  if (!state) {
    safeUnlink();
    return;
  }

  if (opts?.staleOnly) {
    if (!isPidAlive(state.pid)) safeUnlink();
    return;
  }

  if (state.pid === process.pid || !isPidAlive(state.pid)) {
    safeUnlink();
  }
}

/**
 * Resolve current supervisor dashboard port.
 * Prefers runtime state when a live supervisor exists.
 */
function resolveSupervisorPort(config: OrchestratorConfig): number {
  const runtimeState = readStartRuntimeState(config.configPath);
  if (
    runtimeState &&
    runtimeState.configPath === config.configPath &&
    isPidAlive(runtimeState.pid) &&
    Number.isInteger(runtimeState.port) &&
    runtimeState.port > 0
  ) {
    return runtimeState.port;
  }
  return config.port ?? DEFAULT_PORT;
}

/**
 * Check whether any configured orchestrator session is currently active.
 * Used as an additional attach signal when a runtime state PID is live.
 */
async function hasActiveOrchestratorSessions(
  config: OrchestratorConfig,
  sessionManager: Awaited<ReturnType<typeof getSessionManager>>,
): Promise<boolean> {
  for (const project of Object.values(config.projects)) {
    const sessionId = `${project.sessionPrefix}-orchestrator`;
    const session = await sessionManager.get(sessionId);
    if (session !== null && session.status !== "killed") {
      return true;
    }
  }
  return false;
}

/**
 * Resolve target projects for `ao start`.
 * If projectArg is omitted, start all configured projects.
 */
function resolveStartProjects(config: OrchestratorConfig, projectArg?: string): string[] {
  const projectIds = Object.keys(config.projects);
  if (projectIds.length === 0) {
    throw new Error("No projects configured. Add a project to agent-orchestrator.yaml.");
  }

  if (!projectArg) return projectIds;

  if (!config.projects[projectArg]) {
    throw new Error(
      `Project "${projectArg}" not found. Available projects:\n  ${projectIds.join(", ")}`,
    );
  }
  return [projectArg];
}

/**
 * Resolve a single project from config.
 * Used by `stop`/`restart`, where a unique project target is required.
 */
function resolveProject(
  config: OrchestratorConfig,
  projectArg?: string,
): { projectId: string; project: ProjectConfig } {
  const projectIds = Object.keys(config.projects);

  if (projectIds.length === 0) {
    throw new Error("No projects configured. Add a project to agent-orchestrator.yaml.");
  }

  // Explicit project argument
  if (projectArg) {
    const project = config.projects[projectArg];
    if (!project) {
      throw new Error(
        `Project "${projectArg}" not found. Available projects:\n  ${projectIds.join(", ")}`,
      );
    }
    return { projectId: projectArg, project };
  }

  // Only one project — use it
  if (projectIds.length === 1) {
    const projectId = projectIds[0];
    return { projectId, project: config.projects[projectId] };
  }

  // Multiple projects, no argument — error
  throw new Error(
    `Multiple projects configured. Specify which one to start:\n  ${projectIds.map((id) => `ao start ${id}`).join("\n  ")}`,
  );
}

/**
 * Resolve project from config by matching against a repo URL's ownerRepo.
 * Used when `ao start <url>` loads an existing multi-project config — the user
 * can't pass both a URL and a project name since they share the same arg slot.
 *
 * Falls back to `resolveProject` (which handles single-project configs or
 * errors with a helpful message for ambiguous multi-project cases).
 */
function resolveProjectByRepo(
  config: OrchestratorConfig,
  parsed: ParsedRepoUrl,
): { projectId: string; project: ProjectConfig } {
  const projectIds = Object.keys(config.projects);

  // Try to match by repo field (e.g. "owner/repo")
  for (const id of projectIds) {
    const project = config.projects[id];
    if (project.repo === parsed.ownerRepo) {
      return { projectId: id, project };
    }
  }

  // No repo match — fall back to standard resolution (works for single-project)
  return resolveProject(config);
}

/**
 * Clone a repo with authentication support.
 *
 * Strategy:
 *   1. Try `gh repo clone owner/repo target -- --depth 1` — handles GitHub auth
 *      for private repos via the user's `gh auth` token.
 *   2. Fall back to `git clone --depth 1` with SSH URL — works for users with
 *      SSH keys configured (common for private repos without gh).
 *   3. Final fallback to `git clone --depth 1` with HTTPS URL — works for
 *      public repos without any auth setup.
 */
async function cloneRepo(parsed: ParsedRepoUrl, targetDir: string, cwd: string): Promise<void> {
  // 1. Try gh repo clone (handles GitHub auth automatically)
  if (parsed.host === "github.com") {
    const ghAvailable = (await execSilent("gh", ["auth", "status"])) !== null;
    if (ghAvailable) {
      try {
        await exec("gh", ["repo", "clone", parsed.ownerRepo, targetDir, "--", "--depth", "1"], {
          cwd,
        });
        return;
      } catch {
        // gh clone failed — fall through to git clone with SSH
      }
    }
  }

  // 2. Try git clone with SSH URL (works with SSH keys for private repos)
  const sshUrl = `git@${parsed.host}:${parsed.ownerRepo}.git`;
  try {
    await exec("git", ["clone", "--depth", "1", sshUrl, targetDir], { cwd });
    return;
  } catch {
    // SSH failed — fall through to HTTPS
  }

  // 3. Final fallback: HTTPS (works for public repos)
  await exec("git", ["clone", "--depth", "1", parsed.cloneUrl, targetDir], { cwd });
}

/**
 * Handle `ao start <url>` — clone repo, generate config, return loaded config.
 * Also returns the parsed URL so the caller can match by repo when the config
 * contains multiple projects.
 */
async function handleUrlStart(url: string): Promise<{ config: OrchestratorConfig; parsed: ParsedRepoUrl; autoGenerated: boolean }> {
  const spinner = ora();

  // 1. Parse URL
  spinner.start("Parsing repository URL");
  const parsed = parseRepoUrl(url);
  spinner.succeed(`Repository: ${chalk.cyan(parsed.ownerRepo)} (${parsed.host})`);

  // 2. Determine target directory
  const cwd = process.cwd();
  const targetDir = resolveCloneTarget(parsed, cwd);
  const alreadyCloned = isRepoAlreadyCloned(targetDir, parsed.cloneUrl);

  // 3. Clone or reuse
  if (alreadyCloned) {
    console.log(chalk.green(`  Reusing existing clone at ${targetDir}`));
  } else {
    spinner.start(`Cloning ${parsed.ownerRepo}`);
    try {
      await cloneRepo(parsed, targetDir, cwd);
      spinner.succeed(`Cloned to ${targetDir}`);
    } catch (err) {
      spinner.fail("Clone failed");
      throw new Error(
        `Failed to clone ${parsed.ownerRepo}: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  }

  // 4. Check for existing config
  const configPath = resolve(targetDir, "agent-orchestrator.yaml");
  const configPathAlt = resolve(targetDir, "agent-orchestrator.yml");

  if (existsSync(configPath)) {
    console.log(chalk.green(`  Using existing config: ${configPath}`));
    return { config: loadConfig(configPath), parsed, autoGenerated: false };
  }

  if (existsSync(configPathAlt)) {
    console.log(chalk.green(`  Using existing config: ${configPathAlt}`));
    return { config: loadConfig(configPathAlt), parsed, autoGenerated: false };
  }

  // 5. Auto-generate config with a free port
  spinner.start("Generating config");
  const freePort = await findFreePort(DEFAULT_PORT);
  const rawConfig = generateConfigFromUrl({
    parsed,
    repoPath: targetDir,
    port: freePort ?? DEFAULT_PORT,
  });

  const yamlContent = configToYaml(rawConfig);
  writeFileSync(configPath, yamlContent);
  spinner.succeed(`Config generated: ${configPath}`);

  return { config: loadConfig(configPath), parsed, autoGenerated: true };
}

/**
 * Start dashboard server in the background.
 * Returns the child process handle for cleanup.
 */
async function startDashboard(
  port: number,
  webDir: string,
  configPath: string | null,
  projectId: string,
  integrationHealthSnapshotPath: string,
  terminalPort?: number,
  directTerminalPort?: number,
): Promise<ChildProcess> {
  const env =
    (await buildDashboardEnv(port, configPath, terminalPort, directTerminalPort)) ??
    ({ ...process.env } as Record<string, string>);
  env["AO_PROJECT_ID"] = projectId;
  env["AO_INTEGRATIONS_HEALTH_SNAPSHOT_PATH"] = integrationHealthSnapshotPath;
  // Compatibility aliases for older status readers.
  env["AO_HEALTH_SNAPSHOT_PATH"] = integrationHealthSnapshotPath;
  env["AO_INTEGRATIONS_STATUS_PATH"] = integrationHealthSnapshotPath;

  const child = spawn("pnpm", ["run", "dev"], {
    cwd: webDir,
    stdio: "inherit",
    detached: false,
    env,
  });

  child.on("error", (err) => {
    console.error(chalk.red("Dashboard failed to start:"), err.message);
    // Emit synthetic exit so callers listening on "exit" can clean up
    child.emit("exit", 1, null);
  });

  return child;
}

/**
 * Shared startup logic: launch dashboard + orchestrator session, print summary.
 * Used by both normal and URL-based start flows.
 */
async function runStartup(
  config: OrchestratorConfig,
  targetProjectIds: string[],
  opts?: {
    dashboard?: boolean;
    orchestrator?: boolean;
    rebuild?: boolean;
    autoPort?: boolean;
    forceFreshRuntime?: boolean;
  },
): Promise<void> {
  if (targetProjectIds.length === 0) {
    throw new Error("No target projects provided for startup");
  }

  const primaryProjectId = targetProjectIds[0];
  const primaryProject = config.projects[primaryProjectId];
  if (!primaryProject) {
    throw new Error(`Project "${primaryProjectId}" not found`);
  }

  let port = config.port ?? DEFAULT_PORT;
  const integrationHealth = createIntegrationHealthReporter({
    config,
    projectId: primaryProjectId,
    project: primaryProject,
  });

  if (targetProjectIds.length === 1) {
    console.log(chalk.bold(`\nStarting orchestrator for ${chalk.cyan(primaryProject.name)}\n`));
  } else {
    const projectList = targetProjectIds
      .map((id) => config.projects[id]?.name ?? id)
      .join(", ");
    console.log(
      chalk.bold(
        `\nStarting orchestrator for ${chalk.cyan(String(targetProjectIds.length))} projects\n`,
      ),
    );
    console.log(chalk.dim(`  Projects: ${projectList}\n`));
  }

  const spinner = ora();
  let dashboardProcess: ChildProcess | null = null;
  let lifecycleManager: ReturnType<typeof createLifecycleManager> | null = null;
  let telegramPolling: TelegramPollingController | null = null;
  let jiraPolling: JiraCommentPollingController | null = null;
  let configuredListeners: ListenerGroupController | null = null;
  let configuredTriggers: TriggerGroupController | null = null;
  let sharedSessionManager: Awaited<ReturnType<typeof getSessionManager>> | null = null;
  let attachedToExistingRuntime = false;
  let attachedRuntimeDashboardReachable = false;

  // Start dashboard (unless --no-dashboard)
  if (opts?.dashboard !== false) {
    const runtimeState = readStartRuntimeState(config.configPath);
    const attachCandidate =
      opts?.forceFreshRuntime === true
        ? null
        : runtimeState !== null &&
            runtimeState.configPath === config.configPath &&
            isPidAlive(runtimeState.pid)
          ? runtimeState
          : null;

    if (attachCandidate) {
      const dashboardReachable = !(await isPortAvailable(attachCandidate.port));
      let activeSessionsDetected = false;

      if (!dashboardReachable) {
        const sm = sharedSessionManager ?? (await getSessionManager(config));
        sharedSessionManager = sm;
        activeSessionsDetected = await hasActiveOrchestratorSessions(config, sm);
      }

      if (dashboardReachable || activeSessionsDetected) {
        attachedToExistingRuntime = true;
        attachedRuntimeDashboardReachable = dashboardReachable;
        port = attachCandidate.port;
        if (dashboardReachable) {
          console.log(
            chalk.dim(
              `  Reusing running orchestrator runtime (PID ${attachCandidate.pid}) on http://localhost:${port}`,
            ),
          );
        } else {
          console.log(
            chalk.dim(
              `  Reusing running orchestrator runtime (PID ${attachCandidate.pid}) and attaching new project sessions`,
            ),
          );
        }
      } else {
        clearStartRuntimeState(config.configPath);
      }
    }

    if (!attachedToExistingRuntime) {
      // If the config port differs from the reused runtime port we already set `port` above.
      // New runtime startup still begins from config/default.
      if (!attachCandidate) {
        port = config.port ?? DEFAULT_PORT;
      }

      clearStartRuntimeState(config.configPath, { staleOnly: true });

      if (opts?.forceFreshRuntime) {
        clearStartRuntimeState(config.configPath);
      }

      if (opts?.autoPort) {
        // Port was auto-selected during config generation — if it's now busy
        // (race condition), find another free port instead of erroring.
        if (!(await isPortAvailable(port))) {
          const newPort = await findFreePort(DEFAULT_PORT);
          if (newPort === null) {
            throw new Error(
              `No free port found in range ${DEFAULT_PORT}–${DEFAULT_PORT + MAX_PORT_SCAN - 1}.`,
            );
          }
          port = newPort;
        }
      } else {
        await preflight.checkPort(port);
      }
      const webDir = findWebDir();
      if (!existsSync(resolve(webDir, "package.json"))) {
        throw new Error("Could not find @composio/ao-web package. Run: pnpm install");
      }
      await preflight.checkBuilt(webDir);

      if (opts?.rebuild) {
        await cleanNextCache(webDir);
      }

      spinner.start("Starting dashboard");
      dashboardProcess = await startDashboard(
        port,
        webDir,
        config.configPath,
        primaryProjectId,
        integrationHealth.snapshotPath,
        config.terminalPort,
        config.directTerminalPort,
      );
      spinner.succeed(`Dashboard starting on http://localhost:${port}`);
      console.log(chalk.dim("  (Dashboard will be ready in a few seconds)\n"));

      // Start lifecycle polling in the same process as `ao start` so reactions
      // and notifiers (including Telegram) run continuously while dashboard is up.
      const [sessionManager, registry] = await Promise.all([
        getSessionManager(config),
        getPluginRegistry(config),
      ]);
      sharedSessionManager = sessionManager;

      const hasPipeline = Object.values(config.projects).some(
        (p) => p.pipeline?.steps && p.pipeline.steps.length > 0,
      );
      const eventBus = hasPipeline ? createEventBus() : undefined;
      const pipelineEngine = hasPipeline && eventBus
        ? createPipelineEngine({
            sessionsDir: getSessionsDir(config.configPath, Object.values(config.projects)[0].path),
            eventBus,
          })
        : undefined;

      lifecycleManager = createLifecycleManager({
        config,
        registry,
        sessionManager,
        pipelineEngine,
        eventBus,
        healthHooks: {
          onPollStarting: (message) =>
            integrationHealth.markStarting(REACTION_ENGINE_HEALTH, message),
          onPollHealthy: (message) =>
            integrationHealth.markHealthy(REACTION_ENGINE_HEALTH, message),
          onPollDegraded: (message, error) =>
            integrationHealth.markDegraded(REACTION_ENGINE_HEALTH, message, error),
          onPollInactive: (message) =>
            integrationHealth.markInactive(REACTION_ENGINE_HEALTH, message),
        },
      });
      lifecycleManager.start();

      telegramPolling = await maybeStartTelegramLongPolling({
        config,
        sessionManager,
        healthReporter: integrationHealth,
      });
      if (telegramPolling) {
        console.log(
          chalk.dim("  Telegram inbound: polling enabled (2s fallback, 30s rate-limit backoff)"),
        );
      }

      jiraPolling = await maybeStartJiraCommentPolling({
        config,
        sessionManager,
        healthReporter: integrationHealth,
      });
      if (jiraPolling) {
        console.log(chalk.dim("  Tracker inbound: comment polling enabled (60s)"));
      }

      configuredListeners = await maybeStartConfiguredListeners({
        config,
        registry,
        sessionManager,
        healthReporter: integrationHealth,
      });
      if (configuredListeners && configuredListeners.activeListeners.length > 0) {
        console.log(
          chalk.dim(
            `  Trigger listeners: ${configuredListeners.activeListeners.join(", ")} (active)`,
          ),
        );
      }

      configuredTriggers = await maybeStartConfiguredTriggers({
        config,
        sessionManager,
        healthReporter: integrationHealth,
      });
      if (configuredTriggers && configuredTriggers.activeTriggers.length > 0) {
        console.log(
          chalk.dim(
            `  Triggers: ${configuredTriggers.activeTriggers.join(", ")} (active)`,
          ),
        );
      }

      writeStartRuntimeState(config.configPath, port);
    } else {
      if (attachCandidate && attachCandidate.port !== (config.port ?? DEFAULT_PORT)) {
        console.log(
          chalk.dim(
            `  Config port ${config.port ?? DEFAULT_PORT} differs from running runtime port ${attachCandidate.port}; using running port`,
          ),
        );
      }
    }
  }

  const orchestratorResults: Array<{
    projectId: string;
    sessionId: string;
    tmuxTarget: string;
    exists: boolean;
  }> = [];

  // Create orchestrator sessions (unless --no-orchestrator)
  if (opts?.orchestrator !== false) {
    const sm = sharedSessionManager ?? (await getSessionManager(config));
    const createdThisRun: string[] = [];

    for (const projectId of targetProjectIds) {
      const project = config.projects[projectId];
      if (!project) continue;

      const sessionId = `${project.sessionPrefix}-orchestrator`;
      let tmuxTarget = sessionId;
      const existing = await sm.get(sessionId);
      const exists = existing !== null && existing.status !== "killed";

      if (exists) {
        if (existing?.runtimeHandle?.id) {
          tmuxTarget = existing.runtimeHandle.id;
        }
        console.log(
          chalk.yellow(
            `Orchestrator session "${sessionId}" is already running (skipping creation)`,
          ),
        );
      } else {
        try {
          spinner.start(`Creating orchestrator session (${project.name})`);
          const systemPrompt = generateOrchestratorPrompt({ config, projectId, project });
          const session = await sm.spawnOrchestrator({ projectId, systemPrompt });
          if (session.runtimeHandle?.id) {
            tmuxTarget = session.runtimeHandle.id;
          }
          createdThisRun.push(sessionId);
          spinner.succeed(`Orchestrator session created (${project.name})`);
        } catch (err) {
          spinner.fail(`Orchestrator setup failed (${project.name})`);
          for (const createdSessionId of createdThisRun.reverse()) {
            try {
              await sm.kill(createdSessionId);
            } catch {
              // Best effort rollback for partially-created sessions.
            }
          }
          if (dashboardProcess) {
            dashboardProcess.kill();
          }
          throw new Error(
            `Failed to setup orchestrator for ${projectId}: ${err instanceof Error ? err.message : String(err)}`,
            { cause: err },
          );
        }
      }

      orchestratorResults.push({ projectId, sessionId, tmuxTarget, exists });
    }
  }

  // Print summary
  console.log(chalk.bold.green("\n✓ Startup complete\n"));

  if (opts?.dashboard !== false) {
    if (attachedToExistingRuntime) {
      if (attachedRuntimeDashboardReachable) {
        console.log(chalk.cyan("Dashboard:"), `already running (http://localhost:${port})`);
      } else {
        console.log(
          chalk.cyan("Dashboard:"),
          `attached to existing runtime (http://localhost:${port}; may still be warming up)`,
        );
      }
    } else {
      console.log(chalk.cyan("Dashboard:"), `http://localhost:${port}`);
    }
  }

  if (opts?.orchestrator !== false) {
    for (const result of orchestratorResults) {
      const projectName = config.projects[result.projectId]?.name ?? result.projectId;
      const label =
        targetProjectIds.length > 1 ? `Orchestrator (${projectName}):` : "Orchestrator:";

      if (result.exists) {
        console.log(chalk.cyan(label), `already running (${result.sessionId})`);
      } else {
        console.log(chalk.cyan(label), `tmux attach -t ${result.tmuxTarget}`);
      }
    }
  }

  console.log(chalk.dim(`Config: ${config.configPath}\n`));

  // Auto-open browser to orchestrator session page once the server is accepting connections.
  // Polls the port instead of using a fixed delay — deterministic and works regardless of
  // how long Next.js takes to compile. AbortController cancels polling on early exit.
  let openAbort: AbortController | undefined;
  if (opts?.dashboard !== false && !attachedToExistingRuntime) {
    openAbort = new AbortController();
    void waitForPortAndOpen(port, `http://localhost:${port}`, openAbort.signal);
  }

  // Keep dashboard process alive if it was started
  if (dashboardProcess) {
    dashboardProcess.on("exit", (code) => {
      clearStartRuntimeState(config.configPath);
      if (openAbort) openAbort.abort();
      if (lifecycleManager) lifecycleManager.stop();
      if (telegramPolling) telegramPolling.stop();
      if (jiraPolling) jiraPolling.stop();
      if (configuredListeners) configuredListeners.stop();
      if (configuredTriggers) configuredTriggers.stop();
      if (code !== 0 && code !== null) {
        console.error(chalk.red(`Dashboard exited with code ${code}`));
      }
      process.exit(code ?? 0);
    });
  }
}

/**
 * Stop dashboard server.
 * Uses lsof to find the process listening on the port, then kills it.
 * Best effort — if it fails, just warn the user.
 */
async function stopDashboard(port: number): Promise<void> {
  try {
    // Find PIDs listening on the port (can be multiple: parent + children)
    const { stdout } = await exec("lsof", ["-ti", `:${port}`]);
    const pids = stdout
      .trim()
      .split("\n")
      .filter((p) => p.length > 0);

    if (pids.length > 0) {
      // Kill all processes (pass PIDs as separate arguments)
      await exec("kill", pids);
      console.log(chalk.green("Dashboard stopped"));
    } else {
      console.log(chalk.yellow(`Dashboard not running on port ${port}`));
    }
  } catch {
    console.log(chalk.yellow("Could not stop dashboard (may not be running)"));
  }
}

// =============================================================================
// COMMAND REGISTRATION
// =============================================================================

export function registerStart(program: Command): void {
  program
    .command("start [project]")
    .description(
      "Start orchestrator agent and dashboard for one/all projects (or pass a repo URL to onboard)",
    )
    .option("--no-dashboard", "Skip starting the dashboard server")
    .option("--no-orchestrator", "Skip starting the orchestrator agent")
    .option("--rebuild", "Clean and rebuild dashboard before starting")
    .action(
      async (
        projectArg?: string,
        opts?: {
          dashboard?: boolean;
          orchestrator?: boolean;
          rebuild?: boolean;
        },
      ) => {
        try {
          let config: OrchestratorConfig;
          let targetProjectIds: string[] = [];
          let autoPort = false;

          // Detect URL argument — run onboarding flow
          if (projectArg && isRepoUrl(projectArg)) {
            console.log(chalk.bold.cyan("\n  Agent Orchestrator — Quick Start\n"));
            const result = await handleUrlStart(projectArg);
            config = result.config;
            autoPort = result.autoGenerated;
            const resolved = resolveProjectByRepo(config, result.parsed);
            targetProjectIds = [resolved.projectId];
          } else {
            // Normal flow — load existing config
            config = loadConfig();
            targetProjectIds = resolveStartProjects(config, projectArg);
          }

          await runStartup(config, targetProjectIds, { ...opts, autoPort });
        } catch (err) {
          if (err instanceof Error) {
            if (err.message.includes("No agent-orchestrator.yaml found")) {
              console.error(chalk.red("\nNo config found. Run:"));
              console.error(chalk.cyan("  ao init\n"));
            } else {
              console.error(chalk.red("\nError:"), err.message);
            }
          } else {
            console.error(chalk.red("\nError:"), String(err));
          }
          process.exit(1);
        }
      },
    );
}

export function registerStop(program: Command): void {
  program
    .command("stop [project]")
    .description("Stop orchestrator agent and dashboard for a project")
    .action(async (projectArg?: string) => {
      try {
        const config = loadConfig();
        const { projectId: _projectId, project } = resolveProject(config, projectArg);
        const sessionId = `${project.sessionPrefix}-orchestrator`;
        const port = resolveSupervisorPort(config);

        console.log(chalk.bold(`\nStopping orchestrator for ${chalk.cyan(project.name)}\n`));

        // Kill orchestrator session via SessionManager
        const sm = await getSessionManager(config);
        const existing = await sm.get(sessionId);

        if (existing) {
          const spinner = ora("Stopping orchestrator session").start();
          await sm.kill(sessionId);
          spinner.succeed("Orchestrator session stopped");
        } else {
          console.log(chalk.yellow(`Orchestrator session "${sessionId}" is not running`));
        }

        // Stop dashboard
        await stopDashboard(port);

        console.log(chalk.bold.green("\n✓ Orchestrator stopped\n"));
      } catch (err) {
        if (err instanceof Error) {
          console.error(chalk.red("\nError:"), err.message);
        } else {
          console.error(chalk.red("\nError:"), String(err));
        }
        process.exit(1);
      }
    });
}

export function registerRestart(program: Command): void {
  program
    .command("restart <project>")
    .description("Restart orchestrator agent and dashboard for a project")
    .option("--rebuild", "Clean and rebuild dashboard before starting")
    .action(async (projectArg: string, opts?: { rebuild?: boolean }) => {
      try {
        const config = loadConfig();
        const { projectId, project } = resolveProject(config, projectArg);
        const sessionId = `${project.sessionPrefix}-orchestrator`;
        const port = resolveSupervisorPort(config);

        console.log(chalk.bold(`\nRestarting orchestrator for ${chalk.cyan(project.name)}\n`));

        // Stop existing orchestrator session (if any)
        const sm = await getSessionManager(config);
        const existing = await sm.get(sessionId);

        if (existing) {
          const spinner = ora("Stopping orchestrator session").start();
          await sm.kill(sessionId);
          spinner.succeed("Orchestrator session stopped");
        } else {
          console.log(chalk.yellow(`Orchestrator session "${sessionId}" is not running`));
        }

        // Stop dashboard process on configured port before re-starting.
        await stopDashboard(port);

        // Start everything again using the same startup flow as `ao start`.
        await runStartup(config, [projectId], {
          dashboard: true,
          orchestrator: true,
          rebuild: opts?.rebuild,
          forceFreshRuntime: true,
        });
      } catch (err) {
        if (err instanceof Error) {
          console.error(chalk.red("\nError:"), err.message);
        } else {
          console.error(chalk.red("\nError:"), String(err));
        }
        process.exit(1);
      }
    });
}
