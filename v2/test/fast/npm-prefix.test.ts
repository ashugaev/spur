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
  hasNvm,
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

describe("hasNvm", () => {
  let tmpHome: string;
  const originalNvmDir = process.env["NVM_DIR"];

  beforeEach(async () => {
    tmpHome = await mkdtemp(join(tmpdir(), "spur-has-nvm-"));
    Reflect.deleteProperty(process.env, "NVM_DIR");
  });

  afterEach(async () => {
    await rm(tmpHome, { recursive: true, force: true });
    if (originalNvmDir === undefined) Reflect.deleteProperty(process.env, "NVM_DIR");
    else process.env["NVM_DIR"] = originalNvmDir;
  });

  it("is false when neither $NVM_DIR nor <home>/.nvm/nvm.sh exists", () => {
    expect(hasNvm(tmpHome)).toBe(false);
  });

  it("is true when <home>/.nvm/nvm.sh exists and $NVM_DIR is unset", async () => {
    await mkdir(join(tmpHome, ".nvm"), { recursive: true });
    await writeFile(join(tmpHome, ".nvm", "nvm.sh"), "# fake nvm\n", "utf8");
    expect(hasNvm(tmpHome)).toBe(true);
  });

  // MUST FIX 6 regression guard: nvm installed to a custom $NVM_DIR (common
  // in container images) must be detected even though <home>/.nvm is absent.
  it("is true when $NVM_DIR points at a custom directory containing nvm.sh, even when <home>/.nvm is absent", async () => {
    const customNvmDir = join(tmpHome, "custom-nvm-location");
    await mkdir(customNvmDir, { recursive: true });
    await writeFile(join(customNvmDir, "nvm.sh"), "# fake nvm\n", "utf8");
    process.env["NVM_DIR"] = customNvmDir;
    expect(hasNvm(tmpHome)).toBe(true);
  });

  it("is false when $NVM_DIR points at a directory with no nvm.sh, even when <home>/.nvm has one", async () => {
    const emptyNvmDir = join(tmpHome, "empty-nvm-dir");
    await mkdir(emptyNvmDir, { recursive: true });
    await mkdir(join(tmpHome, ".nvm"), { recursive: true });
    await writeFile(join(tmpHome, ".nvm", "nvm.sh"), "# fake nvm\n", "utf8");
    process.env["NVM_DIR"] = emptyNvmDir;
    expect(hasNvm(tmpHome)).toBe(false);
  });
});

