import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as HostInstall from "../../src/host-install.js";

const runNpmInitMock = vi.fn();

vi.mock("../../src/host-install.js", async () => {
  const actual = await vi.importActual<typeof HostInstall>("../../src/host-install.js");
  return { ...actual, runNpmInit: runNpmInitMock };
});

const { createProgram } = await import("../../src/cli.js");

function buildProgram() {
  return createProgram("/tmp/dist/cli.js");
}

function initCommand(program: ReturnType<typeof buildProgram>) {
  const init = program.commands.find((command) => command.name() === "init");
  if (!init) throw new Error("Expected init command to be registered");
  return init;
}

describe("spur init CLI", () => {
  it("documents --tailscale/--no-tailscale alongside the other init flags", () => {
    const help = initCommand(buildProgram()).helpInformation();
    expect(help).toContain("--tailscale");
    expect(help).toContain("--no-tailscale");
    expect(help).toContain("--expose-web");
    expect(help).toContain("--web-port");
  });

  it("leaves tailscale undefined without a flag, true with --tailscale, false with --no-tailscale", () => {
    const init = initCommand(buildProgram());
    init.parseOptions([]);
    expect(init.opts()["tailscale"]).toBeUndefined();
    init.parseOptions(["--tailscale"]);
    expect(init.opts()["tailscale"]).toBe(true);
    init.parseOptions(["--no-tailscale"]);
    expect(init.opts()["tailscale"]).toBe(false);
  });
});

describe("spur init action Tailscale mode", () => {
  let home: string;
  const originalHome = process.env["HOME"];
  const originalXdg = process.env["XDG_CONFIG_HOME"];

  async function writeBoundUnit(): Promise<void> {
    const unitDir = join(home, ".config", "systemd", "user");
    await mkdir(unitDir, { recursive: true });
    await writeFile(
      join(unitDir, "spur-daemon.service"),
      "[Service]\nExecStart=/usr/bin/node cli.js\n",
    );
    await writeFile(
      join(unitDir, "spur-web.service"),
      "[Service]\nEnvironment=PORT=5555\nEnvironment=WEB_HOST=127.0.0.1,100.64.1.2\n",
    );
  }

  async function runInit(...args: string[]): Promise<void> {
    const program = buildProgram();
    // Subcommands copy settings when created, so override init itself.
    program.exitOverride();
    initCommand(program).exitOverride();
    await program.parseAsync(["node", "spur", "init", ...args]);
  }

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "spur-cli-init-home-"));
    process.env["HOME"] = home;
    delete process.env["XDG_CONFIG_HOME"];
    runNpmInitMock.mockReset();
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = originalHome;
    if (originalXdg === undefined) delete process.env["XDG_CONFIG_HOME"];
    else process.env["XDG_CONFIG_HOME"] = originalXdg;
    await rm(home, { recursive: true, force: true });
  });

  it("passes no tailscale mode when no flag is given and no tailnet bind exists", async () => {
    await runInit();
    expect(runNpmInitMock.mock.calls[0]?.[1]).not.toHaveProperty("tailscale");
  });

  it("passes keep, never install, when no flag is given and the unit has a tailnet bind", async () => {
    await writeBoundUnit();
    await runInit();
    expect(runNpmInitMock.mock.calls[0]?.[1]).toMatchObject({ tailscale: "keep" });
  });

  it("passes install for --tailscale even with a tailnet bind", async () => {
    await writeBoundUnit();
    await runInit("--tailscale");
    expect(runNpmInitMock.mock.calls[0]?.[1]).toMatchObject({ tailscale: "install" });
  });

  it("passes off for --no-tailscale even with a tailnet bind", async () => {
    await writeBoundUnit();
    await runInit("--no-tailscale");
    expect(runNpmInitMock.mock.calls[0]?.[1]).toMatchObject({ tailscale: "off" });
  });

  it.each([
    ["--tailscale", "--no-tailscale"],
    ["--no-tailscale", "--tailscale"],
  ])("rejects %s with %s as a usage error", async (first, second) => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await expect(runInit(first, second)).rejects.toMatchObject({
        exitCode: 2,
        message: "spur init: --tailscale and --no-tailscale cannot be used together",
      });
    } finally {
      stderr.mockRestore();
    }
    expect(runNpmInitMock).not.toHaveBeenCalled();
  });
});
