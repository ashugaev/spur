import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, type Server } from "node:http";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, type TestContext } from "vitest";
import { readLiveProcessStarttime } from "../../src/sidecars/reap.js";

const script = readFileSync(
  join(import.meta.dirname, "../../../scripts/spur-isolated-ui.sh"),
  "utf8",
);
const directories: string[] = [];
const servers: Server[] = [];
const CLEANUP_BUDGET_MS = 2000;
interface FixtureChild {
  process: ChildProcessWithoutNullStreams;
  ownerFile: string;
  exited: Promise<void>;
  finished: boolean;
  error: Error | null;
  stderr: string;
  stopping?: Promise<void>;
}
const children: FixtureChild[] = [];
function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
}
async function readWebOwner(child: FixtureChild): Promise<{ pid: number; starttime: number }> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(child.ownerFile, "utf8"));
  } catch {
    throw new Error("Missing or corrupt fixture web owner");
  }
  if (
    value === null ||
    typeof value !== "object" ||
    !("pid" in value) ||
    typeof value.pid !== "number" ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 0 ||
    !("starttime" in value) ||
    typeof value.starttime !== "number" ||
    !Number.isSafeInteger(value.starttime) ||
    value.starttime < 0
  )
    throw new Error("Invalid fixture web owner");
  return { pid: value.pid, starttime: value.starttime };
}
async function exitedWithin(child: FixtureChild, milliseconds: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      child.exited.then(() => true),
      new Promise<boolean>((done) => {
        timer = setTimeout(() => done(false), Math.max(0, milliseconds));
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function stopChild(child: FixtureChild): Promise<void> {
  child.stopping ??= (async () => {
    const deadline = performance.now() + CLEANUP_BUDGET_MS;
    if (!child.finished) child.process.kill("SIGTERM");
    await exitedWithin(child, 500);
    if (!(await exists(`${child.ownerFile}.started`))) {
      if (!child.finished) throw new Error("Fixture cleanup lacks web-start proof");
      return;
    }
    const owner = await readWebOwner(child);
    const gone = async () => {
      if (!pidExists(owner.pid)) return true;
      const current = await readLiveProcessStarttime(owner.pid);
      return current !== null && current !== owner.starttime;
    };
    if ((await readLiveProcessStarttime(owner.pid)) === owner.starttime) {
      try {
        process.kill(owner.pid, "SIGKILL");
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
      }
    }
    while (!(await gone()) && performance.now() < deadline)
      await new Promise((done) => setTimeout(done, 10));
    if (!(await gone())) throw new Error("Fixture web cleanup deadline exceeded");
    if (!child.finished) child.process.kill("SIGKILL");
    if (!(await exitedWithin(child, deadline - performance.now())) || performance.now() >= deadline)
      throw new Error("Fixture supervisor cleanup deadline exceeded");
  })();
  return child.stopping;
}
afterEach(async () => {
  for (const child of children) await stopChild(child);
  children.length = 0;
  for (const server of servers.splice(0))
    await new Promise<void>((done) => server.close(() => done()));
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function launcherFixture(
  context: TestContext,
  options: { publicationDelayMs?: number; signal?: AbortSignal } = {},
) {
  let deadline = performance.now() + context.task.timeout - CLEANUP_BUDGET_MS;
  const signal = options.signal
    ? AbortSignal.any([context.signal, options.signal])
    : context.signal;
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
    `if (process.argv[2] !== "--daemon-ready") await new Promise(done => setTimeout(done, ${options.publicationDelayMs ?? 0}));\nawait import(${JSON.stringify(resolve("bin/isolated-web-endpoint.mjs"))});\n`,
  );
  await writeFile(
    join(root, "path/pnpm"),
    `#!/bin/sh\nexec '${process.execPath}' -e 'const fs=require("node:fs");fs.writeFileSync(process.env.SPUR_TEST_WEB_OWNER+".started","started");fs.writeFileSync(process.env.SPUR_TEST_WEB_OWNER+".webhost",process.env.WEB_HOST??"<unset>");(async()=>{const {readLiveProcessStarttime}=await import(${JSON.stringify(resolve("dist/sidecars/reap.js"))});const starttime=await readLiveProcessStarttime(process.pid);if(starttime===null)throw new Error("Missing fixture web identity");fs.writeFileSync(process.env.SPUR_TEST_WEB_OWNER,JSON.stringify({pid:process.pid,starttime}));fs.writeFileSync(process.env.SPUR_TEST_WEB_MARKER,process.env.SPUR_CONFIG);setInterval(()=>{},1000)})()'\n`,
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
    expire: () => {
      deadline = Math.min(deadline, performance.now());
    },
    waitUntil: async (child: FixtureChild, label: string, predicate: () => Promise<boolean>) => {
      for (;;) {
        const details = `exit=${child.process.exitCode} signal=${child.process.signalCode} error=${child.error?.message ?? "none"} stderr=${child.stderr}`;
        if (signal.aborted) throw new Error(`${label}: fixture aborted; ${details}`);
        if (child.finished) throw new Error(`${label}: fixture child exited; ${details}`);
        if (performance.now() >= deadline)
          throw new Error(`${label}: fixture deadline exceeded; ${details}`);
        if (await predicate()) return;
        await new Promise((done) => setTimeout(done, 10));
      }
    },
    queried: () => queried,
    changeGeneration: () => {
      lifecycle = "replacement-generation";
    },
    launch: (extraEnv?: NodeJS.ProcessEnv) => {
      const ownerFile = join(root, `web-owner-${children.length}.json`);
      const supervisor = spawn("bash", [join(root, "scripts/spur-isolated-ui.sh")], {
        cwd: root,
        env: {
          PATH: `${join(root, "path")}:${process.env["PATH"]}`,
          SPUR_SESSION_TOOL_DIR: join(root, "tool"),
          SPUR_RESERVED_PORT_UI: "5699",
          SPUR_TEST_WEB_MARKER: marker,
          SPUR_TEST_WEB_OWNER: ownerFile,
          ...extraEnv,
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      const exited = new Promise<void>((done) => {
        supervisor.once("exit", () => {
          child.finished = true;
          done();
        });
        supervisor.once("error", (error) => {
          child.error = error;
          child.finished = true;
          done();
        });
      });
      const child: FixtureChild = {
        process: supervisor,
        ownerFile,
        exited,
        finished: false,
        error: null,
        stderr: "",
      };
      supervisor.stdout.resume();
      supervisor.stderr.on("data", (chunk: Buffer) => {
        child.stderr += chunk.toString();
      });
      const abort = () => {
        void stopChild(child).catch(() => undefined);
      };
      signal.addEventListener("abort", abort, { once: true });
      void child.exited.then(() => signal.removeEventListener("abort", abort));
      children.push(child);
      if (signal.aborted) abort();
      return child;
    },
  };
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
  for (const publicationDelayMs of [0, 3500]) {
    it(`supports first publication and current-owner restart without re-reading accepted snapshot (publication delay ${publicationDelayMs}ms)`, async (context) => {
      const fixture = await launcherFixture(context, { publicationDelayMs });
      const child = fixture.launch();
      try {
        await new Promise((done) => setTimeout(done, 50));
        expect(await exists(fixture.marker)).toBe(false);
        await writeFile(
          fixture.runtimeFile,
          fixture.runtime(fixture.currentDir, "fixture-current"),
          {
            mode: 0o600,
          },
        );
        await fixture.waitUntil(child, "first publication", () =>
          exists(join(fixture.currentDir, "ui-endpoint.json")),
        );
        expect(await readFile(fixture.marker, "utf8")).toBe(
          join(fixture.currentDir, "config.yaml"),
        );
      } finally {
        await stopChild(child);
      }
      const gate = join(fixture.root, "web-gate");
      const restarted = fixture.launch({ SPUR_TEST_WEB_GATE: gate });
      try {
        await fixture.waitUntil(restarted, "restart readiness", () => exists(`${gate}.ready`));
        await writeFile(
          fixture.runtimeFile,
          `SPUR_ISOLATED_CONFIG="${fixture.oldDir}/config.yaml"\n`,
          { mode: 0o600 },
        );
        await writeFile(gate, "continue");
        await fixture.waitUntil(restarted, "restart publication", async () =>
          (await readFile(join(fixture.currentDir, "ui-endpoint.json"), "utf8")).includes(
            String(restarted.process.pid),
          ),
        );
        expect(await readFile(fixture.marker, "utf8")).toBe(
          join(fixture.currentDir, "config.yaml"),
        );
        expect(await exists(join(fixture.oldDir, "ui-endpoint.json"))).toBe(false);
      } finally {
        await stopChild(restarted);
      }
    });
  }
  it("refuses receipt and cleans owned web when daemon generation changes during UI readiness", async (context) => {
    const fixture = await launcherFixture(context);
    await writeFile(fixture.runtimeFile, fixture.runtime(fixture.currentDir, "fixture-current"), {
      mode: 0o600,
    });
    const gate = join(fixture.root, "web-gate");
    const child = fixture.launch({ SPUR_TEST_WEB_GATE: gate });
    try {
      await fixture.waitUntil(child, "generation readiness", () => exists(`${gate}.ready`));
      fixture.changeGeneration();
      await writeFile(gate, "continue");
      await child.exited;
      expect(child.process.exitCode).toBe(1);
      expect(child.stderr).toContain("generation changed");
      expect(await exists(join(fixture.currentDir, "ui-endpoint.json"))).toBe(false);
    } finally {
      await stopChild(child);
    }
  });
  it("fails named bounded wait with absent or legacy partial runtime", async (context) => {
    const fixture = await launcherFixture(context);
    // Partial metadata cannot inherit a previously supplied owner's fields.
    await writeFile(fixture.runtimeFile, `SPUR_ISOLATED_CONFIG="${fixture.oldDir}/config.yaml"\n`, {
      mode: 0o600,
    });
    const child = fixture.launch();
    await child.exited;
    expect(child.process.exitCode).toBe(1);
    expect(child.stderr).toContain("Timed out waiting for current isolated daemon runtime");
    expect(await exists(fixture.marker)).toBe(false);
    expect(script).toContain("RUNTIME_DEADLINE=$((SECONDS + 30))");
  });
  it("rejects retained valid old generation until delayed current publication", async (context) => {
    const fixture = await launcherFixture(context);
    await writeFile(fixture.runtimeFile, fixture.runtime(fixture.oldDir, "fixture-old"), {
      mode: 0o600,
    });
    const child = fixture.launch();
    try {
      await fixture.waitUntil(
        child,
        "daemon query",
        async () => fixture.queried() || (await exists(fixture.marker)),
      );
      expect(await exists(fixture.marker)).toBe(false);
      expect(await exists(join(fixture.oldDir, "ui-endpoint.json"))).toBe(false);
      await writeFile(fixture.runtimeFile, fixture.runtime(fixture.currentDir, "fixture-current"), {
        mode: 0o600,
      });
      await fixture.waitUntil(child, "current publication", () =>
        exists(join(fixture.currentDir, "ui-endpoint.json")),
      );
      expect(await readFile(fixture.marker, "utf8")).toBe(join(fixture.currentDir, "config.yaml"));
    } finally {
      await stopChild(child);
    }
  });
  it("never binds the sidecar web server to all interfaces", () => {
    expect(script).not.toContain("0.0.0.0");
  });
  it("strips an ambient WEB_HOST before starting the web child", async (context) => {
    const fixture = await launcherFixture(context);
    await writeFile(fixture.runtimeFile, fixture.runtime(fixture.currentDir, "fixture-current"), {
      mode: 0o600,
    });
    const child = fixture.launch({ WEB_HOST: "0.0.0.0" });
    try {
      await fixture.waitUntil(child, "web child start", () => exists(fixture.marker));
      expect(await readFile(`${child.ownerFile}.webhost`, "utf8")).toBe("<unset>");
    } finally {
      await stopChild(child);
    }
  });
  it("reports an already-exited pre-web child without waiting for another exit", async (context) => {
    const fixture = await launcherFixture(context);
    const child = fixture.launch({ SPUR_SESSION_TOOL_DIR: "" });
    await child.exited;
    await expect(
      fixture.waitUntil(child, "web receipt", () => exists(fixture.marker)),
    ).rejects.toThrow(/web receipt: fixture child exited; exit=1.*SPUR_SESSION_TOOL_DIR/);
    expect(await exists(`${child.ownerFile}.started`)).toBe(false);
    await stopChild(child);
  });
  for (const mode of ["deadline", "abort"] as const) {
    it(`reaps blocked readiness owners before teardown on ${mode}`, async (context) => {
      const controller = new AbortController();
      const fixture = await launcherFixture(context, { signal: controller.signal });
      await writeFile(fixture.runtimeFile, fixture.runtime(fixture.currentDir, "fixture-current"), {
        mode: 0o600,
      });
      const gate = join(fixture.root, "blocked-gate");
      const child = fixture.launch({ SPUR_TEST_WEB_GATE: gate });
      await fixture.waitUntil(child, "blocked readiness", () => exists(`${gate}.ready`));
      const owner = await readWebOwner(child);
      if (mode === "deadline") fixture.expire();
      else controller.abort();
      await expect(
        fixture.waitUntil(child, "blocked receipt", () =>
          exists(join(fixture.currentDir, "ui-endpoint.json")),
        ),
      ).rejects.toThrow(mode === "deadline" ? "fixture deadline exceeded" : "fixture aborted");
      const started = performance.now();
      const stopped = stopChild(child);
      expect(stopChild(child)).toBe(stopped);
      await stopped;
      expect(performance.now() - started).toBeLessThan(CLEANUP_BUDGET_MS);
      expect(child.finished).toBe(true);
      expect(pidExists(owner.pid)).toBe(false);
      expect(await exists(gate)).toBe(false);
      expect(await exists(join(fixture.currentDir, "ui-endpoint.json"))).toBe(false);
      // afterEach closes the server and removes this root only after owned stops settle.
      expect(await exists(fixture.runtimeFile)).toBe(true);
    });
  }
});
