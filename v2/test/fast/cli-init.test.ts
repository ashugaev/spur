import { describe, expect, it } from "vitest";
import { createProgram } from "../../src/cli.js";

function buildProgram() {
  return createProgram("/tmp/dist/cli.js");
}

describe("spur init CLI", () => {
  it("documents --tailscale/--no-tailscale alongside the other init flags", () => {
    const program = buildProgram();
    const init = program.commands.find((command) => command.name() === "init");
    expect(init).toBeDefined();
    if (!init) throw new Error("Expected init command to be registered");

    const help = init.helpInformation();
    expect(help).toContain("--no-tailscale");
    expect(help).toContain("--expose-web");
    expect(help).toContain("--web-port");
  });

  it("defaults tailscale on and flips off with --no-tailscale", () => {
    const program = buildProgram();
    const init = program.commands.find((command) => command.name() === "init");
    if (!init) throw new Error("Expected init command to be registered");

    init.parseOptions([]);
    expect(init.opts()["tailscale"]).toBe(true);

    init.parseOptions(["--no-tailscale"]);
    expect(init.opts()["tailscale"]).toBe(false);
  });
});
