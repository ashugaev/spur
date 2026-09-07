// Regression test for #798/#824: the isolated-ui sidecar pane launches
// through a non-interactive login shell (env -u ... sh -lc, see
// buildCommandSessionShellCommand in v2/src/runtime-tmux.ts) that sources no
// nvm, so it otherwise runs on whatever node happens to be on PATH. Outside
// the root engines range, next/font throws under tsx and every request
// 500s until wait_for_http exhausts its budget. scripts/spur-isolated-ui.sh
// now decides purely on whether the node in hand satisfies the root
// engines.node range (v2/src/host-install.ts satisfiesNodeEngineRange
// semantics, reimplemented in node inside the script) — never on whether
// nvm happens to be present. .nvmrc is only the remedy once engines rejects
// the node in hand, never the predicate: PR #824's QA blocker was a
// conformant node 22 host with a stale nvm that had no node 24 installed,
// which the old "pin exactly" predicate rejected outright.
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

  // The script reads $SCRIPT_DIR/../package.json for engines.node — copy the
  // real repo root package.json so the fake worktree checks the same range
  // production does.
  copyFileSync(join(REPO_ROOT, "package.json"), join(repoDir, "package.json"));

  writeFileSync(join(webDir, "next-env.d.ts"), "// next-env\n", "utf8");
  writeFileSync(join(webDir, "tsconfig.json"), "{}\n", "utf8");

  writeFileSync(
    join(toolDir, "isolated-env.sh"),
    'SPUR_ISOLATED_CONFIG="stub"\nSPUR_ISOLATED_DAEMON_URL="http://127.0.0.1:1"\nSPUR_ISOLATED_TMUX_SOCKET_NAME="stub"\n',
    "utf8",
  );

  const logPath = join(repoDir, "calls.log");

  // The script shells out to a bare `node -e '<script>'` for the engines
  // check, so the stub must be real node (it runs the actual JS), not a
  // fake that only understands `-v`. Only `node -v` (used for messages and
  // by the fake pnpm below) is faked to report the version under test;
  // every other invocation — in particular `node -e` — delegates to the
  // real node binary that ran vitest itself.
  makeExecutable(
    join(pathDir, "node"),
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "-v" ]]; then
  printf '%s\\n' "$SPUR_TEST_SYS_NODE"
  exit 0
fi
exec "$SPUR_TEST_REAL_NODE" "$@"
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

// Writes an nvm-managed node install whose `node -v` and `node -e` (via
// $SPUR_TEST_REAL_NODE passthrough) both report `version`, so activation
// through `nvm use` changes what the engines re-check actually sees.
function writeNvmVersion(nvmDir: string, version: string): void {
  const binDir = join(nvmDir, "versions", "node", `v${version}`, "bin");
  mkdirSync(binDir, { recursive: true });
  makeExecutable(
    join(binDir, "node"),
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "-v" ]]; then
  printf 'v%s\\n' "${version}"
  exit 0
