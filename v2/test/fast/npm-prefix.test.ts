import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  NPM_GLOBALCONFIG_ENV,
  NPM_PREFIX_ENV,
  npmGlobalPrefix,
  npmPinConfigPath,
  ensureNpmPinFile,
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

// Shared fixture for every spec below: a disposable `tmpHome` plus save/
// restore of both prefix-env casings, so `explicitPrefixOverridden` (which
// both `ensureNpmPinFile` and `healNpmrcPrefixLine` consult) sees a clean
// slate regardless of the ambient shell's own npm prefix pin.
describe("npm-prefix pin file + .npmrc heal", () => {
  let tmpHome: string;
  const originalLower = process.env["npm_config_prefix"];
  const originalUpper = process.env[NPM_PREFIX_ENV];

  beforeEach(async () => {
    tmpHome = await mkdtemp(join(tmpdir(), "spur-npm-prefix-"));
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

  // Load-bearing proof for the whole feature: with a real npm binary, a
  // token-only `.npmrc` (the observed clobber shape) resolves away from
  // `<HOME>/.local` on its own, and pointing `NPM_CONFIG_GLOBALCONFIG` at a
  // file containing `prefix=<HOME>/.local` resolves back to it — the exact
  // mechanism `ensureNpmPinFile` and `buildSessionEnv` rely on, invisible to
  // nvm's env-name guard (which matches only `NPM_CONFIG_PREFIX`/`PREFIX`).
  // Runs a real `npm` child process, never touches this host's real `$HOME`.
  describe("real npm root -g under a token-only ~/.npmrc plus a globalconfig pin", () => {
    beforeEach(async () => {
      await writeFile(join(tmpHome, ".npmrc"), TOKEN_ONLY_NPMRC, "utf8");
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

  // Boot-safe half: `daemon start` calls this on every boot, so it must never
  // touch `.npmrc` — see the function's own doc comment.
  describe("ensureNpmPinFile (boot-safe half)", () => {
    it("writes the pin file and never touches .npmrc, even when .npmrc carries a Spur-authored prefix= line", async () => {
      const npmrcWithSpurLine = `${TOKEN_ONLY_NPMRC}prefix=${npmGlobalPrefix(tmpHome)}\n`;
      await writeFile(join(tmpHome, ".npmrc"), npmrcWithSpurLine, "utf8");

      ensureNpmPinFile(tmpHome);

      const pinContents = await readFile(npmPinConfigPath(tmpHome), "utf8");
      expect(pinContents).toBe(`prefix=${npmGlobalPrefix(tmpHome)}\n`);
      // AC1: pin file must be mode 0600 — it is Spur-owned config outside the
      // user's own `~/.npmrc`, no reason for group/other access.
      expect(statSync(npmPinConfigPath(tmpHome)).mode & 0o777).toBe(0o600);
      // The heal half never ran — the .npmrc byte content is unchanged.
      const npmrcContents = await readFile(join(tmpHome, ".npmrc"), "utf8");
      expect(npmrcContents).toBe(npmrcWithSpurLine);
    });

    it("tightens a pre-existing pin file's mode to 0600 even when it was created loose (0666)", async () => {
      const expected = npmGlobalPrefix(tmpHome);
      const pinPath = npmPinConfigPath(tmpHome);
      await mkdir(dirname(pinPath), { recursive: true });
      await writeFile(pinPath, `prefix=${expected}\n`, { mode: 0o666 });

      ensureNpmPinFile(tmpHome);

      expect(statSync(pinPath).mode & 0o777).toBe(0o600);
      const pinContents = await readFile(pinPath, "utf8");
      expect(pinContents).toBe(`prefix=${expected}\n`);
    });

    it("is idempotent across repeated calls (safe to call on every daemon restart)", async () => {
      ensureNpmPinFile(tmpHome);
      ensureNpmPinFile(tmpHome);
      ensureNpmPinFile(tmpHome);

      const pinContents = await readFile(npmPinConfigPath(tmpHome), "utf8");
      expect(pinContents).toBe(`prefix=${npmGlobalPrefix(tmpHome)}\n`);
    });

    it("writes nothing when npm_config_prefix (lowercase) is pinned to a different value", async () => {
      process.env["npm_config_prefix"] = "/different/install/prefix";
      ensureNpmPinFile(tmpHome);
      await expect(readFile(npmPinConfigPath(tmpHome), "utf8")).rejects.toThrow(/ENOENT/);
    });

    it("writes nothing when NPM_CONFIG_PREFIX (uppercase) is pinned to a different value", async () => {
      process.env[NPM_PREFIX_ENV] = "/different/install/prefix";
      ensureNpmPinFile(tmpHome);
      await expect(readFile(npmPinConfigPath(tmpHome), "utf8")).rejects.toThrow(/ENOENT/);
    });

    it("still writes the pin file when the pinned prefix already equals <home>/.local (spur update's own reinit pin)", async () => {
      process.env["npm_config_prefix"] = npmGlobalPrefix(tmpHome);
      ensureNpmPinFile(tmpHome);

      const pinContents = await readFile(npmPinConfigPath(tmpHome), "utf8");
      expect(pinContents).toBe(`prefix=${npmGlobalPrefix(tmpHome)}\n`);
    });
  });

  // `runNpmInit`-only half: never called on a plain daemon boot, since it
  // rewrites a file Spur does not own.
  describe("healNpmrcPrefixLine (runNpmInit-only half)", () => {
    it("removes a Spur-authored prefix= line without needing the pin file to exist first", async () => {
      await writeFile(
        join(tmpHome, ".npmrc"),
        `${TOKEN_ONLY_NPMRC}prefix=${npmGlobalPrefix(tmpHome)}\n`,
        "utf8",
      );

      healNpmrcPrefixLine(tmpHome);

      const npmrcContents = await readFile(join(tmpHome, ".npmrc"), "utf8");
      expect(npmrcContents).toBe(TOKEN_ONLY_NPMRC);
      // The pin-file half never ran.
      await expect(readFile(npmPinConfigPath(tmpHome), "utf8")).rejects.toThrow(/ENOENT/);
    });

    it("preserves an operator-set prefix= line pointing elsewhere", async () => {
      const operatorNpmrc = "prefix=/some/operator/path\n";
      await writeFile(join(tmpHome, ".npmrc"), operatorNpmrc, "utf8");

      healNpmrcPrefixLine(tmpHome);

      const npmrcContents = await readFile(join(tmpHome, ".npmrc"), "utf8");
      expect(npmrcContents).toBe(operatorNpmrc);
    });
  });
});
