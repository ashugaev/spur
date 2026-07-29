import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  NPM_GLOBALCONFIG_ENV,
  NPM_PREFIX_ENV,
  npmGlobalPrefix,
  npmPinConfigPath,
  ensureNpmGlobalPrefixConfigured,
  ensureNpmPinFile,
  ensureNpmPinFileTolerant,
  healNpmrcPrefixLine,
} from "../../src/npm-prefix.js";

const TOKEN_ONLY_NPMRC = "//registry.npmjs.org/:_authToken=fake-token\n";

describe("npmGlobalPrefix", () => {
  it("derives <home>/.local from the given home, never a hardcoded username", () => {
    expect(npmGlobalPrefix("/home/someone-else")).toBe(join("/home/someone-else", ".local"));
    expect(npmGlobalPrefix("/home/a-different-account")).toBe(
      join("/home/a-different-account", ".local"),
    );
  });
});

describe("npmPinConfigPath", () => {
  it("derives <home>/.spur/npmrc from the given home", () => {
    expect(npmPinConfigPath("/home/someone-else")).toBe(
      join("/home/someone-else", ".spur", "npmrc"),
    );
  });
});

// Load-bearing proof for the whole feature: with a real npm binary, a
// token-only `.npmrc` (the observed clobber shape) resolves away from
// `<HOME>/.local` on its own, and pointing `NPM_CONFIG_GLOBALCONFIG` at a
// file containing `prefix=<HOME>/.local` resolves back to it — the exact
// mechanism `ensureNpmGlobalPrefixConfigured` and `buildSessionEnv` rely on,
// invisible to nvm's env-name guard (which matches only `NPM_CONFIG_PREFIX`/
// `PREFIX`). Runs a real `npm` child process, never touches this host's real
// `$HOME`.
describe("real npm root -g under a token-only ~/.npmrc plus a globalconfig pin", () => {
  let tmpHome: string;

  beforeEach(async () => {
    tmpHome = await mkdtemp(join(tmpdir(), "spur-npm-prefix-real-"));
    await writeFile(join(tmpHome, ".npmrc"), TOKEN_ONLY_NPMRC, "utf8");
  });

  afterEach(async () => {
    await rm(tmpHome, { recursive: true, force: true });
  });

  it("resolves away from <HOME>/.local when no globalconfig pin is set", () => {
    const expected = npmGlobalPrefix(tmpHome);
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: tmpHome };
    Reflect.deleteProperty(env, NPM_PREFIX_ENV);
    delete env["npm_config_prefix"];
    Reflect.deleteProperty(env, NPM_GLOBALCONFIG_ENV);
    delete env["npm_config_globalconfig"];
    const result = execFileSync("npm", ["root", "-g"], { env, encoding: "utf8" }).trim();
    expect(result).not.toBe(join(expected, "lib", "node_modules"));
  });

  it("resolves to <HOME>/.local/lib/node_modules when NPM_CONFIG_GLOBALCONFIG points at a pin file", async () => {
    const expected = npmGlobalPrefix(tmpHome);
    const pinFile = join(tmpHome, "pin-npmrc");
    await writeFile(pinFile, `prefix=${expected}\n`, "utf8");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: tmpHome,
      [NPM_GLOBALCONFIG_ENV]: pinFile,
    };
    Reflect.deleteProperty(env, NPM_PREFIX_ENV);
    delete env["npm_config_prefix"];
    delete env["npm_config_globalconfig"];
    const result = execFileSync("npm", ["root", "-g"], { env, encoding: "utf8" }).trim();
    expect(result).toBe(join(expected, "lib", "node_modules"));
  });
});