fi
exec "$SPUR_TEST_REAL_NODE" "$@"
`,
  );
}

function writeStubNvm(nvmDir: string): void {
  mkdirSync(nvmDir, { recursive: true });
  writeFileSync(join(nvmDir, "nvm.sh"), STUB_NVM_SH, "utf8");
}

// A PATH entry that carries only what ensure_node_ready's early failure
// paths need to run (bash itself, dirname for SCRIPT_DIR, tr for parsing
// .nvmrc) and deliberately no `node` — real `/usr/bin` and `/bin` both carry
// a real node on this host, so a plain fallback PATH can never reproduce
// "node not found on PATH".
function createNodeFreePathDir(repoDir: string): string {
  const dir = join(repoDir, "no-node-path");
  mkdirSync(dir, { recursive: true });
  for (const bin of ["bash", "dirname", "tr"]) {
    symlinkSync(`/usr/bin/${bin}`, join(dir, bin));
  }
  return dir;
}

function testEnv(worktree: FakeWorktree, extraEnv?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    HOME: join(worktree.repoDir, "home"),
    PATH: `${worktree.pathDir}:/usr/local/bin:/usr/bin:/bin`,
    SPUR_RESERVED_PORT_UI: "5698",
    SPUR_SESSION_TOOL_DIR: worktree.toolDir,
    SPUR_SIDECAR_NAME: "isolated-ui-pin-test",
    SPUR_TEST_LOG: worktree.logPath,
    SPUR_TEST_REAL_NODE: process.execPath,
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
  it("QA blocker (#824): engines-conformant system node proceeds even when nvm only holds an unrelated major", async () => {
    const worktree = createFakeWorktree();
    writeFileSync(join(worktree.repoDir, ".nvmrc"), "24\n", "utf8");
    writeStubNvm(worktree.nvmDir);
    writeNvmVersion(worktree.nvmDir, "20.12.2");

    await expect(
      runIsolatedUi(worktree, { NVM_DIR: worktree.nvmDir, SPUR_TEST_SYS_NODE: "v22.23.2" }),
    ).resolves.toEqual(["install node=v22.23.2", "dev node=v22.23.2"]);
  });

  it("#798: engines-invalid system node activates the .nvmrc pin via nvm", async () => {
    const worktree = createFakeWorktree();
    writeFileSync(join(worktree.repoDir, ".nvmrc"), "24\n", "utf8");
    writeStubNvm(worktree.nvmDir);
    writeNvmVersion(worktree.nvmDir, "24.15.0");

    await expect(
      runIsolatedUi(worktree, { NVM_DIR: worktree.nvmDir, SPUR_TEST_SYS_NODE: "v21.7.3" }),
    ).resolves.toEqual(["install node=v24.15.0", "dev node=v24.15.0"]);
  });

  it("engines-invalid system node (below the ^20.19.0 floor) activates the pin via nvm", async () => {
    const worktree = createFakeWorktree();
    writeFileSync(join(worktree.repoDir, ".nvmrc"), "24\n", "utf8");
    writeStubNvm(worktree.nvmDir);
    writeNvmVersion(worktree.nvmDir, "24.15.0");

    await expect(
      runIsolatedUi(worktree, { NVM_DIR: worktree.nvmDir, SPUR_TEST_SYS_NODE: "v20.12.2" }),
    ).resolves.toEqual(["install node=v24.15.0", "dev node=v24.15.0"]);
  });

  it("fails fast, naming the range/found version/.nvmrc/nvm install, when nvm exists but the pin isn't installed", async () => {
    const worktree = createFakeWorktree();
    writeFileSync(join(worktree.repoDir, ".nvmrc"), "24\n", "utf8");
    writeStubNvm(worktree.nvmDir);
    writeNvmVersion(worktree.nvmDir, "20.12.2");

    const rejection = await runIsolatedUiExpectFailure(worktree, {
      NVM_DIR: worktree.nvmDir,
      SPUR_TEST_SYS_NODE: "v21.7.3",
    });

    expect(rejection).toMatchObject({ code: 1 });
    expect(rejection.stderr).toMatch(/\^20\.19\.0/);
    // Full range, not a prefix of it: NODE_ENGINES_RANGE here is exactly
    // what node_satisfies_engines's `node -e` wrote to stdout and the shell
    // captured via command substitution — pins that the whole 28-byte
    // engines.node string (including the trailing `>=24` clause) arrived
    // intact, not truncated mid-write.
    expect(rejection.stderr).toMatch(/\^20\.19\.0 \|\| \^22\.13\.0 \|\| >=24/);
    expect(rejection.stderr).toMatch(/v21\.7\.3/);
    expect(rejection.stderr).toMatch(/\.nvmrc/);
    expect(rejection.stderr).toMatch(/nvm install 24/);
    expect(existsSync(worktree.logPath)).toBe(false);
  });

  it("proceeds with no nvm at all when the system node already satisfies engines", async () => {
    const worktree = createFakeWorktree();
    writeFileSync(join(worktree.repoDir, ".nvmrc"), "24\n", "utf8");

    await expect(runIsolatedUi(worktree, { SPUR_TEST_SYS_NODE: "v25.2.0" })).resolves.toEqual([
      "install node=v25.2.0",
      "dev node=v25.2.0",
    ]);
  });

  it("proceeds with no nvm at all on an engines-conformant node 22 host", async () => {
    const worktree = createFakeWorktree();
    writeFileSync(join(worktree.repoDir, ".nvmrc"), "24\n", "utf8");

    await expect(runIsolatedUi(worktree, { SPUR_TEST_SYS_NODE: "v22.23.2" })).resolves.toEqual([
      "install node=v22.23.2",
      "dev node=v22.23.2",
    ]);
  });

  // PR #824 review: a suite that only ever exercises the real `>=24` clause
  // cannot tell "reads engines.node" apart from a `major >= pin` floor —
  // node 21 fails both, so a regression back to the floor would stay green.
  // Override engines.node in the fake worktree with a BOUNDED range (no
  // `>=24` clause) so node 25 satisfies a floor check but fails a real
  // engines check. copyFileSync below runs after createFakeWorktree(), so it
  // only overrides this test's own worktree — no other case is affected.
  it("fails fast with no nvm at all on node 25 against a bounded engines range without >=24 (#824 review)", async () => {
    const worktree = createFakeWorktree();
    writeFileSync(join(worktree.repoDir, ".nvmrc"), "24\n", "utf8");
    writeFileSync(
      join(worktree.repoDir, "package.json"),
      JSON.stringify({ engines: { node: "^20.19.0 || ^22.13.0" } }),
      "utf8",
    );

    const rejection = await runIsolatedUiExpectFailure(worktree, { SPUR_TEST_SYS_NODE: "v25.2.0" });

    expect(rejection).toMatchObject({ code: 1 });
    expect(rejection.stderr).toMatch(/\^20\.19\.0 \|\| \^22\.13\.0/);
    expect(rejection.stderr).toMatch(/v25\.2\.0/);
    expect(existsSync(worktree.logPath)).toBe(false);
  });

  it("proceeds with no nvm at all on node 22 against a bounded engines range without >=24 (#824 review)", async () => {
    const worktree = createFakeWorktree();
    writeFileSync(join(worktree.repoDir, ".nvmrc"), "24\n", "utf8");
    writeFileSync(
      join(worktree.repoDir, "package.json"),
      JSON.stringify({ engines: { node: "^20.19.0 || ^22.13.0" } }),
      "utf8",
    );

    await expect(runIsolatedUi(worktree, { SPUR_TEST_SYS_NODE: "v22.23.2" })).resolves.toEqual([
      "install node=v22.23.2",
      "dev node=v22.23.2",
    ]);
  });

  it("fails fast with no nvm at all when the system node does not satisfy engines", async () => {
    const worktree = createFakeWorktree();
    writeFileSync(join(worktree.repoDir, ".nvmrc"), "24\n", "utf8");

    const rejection = await runIsolatedUiExpectFailure(worktree);

    expect(rejection).toMatchObject({ code: 1 });
    expect(rejection.stderr).toMatch(/\^20\.19\.0/);
    expect(rejection.stderr).toMatch(/v21\.7\.3/);
    expect(rejection.stderr).toMatch(/\.nvmrc/);
    // PR #824 review LOW 1: no nvm ever ran here, so the remedy must never
    // tell the host to run a command it cannot act on, or to check a
    // refusal that never happened.
    expect(rejection.stderr).toMatch(/nvm was not found/);
    expect(rejection.stderr).not.toMatch(/nvm install/);
    expect(rejection.stderr).not.toMatch(/NPM_CONFIG_PREFIX/);
    expect(existsSync(worktree.logPath)).toBe(false);
  });

  // Finding 1 (PR #824 review): a node that answers `-v` but exits 0 with
  // EMPTY stdout for the `-e` engines check must never read as "satisfied".
  // Reproduced against the pre-fix script: this same stub made
  // node_satisfies_engines return 0 and the script proceeded straight to
  // `pnpm install`/`pnpm dev` on an engines-invalid node — a fail-open gate.
  it("fails closed when node exits 0 but prints nothing for the engines check (finding 1)", async () => {
    const worktree = createFakeWorktree();
    writeFileSync(join(worktree.repoDir, ".nvmrc"), "24\n", "utf8");
    makeExecutable(
      join(worktree.pathDir, "node"),
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "-v" ]]; then
  printf 'v18.0.0\\n'
  exit 0
fi
exit 0
`,
    );

    const rejection = await runIsolatedUiExpectFailure(worktree);

    expect(rejection).toMatchObject({ code: 1 });
    expect(rejection.stderr).toMatch(/could not run the engines check/);
    expect(existsSync(worktree.logPath)).toBe(false);
  });

  // Finding 2 (PR #824 review): a node that answers `-v` normally but
  // cannot execute the `-e` check at all (modeling a NODE_OPTIONS rejection,
  // exit 9, empty stdout) must get its own accurate message — never the
  // garbled "does not satisfy the required range the required Node range"
  // text, and never "nvm install" as a remedy, since picking a different
  // node major does not fix a node that cannot execute the check.
  it("names the real failure, not a garbled range or nvm install, when node cannot execute the check (finding 2)", async () => {
    const worktree = createFakeWorktree();
    writeFileSync(join(worktree.repoDir, ".nvmrc"), "24\n", "utf8");
    makeExecutable(
      join(worktree.pathDir, "node"),
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "-v" ]]; then
  printf 'v21.7.3\\n'
  exit 0
fi
exit 9
`,
    );

    const rejection = await runIsolatedUiExpectFailure(worktree);

    expect(rejection).toMatchObject({ code: 1 });
    expect(rejection.stderr).toMatch(/could not run the engines check/);
    expect(rejection.stderr).not.toMatch(/required range the required/);
    expect(rejection.stderr).not.toMatch(/nvm install/);
    expect(existsSync(worktree.logPath)).toBe(false);
  });

  // Finding 3 (PR #824 review, mirror of finding 1 fixed in acf7ae7e): a
  // node that prints a valid, engines-CONFORMANT version on `-v` while
  // EXITING NONZERO must never be trusted — the string came from a failed
  // invocation, not a verdict. Reproduced against 6a02447a's script: the old
  // `current_version="$(node -v 2>/dev/null || true)"` discarded the exit
  // status, the regex matched the printed v25.2.0, and the gate proceeded
  // straight to `pnpm install`/`pnpm dev` — the inverse fail-open of finding 1.
  it("fails closed when node -v exits nonzero despite printing a conformant version (finding 3)", async () => {
    const worktree = createFakeWorktree();
    writeFileSync(join(worktree.repoDir, ".nvmrc"), "24\n", "utf8");
    makeExecutable(
      join(worktree.pathDir, "node"),
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "-v" ]]; then
  printf 'v25.2.0\\n'
  exit 9
fi
exec "$SPUR_TEST_REAL_NODE" "$@"
`,
    );

    const rejection = await runIsolatedUiExpectFailure(worktree);

    expect(rejection).toMatchObject({ code: 1 });
    expect(rejection.stderr).toMatch(/node -v exited 9 instead of reporting a version/);
    expect(rejection.stderr).not.toMatch(/nvm install/);
    expect(existsSync(worktree.logPath)).toBe(false);
  });

  // Finding 2: node missing from PATH entirely names that fact and never
  // claims to know an engines range it never got to read.
  it("names node as missing, not an engines range, when node is absent from PATH", async () => {
    const worktree = createFakeWorktree();
    writeFileSync(join(worktree.repoDir, ".nvmrc"), "24\n", "utf8");
    const nodeFreePathDir = createNodeFreePathDir(worktree.repoDir);

    const rejection = await runIsolatedUiExpectFailure(worktree, { PATH: nodeFreePathDir });

    expect(rejection).toMatchObject({ code: 1 });
    expect(rejection.stderr).toMatch(/node not found on PATH/);
    expect(rejection.stderr).not.toMatch(/\^20\.19\.0/);
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

  // Anti-drift guard: the script reimplements satisfiesClause's semantics in
  // a `node -e` one-liner (see node_satisfies_engines in
  // scripts/spur-isolated-ui.sh) because bash arithmetic can't compare
  // minor/patch versions. Run the same version table through both
  // implementations and assert identical verdicts so they cannot silently
  // diverge.
  it("agrees with satisfiesNodeEngineRange on every version in the equivalence table", async () => {
    const rootPackage = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
      engines: { node: string };
    };
    const range = rootPackage.engines.node;
    const versions = [
      "18.20.0",
      "20.0.0",
      "20.12.2",
      "20.19.0",
      "20.19.5",
      "21.7.3",
      "22.0.0",
      "22.12.0",
      "22.13.0",
      "22.23.2",
      "24.0.0",
      "24.15.0",
      "25.2.0",
    ];

    const worktree = createFakeWorktree();
    const scriptSource = readFileSync(
      join(worktree.repoDir, "scripts", "spur-isolated-ui.sh"),
      "utf8",
    );
    const functionMatch = /node_satisfies_engines\(\) \{[\s\S]*?\n\}\n/.exec(scriptSource);
    if (!functionMatch) {
      throw new Error("could not extract node_satisfies_engines from spur-isolated-ui.sh");
    }

    for (const version of versions) {
      const expected = satisfiesNodeEngineRange(range, version);

      const nodeStubPath = join(worktree.pathDir, "node");
      makeExecutable(
        nodeStubPath,
        `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "-v" ]]; then
  printf 'v%s\\n' "${version}"
  exit 0
fi
exec "$SPUR_TEST_REAL_NODE" "$@"
`,
      );

      const script = `#!/usr/bin/env bash
set -euo pipefail
ROOT_PACKAGE_JSON="${worktree.repoDir}/package.json"
NODE_ENGINES_RANGE=""
NODE_CHECK_ERROR=""
${functionMatch[0]}
if node_satisfies_engines; then
  exit 0
else
  exit 1
fi
`;
      const checkScriptPath = join(worktree.repoDir, "check.sh");
      writeFileSync(checkScriptPath, script, "utf8");

      const actual = await execFileAsync("bash", [checkScriptPath], {
        env: testEnv(worktree),
      })
        .then(() => true)
        .catch(() => false);

      expect({ version, actual }).toEqual({ version, actual: expected });
    }
  });

  // PR #824 review LOW 2: process.stdout.write(range) immediately followed
  // by process.exit() is the documented Node truncation shape (the write to
  // a pipe is async; exit() can abandon it mid-flight), and command
  // substitution makes stdout a pipe here. Regression guard, not a
  // reproduction of the truncation itself (not deterministically
  // reproducible) — pins that the range write is followed by
  // process.exitCode, never an explicit process.exit(satisfied ...) call,
  // so the hazard cannot be silently reintroduced.
  it("regression guard: the engines-range write is never immediately followed by process.exit (finding: #824 LOW 2)", () => {
    const scriptSource = readFileSync(join(SOURCE_SCRIPT_DIR, "spur-isolated-ui.sh"), "utf8");
    const functionMatch = /node_satisfies_engines\(\) \{[\s\S]*?\n\}\n/.exec(scriptSource);
    if (!functionMatch) {
      throw new Error("could not extract node_satisfies_engines from spur-isolated-ui.sh");
    }

    expect(functionMatch[0]).not.toMatch(/process\.exit\(satisfied/);
    expect(functionMatch[0]).toMatch(/process\.exitCode = satisfied \? 0 : 1/);
  });
});
