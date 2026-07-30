// Deliberately does NOT mock "node:child_process" or "../../src/npm-prefix.js":
// this file exercises the real `npm` binary end to end, using the exact env
// object `buildSessionEnv` (session-service.ts) hands to every spawned agent
// session, to catch the class of bug where a session's uppercase
// `NPM_CONFIG_GLOBALCONFIG` pin is silently defeated by an inherited
// lowercase `npm_config_globalconfig` npm considers equivalent (npm
// lowercases every `npm_config_*` key before matching it to a config option,
// so both casings collide and whichever key iterates last inside npm wins).
// Never touches this host's real `$HOME` or `~/.npmrc`: everything runs
// against a disposable temp dir with a token-only `.npmrc` (the observed
// clobber shape).
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  NPM_GLOBALCONFIG_ENV,
  NPM_GLOBALCONFIG_ENV_LOWER,
  npmGlobalPrefix,
  npmPinConfigPath,
} from "../../src/npm-prefix.js";
import { _buildSessionEnvForTests } from "../../src/session-service.js";

const TOKEN_ONLY_NPMRC = "//registry.npmjs.org/:_authToken=fake-token\n";

// npm rejects `npm config get prefix` as reading a "protected" option in this
// harness's ambient npm lifecycle env; `npm root -g` derives from the same
// resolved prefix and is unaffected.
function resolvedGlobalRoot(env: NodeJS.ProcessEnv): string {
  return execFileSync("npm", ["root", "-g"], { env, encoding: "utf8" }).trim();
}

describe("buildSessionEnv's npm prefix pin (real npm, conflicting inherited lowercase)", () => {
  let tmpHome: string;
  let dataDir: string;

  beforeEach(async () => {
    tmpHome = await mkdtemp(join(tmpdir(), "spur-session-env-npm-prefix-"));
    dataDir = await mkdtemp(join(tmpdir(), "spur-session-env-data-"));
    await writeFile(join(tmpHome, ".npmrc"), TOKEN_ONLY_NPMRC, "utf8");
  });

  afterEach(async () => {
    await rm(tmpHome, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  });

  it("carries the globalconfig pin under both env casings, both pointing at npmPinConfigPath()", () => {
    const sessionEnv = _buildSessionEnvForTests({
      agent: "claude",
      projectId: "api",
      sessionId: "api-1",
      sessionToolDir: join(dataDir, "tools"),
      dataDir,
      repoPath: join(dataDir, "repo"),
      symlinks: [],
    });
    // buildSessionEnv derives the pin path from the real host home
    // (`os.homedir()`), never from the session's own `$HOME`/worktree.
    const expectedPinPath = npmPinConfigPath();
    expect(sessionEnv["NPM_CONFIG_GLOBALCONFIG"]).toBe(expectedPinPath);
    expect(sessionEnv["npm_config_globalconfig"]).toBe(expectedPinPath);
    expect(sessionEnv["NPM_CONFIG_PREFIX"]).toBeUndefined();
    expect(sessionEnv["npm_config_prefix"]).toBeUndefined();
  });

  it("resolves to <HOME>/.local even with a conflicting decoy pre-seeded in both casings, positioned to win under npm's last-casing-wins rule unless buildSessionEnv actually pins both", async () => {
    // `tmpHome` stands in for the session's `$HOME` so the spawned `npm`
    // reads a disposable `.npmrc`, and the pin is re-pointed at a temp pin
    // file rather than the real host's `~/.spur/npmrc` — never touches this
    // host's real pin file.
    const expected = npmGlobalPrefix(tmpHome);
    const pinFile = join(tmpHome, "pin-npmrc");
    await writeFile(pinFile, `prefix=${expected}\n`, "utf8");

    const sessionEnv = _buildSessionEnvForTests({
      agent: "claude",
      projectId: "api",
      sessionId: "api-1",
      sessionToolDir: join(dataDir, "tools"),
      dataDir,
      repoPath: join(dataDir, "repo"),
      symlinks: [],
    });

    const env: NodeJS.ProcessEnv = { ...process.env, HOME: tmpHome };
    delete env["NPM_CONFIG_PREFIX"];
    delete env["npm_config_prefix"];
    delete env["NPM_CONFIG_GLOBALCONFIG"];
    delete env["npm_config_globalconfig"];
    delete env["npm_config_userconfig"];

    // Pre-seed BOTH casings with an identical decoy, uppercase inserted
    // before lowercase — the exact ordering the reviewer's shell experiment
    // showed defeats a single-casing pin (npm's own config resolution takes
    // whichever casing it encounters last; here, lowercase). Reassigning an
    // already-present object key never moves its enumeration position, so
    // this relative order survives the overwrite below regardless of what
    // `sessionEnv` does to each key.
    env[NPM_GLOBALCONFIG_ENV] = "/nonexistent/decoy-globalconfig";
    env[NPM_GLOBALCONFIG_ENV_LOWER] = "/nonexistent/decoy-globalconfig";

    // Overwrite each key IN PLACE with `buildSessionEnv`'s real output for
    // that same name, gated on `sessionEnv` actually setting it — deriving
    // from the real session env instead of hardcoding both names, so this
    // test fails if `buildSessionEnv` regresses to pinning only one of the
    // two casings (the other casing's decoy is left standing instead of
    // silently disappearing).
    if (sessionEnv[NPM_GLOBALCONFIG_ENV] !== undefined) {
      env[NPM_GLOBALCONFIG_ENV] = pinFile;
    }
    if (sessionEnv[NPM_GLOBALCONFIG_ENV_LOWER] !== undefined) {
      env[NPM_GLOBALCONFIG_ENV_LOWER] = pinFile;
    }

    expect(resolvedGlobalRoot(env)).toBe(join(expected, "lib", "node_modules"));
  });
});
