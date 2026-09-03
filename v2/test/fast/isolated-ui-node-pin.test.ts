// Regression test for #798: the isolated-ui sidecar pane launches through a
// non-interactive login shell (env -u ... sh -lc, see
// buildCommandSessionShellCommand in v2/src/runtime-tmux.ts) that sources no
// nvm, so it otherwise runs on whatever node happens to be on PATH. Outside
// the root engines range, next/font throws under tsx and every request
// 500s until wait_for_http exhausts its budget. scripts/spur-isolated-ui.sh
// now pins node via .nvmrc before any node consumer runs; these tests prove
// that pin activates, fails fast when the pin is unmet, and is a no-op when
// the host node already satisfies it.
import { execFile } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
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

import { satisfiesNodeEngineRange } from "../../src/host-install.js";

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE_SCRIPT_DIR = resolve(HERE, "../../../scripts");
const REPO_ROOT = resolve(HERE, "../../..");
const cleanupPaths: string[] = [];

// Stub nvm.sh for the isolated-ui pin test. Contract: reads only $1-$3,
// $NVM_DIR and $PATH — the sourcing script runs under `set -u`, and an
// unset-variable abort inside sourced code is NOT rescued by `|| true`.
// Resolves a bare major the way real nvm does; a literal "$version"
// prepend would point at a nonexistent dir.
const STUB_NVM_SH = `
nvm() {
  if [ "\${1:-}" != "use" ]; then
    return 0
  fi

  version="\${2:-}"
  if [ "$version" = "--silent" ]; then
    version="\${3:-}"
  fi
  version="\${version#v}"

  resolved=""
  case "$version" in
    "")
      return 3
      ;;
    *.*)
      if [ -d "$NVM_DIR/versions/node/v$version/bin" ]; then
        resolved="v$version"
      fi
      ;;
    *)
      resolved=$(
        for candidate in "$NVM_DIR"/versions/node/v"$version".*; do
          if [ -d "$candidate/bin" ]; then
            printf '%s\\n' "\${candidate##*/}"
          fi
        done | sort -V | tail -n 1
      )
      ;;
  esac

  if [ -z "$resolved" ]; then
    return 3
  fi

  PATH="$NVM_DIR/versions/node/$resolved/bin:$PATH"
  export PATH
  return 0
}
`;

type FakeWorktree = {
  logPath: string;
  pathDir: string;
  repoDir: string;
  toolDir: string;
  nvmDir: string;
};

function makeExecutable(path: string, source: string): void {
  writeFileSync(path, source, "utf8");
  chmodSync(path, 0o755);
}

function createFakeWorktree(): FakeWorktree {
  const repoDir = mkdtempSync(join(tmpdir(), "spur-isolated-ui-pin-"));
  cleanupPaths.push(repoDir);

  const scriptDir = join(repoDir, "scripts");
  const webDir = join(repoDir, "packages", "web");
  const toolDir = join(repoDir, "tool");
  const pathDir = join(repoDir, "path");
  const homeDir = join(repoDir, "home");
  const nvmDir = join(homeDir, ".nvm");
  mkdirSync(scriptDir, { recursive: true });
  mkdirSync(webDir, { recursive: true });
  mkdirSync(toolDir);
  mkdirSync(homeDir);
  mkdirSync(pathDir);

  copyFileSync(
    join(SOURCE_SCRIPT_DIR, "spur-isolated-ui.sh"),
    join(scriptDir, "spur-isolated-ui.sh"),
  );
  copyFileSync(
    join(SOURCE_SCRIPT_DIR, "spur-sidecar-common.sh"),
    join(scriptDir, "spur-sidecar-common.sh"),
  );
  chmodSync(join(scriptDir, "spur-isolated-ui.sh"), 0o755);

  writeFileSync(join(webDir, "next-env.d.ts"), "// next-env\n", "utf8");
  writeFileSync(join(webDir, "tsconfig.json"), "{}\n", "utf8");

  writeFileSync(
    join(toolDir, "isolated-env.sh"),
    'SPUR_ISOLATED_CONFIG="stub"\nSPUR_ISOLATED_DAEMON_URL="http://127.0.0.1:1"\nSPUR_ISOLATED_TMUX_SOCKET_NAME="stub"\n',
    "utf8",
  );

  const logPath = join(repoDir, "calls.log");

  makeExecutable(
    join(pathDir, "node"),
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "-v" ]]; then
  printf '%s\\n' "$SPUR_TEST_SYS_NODE"
  exit 0
fi
exit 0
`,
  );

  makeExecutable(
    join(pathDir, "pnpm"),
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "install" ]]; then
  echo "install node=$(node -v)" >> "$SPUR_TEST_LOG"
  exit 0
fi
if [[ "$1" == "--dir" && "$3" == "dev" ]]; then
  echo "dev node=$(node -v)" >> "$SPUR_TEST_LOG"
  exit 0
fi
echo "unexpected-pnpm $*" >> "$SPUR_TEST_LOG"
exit 80
`,
  );

  makeExecutable(join(pathDir, "curl"), "#!/usr/bin/env bash\nexit 0\n");
  makeExecutable(join(pathDir, "sleep"), "#!/usr/bin/env bash\nexit 0\n");

  return { logPath, pathDir, repoDir, toolDir, nvmDir };
}

function writeNvmVersion(nvmDir: string, version: string): void {
  const binDir = join(nvmDir, "versions", "node", `v${version}`, "bin");
  mkdirSync(binDir, { recursive: true });
  makeExecutable(
    join(binDir, "node"),
    `#!/usr/bin/env bash\nif [[ "\${1:-}" == "-v" ]]; then printf 'v%s\\n' "${version}"; fi\nexit 0\n`,
  );
}

