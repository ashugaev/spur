import { execFile } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
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
const HOST_WRAPPER_SOURCE = "#!/usr/bin/env bash\necho host-wrapper\n";

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
  makeExecutable(join(toolDir, "spur"), HOST_WRAPPER_SOURCE);

  const logPath = join(repoDir, "calls.log");
  makeExecutable(
    join(pathDir, "pnpm"),
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" != "--dir" || "$2" != "$SPUR_TEST_REPO/v2" || "$3" != "build" ]]; then
  echo "unexpected-pnpm $*" >> "$SPUR_TEST_LOG"
  exit 80
fi
runtime_state=missing
if [[ -f "$SPUR_SESSION_TOOL_DIR/isolated-env.sh" ]]; then
  runtime_state=present
fi
echo "build SPUR_DISABLE_AUTOSTART=\${SPUR_DISABLE_AUTOSTART:-} runtime=$runtime_state" >> "$SPUR_TEST_LOG"
if [[ "\${SPUR_TEST_BUILD_FAIL:-}" == "1" ]]; then
  exit 84
fi
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
if [[ "$1" == "$SPUR_TEST_REPO/v2/dist/cli.js" && "\${2:-}" == "--version" ]]; then
  echo "cli-probe" >> "$SPUR_TEST_LOG"
  if [[ "\${SPUR_TEST_CLI_UNLOADABLE:-}" == "1" ]]; then
    exit 1
  fi
  exit 0
fi
if [[ ! -f "$SPUR_SESSION_TOOL_DIR/isolated-env.sh" ]]; then
  echo "node-before-runtime $1" >> "$SPUR_TEST_LOG"
  exit 83
fi
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

function testEnv(worktree: FakeWorktree, extraEnv?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    HOME: join(worktree.repoDir, "home"),
    PATH: `${worktree.pathDir}:${process.env["PATH"] ?? ""}`,
    SPUR_PROJECT_CONFIG_PATH: join(worktree.repoDir, "spur.yaml"),
    SPUR_RESERVED_PORT_DAEMON: "4789",
    SPUR_SESSION_TOOL_DIR: worktree.toolDir,
    SPUR_TEST_LOG: worktree.logPath,
    SPUR_TEST_REPO: worktree.repoDir,
    ...extraEnv,
  };
}

async function runIsolatedDaemon(
  worktree: FakeWorktree,
  extraEnv?: NodeJS.ProcessEnv,
): Promise<string[]> {
  await execFileAsync("bash", [join(worktree.repoDir, "scripts", "spur-isolated-daemon.sh")], {
    env: testEnv(worktree, extraEnv),
  });
  return readFileSync(worktree.logPath, "utf8").trim().split("\n");
}

afterEach(() => {
  for (const path of cleanupPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("spur-isolated-daemon build guard", () => {
  it("keeps the shared runtime unpublished until a missing v2 build finishes", async () => {
    const worktree = createFakeWorktree();

    await expect(runIsolatedDaemon(worktree)).resolves.toEqual([
      "build SPUR_DISABLE_AUTOSTART=1 runtime=missing",
      "cli-probe",
      "instance-helper",
      "project-helper",
      "daemon-start",
    ]);
  });

  it("removes a stale shared runtime before rebuilding on restart", async () => {
    const worktree = createFakeWorktree();
    const runtimePath = join(worktree.toolDir, "isolated-env.sh");
    writeFileSync(runtimePath, "STALE_RUNTIME=1\n", "utf8");

    await expect(runIsolatedDaemon(worktree)).resolves.toEqual([
      "build SPUR_DISABLE_AUTOSTART=1 runtime=missing",
      "cli-probe",
      "instance-helper",
      "project-helper",
      "daemon-start",
    ]);
    expect(readFileSync(runtimePath, "utf8")).toContain(
      'SPUR_ISOLATED_DAEMON_URL="http://127.0.0.1:4789"',
    );
    expect(readFileSync(runtimePath, "utf8")).not.toContain("STALE_RUNTIME");
  });

  it("leaves no runtime marker when the v2 build fails", async () => {
    const worktree = createFakeWorktree();
    const runtimePath = join(worktree.toolDir, "isolated-env.sh");
    writeFileSync(runtimePath, "STALE_RUNTIME=1\n", "utf8");
    writeFileSync(join(worktree.toolDir, "isolated-env.sh.tmp.stale"), "STALE_TEMP=1\n", "utf8");

    await expect(runIsolatedDaemon(worktree, { SPUR_TEST_BUILD_FAIL: "1" })).rejects.toMatchObject({
      code: 84,
    });
    expect(existsSync(runtimePath)).toBe(false);
    expect(
      readdirSync(worktree.toolDir).filter((name) => name.startsWith("isolated-env.sh.tmp.")),
    ).toEqual([]);
  });

  it("uses existing build outputs without rebuilding", async () => {
    const worktree = createFakeWorktree();
    writeDistFiles(worktree.repoDir);

    await expect(runIsolatedDaemon(worktree)).resolves.toEqual([
      "cli-probe",
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
      "build SPUR_DISABLE_AUTOSTART=1 runtime=missing",
      "cli-probe",
      "instance-helper",
      "project-helper",
      "daemon-start",
    ]);
  });

  it("leaves the session spur wrapper untouched", async () => {
    const worktree = createFakeWorktree();
    const hostWrapperPath = join(worktree.toolDir, "spur");

    await runIsolatedDaemon(worktree);

    expect(readFileSync(hostWrapperPath, "utf8")).toBe(HOST_WRAPPER_SOURCE);
    const isolatedWrapperPath = join(worktree.toolDir, "spur-isolated");
    expect(existsSync(isolatedWrapperPath)).toBe(true);
    expect(statSync(isolatedWrapperPath).mode & 0o100).toBe(0o100);
    expect(readFileSync(isolatedWrapperPath, "utf8")).toMatch(/--config "[^"]+\/config\.yaml"/);
  });

  it("removes the isolated wrapper when the v2 build fails", async () => {
    const worktree = createFakeWorktree();

    await expect(runIsolatedDaemon(worktree, { SPUR_TEST_BUILD_FAIL: "1" })).rejects.toMatchObject({
      code: 84,
    });

    expect(existsSync(join(worktree.toolDir, "spur-isolated"))).toBe(false);
    expect(readFileSync(join(worktree.toolDir, "spur"), "utf8")).toBe(HOST_WRAPPER_SOURCE);
  });

  it("refuses to publish the runtime when the built CLI cannot load", async () => {
    const worktree = createFakeWorktree();
    writeDistFiles(worktree.repoDir);

    await expect(
      runIsolatedDaemon(worktree, { SPUR_TEST_CLI_UNLOADABLE: "1" }),
    ).rejects.toBeTruthy();

    expect(readFileSync(worktree.logPath, "utf8").trim().split("\n")).toEqual(["cli-probe"]);
    expect(existsSync(join(worktree.toolDir, "isolated-env.sh"))).toBe(false);
    expect(existsSync(join(worktree.toolDir, "spur-isolated"))).toBe(false);
    expect(readFileSync(join(worktree.toolDir, "spur"), "utf8")).toBe(HOST_WRAPPER_SOURCE);
  });
});
