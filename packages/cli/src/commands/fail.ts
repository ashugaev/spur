import chalk from "chalk";
import type { Command } from "commander";
import { getEnv } from "../lib/pipeline-env.js";

export function registerFail(program: Command): void {
  program
    .command("fail")
    .description("Signal that the current pipeline step failed")
    .option("--reason <text>", "Reason for failure")
    .action(async (opts: { reason?: string }) => {
      const { sessionId, dashboardUrl } = getEnv();

      try {
        const res = await fetch(
          `${dashboardUrl}/api/sessions/${sessionId}/pipeline`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "fail", reason: opts.reason }),
          },
        );
        if (!res.ok) {
          const text = await res.text();
          console.error(chalk.red(`Pipeline fail failed (${res.status}): ${text}`));
          process.exit(1);
        }
        console.log(chalk.yellow("Step marked as failed."));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`Request failed: ${msg}`));
        process.exit(1);
      }
    });
}
