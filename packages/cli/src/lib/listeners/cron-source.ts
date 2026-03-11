import type { ListenerController, ListenerSource, ListenerStartDeps } from "./types.js";

const DEFAULT_INTERVAL_MS = 60_000;

async function startCronListener(deps: ListenerStartDeps): Promise<ListenerController> {
  const { listener, listenerId, project, projectId, sessionManager, logger, healthReporter, healthIdentity } = deps;

  const intervalMs =
    typeof listener.intervalMs === "number" && listener.intervalMs > 0
      ? listener.intervalMs
      : DEFAULT_INTERVAL_MS;

  if (listener.intervalMs === undefined || listener.intervalMs === null) {
    logger.warn(
      `[listener:${listenerId}] No intervalMs configured — using default ${DEFAULT_INTERVAL_MS}ms`,
    );
  }

  const trigger = listener.trigger;

  // skill takes precedence: "find-cars" → "/find-cars"
  const skillName = typeof trigger?.skill === "string" && trigger.skill.length > 0
    ? trigger.skill
    : undefined;
  const prompt = skillName
    ? `/${skillName}`
    : typeof trigger?.prompt === "string" && trigger.prompt.length > 0
      ? trigger.prompt
      : undefined;

  if (!prompt) {
    throw new Error(
      `[listener:${listenerId}] cron source requires trigger.skill or trigger.prompt to be set`,
    );
  }

  const agentOverride = typeof trigger?.agent === "string" ? trigger.agent : undefined;
  const branchOverride = typeof trigger?.branch === "string" ? trigger.branch : undefined;
  const runOnStart = listener.runOnStart === true;

  let stopped = false;
  let intervalHandle: ReturnType<typeof setInterval> | null = null;

  async function tick(): Promise<void> {
    if (stopped) return;

    logger.info?.(
      `[listener:${listenerId}] Spawning session for project "${projectId}"`,
    );

    try {
      await sessionManager.spawn({
        projectId,
        prompt,
        ...(agentOverride !== undefined ? { agent: agentOverride } : {}),
        ...(branchOverride !== undefined
          ? { branch: branchOverride }
          : project.defaultBranch !== undefined
            ? { branch: project.defaultBranch }
            : {}),
      });

      if (healthReporter !== undefined && healthIdentity !== undefined) {
        healthReporter.markHealthy(
          healthIdentity,
          `Listener active: last spawn at ${new Date().toISOString()}`,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[listener:${listenerId}] Failed to spawn session: ${msg}`);
    }
  }

  function stopPolling(): void {
    stopped = true;
    if (intervalHandle !== null) {
      clearInterval(intervalHandle);
      intervalHandle = null;
    }
  }

  if (runOnStart) {
    void tick();
  }

  intervalHandle = setInterval(() => {
    void tick();
  }, intervalMs);

  if (healthReporter !== undefined && healthIdentity !== undefined) {
    healthReporter.markHealthy(healthIdentity, `Listener active: cron every ${intervalMs}ms`);
  }

  logger.info?.(
    `[listener:${listenerId}] Cron listener started — interval=${intervalMs}ms, runOnStart=${runOnStart}`,
  );

  return {
    stop(): void {
      stopPolling();
    },
  };
}

export const cronSource: ListenerSource = {
  source: "cron",
  start: startCronListener,
};
