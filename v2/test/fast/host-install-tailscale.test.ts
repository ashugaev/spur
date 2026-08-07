import type * as ChildProcess from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface ExecFileSyncCall {
  command: string;
  args: ReadonlyArray<string>;
}

const execFileSyncCalls: ExecFileSyncCall[] = [];

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof ChildProcess>("node:child_process");
  return {
    ...actual,
    execFileSync: (command: string, args: ReadonlyArray<string>) => {
      execFileSyncCalls.push({ command, args: [...args] });
      return "";
    },
  };
});

const { runNpmInit } = await import("../../src/host-install.js");
const { npmGlobalPrefix, npmPinConfigPath } = await import("../../src/npm-prefix.js");

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
    if (originalHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = originalHome;
    await rm(fakeHome, { recursive: true, force: true });
  });

  it("forwards --tailscale by default (tailscale unset)", () => {
    runNpmInit(cliEntrypoint, {});
    expect(execFileSyncCalls).toHaveLength(1);
    expect(execFileSyncCalls[0]?.command).toBe("bash");
    expect(execFileSyncCalls[0]?.args).toContain("--tailscale");
    expect(execFileSyncCalls[0]?.args).not.toContain("--no-tailscale");
  });

  it("forwards --tailscale when explicitly true", () => {
    runNpmInit(cliEntrypoint, { tailscale: true });
    expect(execFileSyncCalls[0]?.args).toContain("--tailscale");
  });

  it("forwards --no-tailscale when explicitly false", () => {
    runNpmInit(cliEntrypoint, { tailscale: false });
    expect(execFileSyncCalls[0]?.args).toContain("--no-tailscale");
    expect(execFileSyncCalls[0]?.args).not.toContain("--tailscale");
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
