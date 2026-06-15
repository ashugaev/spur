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
    expect(help).toContain("doctor [options]");
    expect(help).toContain("spawn [options] <project> [prompt...]");
    expect(help).toContain("list|ls [options]");
    expect(help).toContain("send [options] <sessionId> <message...>");
    expect(help).toContain("pause [options] <sessionId>");
    expect(help).toContain("complete [options] <sessionId>");
    expect(help).toContain("kill [options] <sessionId>");
    expect(help).toContain("respawn [options] <sessionId>");
    expect(help).toContain("session-memory <sessionId>");
    expect(help).toContain("service");
    expect(help).toContain("Use `spur <command> --help` for per-command details.");
    expect(help).not.toContain("help [command]");
    expect(help).not.toContain("daemon");
    expect(help).not.toContain("slots");
    expect(help).not.toContain("memory [options]");
    expect(help).not.toContain("internal");
  });

  it("documents the doctor scaffold flow and follow-up command path", () => {
    const program = buildProgram();
    const doctor = program.commands.find((command) => command.name() === "doctor");

    expect(doctor).toBeDefined();
    if (!doctor) {
      throw new Error("Expected doctor command to be registered");
    }

    const help = doctor.helpInformation();

    expect(help).toContain("Scaffold a local Spur project config for this checkout.");
    expect(help).toContain("--json");
    expect(help).toContain("Writes a local `spur.yaml` for the current repo");
    expect(help).toContain("Run `spur list` or `spur spawn` next");
  });

  it("renders subcommand help with compact sections and inherited globals", () => {
    const program = buildProgram();
    const list = program.commands.find((command) => command.name() === "list");

    expect(list).toBeDefined();
    if (!list) {
      throw new Error("Expected list command to be registered");
    }

    const help = list.helpInformation();

    expect(list.aliases()).toContain("ls");
    expect(help).toContain("𖤓 list");
    expect(help).toContain("Usage");
    expect(help).toContain("list|ls [options]");
    expect(help).toContain("Options");
    expect(help).toContain("--json");
    expect(help).toContain("Global Options");
    expect(help).toContain("--config <path>");
    expect(help).toContain(
      "On a TTY, this opens the live selector instead of printing a one-shot list.",
    );
    expect(help).toContain(
      "TTY keys: ↑↓ move, Enter attach, l logs, d sidecar, p pause, c complete, r restore, s respawn (again after dirty warning), k kill, Ctrl+G detach, Esc quit.",
    );
    expect(help).toContain(
      "Risky kill requires a second `k` when the worktree is dirty or has unpushed commits.",
    );
    expect(help).not.toContain("help [command]");
  });

  it("documents spawn branch and current workspace flags", () => {
    const program = buildProgram();
    const spawn = program.commands.find((command) => command.name() === "spawn");

    expect(spawn).toBeDefined();
    if (!spawn) {
      throw new Error("Expected spawn command to be registered");
    }

    const help = spawn.helpInformation();

    expect(help).toContain("--branch <name>");
    expect(help).toContain("--agent <name>");
    expect(help).toContain("--plan");
    expect(help).toContain("--step <label>");
    expect(help).toContain("--worktree [defaultBranch]");
    expect(help).toContain("--shared");
    expect(help).toContain("Agent to start: claude, codex, or cursor");
    expect(help).toContain("Add a pipeline step; repeatable");
    expect(help).toContain("Start in plan mode");
    expect(help).toContain("adds a planning-only prompt");
    expect(help).toContain("Use the project path directly for this session (no worktree)");
    expect(help).toContain(
      "If the project enables spawn preflight, worktree spawns can derive a branch before worktree creation.",
    );
    expect(help).toContain("`--branch` bypasses any configured preflight branch suggestion.");
    expect(help).toContain("`--shared` cannot be combined with `--worktree` or `--branch`.");
  });

  it("documents the session-bound service helper flow", () => {
    const program = buildProgram();
    const service = program.commands.find((command) => command.name() === "service");

    expect(service).toBeDefined();
    if (!service) {
      throw new Error("Expected service command to be registered");
    }

    const help = service.helpInformation();

    expect(help).toContain("Run and inspect session-bound sidecar services.");
    expect(help).toContain("run");
    expect(help).toContain("logs");
    expect(help).toContain("status");
    expect(help).not.toContain("attach");
  });

  it("documents the optional service port flag", () => {
    const program = buildProgram();
    const service = program.commands.find((command) => command.name() === "service");
    const run = service?.commands.find((command) => command.name() === "run");

    expect(run).toBeDefined();
    if (!run) {
      throw new Error("Expected service run command to be registered");
    }

    const help = run.helpInformation();

    expect(help).toContain("--port <number>");
  });

  it("documents exact session-memory commands without aliases", () => {
    const program = buildProgram();
    const sessionMemory = program.commands.find((command) => command.name() === "session-memory");
    const genericMemory = program.commands.find((command) => command.name() === "memory");

    expect(sessionMemory).toBeDefined();
    expect(genericMemory).toBeUndefined();
    if (!sessionMemory) {
      throw new Error("Expected session-memory command to be registered");
    }

    expect(sessionMemory.aliases()).toEqual([]);
    expect(sessionMemory.commands).toEqual([]);

    const help = sessionMemory.helpInformation();
    expect(help).toContain("session-memory <sessionId> <list|get|set|resolve> [key] [body]");
    expect(help).toContain(
      "Exact forms: `spur session-memory <sessionId> list`, `get <key>`, `set <key> <body>`, `resolve <key>`.",
    );
    expect(help).toContain("Session memory is daemon-managed and scoped to one existing session id.");
  });
});
