import chalk from "chalk";
import type { Command } from "commander";
import { getEnv } from "../lib/pipeline-env.js";

export function registerDone(program: Command): void {
  program
    .command("done")
    .description("Signal that the current pipeline step completed successfully")
    .option("--output <json>", "JSON output to pass to the next step")
    .action(async (opts: { output?: string }) => {
      const { sessionId, dashboardUrl } = getEnv();

      let output: unknown = {};
      if (opts.output) {
        try {
          output = JSON.parse(opts.output) as unknown;
        } catch {
          console.error(chalk.red("Invalid JSON in --output flag"));
          process.exit(1);
        }
      }

      try {
        const res = await fetch(
          `${dashboardUrl}/api/sessions/${sessionId}/pipeline`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "done", output }),
          },
        );
        if (!res.ok) {
          const text = await res.text();
          console.error(chalk.red(`Pipeline done failed (${res.status}): ${text}`));
          process.exit(1);
        }
        console.log(chalk.green("Step completed."));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`Request failed: ${msg}`));
        process.exit(1);
      }
    });
}
