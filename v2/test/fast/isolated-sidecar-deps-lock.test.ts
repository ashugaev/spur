// Regression test for ashugaev/spur#823: isolated-daemon publishes its
// handshake while it still needs v2/node_modules for the rest of its life
// (spur-isolated-daemon.sh:138 execs off that tree), so isolated-ui's old
// post-handshake dependency repair (rm -rf + pnpm install) could wipe the
// tree out from under an already-exec'd daemon. The fix moves the probe and
// repair into scripts/spur-sidecar-common.sh, serialized with flock on
// $SPUR_SESSION_TOOL_DIR/workspace-deps.lock, called by BOTH sidecars before
// they touch the tree.
import { execFile } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE_SCRIPT_DIR = resolve(HERE, "../../../scripts");
const REPO_ROOT = resolve(HERE, "../../..");
const cleanupPaths: string[] = [];
// Engines-conformant per the real root package.json.
const DEFAULT_SYS_NODE_VERSION = "v22.13.0";

type FakeWorktree = {
  logPath: string;
  pathDir: string;
  repoDir: string;
  toolDir: string;
};

function makeExecutable(path: string, source: string): void {
  writeFileSync(path, source, "utf8");
  chmodSync(path, 0o755);
}

// Shared node fake for both sidecars: `-v` reports an engines-conformant
// version so ensure_node_ready is a no-op, `-e` and the no-argv stdin-heredoc
// form (workspace_deps_ready's probe) both delegate to the real node so the
// engines check and the next/node-pty probe genuinely inspect the fixture's
// tree. The cli.js branch mirrors the shape spur-isolated-daemon.sh actually
// execs: --version for the load probe, otherwise the daemon-start form,
// which can optionally block on a FIFO so a test can hold "the daemon" alive.
function nodeFakeSource(): string {
  return `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "-v" ]]; then
  printf '${DEFAULT_SYS_NODE_VERSION}\\n'
  exit 0
fi
if [[ "\${1:-}" == "-e" ]]; then
  exec "$SPUR_TEST_REAL_NODE" "$@"
fi
if [[ $# -eq 0 ]]; then
  exec "$SPUR_TEST_REAL_NODE"
fi
case "$1" in
  "$SPUR_TEST_REPO/v2/dist/cli.js")
    if [[ "\${2:-}" == "--version" ]]; then
      echo "cli-probe" >> "$SPUR_TEST_LOG"
      exit 0
    fi
    echo "daemon-start" >> "$SPUR_TEST_LOG"
    if [[ -n "\${SPUR_TEST_DAEMON_FIFO:-}" ]]; then
      cat "$SPUR_TEST_DAEMON_FIFO" > /dev/null
    fi
    exit 0
    ;;
  "$SPUR_TEST_REPO/v2/bin/write-isolated-instance-config.mjs")
    echo "instance-helper" >> "$SPUR_TEST_LOG"
    ;;
  "$SPUR_TEST_REPO/v2/bin/write-isolated-project-config.mjs")
    echo "project-helper" >> "$SPUR_TEST_LOG"
    ;;
  *)
    echo "unexpected-node $*" >> "$SPUR_TEST_LOG"
    exit 82
    ;;
esac
`;
}

// Shared pnpm fake: `install --frozen-lockfile` is the workspace repair,
// `--dir <v2> build` is the daemon's v2 build, `--dir packages/web dev` is
// the UI's dev server. The install branch can block on a FIFO (so a test can
// observe "install in progress") and always materializes a genuinely ready
// tree afterward, so the sidecar that loses the lock race re-probes true.
function pnpmFakeSource(): string {
  return `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "install" ]]; then
  echo "install-start" >> "$SPUR_TEST_LOG"
  if [[ -n "\${SPUR_TEST_INSTALL_FIFO:-}" ]]; then
    cat "$SPUR_TEST_INSTALL_FIFO" > /dev/null
  fi
  mkdir -p "$SPUR_TEST_REPO/node_modules/.pnpm"
  mkdir -p "$SPUR_TEST_REPO/v2/node_modules"
  mkdir -p "$SPUR_TEST_REPO/packages/web/node_modules/next/dist/server/route-modules/pages/builtin"
  cat > "$SPUR_TEST_REPO/packages/web/node_modules/next/package.json" <<'JSON'
{"name":"next"}
JSON
  touch "$SPUR_TEST_REPO/packages/web/node_modules/next/dist/server/route-modules/pages/builtin/_error.js"
  mkdir -p "$SPUR_TEST_REPO/packages/web/node_modules/node-pty"
  cat > "$SPUR_TEST_REPO/packages/web/node_modules/node-pty/package.json" <<'JSON'
{"name":"node-pty","main":"index.js"}
JSON
  echo "module.exports = {};" > "$SPUR_TEST_REPO/packages/web/node_modules/node-pty/index.js"
  echo "install-end" >> "$SPUR_TEST_LOG"
  exit 0
fi
if [[ "$1" == "--dir" && "$3" == "build" ]]; then
  echo "build" >> "$SPUR_TEST_LOG"
  mkdir -p "$SPUR_TEST_REPO/v2/dist"
  for file_name in cli.js isolated-instance-config.js isolated-project-config.js; do
    printf 'built\\n' > "$SPUR_TEST_REPO/v2/dist/$file_name"
  done
  exit 0
fi
if [[ "$1" == "--dir" && "$3" == "dev" ]]; then
  echo "ui-dev-start" >> "$SPUR_TEST_LOG"
  exit 0
fi
echo "unexpected-pnpm $*" >> "$SPUR_TEST_LOG"
exit 80
`;
}

