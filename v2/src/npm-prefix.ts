import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

// Every env name `createTmuxCommandSession` strips ahead of every sidecar/
// service/login-pane launch (the doctor probe strips it from its own `npm`
// child env too). Only `PREFIX`/`NPM_CONFIG_PREFIX` (case-insensitive on the
// latter) are actually read by either of nvm's two incompatibility guards —
// guard 1 (`nvm_die_on_prefix`) matches those two by name; guard 2
// (`nvm_npmrc_bad_news_bears`) greps `prefix=`/`globalconfig=` lines out of
// four fixed files (npm's builtin npmrc, `<versiondir>/etc/npmrc`,
// `$HOME/.npmrc`, the project `.npmrc`) and never follows a globalconfig env
// var to find them. The two `*_GLOBALCONFIG` keys are stripped for a
// different reason: left set, they would silently redirect a sidecar that
// ran `nvm use` and switched node versions onto Spur's `~/.local` global
// prefix instead of that node version's own nvm-managed prefix — exactly the
// cross-major native-module ABI mismatch nvm's guards exist to prevent, just
// reached by a path the guards themselves don't check. Single exported
// constant so no consumer re-spells the five names.
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
// `ensureNpmPinFile`'s doc comment).
export function npmPinConfigPath(home = homedir()): string {
  return join(home, ".spur", "npmrc");
}

// Whether nvm is installed on this host, per nvm's own resolution order: an
// explicit `$NVM_DIR` (common in container images that install nvm outside
// `~/.nvm`) if set, else `<home>/.nvm`. Shared by `healNpmrcPrefixLine` (only
// nvm hosts benefit from stripping the `~/.npmrc` `prefix=` line — on a host
// without nvm the line is what makes a bare `npm install -g` land in
// `~/.local` at all) and the doctor's `npmrc-nvm-conflict` check, so the two
// can never disagree about whether nvm is present. `healNpmrcPrefixLine`
// runs in the CLI/daemon process itself (never inside a spawned child), so
// reading `process.env` directly here is the right source for it too.
export function hasNvm(home = homedir()): boolean {
  const nvmDir = process.env["NVM_DIR"] ?? join(home, ".nvm");
  return existsSync(join(nvmDir, "nvm.sh"));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// An explicit non-`~/.local` prefix (e.g. spur update's derived install
// location) governs this run; `healNpmrcPrefixLine`'s `.npmrc` surgery must
// never happen behind it. `ensureNpmPinFile` no longer consults this — see
// its own doc comment for why the pin-file write is unconditional.
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
// mutates a shared user file. `daemon start` (the sole real boot path —
// never the exported `startServer` fast tests call directly against
// arbitrary/real `$HOME`) wraps this call in its own try/catch instead of
// throwing through it: a read-only filesystem or a permissions error writing
// into `<home>/.spur/` must never abort daemon boot.
//
// Unlike `healNpmrcPrefixLine`, this write is unconditional — it does NOT
// check `explicitPrefixOverridden`. Every consumer that points `NPM_CONFIG_
// GLOBALCONFIG` at this file (`buildSessionEnv` above all) does so
// regardless of any explicit prefix env var, so skipping the write behind an
// operator's explicit pin left the globalconfig env var dangling at a
// missing file — npm silently ignores that and falls back to node's own
// prefix instead of `~/.local`. Writing anyway cannot override the
// operator's choice: npm's env layer outranks a globalconfig file's
// `prefix=` line unconditionally (verified empirically — an env `prefix`
// wins over a globalconfig-file `prefix` regardless of which is set first),
// so this write only ever removes the dangling pointer, never an operator
// override.
//
// This pin file governs where every agent session's `npm install -g` lands,
// so a world-writable copy lets any local user redirect the agent's install
// target onto their own code. `writeFileSync`'s `mode` option only applies
// when the call creates the file — it silently no-ops on an existing file
// with a looser mode (restored from a backup, copied, created under a
// permissive umask by an older build, and — observed live — `npm config set
// --location=global` itself always chmods its target to 0666 regardless of
// umask). The explicit `chmodSync` below enforces 0600 on the pin FILE
// unconditionally, on both the create and the refresh path. The pin
// directory only gets 0700 on create (`mkdirSync`'s `mode`, which — like
// `writeFileSync`'s — is create-only): `~/.spur` also holds config,
// worktrees, logs, and rollback state, so forcing 0700 on every boot would
// silently revert group/other access an operator deliberately set on the
// directory for unrelated reasons; the file's own 0600 is what carries this
// function's actual threat model (a world-writable pin redirecting agent
// installs), not the directory's mode.
export function ensureNpmPinFile(home = homedir()): void {
  const expected = npmGlobalPrefix(home);
  const pinPath = npmPinConfigPath(home);
  const pinDir = dirname(pinPath);
  mkdirSync(pinDir, { recursive: true, mode: 0o700 });
  writeFileSync(pinPath, `prefix=${expected}\n`, { mode: 0o600 });
  chmodSync(pinPath, 0o600);
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
//
// Gated on `hasNvm`, sharing that one predicate with the doctor's
// `npmrc-nvm-conflict` check: on a host without nvm this line is not just
// harmless but load-bearing — the `~/.spur/npmrc` globalconfig pin only
// reaches Spur-spawned sessions, never the operator's own login shell, so a
// bare `npm install -g` run by the operator directly depends on this exact
// `~/.npmrc` line to land in `~/.local` at all. Verified empirically: on a
// host with no nvm, removing the line makes a bare `npm config get prefix`
// fall back to node's own install prefix, not `~/.local`.
export function healNpmrcPrefixLine(home = homedir()): void {
  if (explicitPrefixOverridden(home)) return;
  if (!hasNvm(home)) return;
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
