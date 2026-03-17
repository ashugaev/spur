#!/usr/bin/env node

import { Command } from "commander";
import { getJson, postJson } from "./client.js";
import { startServer } from "./server.js";
import type {
  RuntimeInfo,
  SendMessageRequest,
  SessionView,
  SpawnSessionRequest,
} from "./types.js";

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function getConfigPath(program: Command): string | undefined {
  const options = program.opts<{ config?: string }>();
  return options.config;
}

async function run(): Promise<void> {
  const program = new Command();
  const cliEntrypoint = process.argv[1] ?? "";

  program
    .name("spur")
    .description("Spur")
    .version("0.1.0")
    .option("--config <path>", "Path to spur.yaml");

  program
    .command("spawn")
    .argument("<project>", "Configured project id")
    .argument("<prompt...>", "Initial agent prompt")
    .option("--agent <name>", "Agent to start: claude or codex")
    .option("--branch <name>", "Branch name to use")
    .action(async (project: string, promptParts: string[], options, command) => {
      const configPath = getConfigPath(command.parent as Command);
      const payload: SpawnSessionRequest = {
        project,
        prompt: promptParts.join(" "),
        agent: options.agent,
        branch: options.branch,
      };
      printJson(await postJson<SessionView>(cliEntrypoint, "/sessions", payload, configPath));
    });

  program
    .command("list")
    .action(async (_options, command) => {
      const configPath = getConfigPath(command.parent as Command);
      printJson(await getJson<SessionView[]>(cliEntrypoint, "/sessions", configPath));
    });

  program
    .command("get")
    .argument("<sessionId>", "Session id")
    .action(async (sessionId: string, _options, command) => {
      const configPath = getConfigPath(command.parent as Command);
      printJson(await getJson<SessionView>(cliEntrypoint, `/sessions/${sessionId}`, configPath));
    });

  program
    .command("send")
    .argument("<sessionId>", "Session id")
    .argument("<message...>", "Message to send")
    .action(async (sessionId: string, messageParts: string[], _options, command) => {
      const configPath = getConfigPath(command.parent as Command);
      const payload: SendMessageRequest = { message: messageParts.join(" ") };
      printJson(
        await postJson<SessionView>(cliEntrypoint, `/sessions/${sessionId}/send`, payload, configPath),
      );
    });

  program
    .command("kill")
    .argument("<sessionId>", "Session id")
    .action(async (sessionId: string, _options, command) => {
      const configPath = getConfigPath(command.parent as Command);
      printJson(await postJson<SessionView>(cliEntrypoint, `/sessions/${sessionId}/kill`, {}, configPath));
    });

  program
    .command("info")
    .action(async (_options, command) => {
      const configPath = getConfigPath(command.parent as Command);
      printJson(await getJson<RuntimeInfo>(cliEntrypoint, "/info", configPath));
    });

  program
    .command("daemon")
    .description("Internal daemon commands")
    .command("start")
    .description("Start the local daemon")
    .action(async (_options: unknown, command: Command) => {
      const configPath = getConfigPath(command.parent?.parent as Command);
      const service = await startServer(configPath);
      printJson(service.info());
    });

  try {
    await program.parseAsync(process.argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  }
}

void run();
