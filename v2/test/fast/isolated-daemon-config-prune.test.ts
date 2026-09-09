import { spawn as spawnChildProcess, execFile } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
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

// Extracts dir_has_unsaved_work() alone (nested 2-space closing brace, per
// its own placement rule), so its return code can be pinned directly
// without going through prune_stale_config_dirs' GATE A/B and the
// subsequent `rm -rf`. That decoupling matters here specifically: a
// directory find must open to enumerate is, by POSIX permission symmetry,
// also a directory `rm -rf` cannot descend into — so a find-failure
// mutation can leave the on-disk dir "surviving" by an unrelated rm
// permission error even when dir_has_unsaved_work itself wrongly decided
// to prune. The exit code is the only unambiguous signal.
function extractDirHasUnsavedWorkSource(): string {
  const lines = readFileSync(SCRIPT_PATH, "utf8").split("\n");
  const start = lines.findIndex((line) => line.trim().startsWith("dir_has_unsaved_work() {"));
  if (start === -1) {
    throw new Error("dir_has_unsaved_work() not found in spur-isolated-daemon.sh");
  }
  const end = lines.findIndex((line, index) => index > start && line === "  }");
  if (end === -1) {
    throw new Error("dir_has_unsaved_work()'s closing brace not found");
  }
  return lines.slice(start, end + 1).join("\n");
}

