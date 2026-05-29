import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = resolve(HERE, "../../../scripts/main-deploy.sh");
const BASH = "/usr/bin/bash";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

function extractBashFunctions(source: string, names: string[]): string {
  const lines = source.split("\n");
  const chunks: string[] = [];
  for (const name of names) {
    const startIdx = lines.findIndex((line) => line.startsWith(`${name}()`));
    if (startIdx < 0) {
      throw new Error(`${name}() not found in ${SCRIPT_PATH}`);
    }
    let depth = 0;
    let started = false;
    for (let i = startIdx; i < lines.length; i++) {
      const line = lines[i];
      if (line === undefined) {
        break;
      }
      for (const ch of line) {
        if (ch === "{") {
          depth++;
          started = true;
        } else if (ch === "}") {
          depth--;
        }
      }
      chunks.push(line);
      if (started && depth === 0) {
        break;
      }
    }
  }
  return chunks.join("\n");
}

function resolveDeployBinsHelper(): string {
  return extractBashFunctions(readFileSync(SCRIPT_PATH, "utf8"), ["resolve_deploy_bins"]);
}

async function createStubBin(dir: string, name: string): Promise<string> {
  const binPath = join(dir, name);
  await writeFile(binPath, "#!/usr/bin/bash\nexit 0\n", "utf8");
  await chmod(binPath, 0o755);
  return binPath;
}

async function createDirnameStub(dir: string): Promise<void> {
  const dirnamePath = join(dir, "dirname");
  await writeFile(
    dirnamePath,
    ["#!/usr/bin/bash", 'path="$1"', 'printf "%s\\n" "' + "$" + '{path%/*}"', ""].join("\n"),
    "utf8",
  );
  await chmod(dirnamePath, 0o755);
}

async function createWhichStub(dir: string): Promise<void> {
  const whichPath = join(dir, "which");
  await writeFile(
    whichPath,
    [
      "#!/usr/bin/bash",
      'name="$1"',
      '[[ -z "$name" ]] && exit 1',
      'IFS=":" read -ra parts <<< "$PATH"',
      'for part in "' + "$" + '{parts[@]}"; do',
      '  candidate="$part/$name"',
      '  if [[ -x "$candidate" ]]; then',
      '    printf "%s\\n" "$candidate"',
      "    exit 0",
      "  fi",
      "done",
      "exit 1",
      "",
    ].join("\n"),
    "utf8",
  );
  await chmod(whichPath, 0o755);
}

function isolatedPath(...dirs: string[]): string {
  return dirs.join(":");
}

async function createBinLayout(opts: {
  nodeDir: string;
  home?: string;
}): Promise<{ nodePath: string; pnpmPath: string; path: string; home: string }> {
  const home = opts.home ?? (await mkdtemp(join(tmpdir(), "main-deploy-home-")));
  if (!opts.home) {
    tempDirs.push(home);
  }
  await createWhichStub(opts.nodeDir);
  await createDirnameStub(opts.nodeDir);
  const nodePath = await createStubBin(opts.nodeDir, "node");
  const pnpmPath = await createStubBin(opts.nodeDir, "pnpm");
  return {
    nodePath,
    pnpmPath,
    path: isolatedPath(opts.nodeDir),
    home,
  };
}

async function runResolveDeployBins(opts: {
  path: string;
  home: string;
  serviceHome?: string;
}): Promise<{ nodePath: string; pnpmPath: string; nvmPathPrefix: string }> {
  const serviceHome = opts.serviceHome ?? opts.home;
  const script = `set -euo pipefail
service_home=${JSON.stringify(serviceHome)}
${resolveDeployBinsHelper()}
resolve_deploy_bins
printf '%s\\n' "$NODE_PATH"
printf '%s\\n' "$PNPM_PATH"
printf '%s' "$NVM_PATH_PREFIX"
`;
  const { stdout } = await execFileAsync(BASH, ["-c", script], {
    env: { HOME: opts.home, PATH: opts.path },
  });
  const [nodePath = "", pnpmPath = "", nvmPathPrefix = ""] = stdout.split("\n");
  return { nodePath, pnpmPath, nvmPathPrefix };
}

async function runResolveDeployBinsExpectFailure(opts: {
  path: string;
  home: string;
}): Promise<{ code: number | null; stderr: string }> {
  const script = `set -euo pipefail
service_home=${JSON.stringify(opts.home)}
${resolveDeployBinsHelper()}
resolve_deploy_bins
`;
  try {
    await execFileAsync(BASH, ["-c", script], {
      env: { HOME: opts.home, PATH: opts.path },
    });
    return { code: 0, stderr: "" };
  } catch (error: unknown) {
    const execError = error as { code?: number; stderr?: string };
    return {
      code: execError.code ?? null,
      stderr: execError.stderr ?? String(error),
    };
  }
}

