// Regression repro for the sidecar-npm-prefix-leak break: nvm 0.39.7's own
// `nvm_die_on_prefix` (nvm.sh:2610-2660) refuses to load whenever it sees an
// `NPM_CONFIG_PREFIX`/`PREFIX` env var (guard 1) or a `prefix=`/
// `globalconfig=` line in `$HOME/.npmrc` (guard 2, nvm.sh:2601-2607,2701-2712)
// — both of which #618 introduced into every sidecar/service/login pane.
// `buildCommandSessionShellCommand` (runtime-tmux.ts) must strip every name
// guard 1 reacts to before the pane ever sources `~/.nvm/nvm.sh`; guard 2 is
// covered by never writing a `prefix=`/`globalconfig=` line into `~/.npmrc`
// (see npm-prefix.test.ts) so it never fires in the first place. This file
// proves guard 1 specifically: never writes to this host's real `$HOME`,
// `~/.npmrc`, or `~/.nvm`.
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { NPM_PIN_SANITIZE_ENV_KEYS } from "../../src/npm-prefix.js";
import { buildCommandSessionShellCommand } from "../../src/runtime-tmux.js";

// Reproduces nvm.sh's own guard 1 (env-name scan, verbatim awk one-liner,
// plus the bare-PREFIX check) and guard 2 ($HOME/.npmrc grep) closely enough
// to prove the sanitize wrap is both necessary and sufficient for guard 1,
// without depending on this host having any particular nvm version
// installed. Deliberately POSIX/dash-safe (no bashisms) since
// `createTmuxCommandSession` runs the wrap through `sh -lc`.
const STUB_NVM_SH = `
nvm() {
  if [ "$1" = "use" ]; then
    version="$2"
    if [ "$version" = "--silent" ]; then
      version="$3"
    fi

    hit=$(awk 'BEGIN { for (name in ENVIRON) if (toupper(name) == "NPM_CONFIG_PREFIX") { print name; break } }')
    if [ -n "$hit" ]; then
      printf 'nvm is not compatible with the "%s" environment variable\n' "$hit" >&2
      return 4
    fi

    if [ -n "$PREFIX" ]; then
      printf 'nvm is not compatible with the "PREFIX" environment variable\n' >&2
      return 4
    fi

    if [ -f "$HOME/.npmrc" ] && grep -Eq '^(prefix|globalconfig) *=' "$HOME/.npmrc"; then
      printf 'user npmrc has a prefix/globalconfig setting, incompatible with nvm\n' >&2
      return 10
    fi

    PATH="$NVM_DIR/versions/node/$version/bin:$PATH"
    export PATH
    return 0
  fi
}
`;

function writeFakeNode(nodeDir: string): void {
  mkdirSync(nodeDir, { recursive: true });
  writeFileSync(join(nodeDir, "node"), "#!/bin/sh\necho fake-node\n", { mode: 0o755 });
}

// Every sanitize key contaminated at once — the exact env shape a pane
// inherits once tmux's `-e` args (which spread the daemon's whole
// `process.env`, per `buildEnvArgs`) merge with `buildSessionEnv`'s own pin.
function contaminatedEnv(extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  for (const key of NPM_PIN_SANITIZE_ENV_KEYS) {
    env[key] = "/contaminated/value";
  }
  return env;
}

// execFileSync only exposes captured stderr through the thrown error on a
// nonzero exit — irrelevant here, since the guard function's own `return 4`
// doesn't propagate to the whole script's exit code (the trailing
// `command -v node` does). Redirect stderr to a file instead, so both
// branches are asserted on the same signal regardless of exit code.
function runCapturingStderr(command: string, env: NodeJS.ProcessEnv, stderrFile: string): string {
  try {
    return execFileSync("/bin/bash", ["-c", `${command} 2>${stderrFile}`], {
      env,
      encoding: "utf8",
    });
  } catch (error) {
    return String((error as { stdout?: string }).stdout ?? "");
  }
}

