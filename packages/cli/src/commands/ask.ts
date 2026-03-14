import chalk from "chalk";
import type { Command } from "commander";
import { getEnv } from "../lib/pipeline-env.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function registerAsk(program: Command): void {
  program
    .command("ask")
    .description("Ask the user a question and wait for a response")
    .argument("<question>", "The question to ask")
    .option("--options <list>", "Comma-separated list of options")
    .option("--timeout <seconds>", "Timeout in seconds", "1800")
    .action(
      async (
        question: string,
        opts: { options?: string; timeout?: string },
      ) => {
        const { sessionId, dashboardUrl } = getEnv();
        const timeoutSec = parseInt(opts.timeout || "1800", 10);
        const timeoutMs =
          (isNaN(timeoutSec) || timeoutSec <= 0 ? 1800 : timeoutSec) * 1000;

        const options = opts.options
          ? opts.options.split(",").map((o) => o.trim())
          : undefined;

        const pipelineUrl = `${dashboardUrl}/api/sessions/${sessionId}/pipeline`;

        try {
          const res = await fetch(pipelineUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              action: "ask",
              question,
              options,
              timeout: timeoutSec,
            }),
          });
          if (!res.ok) {
            const text = await res.text();
            console.error(
              chalk.red(`Pipeline ask failed (${res.status}): ${text}`),
            );
            process.exit(1);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(chalk.red(`Request failed: ${msg}`));
          process.exit(1);
        }

        console.log(chalk.dim("Waiting for response..."));

        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
          await sleep(5000);
          try {
            const res = await fetch(pipelineUrl);
            if (!res.ok) continue;
            const data = (await res.json()) as Record<string, unknown>;
            const state = data["currentStepState"] as string | undefined;
            if (state && state !== "running") {
              const answer = data["answer"] as string | undefined;
              if (answer) {
                console.log(chalk.green(`Response: ${answer}`));
              } else {
                console.log(chalk.yellow("Step state changed, no answer received."));
              }
              return;
            }
          } catch {
            // Retry on network errors
          }
        }

        console.error(chalk.red("Timed out waiting for response."));
        process.exit(1);
      },
    );
}