function createFixture(): FakeWorktree {
  const repoDir = mkdtempSync(join(tmpdir(), "spur-sidecar-deps-lock-"));
  cleanupPaths.push(repoDir);

  const scriptDir = join(repoDir, "scripts");
  const webDir = join(repoDir, "packages", "web");
  const toolDir = join(repoDir, "tool");
  const pathDir = join(repoDir, "path");
  mkdirSync(scriptDir, { recursive: true });
  mkdirSync(join(repoDir, "v2", "bin"), { recursive: true });
  mkdirSync(join(repoDir, "v2", "src"), { recursive: true });
  mkdirSync(webDir, { recursive: true });
  mkdirSync(toolDir, { recursive: true });
  mkdirSync(join(repoDir, "home"), { recursive: true });
  mkdirSync(pathDir, { recursive: true });

  for (const script of [
    "spur-isolated-ui.sh",
    "spur-isolated-daemon.sh",
    "spur-sidecar-common.sh",
  ]) {
    copyFileSync(join(SOURCE_SCRIPT_DIR, script), join(scriptDir, script));
  }
  chmodSync(join(scriptDir, "spur-isolated-ui.sh"), 0o755);
  chmodSync(join(scriptDir, "spur-isolated-daemon.sh"), 0o755);

  // ensure_node_ready reads $SIDECAR_REPO_ROOT/package.json for engines.node.
  copyFileSync(join(REPO_ROOT, "package.json"), join(repoDir, "package.json"));
  writeFileSync(join(repoDir, "spur.yaml"), "projects: {}\n", "utf8");
  writeFileSync(join(repoDir, "home", "config.yaml"), "server:\n  port: 1\n", "utf8");
  writeFileSync(join(webDir, "next-env.d.ts"), "// next-env\n", "utf8");
  writeFileSync(join(webDir, "tsconfig.json"), "{}\n", "utf8");

  const logPath = join(repoDir, "calls.log");
  makeExecutable(join(pathDir, "node"), nodeFakeSource());
  makeExecutable(join(pathDir, "pnpm"), pnpmFakeSource());
  makeExecutable(join(pathDir, "curl"), "#!/usr/bin/env bash\nexit 0\n");
  makeExecutable(join(pathDir, "sleep"), "#!/usr/bin/env bash\nexit 0\n");

  return { logPath, pathDir, repoDir, toolDir };
}

function testEnv(worktree: FakeWorktree, extraEnv?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    HOME: join(worktree.repoDir, "home"),
    PATH: `${worktree.pathDir}:${process.env["PATH"] ?? ""}`,
    SPUR_PROJECT_CONFIG_PATH: join(worktree.repoDir, "spur.yaml"),
    SPUR_RESERVED_PORT_DAEMON: "4791",
    SPUR_RESERVED_PORT_UI: "5691",
    SPUR_SESSION_TOOL_DIR: worktree.toolDir,
    SPUR_SIDECAR_NAME: "deps-lock-test",
    SPUR_TEST_LOG: worktree.logPath,
    SPUR_TEST_REAL_NODE: process.execPath,
    SPUR_TEST_REPO: worktree.repoDir,
    ...extraEnv,
  };
}

