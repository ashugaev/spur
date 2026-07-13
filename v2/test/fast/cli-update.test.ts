import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createProgram } from "../../src/cli.js";

function buildProgram() {
  return createProgram("/tmp/dist/cli.js");
}

const MONITOR_MODULES = [
  "../../src/update.ts",
  "../../src/update-decision.ts",
  "../../src/update-health.ts",
  "../../src/update-state.ts",
] as const;

describe("spur update CLI", () => {
  it("lists update with an optional version argument and --force flag", () => {
    const program = buildProgram();
    const update = program.commands.find((command) => command.name() === "update");
    expect(update).toBeDefined();
    if (!update) throw new Error("Expected update command to be registered");

    const help = update.helpInformation();
    expect(help).toContain("update [options] [version]");
    expect(help).toContain("--force");
    expect(help).toContain("Update Spur to a release");
  });

  it("shows update in root help but hides the internal update-monitor command", () => {
    const program = buildProgram();
    const rootHelp = program.helpInformation();
    expect(rootHelp).toContain("update [options] [version]");
    expect(rootHelp).not.toContain("update-monitor");

    const monitor = program.commands.find((command) => command.name() === "update-monitor");
    expect(monitor).toBeDefined();
  });

  it("keeps the monitor module graph free of dynamic import so a mid-rollback overwrite cannot break it", () => {
    for (const relative of MONITOR_MODULES) {
      const path = fileURLToPath(new URL(relative, import.meta.url));
      const source = readFileSync(path, "utf-8");
      expect(source).not.toContain("await import(");
      expect(source).not.toMatch(/\bimport\s*\(/);
    }
  });
});
