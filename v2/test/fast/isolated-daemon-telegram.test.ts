import { spawn, execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  watch,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { afterEach, expect, it } from "vitest";
import { loadProjectConfig } from "../../src/config.js";
import { buildIsolatedProjectConfig } from "../../src/isolated-project-config.js";
import { requestIsolatedDaemon } from "../../src/isolated-daemon-owner.js";
import { readLiveProcessStarttime } from "../../src/sidecars/reap.js";
import { SPUR_DAEMON_API_VERSION } from "../../src/types.js";

const paths: string[] = [];
afterEach(() => {
  for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});

it("keeps voice-capable UI entrypoint composed by the existing dependency", () => {
  const path = mkdtempSync(join(tmpdir(), "spur-test-sidecar-composition-"));
  paths.push(path);
  execFileSync("git", ["init", "-q"], { cwd: path });
  const source = readFileSync(resolve("../spur.yaml"), "utf8");
  const configPath = join(path, "spur.yaml");
  // Remove parent sources through the same adapter; no production env needed.
  writeFileSync(configPath, buildIsolatedProjectConfig(source, path));
  const project = loadProjectConfig(configPath).projects["sp"];
  if (!project) throw new Error("Missing project");
  expect(project.sidecars["isolated-ui"]?.dependsOn).toEqual(["isolated-daemon"]);
  expect(project.sidecars["isolated-ui"]?.autoStart).toBe(false);
  expect(project.sidecars["isolated-daemon"]?.autoStart).toBe(false);
});

it("holds the launcher bot lock through exec, disables a contender, releases on exit", async () => {
  const path = mkdtempSync(join(tmpdir(), "spur-test-telegram-lock-"));
  paths.push(path);
  const source = readFileSync(resolve("../scripts/spur-isolated-daemon.sh"), "utf8");
  const start = source.indexOf("# Hold the bot lock");
  const end = source.indexOf("\n# Advertise only final configs", start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const boundary = source.slice(start, end);
  const lock = join(path, "bot.lock");
  const writer = join(path, "writer.cjs");
  writeFileSync(
    writer,
    `const fs=require('node:fs');const args=process.argv.slice(2);const i=args.indexOf('--telegram-lock-output');if(i!==-1)fs.writeFileSync(args[i+1],${JSON.stringify(lock)});else if(args.includes('--without-telegram'))console.log('SOURCE_FREE');`,
  );
  const script = `set -euo pipefail\nNODE_BIN="$1"\nWRITE_CONFIG_PATH="$2"\nCONFIG_DIR="$3"\nWRITE_CONFIG_ARGS=()\n${boundary}\nexec "$NODE_BIN" -e 'console.log("STARTED");process.stdin.resume()'\n`;
  const config = join(path, "config");
  execFileSync("mkdir", [config]);
  const owner = spawn("bash", ["-c", script, "fixture", process.execPath, writer, config], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const started = new Promise<void>((resolveStarted, reject) => {
    owner.stdout.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("STARTED")) resolveStarted();
    });
    owner.on("error", reject);
  });
  try {
    await started;
    const contender = execFileSync(
      "bash",
      ["-c", `${script}\n`, "fixture", process.execPath, writer, config],
      { input: "", encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
    );
    expect(contender).toContain("SOURCE_FREE");
    owner.stdin.end();
    await once(owner, "exit");
    const restarted = execFileSync(
      "bash",
      ["-c", script, "fixture", process.execPath, writer, config],
      { input: "", encoding: "utf8" },
    );
    expect(restarted).toContain("STARTED");
    expect(restarted).not.toContain("SOURCE_FREE");
  } finally {
    if (owner.exitCode === null) owner.kill();
  }
});

it("selects off before the first writer and rejects empty or invalid selectors without fixture or lock work", () => {
  const path = mkdtempSync(join(tmpdir(), "spur-test-source-selection-"));
  paths.push(path);
  const source = readFileSync(resolve("../scripts/spur-isolated-daemon.sh"), "utf8");
  const selectorStart = source.indexOf('ISOLATED_TELEGRAM="');
  const selector = source.slice(selectorStart, source.indexOf("\nTOOL_DIR=", selectorStart));
  const argumentStart = source.indexOf('if [[ "$ISOLATED_TELEGRAM" == off ]]');
  const argument = source.slice(argumentStart, source.indexOf("\nfi", argumentStart) + 3);
  const lockStart = source.indexOf("# Hold the bot lock");
  const boundary = source.slice(
    lockStart,
    source.indexOf("\n# Advertise only final configs", lockStart),
  );
  const calls = join(path, "calls.json");
  const loader = join(path, "loader");
  const lock = join(path, "bot.lock");
  const writer = join(path, "writer.cjs");
  writeFileSync(
    writer,
    `const fs=require('node:fs');const a=process.argv.slice(2);fs.writeFileSync(${JSON.stringify(calls)},JSON.stringify(a));const off=a.includes('--without-telegram');if(!off)fs.writeFileSync(${JSON.stringify(loader)},'fixture');const i=a.indexOf('--telegram-lock-output');if(i>=0)fs.writeFileSync(a[i+1],off?'':${JSON.stringify(lock)});`,
  );
  const script = `set -euo pipefail\n${selector}\nNODE_BIN="$1"\nWRITE_CONFIG_PATH="$2"\nCONFIG_DIR="$3"\nWRITE_CONFIG_ARGS=()\n${argument}\n${boundary}\n`;
  const run = (value: string | undefined): string =>
    execFileSync("bash", ["-c", script, "fixture", process.execPath, writer, path], {
      env: { ...process.env, SPUR_ISOLATED_TELEGRAM: value },
      encoding: "utf8",
      stdio: "pipe",
    });
  for (const invalid of ["", "other"]) {
    expect(() => run(invalid)).toThrow();
    expect(() => readFileSync(calls)).toThrow();
    expect(() => readFileSync(loader)).toThrow();
    expect(() => readFileSync(lock)).toThrow();
  }
  run("off");
  expect(JSON.parse(readFileSync(calls, "utf8"))).toContain("--without-telegram");
  expect(readFileSync(join(path, "telegram-lock"), "utf8")).toBe("");
  expect(() => readFileSync(loader)).toThrow();
  expect(() => readFileSync(lock)).toThrow();
  run(undefined);
  expect(JSON.parse(readFileSync(calls, "utf8"))).not.toContain("--without-telegram");
  expect(readFileSync(loader, "utf8")).toBe("fixture");
  expect(readFileSync(lock, "utf8")).toBe("");
});

it.for(["restart", "blocked"] as const)(
  "retains the TEST descriptor through %s until the tracked child and owner exit",
  async (mode, { signal }) => {
    const path = mkdtempSync(join(tmpdir(), "spur-test-owner-lease-"));
    paths.push(path);
    chmodSync(path, 0o700);
    const configPath = join(path, "config.yaml");
    writeFileSync(
      configPath,
      `server:\n  host: 127.0.0.1\n  port: 4999\ndataDir: ${path}/data\nworktreeDir: ${path}/worktrees\ntmux:\n  socketName: fixture\n`,
    );
    const childPath = join(path, "child.cjs");
    const infoPath = join(path, "info.json");
    const terminalMarker = join(path, "terminal-marker");
    const releasePath = join(path, "release-child");
    writeFileSync(
      childPath,
      `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(infoPath)},JSON.stringify({ok:true,apiVersion:${SPUR_DAEMON_API_VERSION},pid:process.pid,host:'127.0.0.1',port:4999,configPath:${JSON.stringify(configPath)},dataDir:${JSON.stringify(join(path, "data"))},tmuxSocketName:'fixture',lifecycleInstanceId:String(process.pid),version:'fixture',worktreeDir:'fixture',startedAt:'2026-01-01T00:00:00Z',uiPort:0,tags:[]}));${mode === "blocked" ? `process.on('SIGTERM',()=>fs.writeFileSync(${JSON.stringify(terminalMarker)},'owned fixture shutdown pending'));setInterval(()=>{if(fs.existsSync(${JSON.stringify(releasePath)}))process.exit(0);},25);` : "setInterval(()=>{},1000);"}`,
    );
    const ownerPath = join(path, "owner.mjs");
    writeFileSync(
      ownerPath,
      `import {readFile} from 'node:fs/promises';import {existsSync} from 'node:fs';import {serveIsolatedDaemon} from ${JSON.stringify(resolve("dist/isolated-daemon-owner.js"))};globalThis.fetch=async()=>{const info=JSON.parse(await readFile(${JSON.stringify(infoPath)},'utf8'));if(existsSync(${JSON.stringify(terminalMarker)}))info.lifecycleInstanceId='unconfirmed';return Response.json(info);};try{console.log('OWNER_GATE_ENTERED');await new Promise(resolve=>{process.stdin.once('data',resolve);process.stdin.once('end',resolve);process.stdin.resume();});process.stdin.pause();await serveIsolatedDaemon(${JSON.stringify({ configPath, cliPath: childPath, runtimePath: join(path, "runtime.env"), projectConfigPath: join(path, "project.yaml"), sourceWorktree: path })});}catch(error){console.error(error);process.exitCode=1;}`,
    );
    const lock = join(path, "bot.lock");
    const writer = join(path, "writer.cjs");
    writeFileSync(
      writer,
      `const fs=require('node:fs');const a=process.argv.slice(2);fs.writeFileSync(a[a.indexOf('--telegram-lock-output')+1],${JSON.stringify(lock)});`,
    );
    const source = readFileSync(resolve("../scripts/spur-isolated-daemon.sh"), "utf8");
    const start = source.indexOf("# Hold the bot lock");
    const boundary = source.slice(start, source.indexOf("\n# Advertise only final configs", start));
    const script = `set -euo pipefail\nNODE_BIN="$1"\nWRITE_CONFIG_PATH="$2"\nCONFIG_DIR="$3"\nWRITE_CONFIG_ARGS=()\n${boundary}\nexec "$NODE_BIN" "$4"\n`;
    const owner = spawn(
      "bash",
      ["-c", script, "fixture", process.execPath, writer, path, ownerPath],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let stderr = "";
    let spawnError: Error | undefined;
    owner.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-65_536);
    });
    let phase = "record absent";
    const startupDiagnostic = () =>
      `Owner startup: phase=${phase}, exit=${owner.exitCode}, signal=${owner.signalCode}, spawn=${spawnError?.message ?? "none"}\n${stderr}`;
    const exited = once(owner, "exit");
    void exited.catch(() => {});
    let resolveGate!: () => void;
    let rejectGate!: (error: Error) => void;
    let resolvePublication!: () => void;
    let rejectPublication!: (error: Error) => void;
    let gateSettled = false;
    let publicationSettled = false;
    const gateEntered = new Promise<void>((resolve, reject) => {
      resolveGate = resolve;
      rejectGate = reject;
    });
    const published = new Promise<void>((resolve, reject) => {
      resolvePublication = resolve;
      rejectPublication = reject;
    });
    void gateEntered.catch(() => {});
    void published.catch(() => {});
    let watcher: ReturnType<typeof watch> | undefined;
    const detach = () => {
      watcher?.close();
      owner.stdout.off("data", onStdout);
      owner.off("error", onError);
      owner.off("exit", onExit);
      signal.removeEventListener("abort", onAbort);
    };
    const fail = (cause: unknown) => {
      const error = new Error(startupDiagnostic(), { cause });
      if (!gateSettled) {
        gateSettled = true;
        rejectGate(error);
      }
      if (!publicationSettled) {
        publicationSettled = true;
        rejectPublication(error);
      }
      detach();
    };
    function onError(error: Error) {
      spawnError = error;
      fail(error);
    }
    function onExit() {
      fail(new Error("Owner exited before ready publication"));
    }
    function onAbort() {
      fail(signal.reason);
    }
    let stdout = "";
    function onStdout(chunk: Buffer) {
      stdout = (stdout + chunk.toString()).slice(-64);
      if (!gateSettled && stdout.includes("OWNER_GATE_ENTERED\n")) {
        gateSettled = true;
        resolveGate();
        if (publicationSettled) detach();
      }
    }
    const object = (value: unknown): value is Record<string, unknown> =>
      value !== null && typeof value === "object";
    const readPublication = () => {
      if (publicationSettled) return;
      try {
        const record: unknown = JSON.parse(readFileSync(join(path, "owner.json"), "utf8"));
        if (!object(record) || !object(record["owner"]) || record["owner"]["pid"] !== owner.pid)
          throw new Error("Unexpected owner publication");
        const daemon = record["daemon"];
        if (daemon === null) {
          phase = "daemon null";
          return;
        }
        if (
          !object(daemon) ||
          typeof daemon["pid"] !== "number" ||
          !Number.isSafeInteger(daemon["pid"]) ||
          daemon["pid"] <= 0 ||
          typeof daemon["starttime"] !== "number" ||
          !Number.isSafeInteger(daemon["starttime"]) ||
          daemon["starttime"] < 0 ||
          typeof daemon["lifecycleInstanceId"] !== "string" ||
          !daemon["lifecycleInstanceId"].trim()
        )
          throw new Error("Invalid daemon publication");
        phase = "record ready";
        publicationSettled = true;
        resolvePublication();
        if (gateSettled) detach();
      } catch (error) {
        if (object(error) && error["code"] === "ENOENT") {
          phase = "record absent";
          return;
        }
        fail(error);
      }
    };
    const releaseGate = () => {
      if (!owner.stdin.destroyed && !owner.stdin.writableEnded) owner.stdin.end("release\n");
    };
    const dispose = () => {
      if (!gateSettled || !publicationSettled) fail(new Error("Startup wait disposed"));
      detach();
      releaseGate();
    };
    owner.on("error", onError);
    owner.once("exit", onExit);
    owner.stdin.on("error", onError);
    owner.stdout.on("data", onStdout);
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      watcher = watch(path, (_event, filename) => {
        if (filename === null || filename.toString() === "owner.json") readPublication();
      });
      watcher.on("error", onError);
      if (signal.aborted) onAbort();
      else if (spawnError || owner.exitCode !== null || owner.signalCode !== null) onExit();
      else readPublication();
      await gateEntered;
      expect(existsSync(join(path, "owner.json"))).toBe(false);
      expect(publicationSettled).toBe(false);
      releaseGate();
      await published;
      const before = JSON.parse(readFileSync(join(path, "owner.json"), "utf8")) as {
        owner: { pid: number };
        daemon: { pid: number };
      };
      expect(before.owner.pid).toBe(owner.pid);
      expect(() => execFileSync("flock", ["-n", lock, "true"], { stdio: "pipe" })).toThrow();
      if (mode === "blocked") {
        await expect(requestIsolatedDaemon(configPath, "stop")).rejects.toThrow("stop_failed");
        expect(owner.exitCode).toBeNull();
        expect(await readLiveProcessStarttime(before.daemon.pid)).not.toBeNull();
        expect(() => execFileSync("flock", ["-n", lock, "true"], { stdio: "pipe" })).toThrow();
        writeFileSync(releasePath, "exit owned fixture");
        await exited;
        expect(owner.exitCode).toBe(1);
        expect(await readLiveProcessStarttime(before.daemon.pid)).toBeNull();
        execFileSync("flock", ["-n", lock, "true"]);
        return;
      }
      await requestIsolatedDaemon(configPath, "restart");
      const after = JSON.parse(readFileSync(join(path, "owner.json"), "utf8")) as {
        owner: { pid: number };
        daemon: { pid: number };
      };
      expect(after.owner.pid).toBe(before.owner.pid);
      expect(after.daemon.pid).not.toBe(before.daemon.pid);
      expect(() => execFileSync("flock", ["-n", lock, "true"], { stdio: "pipe" })).toThrow();
      await requestIsolatedDaemon(configPath, "stop");
      await exited;
      expect(owner.exitCode).toBe(0);
      execFileSync("flock", ["-n", lock, "true"]);
    } finally {
      dispose();
      writeFileSync(releasePath, "exit owned fixture");
      if (owner.exitCode === null && owner.signalCode === null) {
        owner.kill("SIGTERM");
        await exited;
      }
      owner.stdin.off("error", onError);
    }
  },
);
