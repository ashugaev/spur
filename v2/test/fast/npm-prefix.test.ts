import type * as ChildProcess from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface ExecFileSyncCall {
  command: string;
  args: readonly string[];
}

const execFileSyncCalls: ExecFileSyncCall[] = [];

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof ChildProcess>("node:child_process");
  return {
    ...actual,
    execFileSync: (command: string, args: readonly string[]) => {
      execFileSyncCalls.push({ command, args: [...args] });
      return "";
    },
  };
});

const { NPM_PREFIX_ENV, npmGlobalPrefix, ensureNpmGlobalPrefixConfigured } =
  await import("../../src/npm-prefix.js");
const actualChildProcess = await vi.importActual<typeof ChildProcess>("node:child_process");

const TOKEN_ONLY_NPMRC = "//registry.npmjs.org/:_authToken=fake-token\n";

describe("npmGlobalPrefix", () => {
  it("derives <home>/.local from the given home, never a hardcoded username", () => {
    expect(npmGlobalPrefix("/home/someone-else")).toBe(join("/home/someone-else", ".local"));
    expect(npmGlobalPrefix("/home/a-different-account")).toBe(
      join("/home/a-different-account", ".local"),
    );
  });
});

// Load-bearing proof for the whole feature: with a real npm binary, a
// token-only `.npmrc` (the observed clobber shape) resolves away from
// `<HOME>/.local` on its own, and `NPM_CONFIG_PREFIX` overrides that back to
// `<HOME>/.local` — the exact mechanism `ensureNpmGlobalPrefixConfigured` and
// `buildSessionEnv` rely on. Runs a real `npm` child process (measured
// ~0.11s), never touches this host's real `$HOME`.
describe("real npm config get prefix under a token-only ~/.npmrc", () => {
  let tmpHome: string;

  beforeEach(async () => {
    tmpHome = await mkdtemp(join(tmpdir(), "spur-npm-prefix-real-"));
    await writeFile(join(tmpHome, ".npmrc"), TOKEN_ONLY_NPMRC, "utf8");
  });

  afterEach(async () => {
    await rm(tmpHome, { recursive: true, force: true });
  });

  it("resolves away from <HOME>/.local when the env var is unset", () => {
    const expected = npmGlobalPrefix(tmpHome);
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: tmpHome };
    delete env["NPM_CONFIG_PREFIX"];
    delete env["npm_config_prefix"];
    const result = actualChildProcess
      .execFileSync("npm", ["config", "get", "prefix"], { env, encoding: "utf8" })
      .trim();
    expect(result).not.toBe(expected);
  });

  it("resolves to <HOME>/.local when NPM_CONFIG_PREFIX is injected", () => {
    const expected = npmGlobalPrefix(tmpHome);
    const env = { ...process.env, HOME: tmpHome, [NPM_PREFIX_ENV]: expected };
    const result = actualChildProcess
      .execFileSync("npm", ["config", "get", "prefix"], { env, encoding: "utf8" })
      .trim();
    expect(result).toBe(expected);
  });
});

describe("ensureNpmGlobalPrefixConfigured", () => {
  let tmpHome: string;
  const originalLower = process.env["npm_config_prefix"];
  const originalUpper = process.env["NPM_CONFIG_PREFIX"];

  beforeEach(async () => {
    tmpHome = await mkdtemp(join(tmpdir(), "spur-npm-prefix-heal-"));
    execFileSyncCalls.length = 0;
    delete process.env["npm_config_prefix"];
    delete process.env["NPM_CONFIG_PREFIX"];
  });

  afterEach(async () => {
    await rm(tmpHome, { recursive: true, force: true });
    if (originalLower === undefined) delete process.env["npm_config_prefix"];
    else process.env["npm_config_prefix"] = originalLower;
    if (originalUpper === undefined) delete process.env["NPM_CONFIG_PREFIX"];
    else process.env["NPM_CONFIG_PREFIX"] = originalUpper;
  });

  it("writes npm config set prefix when .npmrc has no prefix= line", async () => {
    await writeFile(join(tmpHome, ".npmrc"), TOKEN_ONLY_NPMRC, "utf8");
    ensureNpmGlobalPrefixConfigured(tmpHome);
    expect(execFileSyncCalls).toEqual([
      {
        command: "npm",
        args: [
          "config",
          "set",
          "prefix",
          npmGlobalPrefix(tmpHome),
          "--userconfig",
          join(tmpHome, ".npmrc"),
        ],
      },
    ]);
  });

  it("writes npm config set prefix when .npmrc does not exist at all", () => {
    ensureNpmGlobalPrefixConfigured(tmpHome);
    expect(execFileSyncCalls).toEqual([
      {
        command: "npm",
        args: [
          "config",
          "set",
          "prefix",
          npmGlobalPrefix(tmpHome),
          "--userconfig",
          join(tmpHome, ".npmrc"),
        ],
      },
    ]);
  });

  it("writes nothing when .npmrc already has a prefix= line (operator value never overwritten)", async () => {
    await writeFile(join(tmpHome, ".npmrc"), "prefix=/some/operator/path\n", "utf8");
    ensureNpmGlobalPrefixConfigured(tmpHome);
    expect(execFileSyncCalls).toEqual([]);
  });

  it("writes nothing when npm_config_prefix is pinned to a different value", async () => {
    await writeFile(join(tmpHome, ".npmrc"), TOKEN_ONLY_NPMRC, "utf8");
    process.env["npm_config_prefix"] = "/different/install/prefix";
    ensureNpmGlobalPrefixConfigured(tmpHome);
    expect(execFileSyncCalls).toEqual([]);
  });

  it("writes nothing when NPM_CONFIG_PREFIX is pinned to a different value", async () => {
    await writeFile(join(tmpHome, ".npmrc"), TOKEN_ONLY_NPMRC, "utf8");
    process.env["NPM_CONFIG_PREFIX"] = "/different/install/prefix";
    ensureNpmGlobalPrefixConfigured(tmpHome);
    expect(execFileSyncCalls).toEqual([]);
  });

  it("still heals when the pinned prefix already matches <home>/.local (spur update's own reinit pin)", async () => {
    await writeFile(join(tmpHome, ".npmrc"), TOKEN_ONLY_NPMRC, "utf8");
    process.env["npm_config_prefix"] = npmGlobalPrefix(tmpHome);
    ensureNpmGlobalPrefixConfigured(tmpHome);
    expect(execFileSyncCalls).toEqual([
      {
        command: "npm",
        args: [
          "config",
          "set",
          "prefix",
          npmGlobalPrefix(tmpHome),
          "--userconfig",
          join(tmpHome, ".npmrc"),
        ],
      },
    ]);
  });
});
