// Deliberately does NOT mock "node:child_process": this file exercises the
// real `npm` binary end to end, to catch the class of bug where
// `ensureNpmGlobalPrefixConfigured(home)` reads `<home>/.npmrc` but the
// spawned `npm config set prefix` — which resolves its userconfig from
// `$HOME` at spawn time, not from the `home` argument — writes somewhere
// else entirely. Never touches this host's real `$HOME`: the "ambient HOME
// points elsewhere" side of the scenario is a second, disposable temp dir,
// not the real account home.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureNpmGlobalPrefixConfigured, npmGlobalPrefix } from "../../src/npm-prefix.js";

describe("ensureNpmGlobalPrefixConfigured (real npm, HOME divergence)", () => {
  let targetHome: string;
  let ambientHome: string;
  const originalHome = process.env["HOME"];
  const originalLower = process.env["npm_config_prefix"];
  const originalUpper = process.env["NPM_CONFIG_PREFIX"];
  const originalUserconfig = process.env["npm_config_userconfig"];

  let decoyDir: string;

  beforeEach(async () => {
    targetHome = await mkdtemp(join(tmpdir(), "spur-npm-prefix-target-"));
    ambientHome = await mkdtemp(join(tmpdir(), "spur-npm-prefix-ambient-"));
    decoyDir = await mkdtemp(join(tmpdir(), "spur-npm-prefix-decoy-"));
    delete process.env["npm_config_prefix"];
    delete process.env["NPM_CONFIG_PREFIX"];
    // Simulates the ambient env `npx`/`npm exec`/`npm run` set on every
    // lifecycle invocation: an inherited `npm_config_userconfig` outranks
    // `HOME` as npm's userconfig source. Positive proof, not a defensive
    // clear: the write must still land in `<targetHome>/.npmrc` and this
    // decoy file must never be created.
    process.env["npm_config_userconfig"] = join(decoyDir, "decoy.npmrc");
    // Simulates a caller passing a `home` other than the process's own —
    // never the real account $HOME.
    process.env["HOME"] = ambientHome;
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = originalHome;
    if (originalLower === undefined) delete process.env["npm_config_prefix"];
    else process.env["npm_config_prefix"] = originalLower;
    if (originalUpper === undefined) delete process.env["NPM_CONFIG_PREFIX"];
    else process.env["NPM_CONFIG_PREFIX"] = originalUpper;
    if (originalUserconfig === undefined) delete process.env["npm_config_userconfig"];
    else process.env["npm_config_userconfig"] = originalUserconfig;
    await rm(targetHome, { recursive: true, force: true });
    await rm(ambientHome, { recursive: true, force: true });
    await rm(decoyDir, { recursive: true, force: true });
  });

  it("writes prefix into <targetHome>/.npmrc, not the ambient $HOME's npmrc", async () => {
    ensureNpmGlobalPrefixConfigured(targetHome);

    const targetNpmrc = await readFile(join(targetHome, ".npmrc"), "utf8");
    expect(targetNpmrc).toMatch(
      new RegExp(`prefix\\s*=\\s*${npmGlobalPrefix(targetHome).replaceAll("/", "\\/")}`),
    );

    await expect(readFile(join(ambientHome, ".npmrc"), "utf8")).rejects.toThrow(/ENOENT/);
  });

  // MUST FIX regression guard: an inherited `npm_config_userconfig` outranks
  // `HOME` as npm's userconfig source (npx/`npm exec`/`npm run` all set one),
  // so without an explicit `--userconfig` the write would land in the decoy
  // file this env var names instead of `<targetHome>/.npmrc`.
  it("writes prefix into <targetHome>/.npmrc even with an inherited npm_config_userconfig decoy", async () => {
    ensureNpmGlobalPrefixConfigured(targetHome);

    const targetNpmrc = await readFile(join(targetHome, ".npmrc"), "utf8");
    expect(targetNpmrc).toMatch(
      new RegExp(`prefix\\s*=\\s*${npmGlobalPrefix(targetHome).replaceAll("/", "\\/")}`),
    );

    await expect(readFile(join(decoyDir, "decoy.npmrc"), "utf8")).rejects.toThrow(/ENOENT/);
  });
});
