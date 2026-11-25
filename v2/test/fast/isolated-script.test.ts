import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { loadProjectConfig } from "../../src/config.js";
import { buildIsolatedProjectConfig } from "../../src/isolated-project-config.js";

const sourceRoot = resolve("..");
const fixtures: { root: string; child?: ChildProcess; exited?: Promise<number | null> }[] = [];

async function waitUntil(check: () => Promise<boolean>, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error("Fixture condition timed out");
    await new Promise((done) => setTimeout(done, 20));
  }
}

async function contents(path: string) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return "";
    throw error;
  }
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    if (fixture.child && fixture.child.exitCode === null && fixture.child.signalCode === null) {
      fixture.child.kill("SIGTERM");
      await Promise.race([
        fixture.exited,
        new Promise((_, reject) => setTimeout(() => reject(new Error("Cleanup timed out")), 3000)),
      ]);
    }
    await rm(fixture.root, { recursive: true, force: true });
  }
});

async function launcherFixture(options: { delay?: number; failDaemon?: boolean; failUi?: boolean; timeout?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "spur-combined-"));
  const fixture: (typeof fixtures)[number] = { root };
  fixtures.push(fixture);
  for (const directory of ["scripts", "tool", "v2/bin", "path"])
    await mkdir(join(root, directory), { recursive: true });
  await copyFile(join(sourceRoot, "scripts/spur-isolated.sh"), join(root, "scripts/spur-isolated.sh"));
  await writeFile(join(root, "scripts/spur-sidecar-common.sh"),
    `source ${JSON.stringify(join(sourceRoot, "scripts/spur-sidecar-common.sh"))}\nSIDECAR_REPO_ROOT="$PWD"\nensure_node_ready() { :; }\n`);
  await writeFile(join(root, "v2/bin/isolated-web-endpoint.mjs"),
    `await import(${JSON.stringify(join(sourceRoot, "v2/bin/isolated-web-endpoint.mjs"))});\n`);
  if (options.timeout) {
    // Shorten attempts, while executing the production wait and cleanup paths.
    await writeFile(join(root, "path/seq"), '#!/bin/sh\nif [ "$2" = 180 ]; then echo 1; else exec /usr/bin/seq "$@"; fi\n', { mode: 0o755 });
  }
  const events = join(root, "events");
  const runtime = join(root, "tool/isolated-env.sh");
  const config = join(root, "config.yaml");
  const workerSource = `
import {appendFileSync, writeFileSync, rmSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {readLiveProcessStarttime} from ${JSON.stringify(resolve("dist/sidecars/reap.js"))};
const kind=process.argv[2];
const record=value=>appendFileSync(${JSON.stringify(events)},value+'\\n');
record(kind+' '+process.pid);
const descendant=spawn(process.execPath,['-e','setInterval(()=>{},1000)']);
record(kind+'-descendant '+descendant.pid);
let server;
let timer;
process.on('SIGTERM',()=>{clearTimeout(timer);descendant.once('exit',()=>{server?.close();if(kind==='daemon')rmSync(${JSON.stringify(runtime)},{force:true});record(kind+'-stopped');process.exit(0)});descendant.kill('SIGTERM')});
if(kind==='daemon') {
  if(${options.failDaemon === true}) {descendant.once('exit',()=>process.exit(7));descendant.kill();}
  else timer=setTimeout(async()=>{
    server=createServer((request,response)=>{response.setHeader('content-type','application/json');response.end(JSON.stringify({ok:true,apiVersion:3,pid:process.pid,host:'127.0.0.1',port:server.address().port,configPath:${JSON.stringify(config)},dataDir:${JSON.stringify(join(root, "data"))},tmuxSocketName:'fixture',lifecycleInstanceId:'fixture-generation'}))});
    server.listen(0,'127.0.0.1',async()=>{
      const port=server.address().port;
      writeFileSync(${JSON.stringify(config)},'server: {host: 127.0.0.1, port: '+port+'}\\ndataDir: '+${JSON.stringify(join(root, "data"))}+'\\ntmux: {socketName: fixture}\\n');
      const fields={SPUR_ISOLATED_CONFIG:${JSON.stringify(config)},SPUR_ISOLATED_UI_ENDPOINT_FILE:${JSON.stringify(join(root, "ui-endpoint.json"))},SPUR_ISOLATED_DATA_DIR:${JSON.stringify(join(root, "data"))},SPUR_ISOLATED_DAEMON_URL:'http://127.0.0.1:'+port,SPUR_ISOLATED_TMUX_SOCKET_NAME:'fixture',SPUR_ISOLATED_DAEMON_PID:String(process.pid),SPUR_ISOLATED_DAEMON_STARTTIME:String(await readLiveProcessStarttime(process.pid))};
      writeFileSync(${JSON.stringify(runtime)},Object.entries(fields).map(([key,value])=>key+'='+JSON.stringify(value)).join('\\n')+'\\n');record('ready');
    });
  },${options.delay ?? 0});
} else if(${options.failUi === true}) {descendant.once('exit',()=>process.exit(9));descendant.kill();}
`;
  await writeFile(join(root, "worker.mjs"), workerSource);
  for (const kind of ["daemon", "ui"]) {
    await writeFile(join(root, `scripts/spur-isolated-${kind}.sh`),
      `#!/bin/bash\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(root, "worker.mjs"))} ${kind}\n`);
  }
  let stderr = "";
  return {
    root, events, runtime,
    output: () => stderr,
    launch() {
      const child = spawn("bash", [join(root, "scripts/spur-isolated.sh")], {
        cwd: root,
        env: { ...process.env, SPUR_SESSION_TOOL_DIR: join(root, "tool"), PATH: `${join(root, "path")}:${process.env["PATH"]}` },
        stdio: ["ignore", "pipe", "pipe"],
      });
      fixture.child = child;
      fixture.exited = new Promise<number | null>((done, reject) => {
        child.once("exit", done);
        child.once("error", reject);
      });
      child.stdout?.resume();
      child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
      return { child, exited: fixture.exited };
    },
    async assertGone() {
      for (const line of (await contents(events)).trim().split("\n")) {
        const match = /^(?:daemon|ui)(?:-descendant)? (\d+)$/.exec(line);
        if (match) expect(() => process.kill(Number(match[1]), 0)).toThrow();
      }
    },
  };
}

