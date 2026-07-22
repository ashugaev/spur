import { describe, expect, it } from "vitest";
import { createProgram } from "../../src/cli.js";

function buildProgram() {
  return createProgram("/tmp/dist/cli.js");
}

describe("spur reinit CLI", () => {
  it("registers the internal reinit command", () => {
    const program = buildProgram();
    const reinit = program.commands.find((command) => command.name() === "reinit");
    expect(reinit).toBeDefined();
  });

  it("hides reinit from root help", () => {
    const program = buildProgram();
    const rootHelp = program.helpInformation();
    expect(rootHelp).not.toContain("reinit");
  });
});
