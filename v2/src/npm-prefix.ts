import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// The single source of truth for the npm global prefix Spur pins agent
// sessions and host init to. `~/.local` is the one hardcoded path segment in
// v2/src — every other consumer (session env, doctor's `npm-prefix` check,
// `runNpmInit`'s heal) derives from this function instead of its own literal.
export const NPM_PREFIX_ENV = "NPM_CONFIG_PREFIX";

// npm lowercases every `npm_config_*` env key before matching it to a config
// option, so this and `NPM_PREFIX_ENV` both resolve to npm's `prefix` option.
// Kept alongside it so consumers that must check both casings (the
// differing-explicit-pin guard below) share one name instead of a scattered
// literal.
export const NPM_PREFIX_ENV_LOWER = "npm_config_prefix";

// nvm's own env-name guard (`nvm.sh`'s `nvm_die_on_prefix`) matches only the
// literal name `NPM_CONFIG_PREFIX` (case-insensitively via `toupper`), so a
// `*_GLOBALCONFIG` pin is invisible to it — the mechanism this module now
// pins agent sessions through instead.
export const NPM_GLOBALCONFIG_ENV = "NPM_CONFIG_GLOBALCONFIG";

// Same lowercase-mirroring rationale as `NPM_PREFIX_ENV_LOWER`: measured, an
// uppercase `NPM_CONFIG_GLOBALCONFIG` declared before a conflicting lowercase
// `npm_config_globalconfig` loses (whichever casing npm's config resolution
// encounters last wins), so every consumer that sets or strips this pin must
// use both casings, never just one.
export const NPM_GLOBALCONFIG_ENV_LOWER = "npm_config_globalconfig";

// Every env name that either of nvm's two incompatibility guards reacts to:
// guard 1 (`nvm_die_on_prefix`) matches `NPM_CONFIG_PREFIX`/`PREFIX` by name
// (case-insensitive on the former), guard 2 (`nvm_npmrc_bad_news_bears`)
// greps `prefix=`/`globalconfig=` lines in files a globalconfig env var can
// point npm's own children at. `createTmuxCommandSession` strips exactly
// this list ahead of every sidecar/service/login-pane launch; the doctor
// probe strips it from its own `npm` child env. Single exported constant so
// no consumer re-spells the five names.
export const NPM_PIN_SANITIZE_ENV_KEYS = [
  NPM_PREFIX_ENV,
  NPM_PREFIX_ENV_LOWER,
  NPM_GLOBALCONFIG_ENV,
  NPM_GLOBALCONFIG_ENV_LOWER,
  "PREFIX",
] as const;

export function npmGlobalPrefix(home = homedir()): string {
  return join(home, ".local");
}

// Path to the Spur-owned npm config file that carries the persisted prefix
// pin. Never `<home>/.npmrc` — nvm greps that file for a `prefix=`/
// `globalconfig=` line and refuses to load when it finds one (see
// `ensureNpmGlobalPrefixConfigured`'s doc comment).
export function npmPinConfigPath(home = homedir()): string {
  return join(home, ".spur", "npmrc");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Repairs the npm global-prefix pin. Historically this wrote `prefix=` into
// `~/.npmrc` (observed cause of the need: an external process periodically
// rewrites `~/.npmrc` down to just the registry `_authToken` line) — but that
// file is also one of the four nvm's own `nvm_npmrc_bad_news_bears` guard
// greps for a `prefix=`/`globalconfig=` line, and refuses to load (with no
// `nvm deactivate`, so `PATH` is left rewritten but broken) whenever it finds
// one. Spur now persists the pin in its own `<home>/.spur/npmrc` and points
// `NPM_CONFIG_GLOBALCONFIG`/`npm_config_globalconfig` at it (session env,
// `npm-init.sh`'s gate, the doctor probe) instead — invisible to both nvm
// guards — and, on every run, surgically removes a Spur-authored `prefix=`
// line it previously wrote into `~/.npmrc`, leaving every other byte (and an
// operator-set `prefix=` line for any other value) untouched.
export function ensureNpmGlobalPrefixConfigured(home = homedir()): void {
  const expected = npmGlobalPrefix(home);

  const pinned = process.env[NPM_PREFIX_ENV_LOWER] ?? process.env[NPM_PREFIX_ENV];
  if (pinned !== undefined && pinned !== expected) {
    // An explicit non-`~/.local` prefix (e.g. spur update's derived install
    // location) governs this run; never write behind it.
    return;
  }

  const pinPath = npmPinConfigPath(home);
  mkdirSync(dirname(pinPath), { recursive: true });
  writeFileSync(pinPath, `prefix=${expected}\n`, { mode: 0o600 });

  let npmrc: string;
  try {
    npmrc = readFileSync(join(home, ".npmrc"), "utf8");
  } catch {
    return;
  }

  const spurAuthoredLine = new RegExp(`^\\s*prefix\\s*=\\s*${escapeRegExp(expected)}\\s*$`);
  const lines = npmrc.split("\n");
  const kept = lines.filter((line) => !spurAuthoredLine.test(line));
  if (kept.length !== lines.length) {
    writeFileSync(join(home, ".npmrc"), kept.join("\n"), { mode: 0o600 });
  }
}
