import { spawn as spawnChildProcess, execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = resolve(HERE, "../../../scripts/spur-isolated-daemon.sh");

// Extracts prune_stale_config_dirs() verbatim from the real script — the
// same "test the exact fragment the script writes/defines" pattern as
// isolated-daemon-user-config-precedence.test.ts's configHeredocBody(), so
// this test exercises the real function body, not a reimplementation of it.
function extractPruneFunctionSource(): string {
  const lines = readFileSync(SCRIPT_PATH, "utf8").split("\n");
  const start = lines.findIndex((line) => line.startsWith("prune_stale_config_dirs() {"));
  if (start === -1) {
    throw new Error("prune_stale_config_dirs() not found in spur-isolated-daemon.sh");
  }
  const end = lines.findIndex((line, index) => index > start && line === "}");
  if (end === -1) {
    throw new Error("prune_stale_config_dirs()'s closing brace not found");
  }
  return lines.slice(start, end + 1).join("\n");
}

const cleanupPaths: string[] = [];

afterEach(async () => {
  for (const path of cleanupPaths.splice(0)) {
    await rm(path, { recursive: true, force: true }).catch(() => undefined);
  }
});

function makeExecutable(path: string, source: string): void {
  writeFileSync(path, source, "utf8");
  chmodSync(path, 0o755);
}

async function makeStaleDir(root: string, name: string, ageMinutes: number): Promise<string> {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const past = new Date(Date.now() - ageMinutes * 60_000);
  utimesSync(dir, past, past);
  return dir;
}

async function runPrune(options: {
  tmpRoot: string;
  configDir: string;
  psArgsOutput?: string;
  psArgsFail?: boolean;
  psPidOutput?: string;
  psPidFail?: boolean;
  fakeBinDir: string;
}): Promise<void> {
  const {
    tmpRoot,
    configDir,
    psArgsOutput = "",
    psArgsFail = false,
    psPidOutput = "",
    psPidFail = false,
    fakeBinDir,
  } = options;
  mkdirSync(fakeBinDir, { recursive: true });
  const fakePs = join(fakeBinDir, "ps");
  makeExecutable(
    fakePs,
    // Pins the exact argv invariant I3 rests on: GATE A is \`ps -eo args=\`
    // (exactly 2 args), GATE B is \`ps -o pid= -u <uid>\` (exactly 4, "-o"
    // never "-e" — "-e" overrides "-u" and returns the whole table). Any
    // other invocation fails LOUDLY instead of falling through to the real
    // \`ps\`, so a mutation of either flag set is a prune-suite failure, not
    // a silent real-ps passthrough that happens to still look fine.
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "$#" -eq 2 && "$1" == "-eo" && "$2" == "args=" ]]; then
  if [[ "${psArgsFail ? "1" : "0"}" == "1" ]]; then
    exit 1
  fi
  printf '%s\\n' "$PRUNE_TEST_PS_ARGS_OUTPUT"
  exit 0
fi
if [[ "$#" -eq 4 && "$1" == "-o" && "$2" == "pid=" && "$3" == "-u" && "$4" =~ ^[0-9]+$ ]]; then
  if [[ "${psPidFail ? "1" : "0"}" == "1" ]]; then
    exit 1
  fi
  printf '%s\\n' "$PRUNE_TEST_PS_PID_OUTPUT"
  exit 0
fi

echo "unexpected ps invocation: $*" >&2
exit 97
`,
  );

  const script = `set -euo pipefail\n${extractPruneFunctionSource()}\nprune_stale_config_dirs\n`;
  await execFileAsync("bash", ["-c", script], {
    env: {
      PATH: `${fakeBinDir}:${process.env["PATH"] ?? ""}`,
      TMPDIR: tmpRoot,
      CONFIG_DIR: configDir,
      PRUNE_TEST_PS_ARGS_OUTPUT: psArgsOutput,
      PRUNE_TEST_PS_PID_OUTPUT: psPidOutput,
    },
  });
}

describe("spur-isolated-daemon.sh prune_stale_config_dirs", () => {
  it("removes a stale, unreferenced dir", async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), "spur-prune-test-"));
    cleanupPaths.push(tmpRoot);
    const configDir = join(tmpRoot, "spur-isolated-daemon.self");
    mkdirSync(configDir, { recursive: true });
    const stale = await makeStaleDir(tmpRoot, "spur-isolated-daemon.stale1", 120);

    await runPrune({
      tmpRoot,
      configDir,
      fakeBinDir: join(tmpRoot, "bin"),
    });

    expect(existsSync(stale)).toBe(false);
  });

  it("keeps a stale dir named in ps argv output (GATE A)", async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), "spur-prune-test-"));
    cleanupPaths.push(tmpRoot);
    const configDir = join(tmpRoot, "spur-isolated-daemon.self");
    mkdirSync(configDir, { recursive: true });
    const stale = await makeStaleDir(tmpRoot, "spur-isolated-daemon.live-argv", 120);

    await runPrune({
      tmpRoot,
      configDir,
      psArgsOutput: `node /some/cli.js --config ${stale}/config.yaml daemon start`,
      fakeBinDir: join(tmpRoot, "bin"),
    });

    expect(existsSync(stale)).toBe(true);
  });

  it("keeps a stale dir a live own-uid pid has as its cwd, including a cwd under <dir>/worktrees (GATE B)", async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), "spur-prune-test-"));
    cleanupPaths.push(tmpRoot);
    const configDir = join(tmpRoot, "spur-isolated-daemon.self");
    mkdirSync(configDir, { recursive: true });
    const stale = await makeStaleDir(tmpRoot, "spur-isolated-daemon.live-cwd", 120);
    const worktreeCwd = join(stale, "worktrees", "api", "api-1");
    mkdirSync(worktreeCwd, { recursive: true });
    // Re-apply: the nested mkdir just bumped `stale`'s mtime to now, dropping
    // it below the 60-minute floor so GATE B is never reached.
    await makeStaleDir(tmpRoot, "spur-isolated-daemon.live-cwd", 120);

    // A real, disposable child whose cwd is genuinely inside the candidate
    // dir's worktrees subtree — readlink -f /proc/<pid>/cwd must resolve to
    // a real path, so this needs a real process, not a fabricated pid.
    const child = spawnChildProcess("sleep", ["30"], { cwd: worktreeCwd, detached: true });
    const childPid = child.pid;
    expect(childPid).toBeDefined();

    try {
      await runPrune({
        tmpRoot,
        configDir,
        psPidOutput: String(childPid),
        fakeBinDir: join(tmpRoot, "bin"),
      });

      expect(existsSync(stale)).toBe(true);
    } finally {
      if (childPid !== undefined) {
        try {
          process.kill(-childPid, "SIGKILL");
        } catch {
          // already gone
        }
      }
    }
  });

  it("keeps a dir younger than the 60-minute floor", async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), "spur-prune-test-"));
    cleanupPaths.push(tmpRoot);
    const configDir = join(tmpRoot, "spur-isolated-daemon.self");
    mkdirSync(configDir, { recursive: true });
    const fresh = join(tmpRoot, "spur-isolated-daemon.fresh");
    mkdirSync(fresh, { recursive: true });

    await runPrune({
      tmpRoot,
      configDir,
      fakeBinDir: join(tmpRoot, "bin"),
    });

    expect(existsSync(fresh)).toBe(true);
  });

  it("keeps $CONFIG_DIR itself even when it matches the stale-name pattern and age floor", async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), "spur-prune-test-"));
    cleanupPaths.push(tmpRoot);
    const configDir = await makeStaleDir(tmpRoot, "spur-isolated-daemon.self", 120);

    await runPrune({
      tmpRoot,
      configDir,
      fakeBinDir: join(tmpRoot, "bin"),
    });

    expect(existsSync(configDir)).toBe(true);
  });

  it("removes nothing when ps exits nonzero", async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), "spur-prune-test-"));
    cleanupPaths.push(tmpRoot);
    const configDir = join(tmpRoot, "spur-isolated-daemon.self");
    mkdirSync(configDir, { recursive: true });
    const stale = await makeStaleDir(tmpRoot, "spur-isolated-daemon.stale-ps-fail", 120);

    await runPrune({
      tmpRoot,
      configDir,
      psArgsFail: true,
      fakeBinDir: join(tmpRoot, "bin"),
    });

    expect(existsSync(stale)).toBe(true);
  });

  it("removes nothing when the own-uid pid-listing ps exits nonzero (same fail-safe rule as the argv gate)", async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), "spur-prune-test-"));
    cleanupPaths.push(tmpRoot);
    const configDir = join(tmpRoot, "spur-isolated-daemon.self");
    mkdirSync(configDir, { recursive: true });
    const stale = await makeStaleDir(tmpRoot, "spur-isolated-daemon.stale-pid-ps-fail", 120);

    await runPrune({
      tmpRoot,
      configDir,
      psPidFail: true,
      fakeBinDir: join(tmpRoot, "bin"),
    });

    expect(existsSync(stale)).toBe(true);
  });

  it("still removes an otherwise-stale dir when the fake pid list contains a pid whose /proc/<pid>/cwd is unreadable", async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), "spur-prune-test-"));
    cleanupPaths.push(tmpRoot);
    const configDir = join(tmpRoot, "spur-isolated-daemon.self");
    mkdirSync(configDir, { recursive: true });
    const stale = await makeStaleDir(tmpRoot, "spur-isolated-daemon.stale-unreadable-cwd", 120);

    await runPrune({
      tmpRoot,
      configDir,
      // A pid certain to be absent from /proc — readlink -f fails, that one
      // pid is skipped, and the scan continues instead of aborting.
      psPidOutput: "999999999",
      fakeBinDir: join(tmpRoot, "bin"),
    });

    expect(existsSync(stale)).toBe(false);
  });

  it("an unremovable candidate does not abort the script or block later candidates (fail-DANGEROUS regression pin)", async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), "spur-prune-test-"));
    cleanupPaths.push(tmpRoot);
    const configDir = join(tmpRoot, "spur-isolated-daemon.self");
    mkdirSync(configDir, { recursive: true });

    // A candidate whose subdir this uid cannot write into — `rm -rf` on it
    // fails (nonzero) while `set -euo pipefail` is active. Named so it
    // sorts and is scanned BEFORE the second, fully-removable candidate:
    // `find`'s output order is not contractual, so both a leading and a
    // later ordinal are covered by naming this "aaa" and the removable one
    // "zzz".
    const unremovable = await makeStaleDir(tmpRoot, "spur-isolated-daemon.aaa-unremovable", 120);
    const lockedSubdir = join(unremovable, "locked");
    mkdirSync(lockedSubdir, { recursive: true });
    writeFileSync(join(lockedSubdir, "file"), "x", "utf8");
    chmodSync(lockedSubdir, 0o500);
    // Re-apply: creating the subdir/file above just bumped `unremovable`'s
    // own mtime to now, which would drop it below the 60-minute floor and
    // mean the buggy `rm -rf` line is never reached at all.
    await makeStaleDir(tmpRoot, "spur-isolated-daemon.aaa-unremovable", 120);

    const removable = await makeStaleDir(tmpRoot, "spur-isolated-daemon.zzz-removable", 120);

    try {
      await runPrune({
        tmpRoot,
        configDir,
        fakeBinDir: join(tmpRoot, "bin"),
      });
    } finally {
      chmodSync(lockedSubdir, 0o700);
    }

    // The exact assertion the reviewer's fix targets: `rm -rf "$dir" ||
    // true` means the script reaches its end (execFileAsync above did not
    // throw) and the LATER candidate still gets pruned.
    expect(existsSync(removable)).toBe(false);
  });

  it("touches no path outside the injected TMPDIR", async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), "spur-prune-test-"));
    cleanupPaths.push(tmpRoot);
    const configDir = join(tmpRoot, "spur-isolated-daemon.self");
    mkdirSync(configDir, { recursive: true });
    const outsideRoot = await mkdtemp(join(tmpdir(), "spur-prune-outside-"));
    cleanupPaths.push(outsideRoot);
    const outsideStale = await makeStaleDir(outsideRoot, "spur-isolated-daemon.outside", 120);

    await runPrune({
      tmpRoot,
      configDir,
      fakeBinDir: join(tmpRoot, "bin"),
    });

    expect(existsSync(outsideStale)).toBe(true);
  });
});