async function substituteTemplate(opts: {
  template: string;
  root: string;
  serviceUser: string;
  serviceHome: string;
  path: string;
  home: string;
}): Promise<string> {
  const script = `set -euo pipefail
service_user=${JSON.stringify(opts.serviceUser)}
service_home=${JSON.stringify(opts.serviceHome)}
root=${JSON.stringify(opts.root)}
${resolveDeployBinsHelper()}
resolve_deploy_bins
content=${JSON.stringify(opts.template)}
content="\${content//\\{\\{SPUR_ROOT\\}\\}/$root}"
content="\${content//\\{\\{SPUR_SERVICE_USER\\}\\}/$service_user}"
content="\${content//\\{\\{SPUR_SERVICE_HOME\\}\\}/$service_home}"
content="\${content//\\{\\{NODE_BIN\\}\\}/$NODE_PATH}"
content="\${content//\\{\\{PNPM_BIN\\}\\}/$PNPM_PATH}"
if [[ -n "$NVM_PATH_PREFIX" ]]; then
  content="\${content//Environment=PATH=/Environment=PATH=$NVM_PATH_PREFIX}"
fi
if printf '%s' "$content" | grep -qF '{{'; then
  echo "unsubstituted placeholders" >&2
  exit 1
fi
printf '%s' "$content"
`;
  const { stdout } = await execFileAsync(BASH, ["-c", script], {
    env: { HOME: opts.home, PATH: opts.path },
  });
  return stdout;
}

describe("main-deploy path resolution (runtime)", () => {
  it("resolves node and pnpm from PATH", async () => {
    const binDir = await mkdtemp(join(tmpdir(), "main-deploy-bins-"));
    tempDirs.push(binDir);
    const layout = await createBinLayout({ nodeDir: binDir });

    const result = await runResolveDeployBins({
      path: layout.path,
      home: layout.home,
    });

    expect(result.nodePath).toBe(layout.nodePath);
    expect(result.pnpmPath).toBe(layout.pnpmPath);
    expect(result.nvmPathPrefix).toBe("");
  });

  it("prepends nvm bin dir to NVM_PATH_PREFIX", async () => {
    const home = await mkdtemp(join(tmpdir(), "main-deploy-nvm-home-"));
    tempDirs.push(home);
    const nvmBinDir = join(home, ".nvm/versions/node/v24.0.0/bin");
    await mkdir(nvmBinDir, { recursive: true });
    const layout = await createBinLayout({ nodeDir: nvmBinDir, home });

    const result = await runResolveDeployBins({
      path: layout.path,
      home: layout.home,
      serviceHome: layout.home,
    });

    expect(result.nodePath).toBe(layout.nodePath);
    expect(result.nvmPathPrefix).toBe(`${nvmBinDir}:`);
  });

  it("fails fast when node is missing from PATH", async () => {
    const home = await mkdtemp(join(tmpdir(), "main-deploy-no-node-"));
    tempDirs.push(home);
    const emptyDir = await mkdtemp(join(tmpdir(), "main-deploy-empty-path-"));
    tempDirs.push(emptyDir);

    const result = await runResolveDeployBinsExpectFailure({
      path: isolatedPath(emptyDir),
      home,
    });

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("node not found on PATH");
  });

  it("fails fast when pnpm is missing from PATH", async () => {
    const home = await mkdtemp(join(tmpdir(), "main-deploy-no-pnpm-"));
    tempDirs.push(home);
    const nodeDir = await mkdtemp(join(tmpdir(), "main-deploy-node-only-"));
    tempDirs.push(nodeDir);
    await createWhichStub(nodeDir);
    await createStubBin(nodeDir, "node");

    const result = await runResolveDeployBinsExpectFailure({
      path: isolatedPath(nodeDir),
      home,
    });

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("pnpm not found on PATH");
  });

  it("substitutes template placeholders and injects nvm PATH prefix", async () => {
    const home = await mkdtemp(join(tmpdir(), "main-deploy-template-"));
    tempDirs.push(home);
    const nvmBinDir = join(home, ".nvm/versions/node/v24.0.0/bin");
    await mkdir(nvmBinDir, { recursive: true });
    const layout = await createBinLayout({ nodeDir: nvmBinDir, home });

    const template = [
      "ExecStart={{NODE_BIN}} {{SPUR_ROOT}}/v2/dist/cli.js daemon start",
      "Environment=PATH={{SPUR_SERVICE_HOME}}/.local/bin:/usr/bin:/bin",
      "ExecStart={{PNPM_BIN}} ui:start",
    ].join("\n");

    const output = await substituteTemplate({
      template,
      root: "/srv/spur",
      serviceUser: "spur",
      serviceHome: home,
      path: layout.path,
      home: layout.home,
    });

    expect(output).toContain(`ExecStart=${layout.nodePath} /srv/spur/v2/dist/cli.js daemon start`);
    expect(output).toContain(`ExecStart=${layout.pnpmPath} ui:start`);
    expect(output).toContain(`Environment=PATH=${nvmBinDir}:${home}/.local/bin:/usr/bin:/bin`);
    expect(output).not.toContain("{{");
  });
});
