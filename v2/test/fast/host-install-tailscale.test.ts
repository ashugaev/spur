import type * as ChildProcess from "node:child_process";
import type * as Executable from "../../src/agents/executable.js";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface ExecFileSyncCall {
  command: string;
  args: ReadonlyArray<string>;
}

const execFileSyncCalls: ExecFileSyncCall[] = [];
const callOrder: string[] = [];
let failingCommand: string | null = null;
const findExecutableOnPathMock = vi.fn<(command: string) => string | null>();
const installHostSkillsMock = vi.fn(() => {
  callOrder.push("installHostSkills");
  return [];
});

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof ChildProcess>("node:child_process");
  return {
    ...actual,
    execFileSync: (command: string, args: ReadonlyArray<string>) => {
      execFileSyncCalls.push({ command, args: [...args] });
      callOrder.push("bash");
      if (command === failingCommand) throw new Error(`${command} failed`);
      return "";
    },
  };
});

vi.mock("../../src/agents/executable.js", async () => {
  const actual = await vi.importActual<typeof Executable>("../../src/agents/executable.js");
  return { ...actual, findExecutableOnPath: findExecutableOnPathMock };
});

// D2 safety, also T8 (see AMENDMENT A6): the fixture root from
// `writeFakeCliTree` has no `skills/` dir, so the real installer would
// already no-op here — but mock it wholesale anyway rather than rely on
// that, and to make the call itself assertable.
vi.mock("../../src/host-skills.js", () => ({
  installHostSkills: installHostSkillsMock,
  renderHostSkillWarnings: vi.fn(() => []),
}));

const { runNpmInit } = await import("../../src/host-install.js");
const { npmGlobalPrefix, npmPinConfigPath } = await import("../../src/npm-prefix.js");

beforeEach(() => {
  findExecutableOnPathMock.mockReset();
  failingCommand = null;
});

function tailscaleFlags(args: ReadonlyArray<string>): string[] {
  return args.filter((arg) => /^--(?:install-|no-)?tailscale$/.test(arg));
}

async function writeFakeCliTree(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "spur-host-install-tailscale-"));
  await mkdir(join(dir, "dist"), { recursive: true });
  await mkdir(join(dir, "scripts"), { recursive: true });
  const cliEntrypoint = join(dir, "dist", "cli.js");
  await writeFile(cliEntrypoint, "");
  await writeFile(join(dir, "scripts", "npm-init.sh"), "");
  return cliEntrypoint;
}