// Runs dir_has_unsaved_work(dir) in isolation and returns its exit code:
// 0 = keep, 1 = safe to prune. `tmp_root` is a dynamically-scoped local
// the real function reads from its caller (prune_stale_config_dirs) for
// its own find-results temp file; this harness sets it directly since
// there is no outer function invocation here.
async function runDirHasUnsavedWork(dir: string, tmpRootForList: string): Promise<number> {
  const script = `set -uo pipefail\ntmp_root="${tmpRootForList}"\n${extractDirHasUnsavedWorkSource()}\ndir_has_unsaved_work "$1"\necho $?\n`;
  const { stdout } = await execFileAsync("bash", ["-c", script, "_", dir]);
  return Number.parseInt(stdout.trim(), 10);
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

// GATE C (859/B2) fixtures: a `worktrees/<project>/<session>` git checkout
// in a chosen dirty/clean state. `gitEnv` pins HOME/GIT_CONFIG_GLOBAL so
// `git status`/`commit`/`push` never touch the real operator's identity or
// global config, and never hit "detected dubious ownership" under a
// container uid mismatch.
async function makeGitTestHome(): Promise<{ home: string; env: NodeJS.ProcessEnv }> {
  const home = await mkdtemp(join(tmpdir(), "spur-prune-git-home-"));
  const gitConfigPath = join(home, ".gitconfig");
  writeFileSync(
    gitConfigPath,
    [
      "[user]",
      "  name = Spur Prune Test",
      "  email = spur-prune-test@example.com",
      "[init]",
      "  defaultBranch = main",
      "[safe]",
      "  directory = *",
    ].join("\n"),
    "utf8",
  );
  return {
    home,
    env: {
      PATH: process.env["PATH"] ?? "",
      HOME: home,
      GIT_CONFIG_GLOBAL: gitConfigPath,
    },
  };
}

function worktreeSessionDir(configDir: string): string {
  const dir = join(configDir, "worktrees", "api", "api-1");
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function git(env: NodeJS.ProcessEnv, cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", ["-C", cwd, ...args], { env });
}

// Clean, pushed worktree: a bare "origin" remote, one committed file, pushed
// and tracked — the baseline every dirty variant below starts from.
async function makeCleanPushedWorktree(
  env: NodeJS.ProcessEnv,
  wt: string,
  originRoot: string,
): Promise<void> {
  const originDir = join(originRoot, "origin.git");
  await execFileAsync("git", ["init", "-q", "--bare", "-b", "main", originDir], { env });
  await git(env, wt, "init", "-q", "-b", "main");
  writeFileSync(join(wt, "committed.txt"), "hello\n", "utf8");
  await git(env, wt, "add", "committed.txt");
  await git(env, wt, "commit", "-q", "-m", "initial");
  await git(env, wt, "remote", "add", "origin", originDir);
  await git(env, wt, "push", "-q", "-u", "origin", "main");
}

async function runPrune(options: {
  tmpRoot: string;
  configDir: string;
  psArgsOutput?: string;
  psArgsFail?: boolean;
  psPidOutput?: string;
  psPidFail?: boolean;
  fakeBinDir: string;
  // GATE C (859/B2): HOME + GIT_CONFIG_GLOBAL for the real `git` calls
  // inside dir_has_unsaved_work. Without HOME, `git status` in a fixture
  // repo can exit 128 ("detected dubious ownership" / no global config),
  // which GATE C converts to "keep" — a green test proving nothing. Callers
  // exercising GATE C pass the SAME home their fixture worktree was created
  // under; every other caller gets a fresh, harmless throwaway one.
  gitHome?: { home: string; env: NodeJS.ProcessEnv };
}): Promise<void> {
  const {
    tmpRoot,
    configDir,
    psArgsOutput = "",
    psArgsFail = false,
    psPidOutput = "",
    psPidFail = false,
    fakeBinDir,
    gitHome,
  } = options;
  const resolvedGitHome = gitHome ?? (await makeGitTestHome());
  if (!gitHome) {
    cleanupPaths.push(resolvedGitHome.home);
  }
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
      HOME: resolvedGitHome.home,
      GIT_CONFIG_GLOBAL: join(resolvedGitHome.home, ".gitconfig"),
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

// GATE C (859/B2): the prune must never delete a stale dir whose
// worktrees/<project>/<session> holds unsaved or unevaluable work.
describe("spur-isolated-daemon.sh prune_stale_config_dirs: GATE C", () => {
  it("859/AC15: keeps a stale dir with an untracked file", async () => {
    const gitHome = await makeGitTestHome();
    cleanupPaths.push(gitHome.home);
    const tmpRoot = await mkdtemp(join(tmpdir(), "spur-prune-test-"));
    cleanupPaths.push(tmpRoot);
    const configDir = join(tmpRoot, "spur-isolated-daemon.self");
    mkdirSync(configDir, { recursive: true });
    const stale = await makeStaleDir(tmpRoot, "spur-isolated-daemon.dirty-untracked", 120);
    const wt = worktreeSessionDir(stale);
    await makeCleanPushedWorktree(gitHome.env, wt, tmpRoot);
    writeFileSync(join(wt, "untracked.txt"), "surprise\n", "utf8");
    await makeStaleDir(tmpRoot, "spur-isolated-daemon.dirty-untracked", 120);

    await runPrune({ tmpRoot, configDir, fakeBinDir: join(tmpRoot, "bin"), gitHome });

    expect(existsSync(stale)).toBe(true);
  });

  it("859/AC15: keeps a stale dir with a modified tracked file", async () => {
    const gitHome = await makeGitTestHome();
    cleanupPaths.push(gitHome.home);
    const tmpRoot = await mkdtemp(join(tmpdir(), "spur-prune-test-"));
    cleanupPaths.push(tmpRoot);
    const configDir = join(tmpRoot, "spur-isolated-daemon.self");
    mkdirSync(configDir, { recursive: true });
    const stale = await makeStaleDir(tmpRoot, "spur-isolated-daemon.dirty-modified", 120);
    const wt = worktreeSessionDir(stale);
    await makeCleanPushedWorktree(gitHome.env, wt, tmpRoot);
    writeFileSync(join(wt, "committed.txt"), "changed\n", "utf8");
    await makeStaleDir(tmpRoot, "spur-isolated-daemon.dirty-modified", 120);

    await runPrune({ tmpRoot, configDir, fakeBinDir: join(tmpRoot, "bin"), gitHome });

    expect(existsSync(stale)).toBe(true);
  });

  it("859/AC15: keeps a stale dir with a commit unreachable from upstream (unpushed)", async () => {
    const gitHome = await makeGitTestHome();
    cleanupPaths.push(gitHome.home);
    const tmpRoot = await mkdtemp(join(tmpdir(), "spur-prune-test-"));
    cleanupPaths.push(tmpRoot);
    const configDir = join(tmpRoot, "spur-isolated-daemon.self");
    mkdirSync(configDir, { recursive: true });
    const stale = await makeStaleDir(tmpRoot, "spur-isolated-daemon.dirty-unpushed", 120);
    const wt = worktreeSessionDir(stale);
    await makeCleanPushedWorktree(gitHome.env, wt, tmpRoot);
    writeFileSync(join(wt, "second.txt"), "more\n", "utf8");
    await git(gitHome.env, wt, "add", "second.txt");
    await git(gitHome.env, wt, "commit", "-q", "-m", "unpushed");
    await makeStaleDir(tmpRoot, "spur-isolated-daemon.dirty-unpushed", 120);

    await runPrune({ tmpRoot, configDir, fakeBinDir: join(tmpRoot, "bin"), gitHome });

    expect(existsSync(stale)).toBe(true);
  });

  it("859/AC15: keeps a stale dir with a non-repo, non-empty session directory", async () => {
    const gitHome = await makeGitTestHome();
    cleanupPaths.push(gitHome.home);
    const tmpRoot = await mkdtemp(join(tmpdir(), "spur-prune-test-"));
    cleanupPaths.push(tmpRoot);
    const configDir = join(tmpRoot, "spur-isolated-daemon.self");
    mkdirSync(configDir, { recursive: true });
    const stale = await makeStaleDir(tmpRoot, "spur-isolated-daemon.dirty-non-repo", 120);
    const wt = worktreeSessionDir(stale);
    writeFileSync(join(wt, "some-file.txt"), "content\n", "utf8");
    await makeStaleDir(tmpRoot, "spur-isolated-daemon.dirty-non-repo", 120);

    await runPrune({ tmpRoot, configDir, fakeBinDir: join(tmpRoot, "bin"), gitHome });

    expect(existsSync(stale)).toBe(true);
  });

  it("859/AC15: keeps a stale dir whose worktrees/ root is unreadable", async () => {
    const gitHome = await makeGitTestHome();
    cleanupPaths.push(gitHome.home);
    const tmpRoot = await mkdtemp(join(tmpdir(), "spur-prune-test-"));
    cleanupPaths.push(tmpRoot);
    const configDir = join(tmpRoot, "spur-isolated-daemon.self");
    mkdirSync(configDir, { recursive: true });
    const stale = await makeStaleDir(tmpRoot, "spur-isolated-daemon.dirty-unreadable-root", 120);
    const worktreesRoot = join(stale, "worktrees");
    mkdirSync(worktreesRoot, { recursive: true });
    chmodSync(worktreesRoot, 0o000);
    await makeStaleDir(tmpRoot, "spur-isolated-daemon.dirty-unreadable-root", 120);

    try {
      await runPrune({ tmpRoot, configDir, fakeBinDir: join(tmpRoot, "bin"), gitHome });
      expect(existsSync(stale)).toBe(true);
    } finally {
      chmodSync(worktreesRoot, 0o700);
    }
  });

  it("859/AC15: dir_has_unsaved_work keeps (returns 0) when a subdirectory under worktrees/ is unreadable (find failure, not the root)", async () => {
    // `worktrees/` itself is readable here (unlike the case above) — the
    // failure is one level down, at worktrees/<project>, which
    // `find -mindepth 2 -maxdepth 2` must open to enumerate the
    // worktrees/<project>/<session> dirs beneath it. A mode-000 <project>
    // dir makes `find` exit nonzero while printing nothing from inside it —
    // the exact "found=() -> return 1 -> rm -rf" data-loss path a reviewer
    // reproduced against an earlier draft of this gate, where
    // `done < <(find ...) || return 0` silently discarded find's own exit
    // status (bash attaches that `||` to the loop body, never the process
    // substitution).
    //
    // Asserts dir_has_unsaved_work's OWN exit code directly, not the
    // survival of the on-disk dir afterward: the same permission bit that
    // blocks `find` from enumerating `<project>` also blocks `rm -rf` from
    // descending into it (POSIX symmetry — both need read+execute on the
    // same directory to see its children), so `rm -rf $dir` on a bug-hit
    // "prune" decision would still fail to remove the blocked subtree and
    // leave the outer dir "surviving" by accident — a false pass that says
    // nothing about whether the GATE itself made the right call.
    const stale = await mkdtemp(join(tmpdir(), "spur-prune-unreadable-sub-"));
    cleanupPaths.push(stale);
    const projectDir = join(stale, "worktrees", "api");
    const sessionDir = join(projectDir, "api-1");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, "dirty.txt"), "uncommitted\n", "utf8");
    chmodSync(projectDir, 0o000);

    try {
      const exitCode = await runDirHasUnsavedWork(stale, stale);
      expect(exitCode).toBe(0);
    } finally {
      chmodSync(projectDir, 0o700);
    }
  });

  it("859/AC15: keeps a stale dir when a `git` call fails outright (corrupt .git)", async () => {
    const gitHome = await makeGitTestHome();
    cleanupPaths.push(gitHome.home);
    const tmpRoot = await mkdtemp(join(tmpdir(), "spur-prune-test-"));
    cleanupPaths.push(tmpRoot);
    const configDir = join(tmpRoot, "spur-isolated-daemon.self");
    mkdirSync(configDir, { recursive: true });
    const stale = await makeStaleDir(tmpRoot, "spur-isolated-daemon.dirty-corrupt-git", 120);
    const wt = worktreeSessionDir(stale);
    // A `.git` entry that exists but is not a valid git dir: `git status`
    // exits nonzero, exercising the `|| return 0` (keep) fail-safe rather
    // than the "no .git at all" non-repo branch above.
    writeFileSync(join(wt, ".git"), "not a real gitdir\n", "utf8");
    await makeStaleDir(tmpRoot, "spur-isolated-daemon.dirty-corrupt-git", 120);

    await runPrune({ tmpRoot, configDir, fakeBinDir: join(tmpRoot, "bin"), gitHome });

    expect(existsSync(stale)).toBe(true);
  });

  it("859/AC15: removes an otherwise-stale dir whose worktree is clean, pushed, and its only untracked-looking entry is a gitignored symlinked node_modules", async () => {
    const gitHome = await makeGitTestHome();
    cleanupPaths.push(gitHome.home);
    const tmpRoot = await mkdtemp(join(tmpdir(), "spur-prune-test-"));
    cleanupPaths.push(tmpRoot);
    const configDir = join(tmpRoot, "spur-isolated-daemon.self");
    mkdirSync(configDir, { recursive: true });
    const stale = await makeStaleDir(tmpRoot, "spur-isolated-daemon.clean-pushed", 120);
    const wt = worktreeSessionDir(stale);
    await makeCleanPushedWorktree(gitHome.env, wt, tmpRoot);
    const realNodeModules = join(tmpRoot, "shared-node-modules");
    mkdirSync(realNodeModules, { recursive: true });
    symlinkSync(realNodeModules, join(wt, "node_modules"));
    writeFileSync(join(wt, ".gitignore"), "node_modules\n", "utf8");
    await git(gitHome.env, wt, "add", ".gitignore");
    await git(gitHome.env, wt, "commit", "-q", "-m", "ignore node_modules");
    await git(gitHome.env, wt, "push", "-q");
    await makeStaleDir(tmpRoot, "spur-isolated-daemon.clean-pushed", 120);

    await runPrune({ tmpRoot, configDir, fakeBinDir: join(tmpRoot, "bin"), gitHome });

    expect(existsSync(stale)).toBe(false);
  });
});

// 859/AC17: GATE A's `ps` substring depends on the wrapper's own `--config`
// line (script:175) staying in sync. Extracted BY PATTERN from the real
// script, never hardcoded, so this fails on a one-sided change either way.
describe("spur-isolated-daemon.sh: GATE A / wrapper exec line cross-file pin", () => {
  it("859/AC17: a ps line synthesized from the wrapper's own exec line is matched by GATE A's grep, so the dir survives", async () => {
    const scriptLines = readFileSync(SCRIPT_PATH, "utf8").split("\n");
    const execLine = scriptLines.find(
      (line) => line.startsWith("exec ") && line.includes("--config") && line.includes("CLI_PATH"),
    );
    if (!execLine) {
      throw new Error("wrapper's --config exec line not found in spur-isolated-daemon.sh");
    }

    const tmpRoot = await mkdtemp(join(tmpdir(), "spur-prune-test-"));
    cleanupPaths.push(tmpRoot);
    const configDir = join(tmpRoot, "spur-isolated-daemon.self");
    mkdirSync(configDir, { recursive: true });
    const stale = await makeStaleDir(tmpRoot, "spur-isolated-daemon.live-via-wrapper", 120);
    // Substitute the same shell variables the real wrapper heredoc would
    // have expanded at generation time, synthesizing the exact `ps args=`
    // line a live daemon for THIS dir would produce.
    const synthesizedPsLine = execLine
      .replace(/^exec\s+/, "")
      .replaceAll('"$NODE_BIN"', "/usr/bin/node")
      .replaceAll('"$CLI_PATH"', `${stale}/v2/dist/cli.js`)
      .replaceAll('"$CONFIG_DIR/config.yaml"', `${stale}/config.yaml`)
      .replaceAll('"\\$@"', "daemon start");

    await runPrune({
      tmpRoot,
      configDir,
      psArgsOutput: synthesizedPsLine,
      fakeBinDir: join(tmpRoot, "bin"),
    });

    expect(existsSync(stale)).toBe(true);
  });
});