describe("combined isolated sidecar", () => {
  it("reuses standalone reserved ports and public environment", async () => {
    const root = await mkdtemp(join(tmpdir(), "spur-combined-config-"));
    fixtures.push({ root });
    execFileSync("git", ["init", "-q"], { cwd: root });
    const configPath = join(root, "spur.yaml");
    await writeFile(configPath, buildIsolatedProjectConfig(await readFile(join(sourceRoot, "spur.yaml"), "utf8"), root));
    const project = loadProjectConfig(configPath).projects["sp"];
    if (!project) throw new Error("Missing project");
    const combined = project.sidecars["isolated"];
    expect(combined?.command).toBe("./scripts/spur-isolated.sh");
    expect(combined?.ports).toEqual({ ...project.sidecars["isolated-daemon"]?.ports, ...project.sidecars["isolated-ui"]?.ports });
    expect(combined?.env).toEqual(project.sidecars["isolated-ui"]?.env);
    expect(combined?.dependsOn).toBeUndefined();
  });

  it("waits beyond standalone startup budget before launching frontend", async () => {
    const fixture = await launcherFixture({ delay: 31_000 });
    const { child, exited } = fixture.launch();
    await waitUntil(async () => (await contents(fixture.events)).includes("daemon "));
    await new Promise((done) => setTimeout(done, 30_100));
    expect(await contents(fixture.events)).not.toContain("ui ");
    await waitUntil(async () => (await contents(fixture.events)).includes("ui "), 10_000);
    expect((await contents(fixture.events)).indexOf("ready")).toBeLessThan((await contents(fixture.events)).indexOf("ui "));
    child.kill("SIGTERM");
    expect(await exited).toBe(143);
    await fixture.assertGone();
  }, 45_000);

  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    it(`stops owned groups on ${signal}`, async () => {
      const fixture = await launcherFixture();
      const { child, exited } = fixture.launch();
      await waitUntil(async () => (await contents(fixture.events)).includes("ui-descendant "));
      child.kill(signal);
      expect(await exited).toBe({ SIGTERM: 143, SIGINT: 130, SIGHUP: 129 }[signal]);
      await fixture.assertGone();
      expect(await contents(fixture.events)).toContain("daemon-stopped");
      expect(await contents(fixture.events)).toContain("ui-stopped");
    }, 10_000);
  }

  for (const kind of ["daemon", "ui"] as const) {
    it(`propagates ${kind} failure and cleans other owned processes`, async () => {
      const fixture = await launcherFixture({ failDaemon: kind === "daemon", failUi: kind === "ui" });
      const { exited } = fixture.launch();
      expect(await exited).toBe(kind === "daemon" ? 7 : 9);
      if (kind === "daemon") expect(await contents(fixture.events)).not.toContain("ui ");
      else expect(await contents(fixture.events)).toContain("daemon-stopped");
      await fixture.assertGone();
    }, 10_000);
  }

  it("cleans daemon on readiness timeout", async () => {
    const fixture = await launcherFixture({ delay: 60_000, timeout: true });
    const { exited } = fixture.launch();
    expect(await exited).toBe(1);
    expect(fixture.output()).toContain("Timed out waiting for current isolated daemon runtime");
    expect(await contents(fixture.events)).not.toContain("ui ");
    await fixture.assertGone();
    expect(await readFile(join(sourceRoot, "scripts/spur-isolated.sh"), "utf8")).toContain('wait_for_isolated_daemon 180 "$DAEMON_PID"');
  });

  it("rejects pre-existing metadata without starting or touching another owner", async () => {
    const fixture = await launcherFixture();
    const marker = `FOREIGN_PID=${process.pid}\n`;
    await writeFile(fixture.runtime, marker);
    const { exited } = fixture.launch();
    expect(await exited).toBe(1);
    expect(fixture.output()).toContain("Stop the existing isolated stand");
    expect(await readFile(fixture.runtime, "utf8")).toBe(marker);
    expect(await contents(fixture.events)).toBe("");
    expect(() => process.kill(process.pid, 0)).not.toThrow();
  });
});