describe("runNpmInit --tailscale forwarding", () => {
  let cliEntrypoint: string;
  let fakeHome: string;
  const originalHome = process.env["HOME"];

  beforeEach(async () => {
    cliEntrypoint = await writeFakeCliTree();
    // Pin HOME to a controlled temp home. The heal now only ever writes the
    // Spur-owned pin file (no `npm` child), so these tests just need a real
    // temp dir for the file writes to land in, independent of this host's
    // real `~/.spur/npmrc`/`~/.npmrc`.
    fakeHome = await mkdtemp(join(tmpdir(), "spur-host-install-tailscale-home-"));
    process.env["HOME"] = fakeHome;
  });

  afterEach(async () => {
    execFileSyncCalls.length = 0;
    callOrder.length = 0;
    installHostSkillsMock.mockClear();
    if (originalHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = originalHome;
    await rm(fakeHome, { recursive: true, force: true });
  });

  it("writes the Cursor hook only after the script succeeds", async () => {
    failingCommand = "bash";
    expect(() => runNpmInit(cliEntrypoint, { noStart: true })).toThrow("bash failed");
    await expect(readFile(join(fakeHome, ".cursor", "hooks.json"))).rejects.toThrow();
    expect(installHostSkillsMock).not.toHaveBeenCalled();
  });

  it("forwards no Tailscale flag when tailscale is unset", () => {
    runNpmInit(cliEntrypoint, {});
    expect(execFileSyncCalls).toHaveLength(1);
    expect(execFileSyncCalls[0]?.command).toBe("bash");
    expect(tailscaleFlags(execFileSyncCalls[0]?.args ?? [])).toEqual([]);
  });

  it("installs Cursor metering during cold init before any session exists", async () => {
    runNpmInit(cliEntrypoint, { noStart: true });
    const hooks = JSON.parse(await readFile(join(fakeHome, ".cursor", "hooks.json"), "utf8"));
    expect(hooks.hooks.stop).toHaveLength(1);
    expect(hooks.hooks.stop[0].command).toContain("spur-cursor-token-usage.mjs");
    expect(
      await readFile(join(fakeHome, ".cursor", "spur-cursor-token-usage.mjs"), "utf8"),
    ).toContain("process.env.SPUR_SESSION");
    runNpmInit(cliEntrypoint, { noStart: true });
    expect(
      JSON.parse(await readFile(join(fakeHome, ".cursor", "hooks.json"), "utf8")).hooks.stop,
    ).toHaveLength(1);
  });

  it.each([
    ["install", "--install-tailscale"],
    ["keep", "--tailscale"],
    ["off", "--no-tailscale"],
  ] as const)("forwards exactly one flag for %s", (mode, flag) => {
    findExecutableOnPathMock.mockReturnValue("/usr/bin/tailscale");
    runNpmInit(cliEntrypoint, { tailscale: mode });
    expect(tailscaleFlags(execFileSyncCalls[0]?.args ?? [])).toEqual([flag]);
  });

  it("makes no sudo call and no sudo lookup for keep, off and unset", () => {
    for (const tailscale of ["keep", "off", undefined] as const) {
      runNpmInit(cliEntrypoint, tailscale === undefined ? {} : { tailscale });
    }
    expect(execFileSyncCalls.map((call) => call.command)).toEqual(["bash", "bash", "bash"]);
    expect(findExecutableOnPathMock).not.toHaveBeenCalled();
  });
});

describe("runNpmInit --tailscale install preflight", () => {
  const msgNoSudo =
    "npm-init: --tailscale needs root or sudo to install Tailscale; no changes made. Install it manually (https://tailscale.com/download), then re-run: spur init --tailscale";
  const msgNoTty =
    "npm-init: --tailscale needs passwordless sudo when run without a terminal; no changes made. Run spur init --tailscale from a terminal, or install Tailscale manually (https://tailscale.com/download) and re-run.";
  let cliEntrypoint: string;
  let fakeHome: string;
  const originalHome = process.env["HOME"];
  const originalGetuid = process.getuid;
  const originalIsTTY = process.stdin.isTTY;

  function setPath(installed: ReadonlyArray<string>): void {
    findExecutableOnPathMock.mockImplementation((command) =>
      installed.includes(command) ? `/usr/bin/${command}` : null,
    );
  }

  function sudoCalls(): ExecFileSyncCall[] {
    return execFileSyncCalls.filter((call) => call.command === "sudo");
  }

  async function expectNothingWritten(): Promise<void> {
    expect(execFileSyncCalls.filter((call) => call.command === "bash")).toHaveLength(0);
    await expect(readFile(npmPinConfigPath(fakeHome))).rejects.toThrow();
    await expect(readFile(join(fakeHome, ".cursor", "hooks.json"))).rejects.toThrow();
  }

  beforeEach(async () => {
    cliEntrypoint = await writeFakeCliTree();
    fakeHome = await mkdtemp(join(tmpdir(), "spur-host-install-preflight-home-"));
    process.env["HOME"] = fakeHome;
    process.getuid = () => 1000;
    process.stdin.isTTY = true;
  });

  afterEach(async () => {
    execFileSyncCalls.length = 0;
    callOrder.length = 0;
    failingCommand = null;
    if (originalHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = originalHome;
    if (originalGetuid === undefined) delete process.getuid;
    else process.getuid = originalGetuid;
    process.stdin.isTTY = originalIsTTY;
    await rm(fakeHome, { recursive: true, force: true });
  });

  it("throws before any write when Tailscale and sudo are both missing", async () => {
    setPath([]);
    expect(() => runNpmInit(cliEntrypoint, { tailscale: "install" })).toThrow(msgNoSudo);
    await expectNothingWritten();
  });

  it("throws before any write when there is no terminal and sudo -n fails", async () => {
    setPath(["sudo"]);
    process.stdin.isTTY = false;
    failingCommand = "sudo";
    expect(() => runNpmInit(cliEntrypoint, { tailscale: "install" })).toThrow(msgNoTty);
    expect(sudoCalls().map((call) => call.args)).toEqual([["-n", "true"]]);
    await expectNothingWritten();
  });

  it("runs the script once when there is no terminal and sudo -n succeeds", () => {
    setPath(["sudo"]);
    process.stdin.isTTY = false;
    runNpmInit(cliEntrypoint, { tailscale: "install" });
    expect(sudoCalls().map((call) => call.args)).toEqual([["-n", "true"]]);
    expect(execFileSyncCalls.filter((call) => call.command === "bash")).toHaveLength(1);
  });

  it("authorizes with sudo -v when sudo is present and a terminal exists", () => {
    setPath(["sudo"]);
    runNpmInit(cliEntrypoint, { tailscale: "install" });
    expect(sudoCalls().map((call) => call.args)).toEqual([["-v"]]);
    expect(execFileSyncCalls.filter((call) => call.command === "bash")).toHaveLength(1);
  });

  it("throws before any write when sudo -v fails on a terminal", async () => {
    setPath(["sudo"]);
    failingCommand = "sudo";
    expect(() => runNpmInit(cliEntrypoint, { tailscale: "install" })).toThrow(msgNoSudo);
    expect(sudoCalls().map((call) => call.args)).toEqual([["-v"]]);
    await expectNothingWritten();
  });

  it("makes no sudo call when Tailscale is already installed", () => {
    setPath(["tailscale"]);
    process.stdin.isTTY = false;
    runNpmInit(cliEntrypoint, { tailscale: "install" });
    expect(sudoCalls()).toHaveLength(0);
    expect(execFileSyncCalls).toHaveLength(1);
  });

  it("makes no sudo call for uid 0", () => {
    setPath([]);
    process.getuid = () => 0;
    process.stdin.isTTY = false;
    runNpmInit(cliEntrypoint, { tailscale: "install" });
    expect(sudoCalls()).toHaveLength(0);
    expect(execFileSyncCalls).toHaveLength(1);
  });

  it("skips the preflight under --expose-web", () => {
    setPath([]);
    runNpmInit(cliEntrypoint, { tailscale: "install", exposeWeb: true });
    expect(execFileSyncCalls).toHaveLength(1);
  });
});

describe("runNpmInit npm-prefix heal ordering", () => {
  let cliEntrypoint: string;
  let fakeHome: string;
  const originalHome = process.env["HOME"];
  const originalLower = process.env["npm_config_prefix"];
  const originalUpper = process.env["NPM_CONFIG_PREFIX"];

  beforeEach(async () => {
    cliEntrypoint = await writeFakeCliTree();
    fakeHome = await mkdtemp(join(tmpdir(), "spur-host-install-heal-home-"));
    process.env["HOME"] = fakeHome;
    delete process.env["npm_config_prefix"];
    delete process.env["NPM_CONFIG_PREFIX"];
  });

  afterEach(async () => {
    execFileSyncCalls.length = 0;
    callOrder.length = 0;
    installHostSkillsMock.mockClear();
    if (originalHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = originalHome;
    if (originalLower === undefined) delete process.env["npm_config_prefix"];
    else process.env["npm_config_prefix"] = originalLower;
    if (originalUpper === undefined) delete process.env["NPM_CONFIG_PREFIX"];
    else process.env["NPM_CONFIG_PREFIX"] = originalUpper;
    await rm(fakeHome, { recursive: true, force: true });
  });

  it("issues only the bash call — the heal is a pure filesystem write, never an npm child", async () => {
    await writeFile(join(fakeHome, ".npmrc"), "//registry.npmjs.org/:_authToken=fake\n", "utf8");
    runNpmInit(cliEntrypoint, {});
    expect(execFileSyncCalls).toHaveLength(1);
    expect(execFileSyncCalls[0]?.command).toBe("bash");
  });

  // MUST FIX 2 regression guard: `ensureNpmPinFile` no longer skips its write
  // behind an explicit prefix pin — `buildSessionEnv` points
  // `NPM_CONFIG_GLOBALCONFIG` at this file unconditionally, so skipping the
  // write left it dangling at a missing file. The write still resolves to
  // `<home>/.local` (never the overridden value); npm's env layer outranks
  // it regardless.
  it("still writes the pin file (content <home>/.local) when npm_config_prefix is pinned to a different install prefix", async () => {
    await writeFile(join(fakeHome, ".npmrc"), "//registry.npmjs.org/:_authToken=fake\n", "utf8");
    process.env["npm_config_prefix"] = "/some/other/install/prefix";
    runNpmInit(cliEntrypoint, {});
    expect(execFileSyncCalls).toHaveLength(1);
    expect(execFileSyncCalls[0]?.command).toBe("bash");
    const pinContents = await readFile(npmPinConfigPath(fakeHome), "utf8");
    expect(pinContents).toBe(`prefix=${npmGlobalPrefix(fakeHome)}\n`);
  });
});

// T8 (see AMENDMENT A6): the host-skill install hook inside `runNpmInit`.
describe("runNpmInit host skill install hook", () => {
  let cliEntrypoint: string;
  let fakeHome: string;
  const originalHome = process.env["HOME"];

  beforeEach(async () => {
    cliEntrypoint = await writeFakeCliTree();
    fakeHome = await mkdtemp(join(tmpdir(), "spur-host-install-skills-home-"));
    process.env["HOME"] = fakeHome;
  });

  afterEach(async () => {
    execFileSyncCalls.length = 0;
    callOrder.length = 0;
    installHostSkillsMock.mockClear();
    installHostSkillsMock.mockImplementation(() => {
      callOrder.push("installHostSkills");
      return [];
    });
    if (originalHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = originalHome;
    await rm(fakeHome, { recursive: true, force: true });
  });

  it("calls installHostSkills exactly once, after the bash execFileSync call", () => {
    runNpmInit(cliEntrypoint, {});
    expect(installHostSkillsMock).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual(["bash", "installHostSkills"]);
  });

  it("leaves runNpmInit resolving normally when the installer throws", () => {
    installHostSkillsMock.mockImplementation(() => {
      throw new Error("boom");
    });
    expect(() => runNpmInit(cliEntrypoint, {})).not.toThrow();
    expect(execFileSyncCalls).toHaveLength(1);
  });
});
