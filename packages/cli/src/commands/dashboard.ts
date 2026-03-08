import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import chalk from "chalk";
import type { Command } from "commander";
import { loadConfig, getDashboardUrl } from "@composio/ao-core";
import { findWebDir, buildDashboardEnv, waitForPortAndOpen, waitForPort } from "../lib/web-dir.js";
import { cleanNextCache, findRunningDashboardPid, findProcessWebDir, waitForPortFree } from "../lib/dashboard-rebuild.js";
import { notifyRemoteReady } from "../lib/remote-notify.js";

export function registerDashboard(program: Command): void {
  program
    .command("dashboard")
    .description("Start the web dashboard")
    .option("-p, --port <port>", "Port to listen on")
    .option("--no-open", "Don't open browser automatically")
    .option("--rebuild", "Clean stale build artifacts and rebuild before starting")
    .action(async (opts: { port?: string; open?: boolean; rebuild?: boolean }) => {
      const config = loadConfig();
      const port = opts.port ? parseInt(opts.port, 10) : (config.port ?? 3000);

      if (isNaN(port) || port < 1 || port > 65535) {
        console.error(chalk.red("Invalid port number. Must be 1-65535."));
        process.exit(1);
      }

      const localWebDir = findWebDir();

      if (!existsSync(resolve(localWebDir, "package.json"))) {
        console.error(
          chalk.red(
            "Could not find @composio/ao-web package.\n" + "Ensure it is installed: pnpm install",
          ),
        );
        process.exit(1);
      }

      if (opts.rebuild) {
        // Check if a dashboard is already running on this port.
        const runningPid = await findRunningDashboardPid(port);
        const runningWebDir = runningPid ? await findProcessWebDir(runningPid) : null;
        const targetWebDir = runningWebDir ?? localWebDir;

        if (runningPid) {
          // Kill the running server, clean .next, then start fresh below.
          console.log(
            chalk.dim(`Stopping dashboard (PID ${runningPid}) on port ${port}...`),
          );
          try {
            process.kill(parseInt(runningPid, 10), "SIGTERM");
          } catch {
            // Process already exited (ESRCH) — that's fine
          }
          // Wait for port to be released
          await waitForPortFree(port, 5000);
        }

        await cleanNextCache(targetWebDir);
        // Fall through to start the dashboard on this port.
      }

      const webDir = localWebDir;
      const localUrl = `http://localhost:${port}`;
      const remoteUrlPromise = getDashboardUrl(port, config.remote?.tailscaleHost);

      console.log(chalk.bold(`Starting dashboard on ${localUrl}`));
      console.log();

      const env = await buildDashboardEnv(
        port,
        config.configPath,
        config.terminalPort,
        config.directTerminalPort,
      );

      // Start full web stack (Next.js + terminal servers) so session pages
      // always have a reachable DirectTerminal WebSocket backend.
      const child = spawn("pnpm", ["run", "dev"], {
        cwd: webDir,
        stdio: ["inherit", "inherit", "pipe"],
        env,
      });

      const stderrChunks: string[] = [];

      const MAX_STDERR_CHUNKS = 100;

      child.stderr?.on("data", (data: Buffer) => {
        const text = data.toString();
        if (stderrChunks.length < MAX_STDERR_CHUNKS) {
          stderrChunks.push(text);
        }
        // Still show stderr to the user
        process.stderr.write(data);
      });

      child.on("error", (err) => {
        console.error(chalk.red("Could not start dashboard. Ensure Next.js is installed."));
        console.error(chalk.dim(String(err)));
        process.exit(1);
      });

      const startupAbort = new AbortController();

      // Log remote URL as soon as it is available (non-blocking).
      void remoteUrlPromise.then((remoteUrl) => {
        if (startupAbort.signal.aborted || !remoteUrl) return;
        console.log(chalk.dim(`Remote: ${remoteUrl}`));
      });

      // Notify Telegram only when the dashboard actually starts listening.
      void (async () => {
        const ready = await waitForPort(port, startupAbort.signal);
        if (!ready || startupAbort.signal.aborted) return;
        const remoteUrl = await remoteUrlPromise;
        void notifyRemoteReady(config, remoteUrl ?? localUrl);
      })();

      if (opts.open !== false) {
        void waitForPortAndOpen(port, localUrl, startupAbort.signal);
      }

      child.on("exit", (code) => {
        startupAbort.abort();

        if (code !== 0 && code !== null && !opts.rebuild) {
          const stderr = stderrChunks.join("");
          if (looksLikeStaleBuild(stderr)) {
            console.error(
              chalk.yellow(
                "\nThis looks like a stale build cache issue. Try:\n\n" +
                  `  ${chalk.cyan("ao dashboard --rebuild")}\n`,
              ),
            );
          }
        }

        process.exit(code ?? 0);
      });
    });
}

/**
 * Check if stderr output suggests stale build artifacts.
 */
function looksLikeStaleBuild(stderr: string): boolean {
  const patterns = [
    /Cannot find module.*vendor-chunks/,
    /Cannot find module.*\.next/,
    /Module not found.*\.next/,
    /ENOENT.*\.next/,
    /Could not find a production build/,
  ];
  return patterns.some((p) => p.test(stderr));
}