describe("ensureNpmGlobalPrefixConfigured", () => {
  let tmpHome: string;
  const originalLower = process.env["npm_config_prefix"];
  const originalUpper = process.env[NPM_PREFIX_ENV];

  beforeEach(async () => {
    tmpHome = await mkdtemp(join(tmpdir(), "spur-npm-prefix-heal-"));
    delete process.env["npm_config_prefix"];
    Reflect.deleteProperty(process.env, NPM_PREFIX_ENV);
  });

  afterEach(async () => {
    await rm(tmpHome, { recursive: true, force: true });
    if (originalLower === undefined) delete process.env["npm_config_prefix"];
    else process.env["npm_config_prefix"] = originalLower;
    if (originalUpper === undefined) Reflect.deleteProperty(process.env, NPM_PREFIX_ENV);
    else process.env[NPM_PREFIX_ENV] = originalUpper;
  });

  it("writes the pin file when .npmrc has no prefix= line, and writes no prefix= into .npmrc", async () => {
    await writeFile(join(tmpHome, ".npmrc"), TOKEN_ONLY_NPMRC, "utf8");
    ensureNpmGlobalPrefixConfigured(tmpHome);

    const pinPath = npmPinConfigPath(tmpHome);
    const pinContents = await readFile(pinPath, "utf8");
    expect(pinContents).toBe(`prefix=${npmGlobalPrefix(tmpHome)}\n`);
    // AC1: pin file must be mode 0600 — it is Spur-owned config outside the
    // user's own `~/.npmrc`, no reason for group/other access.
    expect(statSync(pinPath).mode & 0o777).toBe(0o600);

    const npmrcContents = await readFile(join(tmpHome, ".npmrc"), "utf8");
    expect(npmrcContents).toBe(TOKEN_ONLY_NPMRC);
    expect(npmrcContents).not.toMatch(/^\s*prefix\s*=/m);
  });

  it("writes the pin file when .npmrc does not exist at all", async () => {
    ensureNpmGlobalPrefixConfigured(tmpHome);
    const pinContents = await readFile(npmPinConfigPath(tmpHome), "utf8");
    expect(pinContents).toBe(`prefix=${npmGlobalPrefix(tmpHome)}\n`);
  });

  it("removes a pre-existing Spur-authored prefix= line, keeping the _authToken line byte-identical", async () => {
    const tokenLine = "//registry.npmjs.org/:_authToken=fake-token\n";
    await writeFile(
      join(tmpHome, ".npmrc"),
      `${tokenLine}prefix=${npmGlobalPrefix(tmpHome)}\n`,
      "utf8",
    );
    ensureNpmGlobalPrefixConfigured(tmpHome);

    const npmrcContents = await readFile(join(tmpHome, ".npmrc"), "utf8");
    expect(npmrcContents).toBe(tokenLine);
  });

  it("preserves an operator-set prefix= line pointing elsewhere", async () => {
    const operatorNpmrc = "prefix=/some/operator/path\n";
    await writeFile(join(tmpHome, ".npmrc"), operatorNpmrc, "utf8");
    ensureNpmGlobalPrefixConfigured(tmpHome);

    const npmrcContents = await readFile(join(tmpHome, ".npmrc"), "utf8");
    expect(npmrcContents).toBe(operatorNpmrc);
    // Still writes the pin file — the operator's `~/.npmrc` value is a
    // separate, higher-precedence npm layer this heal never targets.
    const pinContents = await readFile(npmPinConfigPath(tmpHome), "utf8");
    expect(pinContents).toBe(`prefix=${npmGlobalPrefix(tmpHome)}\n`);
  });

  it("writes nothing when npm_config_prefix is pinned to a different value", async () => {
    await writeFile(join(tmpHome, ".npmrc"), TOKEN_ONLY_NPMRC, "utf8");
    process.env["npm_config_prefix"] = "/different/install/prefix";
    ensureNpmGlobalPrefixConfigured(tmpHome);

    await expect(readFile(npmPinConfigPath(tmpHome), "utf8")).rejects.toThrow(/ENOENT/);
    const npmrcContents = await readFile(join(tmpHome, ".npmrc"), "utf8");
    expect(npmrcContents).toBe(TOKEN_ONLY_NPMRC);
  });

  it("writes nothing when NPM_CONFIG_PREFIX is pinned to a different value", async () => {
    await writeFile(join(tmpHome, ".npmrc"), TOKEN_ONLY_NPMRC, "utf8");
    process.env[NPM_PREFIX_ENV] = "/different/install/prefix";
    ensureNpmGlobalPrefixConfigured(tmpHome);

    await expect(readFile(npmPinConfigPath(tmpHome), "utf8")).rejects.toThrow(/ENOENT/);
  });

  it("still heals when the pinned prefix already matches <home>/.local (spur update's own reinit pin)", async () => {
    await writeFile(join(tmpHome, ".npmrc"), TOKEN_ONLY_NPMRC, "utf8");
    process.env["npm_config_prefix"] = npmGlobalPrefix(tmpHome);
    ensureNpmGlobalPrefixConfigured(tmpHome);

    const pinContents = await readFile(npmPinConfigPath(tmpHome), "utf8");
    expect(pinContents).toBe(`prefix=${npmGlobalPrefix(tmpHome)}\n`);
  });
});

