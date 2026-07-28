// Deliberately does NOT mock "node:child_process" or "../../src/npm-prefix.js":
// this file exercises the real `npm` binary end to end, using the exact env
// object `buildSessionEnv` (session-service.ts) hands to every spawned agent
// session, to catch the class of bug where a session's uppercase
// `NPM_CONFIG_PREFIX` pin is silently defeated by an inherited lowercase
// `npm_config_prefix` npm considers equivalent (npm lowercases every
// `npm_config_*` key before matching it to a config option, so both casings
// collide and whichever key iterates last inside npm wins). Never touches
// this host's real `$HOME` or `~/.npmrc`: everything runs against a
// disposable temp dir with a token-only `.npmrc` (the observed clobber
// shape).
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { npmGlobalPrefix } from "../../src/npm-prefix.js";
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

  it("resolves to <HOME>/.local even when an inherited lowercase npm_config_prefix points elsewhere", () => {
    const sessionEnv = _buildSessionEnvForTests({
      agent: "claude",
      projectId: "api",
      sessionId: "api-1",
      sessionToolDir: join(dataDir, "tools"),
      dataDir,
      repoPath: join(dataDir, "repo"),
      symlinks: [],
    });
    // buildSessionEnv derives the pin from the real host home (`os.homedir()`),
    // never from the session's own `$HOME`/worktree — `tmpHome` below only
    // stands in for the session's `$HOME` so the spawned `npm` reads a
    // disposable `.npmrc`, unrelated to the pinned target path.
    const expected = npmGlobalPrefix();
    expect(sessionEnv["NPM_CONFIG_PREFIX"]).toBe(expected);

    // Matches the exact ordering the reviewer's shell experiment showed
    // defeats a single-case pin: the uppercase key declared/inserted before a
    // conflicting lowercase one loses, because npm's own config resolution
    // processes whichever `npm_config_*` casing it encounters last. This is
    // the ordering a session's env can end up in once tmux (not this
    // process's own env, which is untouched) merges the daemon's inherited
    // `process.env` — see session-service.ts's buildSessionEnv comment.
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: tmpHome };
    delete env["NPM_CONFIG_PREFIX"];
    delete env["npm_config_prefix"];
    delete env["npm_config_userconfig"];
    env["NPM_CONFIG_PREFIX"] = sessionEnv["NPM_CONFIG_PREFIX"];
    env["npm_config_prefix"] = "/usr";
    if (sessionEnv["npm_config_prefix"] !== undefined) {
      env["npm_config_prefix"] = sessionEnv["npm_config_prefix"];
    }

    expect(resolvedGlobalRoot(env)).toBe(join(expected, "lib", "node_modules"));
  });
});