describe("nvm guard sanitize (stub nvm.sh, guard 1 repro)", () => {
  let tmpHome: string;

  afterEach(() => {
    if (tmpHome) rmSync(tmpHome, { recursive: true, force: true });
  });

  it("keeps the fake node resolvable with empty stderr under a fully contaminated env", () => {
    tmpHome = mkdtempSync(join(tmpdir(), "spur-nvm-guard-sanitize-"));
    const nvmDir = join(tmpHome, ".nvm");
    writeFakeNode(join(nvmDir, "versions", "node", "v20.12.2", "bin"));
    writeFileSync(join(nvmDir, "nvm.sh"), STUB_NVM_SH);
    writeFileSync(join(tmpHome, ".npmrc"), "//registry.npmjs.org/:_authToken=fake-token\n");

    const script = `. $HOME/.nvm/nvm.sh; nvm use v20.12.2; command -v node`;
    const wrapped = buildCommandSessionShellCommand(script);
    const stderrFile = join(tmpHome, "stderr.log");

    const env = contaminatedEnv({ HOME: tmpHome, NVM_DIR: nvmDir });
    const stdout = runCapturingStderr(wrapped, env, stderrFile);

    expect(stdout.trim()).toBe(join(nvmDir, "versions", "node", "v20.12.2", "bin", "node"));
    expect(readFileSync(stderrFile, "utf8")).toBe("");
  });

  it("emits nvm's guard-1 message without the sanitize wrap, same contaminated env", () => {
    tmpHome = mkdtempSync(join(tmpdir(), "spur-nvm-guard-sanitize-unwrapped-"));
    const nvmDir = join(tmpHome, ".nvm");
    writeFakeNode(join(nvmDir, "versions", "node", "v20.12.2", "bin"));
    writeFileSync(join(nvmDir, "nvm.sh"), STUB_NVM_SH);
    writeFileSync(join(tmpHome, ".npmrc"), "//registry.npmjs.org/:_authToken=fake-token\n");

    const script = `. $HOME/.nvm/nvm.sh; nvm use v20.12.2; command -v node`;
    const unwrapped = `sh -lc ${JSON.stringify(script)}`;
    const stderrFile = join(tmpHome, "stderr.log");

    const env = contaminatedEnv({ HOME: tmpHome, NVM_DIR: nvmDir });
    runCapturingStderr(unwrapped, env, stderrFile);

    expect(readFileSync(stderrFile, "utf8")).toMatch(
      /nvm is not compatible with the "(NPM_CONFIG_PREFIX|npm_config_prefix)" environment variable/,
    );
  });
});

function firstInstalledNodeVersion(nvmDir: string): string | undefined {
  const versionsDir = join(nvmDir, "versions", "node");
  if (!existsSync(versionsDir)) return undefined;
  const entries = readdirSync(versionsDir).filter((entry) => entry.startsWith("v"));
  return entries[0];
}

const realNvmDir = join(homedir(), ".nvm");
const realNvmScript = join(realNvmDir, "nvm.sh");
const realNvmAvailable =
  existsSync(realNvmScript) && firstInstalledNodeVersion(realNvmDir) !== undefined;

describe.skipIf(!realNvmAvailable)("nvm guard sanitize (real ~/.nvm, read-only)", () => {
  let tmpHome: string;

  afterEach(() => {
    if (tmpHome) rmSync(tmpHome, { recursive: true, force: true });
  });

  it("loads a real installed node version with no guard output under a contaminated env", () => {
    tmpHome = mkdtempSync(join(tmpdir(), "spur-nvm-guard-real-"));
    // Symlinked read-only into the temp home — never writes into the real
    // `~/.nvm`. `NVM_SYMLINK_CURRENT` is unset, so `nvm use` writes nothing.
    symlinkSync(realNvmDir, join(tmpHome, ".nvm"));
    writeFileSync(join(tmpHome, ".npmrc"), "//registry.npmjs.org/:_authToken=fake-token\n");
    const version = firstInstalledNodeVersion(realNvmDir);
    if (!version) throw new Error("expected an installed nvm node version");

    // `sh` is dash on Debian/Ubuntu and lacks `source`/nvm's own bashisms, so
    // the sanctioned sidecar-nvm pattern (docs/commands.md) explicitly
    // invokes `bash -lc` — mirrored here rather than sourcing nvm.sh directly
    // under the outer `sh -lc`.
    const innerScript = `. $HOME/.nvm/nvm.sh && nvm use --silent ${version} && command -v node`;
    const script = `bash -lc "${innerScript}"`;
    const wrapped = buildCommandSessionShellCommand(script);
    const stderrFile = join(tmpHome, "stderr.log");

    const env = contaminatedEnv({ HOME: tmpHome });
    const stdout = runCapturingStderr(wrapped, env, stderrFile);

    // `nvm_cd`'s `pwd` resolves the `$HOME/.nvm` symlink to its real target
    // when computing `NVM_DIR`, so the resolved node path is under the real
    // `~/.nvm`, not the temp symlink path — still never written to.
    expect(stdout.trim()).toBe(join(realNvmDir, "versions", "node", version, "bin", "node"));
    expect(readFileSync(stderrFile, "utf8")).toBe("");
  });
});
