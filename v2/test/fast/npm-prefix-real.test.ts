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

  beforeEach(async () => {
    targetHome = await mkdtemp(join(tmpdir(), "spur-npm-prefix-target-"));
    ambientHome = await mkdtemp(join(tmpdir(), "spur-npm-prefix-ambient-"));
    delete process.env["npm_config_prefix"];
    delete process.env["NPM_CONFIG_PREFIX"];
    // An inherited `npm_config_userconfig` would steer the spawned `npm
    // config set` at a different `.npmrc` than the `<home>/.npmrc` this test
    // asserts against — clear it alongside the prefix vars so no ambient npm
    // lifecycle env can redirect the write.
    delete process.env["npm_config_userconfig"];
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
  });

  it("writes prefix into <targetHome>/.npmrc, not the ambient $HOME's npmrc", async () => {
    ensureNpmGlobalPrefixConfigured(targetHome);

    const targetNpmrc = await readFile(join(targetHome, ".npmrc"), "utf8");
    expect(targetNpmrc).toMatch(
      new RegExp(`prefix\\s*=\\s*${npmGlobalPrefix(targetHome).replaceAll("/", "\\/")}`),
    );

    await expect(readFile(join(ambientHome, ".npmrc"), "utf8")).rejects.toThrow(/ENOENT/);
  });
});
