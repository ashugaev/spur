import { Command, CommanderError } from "commander";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { registerReviewApp } from "./review-app.js";

export function createReviewAppProgram(): Command {
  const program = new Command()
    .name("spur-review-app")
    .description("Spur reviewer App commands.")
    .helpCommand(false)
    .exitOverride();
  registerReviewApp(program);
  return program;
}

// Validate the registered tree before Commander's help short-circuit.
function validateArguments(program: Command, argv: string[]): void {
  let command = program;
  for (let index = 2; index < argv.length; index++) {
    const token = argv[index];
    if (token === undefined || token === "--help" || token === "-h") continue;
    const child = command.commands.find((value) => value.name() === token);
    if (child) {
      command = child;
      continue;
    }
    const flag = token.split("=", 1)[0];
    const option = command.options.find((value) => value.long === flag || value.short === flag);
    if (!option) command.error(`unknown argument '${token}'`);
    if (option.required && !token.includes("=")) index++;
  }
}

export async function run(argv = process.argv): Promise<void> {
  const program = createReviewAppProgram();
  try {
    validateArguments(program, argv);
    await program.parseAsync(argv);
  } catch (error) {
    if (error instanceof CommanderError) {
      process.exitCode = error.exitCode;
      return;
    }
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  void run();
}
