import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// The single source of truth for the npm global prefix Spur pins agent
// sessions and host init to. `~/.local` is the one hardcoded path segment in
// v2/src — every other consumer (session env, doctor's `npm-prefix` check,
// `runNpmInit`'s heal) derives from this function instead of its own literal.
export const NPM_PREFIX_ENV = "NPM_CONFIG_PREFIX";

// npm lowercases every `npm_config_*` env key before matching it to a config
// option, so this and `NPM_PREFIX_ENV` both resolve to npm's `prefix` option.
// Kept alongside it so consumers that must set/strip both casings (session
// env pin, doctor's probe) share one name instead of a scattered literal.
export const NPM_PREFIX_ENV_LOWER = "npm_config_prefix";

export function npmGlobalPrefix(home = homedir()): string {
  return join(home, ".local");
}

// Repairs `~/.npmrc` when it has lost its `prefix=` line (observed cause: an
// external process periodically rewrites `~/.npmrc` down to just the
// registry `_authToken` line), so `npm-init.sh`'s `npm config get prefix ==
// $HOME/.local` gate — and any bare `npm install -g` a self-updating agent
// runtime shells out to — resolve `~/.local` instead of falling back to
// npm's system globalconfig (typically an unwritable `/usr`).
export function ensureNpmGlobalPrefixConfigured(home = homedir()): void {
  const expected = npmGlobalPrefix(home);

  const pinned = process.env["npm_config_prefix"] ?? process.env[NPM_PREFIX_ENV];
  if (pinned !== undefined && pinned !== expected) {
    // An explicit non-`~/.local` prefix (e.g. spur update's derived install
    // location) governs this run; never overwrite the file behind it.
    return;
  }

  let npmrc: string;
  try {
    npmrc = readFileSync(join(home, ".npmrc"), "utf8");
  } catch {
    npmrc = "";
  }
  if (/^\s*prefix\s*=/m.test(npmrc)) {
    // Operator-set value is never overwritten; npm-init.sh still dies on a
    // wrong one, unchanged behavior.
    return;
  }

  // npm resolves its userconfig (`~/.npmrc`) from `$HOME` at spawn time, not
  // from the `home` argument above — without this override the write target
  // would diverge from the read target whenever a caller passes a `home`
  // other than the ambient one.
  execFileSync("npm", ["config", "set", "prefix", expected], {
    stdio: "ignore",
    env: { ...process.env, HOME: home },
  });
}