// Shared fixture for every spec below: a disposable `tmpHome` plus save/
// restore of both prefix-env casings (consulted by `explicitPrefixOverridden`,
// still checked by `healNpmrcPrefixLine`) and `$NVM_DIR` (consulted by
// `hasNvm`, gating `healNpmrcPrefixLine`), so both see a clean slate
// regardless of the ambient shell's own npm prefix pin or nvm install.
describe("npm-prefix pin file + .npmrc heal", () => {
  let tmpHome: string;
  const originalLower = process.env["npm_config_prefix"];
  const originalUpper = process.env[NPM_PREFIX_ENV];
  const originalNvmDir = process.env["NVM_DIR"];

  beforeEach(async () => {
    tmpHome = await mkdtemp(join(tmpdir(), "spur-npm-prefix-"));
    delete process.env["npm_config_prefix"];
    Reflect.deleteProperty(process.env, NPM_PREFIX_ENV);
    Reflect.deleteProperty(process.env, "NVM_DIR");
  });

  afterEach(async () => {
    await rm(tmpHome, { recursive: true, force: true });
    if (originalLower === undefined) delete process.env["npm_config_prefix"];
    else process.env["npm_config_prefix"] = originalLower;
    if (originalUpper === undefined) Reflect.deleteProperty(process.env, NPM_PREFIX_ENV);
    else process.env[NPM_PREFIX_ENV] = originalUpper;
    if (originalNvmDir === undefined) Reflect.deleteProperty(process.env, "NVM_DIR");
    else process.env["NVM_DIR"] = originalNvmDir;
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

    // MUST FIX 2 regression guard: proves `ensureNpmPinFile` writing the pin
    // file unconditionally can never override an operator's explicit prefix
    // env var — npm's env layer outranks a globalconfig file's `prefix=`
    // line regardless of which one is set.
    it("an explicit npm_config_prefix env still outranks the globalconfig pin file", async () => {
      const expected = npmGlobalPrefix(tmpHome);
      const operatorPrefix = join(tmpHome, "operator-explicit-prefix");
      const pinFile = join(tmpHome, "pin-npmrc");
      await writeFile(pinFile, `prefix=${expected}\n`, "utf8");
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        HOME: tmpHome,
        [NPM_GLOBALCONFIG_ENV]: pinFile,
        npm_config_prefix: operatorPrefix,
      };
      Reflect.deleteProperty(env, NPM_PREFIX_ENV);
      delete env["npm_config_globalconfig"];
      const result = execFileSync("npm", ["root", "-g"], { env, encoding: "utf8" }).trim();
      expect(result).toBe(join(operatorPrefix, "lib", "node_modules"));
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

    // MUST FIX 4 regression guard: `~/.spur` also holds config, worktrees,
    // logs, and rollback state — forcing 0700 on the pin directory on every
    // boot would silently revert group/other access an operator set on it
    // for unrelated reasons. Only the pin FILE's mode is enforced
    // unconditionally; the directory only gets 0700 on create.
    it("does not tighten a pre-existing pin directory's looser mode, but still tightens the pin file", async () => {
      const pinPath = npmPinConfigPath(tmpHome);
      const pinDir = dirname(pinPath);
      await mkdir(pinDir, { recursive: true, mode: 0o755 });
      await writeFile(pinPath, `prefix=${npmGlobalPrefix(tmpHome)}\n`, { mode: 0o666 });

      ensureNpmPinFile(tmpHome);

      expect(statSync(pinDir).mode & 0o777).toBe(0o755);
      expect(statSync(pinPath).mode & 0o777).toBe(0o600);
    });

    // MUST FIX 2 regression guard: `buildSessionEnv` always points
    // `NPM_CONFIG_GLOBALCONFIG` at this file regardless of any explicit
    // prefix env var, so skipping the write behind an override left the
    // globalconfig env var dangling at a missing file. The write must
    // happen unconditionally — it still resolves the pin file's own content
    // to `~/.local` (never the overridden value), since npm's env layer
    // outranks it regardless (verified empirically against a real npm
    // binary in the "real npm root -g" spec above).
    it("still writes the pin file (content <home>/.local) when npm_config_prefix (lowercase) is pinned to a different value", async () => {
      process.env["npm_config_prefix"] = "/different/install/prefix";
      ensureNpmPinFile(tmpHome);
      const pinContents = await readFile(npmPinConfigPath(tmpHome), "utf8");
      expect(pinContents).toBe(`prefix=${npmGlobalPrefix(tmpHome)}\n`);
    });

    it("still writes the pin file (content <home>/.local) when NPM_CONFIG_PREFIX (uppercase) is pinned to a different value", async () => {
      process.env[NPM_PREFIX_ENV] = "/different/install/prefix";
      ensureNpmPinFile(tmpHome);
      const pinContents = await readFile(npmPinConfigPath(tmpHome), "utf8");
      expect(pinContents).toBe(`prefix=${npmGlobalPrefix(tmpHome)}\n`);
    });

    it("still writes the pin file when the pinned prefix already equals <home>/.local (spur update's own reinit pin)", async () => {
      process.env["npm_config_prefix"] = npmGlobalPrefix(tmpHome);
      ensureNpmPinFile(tmpHome);

      const pinContents = await readFile(npmPinConfigPath(tmpHome), "utf8");
      expect(pinContents).toBe(`prefix=${npmGlobalPrefix(tmpHome)}\n`);
    });
  });

  // `runNpmInit`-only half: never called on a plain daemon boot, since it
  // rewrites a file Spur does not own. Also gated on `hasNvm` (MUST FIX 1):
  // stripping the line has no benefit on a host without nvm, and actively
  // breaks a bare `npm install -g` that was landing in `~/.local` via it.
  describe("healNpmrcPrefixLine (runNpmInit-only half)", () => {
    describe("when nvm is installed", () => {
      beforeEach(async () => {
        await mkdir(join(tmpHome, ".nvm"), { recursive: true });
        await writeFile(join(tmpHome, ".nvm", "nvm.sh"), "# fake nvm\n", "utf8");
      });

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

    // MUST FIX 1 regression guard: on a host with no nvm at all, the
    // Spur-authored line is what makes a bare `npm install -g` land in
    // `~/.local` (verified empirically against a real npm binary: removing
    // it makes `npm config get prefix` fall back to node's own install
    // prefix). Stripping it here would silently break that with nothing to
    // show for it, since no nvm guard exists on this host to conflict with.
    it("does nothing when nvm is not installed, even with a Spur-authored prefix= line present", async () => {
      const npmrcWithSpurLine = `${TOKEN_ONLY_NPMRC}prefix=${npmGlobalPrefix(tmpHome)}\n`;
      await writeFile(join(tmpHome, ".npmrc"), npmrcWithSpurLine, "utf8");

      healNpmrcPrefixLine(tmpHome);

      const npmrcContents = await readFile(join(tmpHome, ".npmrc"), "utf8");
      expect(npmrcContents).toBe(npmrcWithSpurLine);
    });
  });
});