// MUST FIX 1: `ensureNpmGlobalPrefixConfigured` split so the pin-file write
// (boot-safe, called on every daemon start) and the `~/.npmrc` heal
// (`runNpmInit`-only, never on every boot) are independently callable.
describe("ensureNpmPinFile (boot-safe half)", () => {
  let tmpHome: string;
  const originalLower = process.env["npm_config_prefix"];
  const originalUpper = process.env[NPM_PREFIX_ENV];

  beforeEach(async () => {
    tmpHome = await mkdtemp(join(tmpdir(), "spur-npm-prefix-pinfile-"));
    delete process.env["npm_config_prefix"];
    Reflect.deleteProperty(process.env, NPM_PREFIX_ENV);
  });

  afterEach(async () => {
    await rm(tmpHome, { recursive: true, force: true });
    if (originalLower === undefined) delete process.env["npm_config_prefix"];
    else process.env["npm_config_prefix"] = originalLower;
    if (originalUpper === undefined) Reflect.deleteProperty(process.env, NPM_PREFIX_ENV);
    else process.env[NPM_PREFIX_ENV] = originalUpper;
  });

  it("writes the pin file and never touches .npmrc, even when .npmrc carries a Spur-authored prefix= line", async () => {
    const npmrcWithSpurLine = `//registry.npmjs.org/:_authToken=fake-token\nprefix=${npmGlobalPrefix(tmpHome)}\n`;
    await writeFile(join(tmpHome, ".npmrc"), npmrcWithSpurLine, "utf8");

    ensureNpmPinFile(tmpHome);

    const pinContents = await readFile(npmPinConfigPath(tmpHome), "utf8");
    expect(pinContents).toBe(`prefix=${npmGlobalPrefix(tmpHome)}\n`);
    // The heal half never ran — the .npmrc byte content is unchanged.
    const npmrcContents = await readFile(join(tmpHome, ".npmrc"), "utf8");
    expect(npmrcContents).toBe(npmrcWithSpurLine);
  });

  it("is idempotent across repeated calls (safe to call on every daemon restart)", async () => {
    ensureNpmPinFile(tmpHome);
    ensureNpmPinFile(tmpHome);
    ensureNpmPinFile(tmpHome);

    const pinContents = await readFile(npmPinConfigPath(tmpHome), "utf8");
    expect(pinContents).toBe(`prefix=${npmGlobalPrefix(tmpHome)}\n`);
  });

  it("writes nothing when an explicit prefix override points elsewhere", async () => {
    process.env["npm_config_prefix"] = "/different/install/prefix";
    ensureNpmPinFile(tmpHome);
    await expect(readFile(npmPinConfigPath(tmpHome), "utf8")).rejects.toThrow(/ENOENT/);
  });
});

