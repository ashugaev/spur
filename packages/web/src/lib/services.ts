/**
 * Server-side singleton for core services.
 *
 * Lazily initializes config, plugin registry, and session manager.
 * Cached in globalThis to survive Next.js HMR reloads in development.
 *
 * NOTE: Plugins are explicitly imported here because Next.js webpack
 * cannot resolve dynamic `import(variable)` expressions used by the
 * core plugin registry's loadBuiltins(). Static imports let webpack
 * bundle them correctly.
 */

import {
  createAudioTranscriber,
  loadConfig,
  createPluginRegistry,
  createSessionManager,
  type AudioTranscriber,
  type OrchestratorConfig,
  type PluginModule,
  type PluginRegistry,
  type SessionManager,
  type SCM,
  type ProjectConfig,
} from "@composio/ao-core";

// Static plugin imports — webpack needs these to be string literals
import pluginRuntimeTmux from "@composio/ao-plugin-runtime-tmux";
import pluginAgentClaudeCode from "@composio/ao-plugin-agent-claude-code";
import pluginWorkspaceWorktree from "@composio/ao-plugin-workspace-worktree";
import pluginScmGithub from "@composio/ao-plugin-scm-github";
import pluginTrackerGithub from "@composio/ao-plugin-tracker-github";
import pluginTrackerJira from "@composio/ao-plugin-tracker-jira";

export interface Services {
  config: OrchestratorConfig;
  registry: PluginRegistry;
  sessionManager: SessionManager;
  audioTranscriber: AudioTranscriber | null;
}

// Cache in globalThis for Next.js HMR stability
const globalForServices = globalThis as typeof globalThis & {
  _aoServices?: Services;
  _aoServicesInit?: Promise<Services>;
};

/** Get (or lazily initialize) the core services singleton. */
export function getServices(): Promise<Services> {
  if (globalForServices._aoServices) {
    return Promise.resolve(globalForServices._aoServices);
  }
  if (!globalForServices._aoServicesInit) {
    globalForServices._aoServicesInit = initServices().catch((err) => {
      // Clear the cached promise so the next call retries instead of
      // permanently returning a rejected promise.
      globalForServices._aoServicesInit = undefined;
      throw err;
    });
  }
  return globalForServices._aoServicesInit;
}

function isLinearOptionalDependencyError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    message.includes("@composio/core") &&
    (message.includes("Cannot find module") ||
      message.includes("Cannot find package") ||
      message.includes("Module not found") ||
      message.includes("ERR_MODULE_NOT_FOUND"))
  );
}

async function registerOptionalLinearTracker(registry: PluginRegistry): Promise<void> {
  try {
    const mod = (await import(
      /* webpackIgnore: true */
      "@composio/ao-plugin-tracker-linear"
    )) as { default?: PluginModule };
    const plugin = mod.default;
    if (plugin?.manifest && typeof plugin.create === "function") {
      registry.register(plugin);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const prefix = isLinearOptionalDependencyError(err)
      ? "[services] Optional tracker plugin 'linear' disabled:"
      : "[services] Failed to load tracker plugin 'linear':";
    console.warn(`${prefix} ${message}`);
  }
}

async function initServices(): Promise<Services> {
  const config = loadConfig();
  const registry = createPluginRegistry();

  // Register plugins explicitly (webpack can't handle dynamic import() in core)
  registry.register(pluginRuntimeTmux);
  registry.register(pluginAgentClaudeCode);
  registry.register(pluginWorkspaceWorktree);
  registry.register(pluginScmGithub);
  registry.register(pluginTrackerGithub);
  registry.register(pluginTrackerJira);
  await registerOptionalLinearTracker(registry);

  const sessionManager = createSessionManager({ config, registry });
  let audioTranscriber: AudioTranscriber | null = null;
  try {
    audioTranscriber = createAudioTranscriber(config);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[services] Audio transcriber disabled due to configuration error: ${message}`);
  }

  const services = { config, registry, sessionManager, audioTranscriber };
  globalForServices._aoServices = services;
  return services;
}

/** Resolve the SCM plugin for a project. Returns null if not configured. */
export function getSCM(registry: PluginRegistry, project: ProjectConfig | undefined): SCM | null {
  if (!project?.scm) return null;
  return registry.get<SCM>("scm", project.scm.plugin);
}