function runIsolatedUi(worktree: FakeWorktree, extraEnv?: NodeJS.ProcessEnv) {
  return execFileAsync("bash", [join(worktree.repoDir, "scripts", "spur-isolated-ui.sh")], {
    cwd: worktree.repoDir,
    env: testEnv(worktree, extraEnv),
  });
}

function runIsolatedDaemon(worktree: FakeWorktree, extraEnv?: NodeJS.ProcessEnv) {
  return execFileAsync("bash", [join(worktree.repoDir, "scripts", "spur-isolated-daemon.sh")], {
    env: testEnv(worktree, extraEnv),
  });
}

function readLog(worktree: FakeWorktree): string[] {
  if (!existsSync(worktree.logPath)) {
    return [];
  }
  const content = readFileSync(worktree.logPath, "utf8").trim();
  return content === "" ? [] : content.split("\n");
}

type ReadyTreeMarkers = {
  root: string;
  v2: string;
  web: string;
};

// Materializes a genuinely ready tree (all three workspace_deps_ready legs
// pass under real node module resolution) with a marker file in each of the
// three node_modules trees, so a test can assert the repair never touched
// them.
function materializeReadyTree(repoDir: string): ReadyTreeMarkers {
  const rootNodeModules = join(repoDir, "node_modules");
  const v2NodeModules = join(repoDir, "v2", "node_modules");
  const webNodeModules = join(repoDir, "packages", "web", "node_modules");

  mkdirSync(join(rootNodeModules, ".pnpm"), { recursive: true });
  mkdirSync(v2NodeModules, { recursive: true });
  const nextDir = join(webNodeModules, "next");
  mkdirSync(join(nextDir, "dist", "server", "route-modules", "pages", "builtin"), {
    recursive: true,
  });
  writeFileSync(join(nextDir, "package.json"), '{"name":"next"}', "utf8");
  writeFileSync(
    join(nextDir, "dist", "server", "route-modules", "pages", "builtin", "_error.js"),
    "module.exports = {};",
    "utf8",
  );
  const nodePtyDir = join(webNodeModules, "node-pty");
  mkdirSync(nodePtyDir, { recursive: true });
  writeFileSync(join(nodePtyDir, "package.json"), '{"name":"node-pty","main":"index.js"}', "utf8");
  writeFileSync(join(nodePtyDir, "index.js"), "module.exports = {};", "utf8");

  const markers: ReadyTreeMarkers = {
    root: join(rootNodeModules, ".pnpm", "PRESEEDED_MARKER"),
    v2: join(v2NodeModules, "PRESEEDED_MARKER"),
    web: join(webNodeModules, "PRESEEDED_MARKER"),
  };
  for (const marker of Object.values(markers)) {
    writeFileSync(marker, "seeded\n", "utf8");
  }
  return markers;
}