// `daemon start` calls `ensureNpmPinFileTolerant`, never `ensureNpmPinFile`
// directly, so a read-only-FS/permissions failure reports instead of
// crashing boot.
describe("ensureNpmPinFileTolerant", () => {
  let tmpHome: string;
  const originalLower = process.env["npm_config_prefix"];
  const originalUpper = process.env[NPM_PREFIX_ENV];

  beforeEach(async () => {
    tmpHome = await mkdtemp(join(tmpdir(), "spur-npm-prefix-tolerant-"));
    delete process.env["npm_config_prefix"];
    Reflect.deleteProperty(process.env, NPM_PREFIX_ENV);
  });

  afterEach(async () => {
    await rm(tmpHome, { recursive: true, force: true });
    if (originalLower === undefined) delete process.env["npm_config_prefix"];
    else process.env["npm_config_prefix"] = originalLower;
    if (originalUpper === undefined) Reflect.deleteProperty(process.env, NPM_PREFIX_ENV);
    else process.env[NPM_PREFIX_ENV] = originalUpper;
  });

  it("writes the pin file and never calls onError on success", async () => {
    const messages: string[] = [];
    ensureNpmPinFileTolerant((message) => messages.push(message), tmpHome);
    expect(messages).toEqual([]);
    const pinContents = await readFile(npmPinConfigPath(tmpHome), "utf8");
    expect(pinContents).toBe(`prefix=${npmGlobalPrefix(tmpHome)}\n`);
  });

  it("reports a write failure via onError instead of throwing", async () => {
    // Collide the pin directory with a plain file so `mkdirSync(..., { recursive: true })` fails.
    await writeFile(join(tmpHome, ".spur"), "not a directory", "utf8");
    const messages: string[] = [];
    expect(() =>
      ensureNpmPinFileTolerant((message) => messages.push(message), tmpHome),
    ).not.toThrow();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("failed to write npm global-prefix pin file");
  });
});

describe("healNpmrcPrefixLine (runNpmInit-only half)", () => {
  let tmpHome: string;
  const originalLower = process.env["npm_config_prefix"];
  const originalUpper = process.env[NPM_PREFIX_ENV];

  beforeEach(async () => {
    tmpHome = await mkdtemp(join(tmpdir(), "spur-npm-prefix-heal-only-"));
    // Ambient shell env can carry NPM_CONFIG_PREFIX/npm_config_prefix pinned
    // at the real host home (this repo's own dev-shell fix for #618) — clear
    // it so `explicitPrefixOverridden` compares against `tmpHome`, not the
    // real host's `~/.local`.
    delete process.env["npm_config_prefix"];
    Reflect.deleteProperty(process.env, NPM_PREFIX_ENV);
  });

  afterEach(async () => {
    await rm(tmpHome, { recursive: true, force: true });
    if (originalLower === undefined) delete process.env["npm_config_prefix"];
    else process.env["npm_config_prefix"] = originalLower;
    if (originalUpper === undefined) Reflect.deleteProperty(process.env, NPM_PREFIX_ENV);
    else process.env[NPM_PREFIX_ENV] = originalUpper;
  });

  it("removes a Spur-authored prefix= line without needing the pin file to exist first", async () => {
    const tokenLine = "//registry.npmjs.org/:_authToken=fake-token\n";
    await writeFile(
      join(tmpHome, ".npmrc"),
      `${tokenLine}prefix=${npmGlobalPrefix(tmpHome)}\n`,
      "utf8",
    );

    healNpmrcPrefixLine(tmpHome);

    const npmrcContents = await readFile(join(tmpHome, ".npmrc"), "utf8");
    expect(npmrcContents).toBe(tokenLine);
    // The pin-file half never ran.
    await expect(readFile(npmPinConfigPath(tmpHome), "utf8")).rejects.toThrow(/ENOENT/);
  });
});