function writeStubNvm(nvmDir: string): void {
  mkdirSync(nvmDir, { recursive: true });
  writeFileSync(join(nvmDir, "nvm.sh"), STUB_NVM_SH, "utf8");
}

function testEnv(worktree: FakeWorktree, extraEnv?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    HOME: join(worktree.repoDir, "home"),
    PATH: `${worktree.pathDir}:/usr/local/bin:/usr/bin:/bin`,
    SPUR_RESERVED_PORT_UI: "5698",
    SPUR_SESSION_TOOL_DIR: worktree.toolDir,
    SPUR_SIDECAR_NAME: "isolated-ui-pin-test",
    SPUR_TEST_LOG: worktree.logPath,
    SPUR_TEST_SYS_NODE: "v21.7.3",
    ...extraEnv,
  };
}

async function runIsolatedUi(
  worktree: FakeWorktree,
  extraEnv?: NodeJS.ProcessEnv,
): Promise<string[]> {
  await execFileAsync("bash", [join(worktree.repoDir, "scripts", "spur-isolated-ui.sh")], {
    cwd: worktree.repoDir,
    env: testEnv(worktree, extraEnv),
  });
  return readFileSync(worktree.logPath, "utf8").trim().split("\n");
}

async function runIsolatedUiExpectFailure(
  worktree: FakeWorktree,
  extraEnv?: NodeJS.ProcessEnv,
): Promise<{ code: number; stderr: string }> {
  try {
    await execFileAsync("bash", [join(worktree.repoDir, "scripts", "spur-isolated-ui.sh")], {
      cwd: worktree.repoDir,
      env: testEnv(worktree, extraEnv),
    });
  } catch (error) {
    return error as { code: number; stderr: string };
  }
  throw new Error("expected spur-isolated-ui.sh to fail");
}

afterEach(() => {
  for (const path of cleanupPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("spur-isolated-ui node pin", () => {
  it("runs pnpm install and pnpm dev on the pinned node when the PATH node is unsupported", async () => {
    const worktree = createFakeWorktree();
    writeFileSync(join(worktree.repoDir, ".nvmrc"), "24\n", "utf8");
    writeStubNvm(worktree.nvmDir);
    writeNvmVersion(worktree.nvmDir, "24.15.0");

    await expect(runIsolatedUi(worktree, { NVM_DIR: worktree.nvmDir })).resolves.toEqual([
      "install node=v24.15.0",
      "dev node=v24.15.0",
    ]);
  });

  it("fails fast with a self-describing message when the pinned node is not installed", async () => {
    const worktree = createFakeWorktree();
    writeFileSync(join(worktree.repoDir, ".nvmrc"), "24\n", "utf8");
    writeStubNvm(worktree.nvmDir);
    writeNvmVersion(worktree.nvmDir, "20.12.2");

    const rejection = await runIsolatedUiExpectFailure(worktree, { NVM_DIR: worktree.nvmDir });

    expect(rejection).toMatchObject({ code: 1 });
    expect(rejection.stderr).toMatch(/\.nvmrc/);
    expect(rejection.stderr).toMatch(/v21\.7\.3/);
    expect(rejection.stderr).toMatch(/nvm install 24/);
    expect(existsSync(worktree.logPath)).toBe(false);
  });

  it("is a no-op when the system node already satisfies the pin", async () => {
    const worktree = createFakeWorktree();
    writeFileSync(join(worktree.repoDir, ".nvmrc"), "24\n", "utf8");

    await expect(runIsolatedUi(worktree, { SPUR_TEST_SYS_NODE: "v24.15.0" })).resolves.toEqual([
      "install node=v24.15.0",
      "dev node=v24.15.0",
    ]);
  });

  it("pins a bare major that satisfies the root engines range", () => {
    const nvmrcPath = join(REPO_ROOT, ".nvmrc");
    const pin = readFileSync(nvmrcPath, "utf8").trim();
    const rootPackage = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
      engines: { node: string };
    };

    expect(pin).toMatch(/^\d+$/);
    expect(satisfiesNodeEngineRange(rootPackage.engines.node, pin)).toBe(true);
  });

  // node_major_at_least (spur-isolated-ui.sh) is a floor check: any major >=
  // the pin skips `nvm use`. That is sound only because the pin sits on
  // engines' unbounded `>=` clause — if .nvmrc ever moved to a major covered
  // by a bounded `^` clause instead (e.g. 22 or 20), a major above the pin
  // could still fail engines, and the floor check would wrongly let it
  // through. Prove the pin is on the unbounded clause by checking majors
  // arbitrarily far above it, not just the pin itself.
  it("sits on engines' unbounded >= clause, so every major at or above the pin also satisfies engines", () => {
    const pin = readFileSync(join(REPO_ROOT, ".nvmrc"), "utf8").trim();
    const rootPackage = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
      engines: { node: string };
    };
    const pinMajor = Number.parseInt(pin, 10);

    for (const major of [pinMajor, pinMajor + 1, pinMajor + 50]) {
      expect(satisfiesNodeEngineRange(rootPackage.engines.node, String(major))).toBe(true);
    }
  });

  it("is a no-op when the system node is newer than the pin", async () => {
    const worktree = createFakeWorktree();
    writeFileSync(join(worktree.repoDir, ".nvmrc"), "24\n", "utf8");

    await expect(runIsolatedUi(worktree, { SPUR_TEST_SYS_NODE: "v25.2.0" })).resolves.toEqual([
      "install node=v25.2.0",
      "dev node=v25.2.0",
    ]);
  });
});