afterEach(() => {
  for (const path of cleanupPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("isolated sidecar workspace dependency lock (#823)", () => {
  it("AC1: isolated-ui repairs the tree before it waits for isolated-env.sh", async () => {
    const worktree = createFixture();

    const rejection = (await runIsolatedUi(worktree).catch((error) => error)) as {
      code: number;
      stderr: string;
    };

    expect(rejection).toMatchObject({ code: 1 });
    expect(rejection.stderr).toMatch(/Missing isolated runtime file/);
    const log = readLog(worktree);
    expect(log).toContain("install-start");
    expect(log).toContain("install-end");
  });

  it("AC2: isolated-daemon does no build/probe/publish while the UI's install holds the lock", async () => {
    const worktree = createFixture();
    const fifoPath = join(worktree.repoDir, "install.fifo");
    await execFileAsync("mkfifo", [fifoPath]);

    const uiPromise = runIsolatedUi(worktree, { SPUR_TEST_INSTALL_FIFO: fifoPath }).catch(
      (error) => error,
    );

    // Wait for the UI to be inside the install (holding the lock).
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (readLog(worktree).includes("install-start")) {
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(readLog(worktree)).toContain("install-start");
    expect(readLog(worktree)).not.toContain("install-end");

    const daemonPromise = runIsolatedDaemon(worktree);

    await new Promise((r) => setTimeout(r, 1000));
    const duringWindow = readLog(worktree);
    expect(duringWindow).not.toContain("build");
    expect(duringWindow).not.toContain("cli-probe");
    expect(duringWindow).not.toContain("daemon-start");

    // Release the UI's install.
    writeFileSync(fifoPath, "go\n");

    await daemonPromise;
    await uiPromise;

    const finalLog = readLog(worktree);
    const order = ["install-start", "install-end", "build", "cli-probe", "daemon-start"];
    const indices: number[] = order.map((entry) => finalLog.indexOf(entry));
    expect(indices.every((index) => index !== -1)).toBe(true);
    for (let i = 1; i < indices.length; i += 1) {
      const previous: number = indices[i - 1] ?? -1;
      const current: number = indices[i] ?? -1;
      expect(current).toBeGreaterThan(previous);
    }
    expect(existsSync(join(worktree.toolDir, "isolated-env.sh"))).toBe(true);
    // Only one repair ran total, no matter which sidecar took the lock.
    expect(finalLog.filter((line) => line === "install-start")).toHaveLength(1);
  });

  it("AC3: with a ready tree neither sidecar installs, and pre-seeded markers survive", async () => {
    const worktree = createFixture();
    const markers = materializeReadyTree(worktree.repoDir);

    await runIsolatedDaemon(worktree);
    // Runtime file is already published by the daemon above, so the UI runs
    // to completion here (no swallowed rejection to hide a dead-before-probe
    // UI making "no install-start" trivially true).
    await runIsolatedUi(worktree);

    const log = readLog(worktree);
    expect(log).not.toContain("install-start");
    expect(log).not.toContain("install-end");
    for (const marker of Object.values(markers)) {
      expect(existsSync(marker)).toBe(true);
    }
  });

  it("AC4: the lock is free once the daemon has exec'd, while that daemon process is alive", async () => {
    const worktree = createFixture();
    const daemonFifoPath = join(worktree.repoDir, "daemon.fifo");
    await execFileAsync("mkfifo", [daemonFifoPath]);

    const daemonPromise = runIsolatedDaemon(worktree, { SPUR_TEST_DAEMON_FIFO: daemonFifoPath });

    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (existsSync(join(worktree.toolDir, "isolated-env.sh"))) {
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(existsSync(join(worktree.toolDir, "isolated-env.sh"))).toBe(true);

    const lockPath = join(worktree.toolDir, "workspace-deps.lock");
    const { stdout } = await execFileAsync("flock", ["-n", lockPath, "echo", "unlocked"]);
    expect(stdout.trim()).toBe("unlocked");

    writeFileSync(daemonFifoPath, "go\n");
    await daemonPromise;
  });

  // Daemon-first order against a ready tree is exactly the AC3 case above
  // (daemon runs first there too); the order this case adds beyond AC3 is
  // ui-first, which AC3 does not cover.
  it("AC7: against an already-ready tree, starting the UI before the daemon still installs nothing", async () => {
    const worktree = createFixture();
    const markers = materializeReadyTree(worktree.repoDir);

    // The UI starts before the daemon has published isolated-env.sh, so it
    // fails at its runtime-file wait — a real, asserted failure, not a
    // swallowed one — but only after its own dependency gate already ran.
    const rejection = (await runIsolatedUi(worktree).catch((error) => error)) as {
      code: number;
      stderr: string;
    };
    expect(rejection).toMatchObject({ code: 1 });
    expect(rejection.stderr).toMatch(/Missing isolated runtime file/);

    await runIsolatedDaemon(worktree);

    const log = readLog(worktree);
    expect(log).not.toContain("install-start");
    for (const marker of Object.values(markers)) {
      expect(existsSync(marker)).toBe(true);
    }
  });

  // Supports the GAP1 rationale directly: the crash in #823 was under
  // v2/node_modules, and the worktree ships it as a symlink, so a probe
  // without this leg can pass on exactly the tree state that kills the
  // daemon. Regression-pinned by mutation check (see report): commenting out
  // the v2 leg in workspace_deps_ready makes this case wrongly read ready.
  it("rejects a ready root/web tree whose v2/node_modules is still a symlink", async () => {
    const worktree = createFixture();
    materializeReadyTree(worktree.repoDir);
    rmSync(join(worktree.repoDir, "v2", "node_modules"), { recursive: true, force: true });
    const realV2Deps = join(worktree.repoDir, "real-v2-node-modules");
    mkdirSync(realV2Deps, { recursive: true });
    symlinkSync(realV2Deps, join(worktree.repoDir, "v2", "node_modules"));

    await runIsolatedDaemon(worktree);

    const log = readLog(worktree);
    expect(log).toContain("install-start");
    expect(log).toContain("install-end");
  });
});
