// Deliberately does NOT mock "node:child_process": the real-npm assertion at
// the end exercises the real `npm` binary end to end, resolving the
// globalconfig pin the way a sidecar/agent session actually would. The heal
// itself (`ensureNpmPinFile` + `healNpmrcPrefixLine`) is a pure filesystem
// write (no `npm` child) — this file's remaining job is to prove it writes
// under the `home` argument, never the ambient `$HOME`, since that used to be
// the class of bug this file existed to catch back when the heal shelled out
// to `npm config set`. Never touches this host's real `$HOME`: the "ambient
// HOME points elsewhere" side of the scenario is a second, disposable temp
// dir, not the real account home.
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  NPM_GLOBALCONFIG_ENV,
  NPM_PREFIX_ENV,
  ensureNpmPinFile,
  healNpmrcPrefixLine,
  npmGlobalPrefix,
  npmPinConfigPath,
} from "../../src/npm-prefix.js";

describe("ensureNpmPinFile + healNpmrcPrefixLine (real npm, HOME divergence)", () => {
  let targetHome: string;
  let ambientHome: string;
  const originalHome = process.env["HOME"];
  const originalLower = process.env["npm_config_prefix"];
  const originalUpper = process.env[NPM_PREFIX_ENV];

  beforeEach(async () => {
    targetHome = await mkdtemp(join(tmpdir(), "spur-npm-prefix-target-"));
    ambientHome = await mkdtemp(join(tmpdir(), "spur-npm-prefix-ambient-"));
    delete process.env["npm_config_prefix"];
    Reflect.deleteProperty(process.env, NPM_PREFIX_ENV);
    // Simulates a caller passing a `home` other than the process's own —
    // never the real account $HOME.
    process.env["HOME"] = ambientHome;
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = originalHome;
    if (originalLower === undefined) delete process.env["npm_config_prefix"];
    else process.env["npm_config_prefix"] = originalLower;
    if (originalUpper === undefined) Reflect.deleteProperty(process.env, NPM_PREFIX_ENV);
    else process.env[NPM_PREFIX_ENV] = originalUpper;
    await rm(targetHome, { recursive: true, force: true });
    await rm(ambientHome, { recursive: true, force: true });
  });

  it("writes <targetHome>/.spur/npmrc and edits <targetHome>/.npmrc, never the ambient $HOME's files", async () => {
    const tokenLine = "//registry.npmjs.org/:_authToken=fake-token\n";
    await writeFile(
      join(targetHome, ".npmrc"),
      `${tokenLine}prefix=${npmGlobalPrefix(targetHome)}\n`,
      "utf8",
    );

    ensureNpmPinFile(targetHome);
    healNpmrcPrefixLine(targetHome);

    const pinContents = await readFile(npmPinConfigPath(targetHome), "utf8");
    expect(pinContents).toBe(`prefix=${npmGlobalPrefix(targetHome)}\n`);

    const targetNpmrc = await readFile(join(targetHome, ".npmrc"), "utf8");
    expect(targetNpmrc).toBe(tokenLine);

    await expect(readFile(join(ambientHome, ".npmrc"), "utf8")).rejects.toThrow(/ENOENT/);
    await expect(readFile(npmPinConfigPath(ambientHome), "utf8")).rejects.toThrow(/ENOENT/);
  });

  it("resolves npm root -g to <targetHome>/.local/lib/node_modules via --globalconfig", async () => {
    await writeFile(
      join(targetHome, ".npmrc"),
      "//registry.npmjs.org/:_authToken=fake-token\n",
      "utf8",
    );

    ensureNpmPinFile(targetHome);
    healNpmrcPrefixLine(targetHome);

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: targetHome,
      [NPM_GLOBALCONFIG_ENV]: npmPinConfigPath(targetHome),
    };
    Reflect.deleteProperty(env, NPM_PREFIX_ENV);
    delete env["npm_config_prefix"];
    delete env["npm_config_globalconfig"];

    const result = execFileSync("npm", ["root", "-g"], { env, encoding: "utf8" }).trim();
    expect(result).toBe(join(npmGlobalPrefix(targetHome), "lib", "node_modules"));
  });
});
