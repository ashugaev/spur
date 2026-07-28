import type * as ChildProcess from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
    // Pin HOME to a controlled temp home whose `.npmrc` already carries a
    // matching `prefix=` line, so `ensureNpmGlobalPrefixConfigured` skips the
    // heal write here and these tests keep asserting only the `--tailscale`
    // forwarding, independent of this host's real `~/.npmrc`.
    fakeHome = await mkdtemp(join(tmpdir(), "spur-host-install-tailscale-home-"));
    process.env["HOME"] = fakeHome;
    await writeFile(join(fakeHome, ".npmrc"), `prefix=${join(fakeHome, ".local")}\n`, "utf8");
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

  it("issues npm config set prefix before bash <script> when .npmrc has no prefix= line", async () => {
    await writeFile(join(fakeHome, ".npmrc"), "//registry.npmjs.org/:_authToken=fake\n", "utf8");
    runNpmInit(cliEntrypoint, {});
    expect(execFileSyncCalls).toHaveLength(2);
    expect(execFileSyncCalls[0]).toMatchObject({
      command: "npm",
      args: [
        "config",
        "set",
        "prefix",
        join(fakeHome, ".local"),
        "--userconfig",
        join(fakeHome, ".npmrc"),
      ],
    });
    expect(execFileSyncCalls[1]?.command).toBe("bash");
  });

  it("issues only the bash call when .npmrc already has a prefix= line", async () => {
    await writeFile(join(fakeHome, ".npmrc"), `prefix=${join(fakeHome, ".local")}\n`, "utf8");
    runNpmInit(cliEntrypoint, {});
    expect(execFileSyncCalls).toHaveLength(1);
    expect(execFileSyncCalls[0]?.command).toBe("bash");
  });

  it("issues only the bash call when npm_config_prefix is pinned to a different install prefix", async () => {
    await writeFile(join(fakeHome, ".npmrc"), "//registry.npmjs.org/:_authToken=fake\n", "utf8");
    process.env["npm_config_prefix"] = "/some/other/install/prefix";
    runNpmInit(cliEntrypoint, {});
    expect(execFileSyncCalls).toHaveLength(1);
    expect(execFileSyncCalls[0]?.command).toBe("bash");
  });
});
