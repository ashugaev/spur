import { Cron } from "croner";
import type { TriggerController, TriggerSource, TriggerStartDeps } from "./types.js";

async function startCronTrigger(deps: TriggerStartDeps): Promise<TriggerController> {
  const { trigger, triggerId, project, projectId, sessionManager, logger, healthReporter, healthIdentity } = deps;

  const schedule = trigger.schedule;
  if (!schedule) {
    throw new Error(`[trigger:${triggerId}] cron:tick requires a "schedule" field (cron expression)`);
  }

  const spawn = trigger.spawn;

  const skillName =
    typeof spawn.skill === "string" && spawn.skill.length > 0 ? spawn.skill : undefined;
  const namedAgent =
    typeof spawn.agent === "string" && spawn.agent.length > 0 ? spawn.agent : undefined;
  const userPrompt =
    typeof spawn.prompt === "string" && spawn.prompt.length > 0 ? spawn.prompt : undefined;

  if (!skillName && !userPrompt) {
    throw new Error(
      `[trigger:${triggerId}] cron:tick requires spawn.skill or spawn.prompt to be set`,
    );
  }

  // Build the full prompt:
  // - skill: "Activate skill /find-cars" + optional user prompt
  // - agent: "Activate agent: architect" + skill or user prompt
  // - plain: just the user prompt
  const parts: string[] = [];
  if (namedAgent) {
    parts.push(`Activate agent: ${namedAgent}`);
  }
  if (skillName) {
    parts.push(`Activate skill /${skillName}`);
  }
  if (userPrompt) {
    parts.push(userPrompt);
  }
  const prompt = parts.join("\n\n");

  const cliOverride = typeof spawn.cli === "string" ? spawn.cli : undefined;
  const branchOverride = typeof spawn.branch === "string" ? spawn.branch : undefined;

  let stopped = false;

  async function tick(): Promise<void> {
    if (stopped) return;

    logger.info?.(`[trigger:${triggerId}] Spawning session for project "${projectId}"`);

    try {
      await sessionManager.spawn({
        projectId,
        prompt,
        ...(cliOverride !== undefined ? { agent: cliOverride } : {}),
        ...(branchOverride !== undefined
          ? { branch: branchOverride }
          : project.defaultBranch !== undefined
            ? { branch: project.defaultBranch }
            : {}),
      });

      if (healthReporter !== undefined && healthIdentity !== undefined) {
        healthReporter.markHealthy(
          healthIdentity,
          `Trigger active: last spawn at ${new Date().toISOString()}`,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[trigger:${triggerId}] Failed to spawn session: ${msg}`);
    }
  }

  // Create cron job
  const cronJob = new Cron(schedule, () => {
    void tick();
  });

  if (healthReporter !== undefined && healthIdentity !== undefined) {
    const nextRun = cronJob.nextRun();
    const nextRunStr = nextRun ? ` next=${nextRun.toISOString()}` : "";
    healthReporter.markHealthy(
      healthIdentity,
      `Trigger active: schedule="${schedule}"${nextRunStr}`,
    );
  }

  if (trigger.runOnStart) {
    void tick();
  }

  logger.info?.(
    `[trigger:${triggerId}] Cron trigger started — schedule="${schedule}", runOnStart=${trigger.runOnStart}`,
  );

  return {
    stop(): void {
      stopped = true;
      cronJob.stop();
    },
  };
}

export const cronTriggerSource: TriggerSource = {
  event: "cron:tick",
  start: startCronTrigger,
};
