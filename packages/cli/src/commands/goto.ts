import chalk from "chalk";
import type { Command } from "commander";
import { getEnv } from "../lib/pipeline-env.js";

export function registerGoto(program: Command): void {
  program
    .command("goto")
    .description("Jump to a specific pipeline step")
    .argument("<step-id>", "The step ID to jump to")
    .action(async (stepId: string) => {
      const { sessionId, dashboardUrl } = getEnv();

      try {
        const res = await fetch(
          `${dashboardUrl}/api/sessions/${sessionId}/pipeline`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "goto", stepId }),
          },
        );
        if (!res.ok) {
          const text = await res.text();
          console.error(chalk.red(`Pipeline goto failed (${res.status}): ${text}`));
          process.exit(1);
        }
        console.log(chalk.green(`Jumped to step: ${stepId}`));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`Request failed: ${msg}`));
        process.exit(1);
      }
    });
}
