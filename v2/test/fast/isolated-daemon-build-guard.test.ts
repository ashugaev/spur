import { execFile } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
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

type FakeWorktree = {
  homeDir: string;
  logPath: string;
  pathDir: string;
  projectConfigPath: string;
  repoDir: string;
  scriptPath: string;
  toolDir: string;
};

function makeExecutable(path: string, source: string): void {
  writeFileSync(path, source, "utf8");
  chmodSync(path, 0o755);
}

function createFakeWorktree(): FakeWorktree {
  const repoDir = mkdtempSync(join(tmpdir(), "spur-isolated-daemon-build-"));
  cleanupPaths.push(repoDir);

  const scriptDir = join(repoDir, "scripts");
  const v2BinDir = join(repoDir, "v2", "bin");
  const toolDir = join(repoDir, "tool");
  const homeDir = join(repoDir, "home");
  const pathDir = join(repoDir, "path");
  mkdirSync(scriptDir, { recursive: true });
  mkdirSync(v2BinDir, { recursive: true });
  mkdirSync(toolDir);
  mkdirSync(homeDir);
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

  const projectConfigPath = join(repoDir, "spur.yaml");
  writeFileSync(projectConfigPath, "projects: {}\n", "utf8");
  writeFileSync(join(homeDir, "config.yaml"), "server:\n  port: 1\n", "utf8");

  const logPath = join(repoDir, "calls.log");
  makeExecutable(
    join(pathDir, "pnpm"),
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" != "--dir" || "$2" != "$SPUR_TEST_REPO/v2" || "$3" != "build" ]]; then
  echo "unexpected-pnpm $*" >> "$SPUR_TEST_LOG"
  exit 80
fi
echo "build session=\${SPUR_SESSION:-}" >> "$SPUR_TEST_LOG"
mkdir -p "$SPUR_TEST_REPO/v2/dist"
printf 'built\\n' > "$SPUR_TEST_REPO/v2/dist/cli.js"
printf 'built\\n' > "$SPUR_TEST_REPO/v2/dist/isolated-instance-config.js"
printf 'built\\n' > "$SPUR_TEST_REPO/v2/dist/isolated-project-config.js"
`,
  );
  makeExecutable(
    join(pathDir, "node"),
    `#!/usr/bin/env bash
set -euo pipefail
for marker in \\
  "$SPUR_TEST_REPO/v2/dist/cli.js" \\
  "$SPUR_TEST_REPO/v2/dist/isolated-instance-config.js" \\
  "$SPUR_TEST_REPO/v2/dist/isolated-project-config.js"; do
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
    homeDir,
    logPath,
    pathDir,
    projectConfigPath,
    repoDir,
    scriptPath: join(scriptDir, "spur-isolated-daemon.sh"),
    toolDir,
  };
}

function testEnv(worktree: FakeWorktree): NodeJS.ProcessEnv {
  return {
    HOME: worktree.homeDir,
    PATH: `${worktree.pathDir}:${process.env["PATH"] ?? ""}`,
    SPUR_PROJECT_CONFIG_PATH: worktree.projectConfigPath,
    SPUR_RESERVED_PORT_DAEMON: "4789",
    SPUR_SESSION: "test-session",
    SPUR_SESSION_TOOL_DIR: worktree.toolDir,
    SPUR_TEST_LOG: worktree.logPath,
    SPUR_TEST_REPO: worktree.repoDir,
  };
}

async function runIsolatedDaemon(worktree: FakeWorktree): Promise<string[]> {
  await execFileAsync("bash", [worktree.scriptPath], {
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
      "build session=test-session",
      "instance-helper",
      "project-helper",
      "daemon-start",
    ]);
  });

  it("uses existing build outputs without rebuilding", async () => {
    const worktree = createFakeWorktree();
    const distDir = join(worktree.repoDir, "v2", "dist");
    mkdirSync(distDir);
    writeFileSync(join(distDir, "cli.js"), "built\n", "utf8");
    writeFileSync(join(distDir, "isolated-instance-config.js"), "built\n", "utf8");
    writeFileSync(join(distDir, "isolated-project-config.js"), "built\n", "utf8");

    await expect(runIsolatedDaemon(worktree)).resolves.toEqual([
      "instance-helper",
      "project-helper",
      "daemon-start",
    ]);
  });
});
