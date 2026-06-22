import { execFile } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
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
const cleanupPaths: string[] = [];
const DIST_FILE_NAMES = "cli.js isolated-instance-config.js isolated-project-config.js";

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

function writeDistFiles(repoDir: string): void {
  const distDir = join(repoDir, "v2", "dist");
  mkdirSync(distDir, { recursive: true });
  for (const fileName of DIST_FILE_NAMES.split(" ")) {
    writeFileSync(join(distDir, fileName), "built\n", "utf8");
  }
}

function createFakeWorktree(): FakeWorktree {
  const repoDir = mkdtempSync(join(tmpdir(), "spur-isolated-daemon-build-"));
  cleanupPaths.push(repoDir);

  const scriptDir = join(repoDir, "scripts");
  const v2BinDir = join(repoDir, "v2", "bin");
  const toolDir = join(repoDir, "tool");
  const pathDir = join(repoDir, "path");
  mkdirSync(scriptDir, { recursive: true });
  mkdirSync(v2BinDir, { recursive: true });
  mkdirSync(join(repoDir, "v2", "src"), { recursive: true });
  mkdirSync(toolDir);
  mkdirSync(join(repoDir, "home"));
  mkdirSync(pathDir);

  copyFileSync(
    join(SOURCE_SCRIPT_DIR, "spur-isolated-daemon.sh"),
    join(scriptDir, "spur-isolated-daemon.sh"),
  );
  copyFileSync(
    join(SOURCE_SCRIPT_DIR, "spur-sidecar-common.sh"),
    join(scriptDir, "spur-sidecar-common.sh"),
  );
  chmodSync(join(scriptDir, "spur-isolated-daemon.sh"), 0o755);

  writeFileSync(join(repoDir, "spur.yaml"), "projects: {}\n", "utf8");
  writeFileSync(join(repoDir, "home", "config.yaml"), "server:\n  port: 1\n", "utf8");

  const logPath = join(repoDir, "calls.log");
  makeExecutable(
    join(pathDir, "pnpm"),
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" != "--dir" || "$2" != "$SPUR_TEST_REPO/v2" || "$3" != "build" ]]; then
  echo "unexpected-pnpm $*" >> "$SPUR_TEST_LOG"
  exit 80
fi
echo "build SPUR_DISABLE_AUTOSTART=\${SPUR_DISABLE_AUTOSTART:-}" >> "$SPUR_TEST_LOG"
mkdir -p "$SPUR_TEST_REPO/v2/dist"
for file_name in ${DIST_FILE_NAMES}; do
  printf 'built\\n' > "$SPUR_TEST_REPO/v2/dist/$file_name"
done
`,
  );
  makeExecutable(
    join(pathDir, "node"),
    `#!/usr/bin/env bash
set -euo pipefail
for file_name in ${DIST_FILE_NAMES}; do
  marker="$SPUR_TEST_REPO/v2/dist/$file_name"
  if [[ ! -f "$marker" ]]; then
    echo "node-before-build $1" >> "$SPUR_TEST_LOG"
    exit 81
  fi
done
case "$1" in
  "$SPUR_TEST_REPO/v2/bin/write-isolated-instance-config.mjs")
    echo "instance-helper" >> "$SPUR_TEST_LOG"
    ;;
  "$SPUR_TEST_REPO/v2/bin/write-isolated-project-config.mjs")
    echo "project-helper" >> "$SPUR_TEST_LOG"
    ;;
  "$SPUR_TEST_REPO/v2/dist/cli.js")
    echo "daemon-start" >> "$SPUR_TEST_LOG"
    ;;
  *)
    echo "unexpected-node $1" >> "$SPUR_TEST_LOG"
    exit 82
    ;;
esac
`,
  );

  return {
    logPath,
    pathDir,
    repoDir,
    toolDir,
  };
}

function testEnv(worktree: FakeWorktree): NodeJS.ProcessEnv {
  return {
    HOME: join(worktree.repoDir, "home"),
    PATH: `${worktree.pathDir}:${process.env["PATH"] ?? ""}`,
    SPUR_PROJECT_CONFIG_PATH: join(worktree.repoDir, "spur.yaml"),
    SPUR_RESERVED_PORT_DAEMON: "4789",
    SPUR_SESSION_TOOL_DIR: worktree.toolDir,
    SPUR_TEST_LOG: worktree.logPath,
    SPUR_TEST_REPO: worktree.repoDir,
  };
}

async function runIsolatedDaemon(worktree: FakeWorktree): Promise<string[]> {
  await execFileAsync("bash", [join(worktree.repoDir, "scripts", "spur-isolated-daemon.sh")], {
    env: testEnv(worktree),
  });
  return readFileSync(worktree.logPath, "utf8").trim().split("\n");
}

afterEach(() => {
  for (const path of cleanupPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("spur-isolated-daemon build guard", () => {
  it("builds v2 before invoking isolated daemon helpers when dist is missing", async () => {
    const worktree = createFakeWorktree();

    await expect(runIsolatedDaemon(worktree)).resolves.toEqual([
      "build SPUR_DISABLE_AUTOSTART=1",
      "instance-helper",
      "project-helper",
      "daemon-start",
    ]);
  });

  it("uses existing build outputs without rebuilding", async () => {
    const worktree = createFakeWorktree();
    writeDistFiles(worktree.repoDir);

    await expect(runIsolatedDaemon(worktree)).resolves.toEqual([
      "instance-helper",
      "project-helper",
      "daemon-start",
    ]);
  });

  it("rebuilds when source is newer than existing build outputs", async () => {
    const worktree = createFakeWorktree();
    writeDistFiles(worktree.repoDir);
    const sourcePath = join(worktree.repoDir, "v2", "src", "session-slots.ts");
    writeFileSync(sourcePath, "newer\n", "utf8");
    const oldTime = new Date("2026-03-18T10:00:00.000Z");
    const newTime = new Date("2026-03-18T10:01:00.000Z");
    for (const fileName of DIST_FILE_NAMES.split(" ")) {
      utimesSync(join(worktree.repoDir, "v2", "dist", fileName), oldTime, oldTime);
    }
    utimesSync(sourcePath, newTime, newTime);

    await expect(runIsolatedDaemon(worktree)).resolves.toEqual([
      "build SPUR_DISABLE_AUTOSTART=1",
      "instance-helper",
      "project-helper",
      "daemon-start",
    ]);
  });
});
