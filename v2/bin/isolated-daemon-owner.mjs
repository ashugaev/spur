#!/usr/bin/env node
import process from "node:process";
import { Buffer } from "node:buffer";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function checkIsolatedSocketPath(controlPath, platform = process.platform) {
  const capacity = platform === "linux" ? 107 : platform === "darwin" ? 103 : undefined;
  if (capacity !== undefined && Buffer.byteLength(controlPath) > capacity)
    throw new Error(`Isolated owner socket pathname exceeds ${capacity} UTF-8 bytes`);
}

async function main() {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === "preflight" && args.length === 1) {
    checkIsolatedSocketPath(args[0]);
  } else if (mode === "serve" && args.length === 5 && args.every(Boolean)) {
    const { serveIsolatedDaemon } = await import("../dist/isolated-daemon-owner.js");
    const [configPath, cliPath, runtimePath, projectConfigPath, sourceWorktree] = args;
    await serveIsolatedDaemon({
      configPath,
      cliPath,
      runtimePath,
      projectConfigPath,
      sourceWorktree,
    });
  } else if (
    mode === "request" &&
    (args[1] === "restart" || args[1] === "stop") &&
    (args.length === 2 || (args.length === 3 && args[2] === "--json"))
  ) {
    const { requestIsolatedDaemon } = await import("../dist/isolated-daemon-owner.js");
    const { outputResult } = await import("../dist/cli.js");
    const { dimText, renderRuntimeInfo } = await import("../dist/cli-view.js");
    const [configPath, operation] = args;
    await outputResult({
      json: args[2] === "--json",
      label: operation === "restart" ? "restarting daemon" : "stopping daemon",
      action: () => requestIsolatedDaemon(configPath, operation),
      success: (result) =>
        operation === "restart"
          ? result.restarted
            ? "Daemon restarted."
            : "Daemon already stopped."
          : result.stopped
            ? "Daemon stopped."
            : "Daemon already stopped.",
      render: (result) =>
        result.runtime
          ? renderRuntimeInfo(result.runtime)
          : dimText(`daemon ${result.baseUrl} is stopped`),
    });
  } else throw new Error("Invalid isolated owner command");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Isolated owner failed"}\n`);
    process.exitCode = 1;
  }
}
