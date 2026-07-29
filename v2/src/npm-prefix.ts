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

// An explicit non-`~/.local` prefix (e.g. spur update's derived install
// location) governs this run; every write below must never happen behind it.
function explicitPrefixOverridden(home: string): boolean {
  const expected = npmGlobalPrefix(home);
  const pinned = process.env[NPM_PREFIX_ENV_LOWER] ?? process.env[NPM_PREFIX_ENV];
  return pinned !== undefined && pinned !== expected;
}

// Writes/refreshes the Spur-owned globalconfig pin file that `NPM_CONFIG_
// GLOBALCONFIG`/`npm_config_globalconfig` point at (session env, `npm-
// init.sh`'s gate, the doctor probe) — a pure `writeFileSync` into Spur's own
// `<home>/.spur/`, safe to call unconditionally on every daemon boot: it
// never reads or writes `<home>/.npmrc`, so calling it repeatedly never
// mutates a shared user file.
export function ensureNpmPinFile(home = homedir()): void {
  if (explicitPrefixOverridden(home)) return;
  const expected = npmGlobalPrefix(home);
  const pinPath = npmPinConfigPath(home);
  mkdirSync(dirname(pinPath), { recursive: true });
  writeFileSync(pinPath, `prefix=${expected}\n`, { mode: 0o600 });
}

// `daemon start` (the sole real boot path — never the exported `startServer`
// fast tests call directly against arbitrary/real `$HOME`) calls this instead
// of `ensureNpmPinFile` directly: a read-only filesystem or a permissions
// error writing into `<home>/.spur/` must never abort daemon boot, so any
// failure is reported through `onError` and swallowed instead of thrown.
export function ensureNpmPinFileTolerant(
  onError: (message: string) => void,
  home = homedir(),
): void {
  try {
    ensureNpmPinFile(home);
  } catch (error) {
    onError(
      `failed to write npm global-prefix pin file: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

// Surgically removes a Spur-authored `prefix=` line this module previously
// wrote into `<home>/.npmrc` (observed cause of the need: an external process
// periodically rewrites `~/.npmrc` down to just the registry `_authToken`
// line), leaving every other byte — and an operator-set `prefix=` line for
// any other value — untouched. That file is one of the two nvm's own
// `nvm_npmrc_bad_news_bears` guard greps for a `prefix=`/`globalconfig=` line
// in, and refuses to load (with no `nvm deactivate`, so `PATH` is left
// rewritten but broken) whenever it finds one, which is why the pin itself
// lives in `<home>/.spur/npmrc` instead (see `ensureNpmPinFile`). Unlike that
// function, this one is NOT safe to call on every daemon boot — it rewrites
// a file Spur does not own — so only `runNpmInit` (`spur init`/`update`/
// `reinit`) calls it; every other host surfaces the fact through `spur
// doctor`'s read-only `npmrc-nvm-conflict` check instead.
export function healNpmrcPrefixLine(home = homedir()): void {
  if (explicitPrefixOverridden(home)) return;
  const expected = npmGlobalPrefix(home);
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

// Full repair: `runNpmInit` (`spur init`/`update`/`reinit`) is the one caller
// allowed to do both the pin-file write and the `~/.npmrc` surgery in one
// shot. Every other consumer (daemon boot) calls `ensureNpmPinFile` alone —
// see that function's doc comment for why the heal half is boot-unsafe.
export function ensureNpmGlobalPrefixConfigured(home = homedir()): void {
  ensureNpmPinFile(home);
  healNpmrcPrefixLine(home);
}
