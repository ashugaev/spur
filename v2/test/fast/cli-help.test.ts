import { describe, expect, it } from "vitest";
import { createProgram } from "../../src/cli.js";

function buildProgram() {
  return createProgram("/tmp/dist/cli.js");
}

describe("spur help", () => {
  it("renders branded root help without implicit or internal commands", () => {
    const help = buildProgram().helpInformation();

    expect(help).toContain("𖤓 Spur");
    expect(help).toContain("Usage");
    expect(help).toContain("Commands");
    expect(help).toContain("spawn [options] <project> <prompt...>");
    expect(help).toContain("list [options]");
    expect(help).toContain("send [options] <sessionId> <message...>");
    expect(help).toContain("Use `spur <command> --help` for per-command details.");
    expect(help).not.toContain("help [command]");
    expect(help).not.toContain("daemon");
  });

  it("renders subcommand help with compact sections and inherited globals", () => {
    const program = buildProgram();
    const list = program.commands.find((command) => command.name() === "list");

    expect(list).toBeDefined();

    const help = list!.helpInformation();

    expect(help).toContain("𖤓 list");
    expect(help).toContain("Usage");
    expect(help).toContain("Options");
    expect(help).toContain("--json");
    expect(help).toContain("Global Options");
    expect(help).toContain("--config <path>");
    expect(help).toContain("On a TTY, this opens the live selector instead of printing a one-shot list.");
    expect(help).not.toContain("help [command]");
  });
});
