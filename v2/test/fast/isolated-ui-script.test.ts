import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { readLiveProcessStarttime } from "../../src/sidecars/reap.js";

const script = readFileSync(
  join(import.meta.dirname, "../../../scripts/spur-isolated-ui.sh"),
  "utf8",
);
const directories: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0))
    await new Promise<void>((done) => server.close(() => done()));
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function launcherFixture() {
  const root = await mkdtemp(join(tmpdir(), "spur-ui-generation-"));
  directories.push(root);
  for (const directory of ["scripts", "tool", "path", "v2/bin", "packages/web"])
    await mkdir(join(root, directory), { recursive: true });
  await copyFile(
    resolve("../scripts/spur-isolated-ui.sh"),
    join(root, "scripts/spur-isolated-ui.sh"),
  );
  await writeFile(
    join(root, "scripts/spur-sidecar-common.sh"),
    `ensure_node_ready() { :; }\nensure_workspace_deps() { :; }\nresolve_sidecar_port() { printf "%s\\n" "$SPUR_RESERVED_PORT_UI"; }\nwait_for_http() { while [[ ! -f "$SPUR_TEST_WEB_MARKER" ]]; do /bin/sleep 0.01; done; if [[ -n "\${SPUR_TEST_WEB_GATE:-}" ]]; then touch "$SPUR_TEST_WEB_GATE.ready"; while [[ ! -f "$SPUR_TEST_WEB_GATE" ]]; do /bin/sleep 0.01; done; fi; }\n`,
  );
  await writeFile(join(root, "packages/web/next-env.d.ts"), "// fixture\n");
  await writeFile(join(root, "packages/web/tsconfig.json"), "{}\n");
  await writeFile(
    join(root, "v2/bin/isolated-web-endpoint.mjs"),
    `import ${JSON.stringify(resolve("bin/isolated-web-endpoint.mjs"))};\n`,
  );
  await writeFile(
    join(root, "path/pnpm"),
    `#!/bin/sh\nexec '${process.execPath}' -e 'require("node:fs").writeFileSync(process.env.SPUR_TEST_WEB_MARKER,process.env.SPUR_CONFIG);setInterval(()=>{},1000)'\n`,
    { mode: 0o755 },
  );
  await writeFile(join(root, "path/sleep"), "#!/bin/sh\nexec /bin/sleep 0.03\n", { mode: 0o755 });
  const oldDir = await mkdtemp(join(root, "old-"));
  const currentDir = await mkdtemp(join(root, "current-"));
  let queried = false;
  let lifecycle = "current-generation";
  const server = createServer((_request, response) => {
    queried = true;
    response.setHeader("Content-Type", "application/json");
    response.end(
      JSON.stringify({
        ok: true,
        apiVersion: 3,
        pid: process.pid,
        host: "127.0.0.1",
        port,
        configPath: join(currentDir, "config.yaml"),
        dataDir: join(currentDir, "data"),
        tmuxSocketName: "fixture-current",
        lifecycleInstanceId: lifecycle,
      }),
    );
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture port");
  const port = address.port;
  for (const [directory, socket] of [
    [oldDir, "fixture-old"],
    [currentDir, "fixture-current"],
  ] as const) {
    await writeFile(
      join(directory, "config.yaml"),
      `server: {host: 127.0.0.1, port: ${port}}\ndataDir: ${directory}/data\ntmux: {socketName: ${socket}}\n`,
      { mode: 0o600 },
    );
  }
  const starttime = await readLiveProcessStarttime(process.pid);
  if (starttime === null) throw new Error("Missing fixture identity");
  const runtime = (directory: string, socket: string) =>
    `SPUR_ISOLATED_CONFIG="${directory}/config.yaml"\nSPUR_ISOLATED_UI_ENDPOINT_FILE="${directory}/ui-endpoint.json"\nSPUR_ISOLATED_DATA_DIR="${directory}/data"\nSPUR_ISOLATED_DAEMON_URL="http://127.0.0.1:${port}"\nSPUR_ISOLATED_TMUX_SOCKET_NAME="${socket}"\nSPUR_ISOLATED_DAEMON_PID="${process.pid}"\nSPUR_ISOLATED_DAEMON_STARTTIME="${starttime}"\n`;
  const runtimeFile = join(root, "tool/isolated-env.sh");
  const marker = join(root, "web-started");
  return {
    root,
    oldDir,
    currentDir,
    runtimeFile,
    marker,
    runtime,
    queried: () => queried,
    changeGeneration: () => {
      lifecycle = "replacement-generation";
    },
    launch: (extraEnv?: NodeJS.ProcessEnv) =>
      spawn("bash", [join(root, "scripts/spur-isolated-ui.sh")], {
        cwd: root,
        env: {
          PATH: `${join(root, "path")}:${process.env["PATH"]}`,
          SPUR_SESSION_TOOL_DIR: join(root, "tool"),
          SPUR_RESERVED_PORT_UI: "5699",
          SPUR_TEST_WEB_MARKER: marker,
          ...extraEnv,
        },
        stdio: ["pipe", "pipe", "pipe"],
      }),
  };
}

async function waitUntil(predicate: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (await predicate()) return;
    await new Promise((done) => setTimeout(done, 10));
  }
  throw new Error("Fixture barrier not reached");
}
async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

describe("spur-isolated-ui.sh", () => {
  it("supports first publication and current-owner restart without re-reading accepted snapshot", async () => {
    const fixture = await launcherFixture();
    const child = fixture.launch();
    try {
      await new Promise((done) => setTimeout(done, 50));
      expect(await exists(fixture.marker)).toBe(false);
      await writeFile(fixture.runtimeFile, fixture.runtime(fixture.currentDir, "fixture-current"), {
        mode: 0o600,
      });
      await waitUntil(() => exists(join(fixture.currentDir, "ui-endpoint.json")));
      expect(await readFile(fixture.marker, "utf8")).toBe(join(fixture.currentDir, "config.yaml"));
    } finally {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
    }
    const gate = join(fixture.root, "web-gate");
    const restarted = fixture.launch({ SPUR_TEST_WEB_GATE: gate });
    try {
      await waitUntil(() => exists(`${gate}.ready`));
      await writeFile(
        fixture.runtimeFile,
        `SPUR_ISOLATED_CONFIG="${fixture.oldDir}/config.yaml"\n`,
        { mode: 0o600 },
      );
      await writeFile(gate, "continue");
      await waitUntil(async () =>
        (await readFile(join(fixture.currentDir, "ui-endpoint.json"), "utf8")).includes(
          String(restarted.pid),
        ),
      );
      expect(await readFile(fixture.marker, "utf8")).toBe(join(fixture.currentDir, "config.yaml"));
      expect(await exists(join(fixture.oldDir, "ui-endpoint.json"))).toBe(false);
    } finally {
      const exited = once(restarted, "exit");
      restarted.kill("SIGTERM");
      await exited;
    }
  });
  it("refuses receipt and cleans owned web when daemon generation changes during UI readiness", async () => {
    const fixture = await launcherFixture();
    await writeFile(fixture.runtimeFile, fixture.runtime(fixture.currentDir, "fixture-current"), {
      mode: 0o600,
    });
    const gate = join(fixture.root, "web-gate");
    const child = fixture.launch({ SPUR_TEST_WEB_GATE: gate });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    try {
      await waitUntil(() => exists(`${gate}.ready`));
      fixture.changeGeneration();
      const exited = once(child, "exit");
      await writeFile(gate, "continue");
      const [code] = await exited;
      expect(code).toBe(1);
      expect(stderr).toContain("generation changed");
      expect(await exists(join(fixture.currentDir, "ui-endpoint.json"))).toBe(false);
    } finally {
      if (child.exitCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGTERM");
        await exited;
      }
    }
  });
  it("fails named bounded wait with absent or legacy partial runtime", async () => {
    const fixture = await launcherFixture();
    // Partial metadata cannot inherit a previously supplied owner's fields.
    await writeFile(fixture.runtimeFile, `SPUR_ISOLATED_CONFIG="${fixture.oldDir}/config.yaml"\n`, {
      mode: 0o600,
    });
    const child = fixture.launch();
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const [code] = await once(child, "exit");
    expect(code).toBe(1);
    expect(stderr).toContain("Timed out waiting for current isolated daemon runtime");
    expect(await exists(fixture.marker)).toBe(false);
    expect(script).toContain("RUNTIME_DEADLINE=$((SECONDS + 30))");
  });
  it("rejects retained valid old generation until delayed current publication", async () => {
    const fixture = await launcherFixture();
    await writeFile(fixture.runtimeFile, fixture.runtime(fixture.oldDir, "fixture-old"), {
      mode: 0o600,
    });
    const child = fixture.launch();
    try {
      await waitUntil(async () => fixture.queried() || (await exists(fixture.marker)));
      expect(await exists(fixture.marker)).toBe(false);
      expect(await exists(join(fixture.oldDir, "ui-endpoint.json"))).toBe(false);
      await writeFile(fixture.runtimeFile, fixture.runtime(fixture.currentDir, "fixture-current"), {
        mode: 0o600,
      });
      await waitUntil(() => exists(join(fixture.currentDir, "ui-endpoint.json")));
      expect(await readFile(fixture.marker, "utf8")).toBe(join(fixture.currentDir, "config.yaml"));
    } finally {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
    }
  });
  it("never binds the sidecar web server to all interfaces", () => {
    expect(script).not.toContain("0.0.0.0");
  });
});
