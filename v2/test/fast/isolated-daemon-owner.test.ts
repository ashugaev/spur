import { createConnection, createServer, type Socket } from "node:net";
import { chmod, copyFile, lstat, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import type * as Cp from "node:child_process";
import type * as Timers from "node:timers/promises";
import type * as Reaper from "../../src/sidecars/reap.js";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requestIsolatedDaemon, serveIsolatedDaemon } from "../../src/isolated-daemon-owner.js";
import { readLiveProcessStarttime } from "../../src/sidecars/reap.js";
import type { IsolatedDaemonCandidate } from "../../src/isolated-web-endpoint.js";
import type * as Endpoint from "../../src/isolated-web-endpoint.js";
import type * as Fs from "node:fs/promises";
import { SPUR_DAEMON_API_VERSION } from "../../src/types.js";

const controls = vi.hoisted(() => ({
  ready: true,
  gate: null as Promise<void> | null,
  identityGate: null as Promise<void> | null,
  identityPid: 0,
  identityExcludedPid: 0,
  runtimeGate: null as Promise<void> | null,
  runtimeWaiting: false,
  latestPid: 0,
  fakeChild: null as Cp.ChildProcess | null,
  identities: new Map<number, number | null>(),
  snapshot: null as Reaper.ProcSnapshot | null,
  fastDelay: false,
  changedLifecycle: false,
}));
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof Cp>();
  return {
    ...original,
    spawn: (...args: Parameters<typeof Cp.spawn>) => controls.fakeChild ?? original.spawn(...args),
  };
});
vi.mock("node:timers/promises", async (importOriginal) => {
  const original = await importOriginal<typeof Timers>();
  return {
    ...original,
    setTimeout: (...args: Parameters<typeof Timers.setTimeout>) =>
      controls.fastDelay ? Promise.resolve(args[1]) : original.setTimeout(...args),
  };
});
vi.mock("../../src/sidecars/reap.js", async (importOriginal) => {
  const original = await importOriginal<typeof Reaper>();
  return {
    ...original,
    snapshotProcesses: () =>
      controls.snapshot ? Promise.resolve(controls.snapshot) : original.snapshotProcesses(),
  };
});
vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof Fs>();
  return {
    ...original,
    rename: async (from: Parameters<typeof Fs.rename>[0], to: Parameters<typeof Fs.rename>[1]) => {
      if (typeof to === "string" && to.endsWith("/runtime.env") && controls.runtimeGate) {
        controls.runtimeWaiting = true;
        await controls.runtimeGate;
      }
      return original.rename(from, to);
    },
    link: async (from: Parameters<typeof Fs.link>[0], to: Parameters<typeof Fs.link>[1]) => {
      if (typeof to === "string" && to.endsWith("/runtime.env") && controls.runtimeGate) {
        controls.runtimeWaiting = true;
        await controls.runtimeGate;
      }
      return original.link(from, to);
    },
  };
});
vi.mock("../../src/isolated-web-endpoint.js", async (importOriginal) => {
  const original = await importOriginal<typeof Endpoint>();
  return {
    ...original,
    captureIsolatedDaemonStarttime: async (pid: number) => {
      const result = controls.identities.has(pid)
        ? (controls.identities.get(pid) ?? null)
        : await original.captureIsolatedDaemonStarttime(pid);
      if (pid !== process.pid && pid !== controls.identityExcludedPid && controls.identityGate) {
        controls.identityPid = pid;
        await controls.identityGate;
      }
      return result;
    },
    readIsolatedDaemonReady: async (
      candidate: IsolatedDaemonCandidate,
      expectedLifecycle?: string,
    ) => {
      controls.latestPid = candidate.pid;
      await controls.gate;
      if (!controls.ready) return null;
      return {
        ok: true,
        apiVersion: SPUR_DAEMON_API_VERSION,
        pid: candidate.pid,
        host: "127.0.0.1",
        port: 4999,
        configPath: candidate.configPath,
        dataDir: candidate.dataDir,
        tmuxSocketName: candidate.socketName,
        lifecycleInstanceId:
          expectedLifecycle && controls.changedLifecycle ? "changed" : `fixture-${candidate.pid}-λ`,
        version: "fixture",
        worktreeDir: "fixture",
        uiPort: 0,
        startedAt: "2026-01-01T00:00:00Z",
        tags: [{ name: "fixture", description: "x".repeat(5000) }],
      };
    },
  };
});

interface RecordFixture {
  version: 1;
  configPath: string;
  controlPath: string;
  owner: { pid: number; starttime: number };
  daemon: { pid: number; starttime: number; lifecycleInstanceId: string } | null;
}
const fixtures: Array<{ directory: string; configPath: string; done: Promise<void> }> = [];
afterEach(async () => {
  controls.gate = null;
  controls.ready = true;
  controls.identityGate = null;
  controls.identityPid = 0;
  controls.identityExcludedPid = 0;
  controls.runtimeGate = null;
  controls.runtimeWaiting = false;
  controls.latestPid = 0;
  for (const fixture of fixtures.splice(0)) {
    await requestIsolatedDaemon(fixture.configPath, "stop").catch(() => undefined);
    await fixture.done.catch(() => undefined);
    await rm(fixture.directory, { recursive: true, force: true });
  }
  controls.fakeChild = null;
  controls.identities.clear();
  controls.snapshot = null;
  controls.fastDelay = false;
  controls.changedLifecycle = false;
});

class FakeChild extends EventEmitter {
  readonly pid = 510001;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  exitOnTerm = false;
  exitOnKill = true;
  killAccepted = true;
  readonly kill = vi.fn((signal: NodeJS.Signals) => {
    if (!this.killAccepted) return false;
    if ((signal === "SIGTERM" && this.exitOnTerm) || (signal === "SIGKILL" && this.exitOnKill))
      this.exit(signal);
    return true;
  });
  exit(signal: NodeJS.Signals = "SIGTERM"): void {
    this.signalCode = signal;
    controls.identities.set(this.pid, null);
    this.emit("exit", null, signal);
  }
}
function fakeSnapshot(child: FakeChild, descendants: number[] = []): Reaper.ProcSnapshot {
  const root: Reaper.ProcessInfo = {
    pid: child.pid,
    ppid: process.pid,
    pgid: child.pid,
    rssKb: 0,
    etimes: 0,
    args: "owned fixture",
  };
  return {
    ok: true,
    byPid: new Map([
      [root.pid, root],
      ...descendants.map((pid): [number, Reaper.ProcessInfo] => [
        pid,
        { ...root, pid, ppid: root.pid },
      ]),
    ]),
    byPgid: new Map(),
  };
}
function prepareFake(): FakeChild {
  const child = new FakeChild();
  controls.fakeChild = child as unknown as Cp.ChildProcess;
  controls.identities.set(child.pid, 100);
  controls.snapshot = fakeSnapshot(child);
  controls.fastDelay = true;
  return child;
}

async function launch(
  childCode = "setInterval(()=>{},1000);\n",
): Promise<(typeof fixtures)[number]> {
  const directory = await mkdtemp(join(tmpdir(), "spur-owner-test-"));
  await chmod(directory, 0o700);
  const configPath = join(directory, "config.yaml");
  await writeFile(
    configPath,
    `server:\n  host: 127.0.0.1\n  port: 4999\ndataDir: ${directory}/data\nworktreeDir: ${directory}/worktrees\ntmux:\n  socketName: fixture\n`,
  );
  const cliPath = join(directory, "child.cjs");
  await writeFile(cliPath, childCode);
  const done = serveIsolatedDaemon({
    configPath,
    cliPath,
    runtimePath: join(directory, "runtime.env"),
    projectConfigPath: join(directory, "project.yaml"),
    sourceWorktree: directory,
  });
  // Retain rejection immediately so failed startup never becomes unhandled.
  void done.catch(() => undefined);
  const fixture = { directory, configPath, done };
  fixtures.push(fixture);
  await expect.poll(async () => (await record(fixture)).daemon).not.toBeNull();
  await expect
    .poll(() => readFile(join(directory, "runtime.env"), "utf8"))
    .toContain("SPUR_ISOLATED_DAEMON_PID=");
  return fixture;
}
async function record(fixture: { directory: string }): Promise<RecordFixture> {
  return JSON.parse(await readFile(join(fixture.directory, "owner.json"), "utf8")) as RecordFixture;
}
async function raw(
  controlPath: string,
  chunks: Array<string | Buffer>,
): Promise<Record<string, unknown>> {
  const socket = createConnection({ path: controlPath, allowHalfOpen: true });
  const response = new Promise<string>((resolve, reject) => {
    let text = "";
    socket.on("data", (chunk: Buffer) => {
      text += chunk.toString();
    });
    socket.on("end", () => resolve(text));
    socket.on("error", reject);
  });
  socket.on("connect", () => {
    for (const chunk of chunks) socket.write(chunk);
    socket.end();
  });
  try {
    return JSON.parse(await response) as Record<string, unknown>;
  } finally {
    socket.destroy();
  }
}

describe("isolated owner control", () => {
  it("confirms graceful exit without escalation, and permits exact terminal escalation only with current ownership and an empty accounted tree", async () => {
    for (const graceful of [true, false]) {
      const child = prepareFake();
      child.exitOnTerm = graceful;
      const fixture = await launch();
      await expect(requestIsolatedDaemon(fixture.configPath, "stop")).resolves.toMatchObject({
        stopped: true,
        pid: child.pid,
      });
      await fixture.done;
      expect(child.kill.mock.calls.map(([signal]) => signal)).toEqual(
        graceful ? ["SIGTERM"] : ["SIGTERM", "SIGKILL"],
      );
      expect(child.signalCode).toBe(graceful ? "SIGTERM" : "SIGKILL");
    }
  });

  it.each([
    "generation",
    "ownership",
    "pid reuse",
    "unreadable identity",
    "descendants",
    "signal failure",
    "exit unconfirmed",
  ])(
    "retains the owner after terminal %s uncertainty until the tracked child exits",
    async (boundary) => {
      const child = prepareFake();
      const fixture = await launch();
      const before = await record(fixture);
      if (boundary === "generation") controls.changedLifecycle = true;
      if (boundary === "ownership")
        controls.snapshot = { ok: false, byPid: new Map(), byPgid: new Map() };
      if (boundary === "pid reuse") controls.identities.set(child.pid, 101);
      if (boundary === "unreadable identity") controls.identities.set(child.pid, null);
      if (boundary === "descendants") {
        controls.snapshot = fakeSnapshot(child, [510002]);
        controls.identities.set(510002, 100);
      }
      if (boundary === "signal failure") child.killAccepted = false;
      if (boundary === "exit unconfirmed") child.exitOnKill = false;
      let finalized = false;
      void fixture.done.then(
        () => {
          finalized = true;
        },
        () => {
          finalized = true;
        },
      );
      try {
        expect(
          await raw(before.controlPath, [
            JSON.stringify({ version: 1, operation: "stop", owner: before.owner }) + "\n",
          ]),
        ).toMatchObject({ ok: false, error: { code: "stop_failed" } });
        expect(finalized).toBe(false);
        expect(child.exitCode).toBeNull();
        expect(child.signalCode).toBeNull();
        expect((await record(fixture)).daemon).toBeNull();
        if (boundary !== "signal failure" && boundary !== "exit unconfirmed")
          expect(child.kill.mock.calls.map(([signal]) => signal)).not.toContain("SIGKILL");
        if (boundary === "pid reuse" || boundary === "unreadable identity")
          expect(child.kill).not.toHaveBeenCalled();
        child.exit();
        await expect(fixture.done).rejects.toThrow();
        expect(finalized).toBe(true);
      } finally {
        if (child.signalCode === null) child.exit();
      }
    },
  );

  it("keeps a failed restart unready without replacement or terminal escalation, then accepts an explicit terminal stop", async () => {
    const child = prepareFake();
    const fixture = await launch();
    const before = await record(fixture);
    const message =
      JSON.stringify({
        version: 1,
        operation: "restart",
        owner: before.owner,
        daemon: before.daemon,
      }) + "\n";
    try {
      expect(await raw(before.controlPath, [message])).toMatchObject({
        ok: false,
        error: { code: "stop_failed" },
      });
      expect(child.kill.mock.calls.map(([signal]) => signal)).toEqual(["SIGTERM"]);
      expect((await record(fixture)).daemon).toBeNull();
      expect(await raw(before.controlPath, [message])).toMatchObject({
        ok: false,
        error: { code: "stop_failed" },
      });
      expect(child.kill).toHaveBeenCalledTimes(1);
      await expect(requestIsolatedDaemon(fixture.configPath, "stop")).resolves.toMatchObject({
        stopped: true,
      });
      await fixture.done;
      expect(child.kill.mock.calls.map(([signal]) => signal)).toEqual([
        "SIGTERM",
        "SIGTERM",
        "SIGKILL",
      ]);
    } finally {
      if (child.signalCode === null) child.exit();
    }
  });
  it("checks known platform UTF-8 pathname budgets without compiled imports or new other-host rejection", async () => {
    const directory = await mkdtemp(join(tmpdir(), "spur-owner-preflight-"));
    const entry = join(directory, "owner.mjs");
    await copyFile(resolve("bin/isolated-daemon-owner.mjs"), entry);
    const check = (path: string, platform: string): string =>
      execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          "const {checkIsolatedSocketPath}=await import(process.argv[2]);try{checkIsolatedSocketPath(process.argv[3],process.argv[4]);console.log('ACCEPT');}catch(error){console.log(error.message);}",
          "fixture",
          entry,
          path,
          platform,
        ],
        { encoding: "utf8" },
      );
    const pathname = (bytes: number): string => "/" + "a".repeat(bytes - 12) + "/owner.sock";
    try {
      for (const [platform, capacity] of [
        ["linux", 107],
        ["darwin", 103],
      ] as const) {
        expect(check(pathname(capacity - 1), platform)).toBe("ACCEPT\n");
        expect(check(pathname(capacity), platform)).toBe("ACCEPT\n");
        expect(check(pathname(capacity + 1), platform)).toContain(`${capacity} UTF-8 bytes`);
        const multibyte = pathname(capacity).replace("a", "λ");
        expect(multibyte.length).toBe(pathname(capacity).length);
        expect(check(multibyte, platform)).toContain(`${capacity} UTF-8 bytes`);
      }
      expect(check(pathname(20), "freebsd")).toBe("ACCEPT\n");
      expect(check(pathname(300), "freebsd")).toBe("ACCEPT\n");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("joins a pending ready snapshot rename before terminal stop, with no late snapshot or successful restart", async () => {
    const fixture = await launch();
    const before = await record(fixture);
    let release!: () => void;
    controls.runtimeGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const restarting = requestIsolatedDaemon(fixture.configPath, "restart");
    void restarting.catch(() => undefined);
    let stopping: ReturnType<typeof requestIsolatedDaemon> | undefined;
    try {
      await expect.poll(() => controls.runtimeWaiting).toBe(true);
      const replacementPid = controls.latestPid;
      stopping = requestIsolatedDaemon(fixture.configPath, "stop");
      let stopped = false;
      void stopping.then(
        () => {
          stopped = true;
        },
        () => undefined,
      );
      await expect
        .poll(() =>
          lstat(before.controlPath).then(
            () => true,
            () => false,
          ),
        )
        .toBe(false);
      // A read of the held publication's live child follows accepted terminal admission.
      expect(await readLiveProcessStarttime(replacementPid)).not.toBeNull();
      expect(stopped).toBe(false);
      release();
      await expect(stopping).resolves.toMatchObject({ stopped: true });
      await expect(restarting).rejects.toThrow(/stopping|UNCONFIRMED/);
      await fixture.done;
      await expect(readFile(join(fixture.directory, "runtime.env"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await readLiveProcessStarttime(replacementPid)).toBeNull();
    } finally {
      release();
      await Promise.allSettled([restarting, ...(stopping ? [stopping] : [])]);
    }
  });
  it.each(["restart", "stop"] as const)(
    "preserves a successor runtime snapshot while cleaning its own child after %s fails",
    async (operation) => {
      const fixture = await launch();
      const before = await record(fixture);
      if (!before.daemon) throw new Error("Missing fixture daemon");
      const replacement = join(fixture.directory, "successor.env");
      await writeFile(replacement, "FOREIGN_SUCCESSOR=retained\n", { mode: 0o600 });
      const { rename } = await import("node:fs/promises");
      await rename(replacement, join(fixture.directory, "runtime.env"));
      const successor = await lstat(join(fixture.directory, "runtime.env"));
      await expect(requestIsolatedDaemon(fixture.configPath, operation)).rejects.toThrow(
        operation === "restart" ? "start_failed" : "stop_failed",
      );
      await expect(fixture.done).rejects.toThrow("changed owner");
      expect(await readLiveProcessStarttime(before.daemon.pid)).toBeNull();
      expect(await readFile(join(fixture.directory, "runtime.env"), "utf8")).toBe(
        "FOREIGN_SUCCESSOR=retained\n",
      );
      expect((await lstat(join(fixture.directory, "runtime.env"))).ino).toBe(successor.ino);
    },
  );
  it.each(["public host", "foreign data", "unsafe store", "production port"])(
    "rejects %s before spawning a child",
    async (boundary) => {
      const fixture = await launch();
      await requestIsolatedDaemon(fixture.configPath, "stop");
      await fixture.done;
      await unlink(join(fixture.directory, "owner.json"));
      const cliPath = join(fixture.directory, "child.cjs");
      const marker = join(fixture.directory, "unexpected-child");
      await writeFile(
        cliPath,
        `require('node:fs').writeFileSync(${JSON.stringify(marker)},'spawned');setInterval(()=>{},1000);`,
      );
      const config = await readFile(fixture.configPath, "utf8");
      if (boundary === "public host")
        await writeFile(fixture.configPath, config.replace("host: 127.0.0.1", "host: 0.0.0.0"));
      if (boundary === "foreign data")
        await writeFile(
          fixture.configPath,
          config.replace(
            `dataDir: ${fixture.directory}/data`,
            `dataDir: ${fixture.directory}/foreign-data`,
          ),
        );
      if (boundary === "unsafe store") await chmod(fixture.directory, 0o755);
      if (boundary === "production port")
        await writeFile(fixture.configPath, config.replace("port: 4999", "port: 4310"));
      await expect(
        serveIsolatedDaemon({
          configPath: fixture.configPath,
          cliPath,
          runtimePath: join(fixture.directory, "runtime.env"),
          projectConfigPath: join(fixture.directory, "project.yaml"),
          sourceWorktree: fixture.directory,
        }),
      ).rejects.toThrow(/Invalid|Unsafe|production slot/);
      await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(lstat(join(fixture.directory, "owner.sock"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await chmod(fixture.directory, 0o700);
    },
  );
  it("reports malformed, truncated and stalled responses as UNCONFIRMED without replay; retains confirmed rejection", async () => {
    const fixture = await launch();
    const before = await record(fixture);
    await requestIsolatedDaemon(fixture.configPath, "stop");
    await fixture.done;
    let response = "";
    let requests = 0;
    let received: (() => void) | undefined;
    const sockets = new Set<Socket>();
    const server = createServer({ allowHalfOpen: true }, (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("data", () => undefined);
      socket.on("end", () => {
        requests++;
        received?.();
        if (response !== "stall") socket.end(response);
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(before.controlPath, resolve);
    });
    await chmod(before.controlPath, 0o600);
    await writeFile(
      join(fixture.directory, "owner.json"),
      JSON.stringify({ ...before, daemon: { ...before.owner, lifecycleInstanceId: "fixture" } }),
      { mode: 0o600 },
    );
    try {
      const success = JSON.stringify({ ok: true, result: { baseUrl: "fixture", restarted: true } });
      for (const invalid of [
        "{bad}\n",
        success,
        `${success}\n{}\n`,
        `${success}\ntrailing`,
        JSON.stringify({ ok: false, error: { code: "unknown", message: "unknown" } }) + "\n",
        JSON.stringify({ ok: false, error: { code: "busy", message: "busy" }, extra: true }) + "\n",
        JSON.stringify({
          ok: true,
          result: { baseUrl: "fixture", restarted: true, previousPid: "bad" },
        }) + "\n",
        JSON.stringify({ ok: true, result: { baseUrl: "fixture", restarted: true, runtime: {} } }) +
          "\n",
      ]) {
        response = invalid;
        const count = requests;
        await expect(requestIsolatedDaemon(fixture.configPath, "restart")).rejects.toThrow(
          "UNCONFIRMED",
        );
        expect(requests).toBe(count + 1);
      }
      response =
        JSON.stringify({ ok: false, error: { code: "busy", message: "Restart in progress" } }) +
        "\n";
      await expect(requestIsolatedDaemon(fixture.configPath, "restart")).rejects.toThrow(
        "busy: Restart in progress",
      );
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      response = "stall";
      const arrived = new Promise<void>((resolve) => {
        received = resolve;
      });
      const pending = requestIsolatedDaemon(fixture.configPath, "restart");
      void pending.catch(() => undefined);
      await arrived;
      const count = requests;
      await vi.advanceTimersByTimeAsync(45_000);
      await expect(pending).rejects.toThrow("UNCONFIRMED");
      expect(requests).toBe(count);
    } finally {
      vi.useRealTimers();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  it("preserves a dummy native-client descendant across restart and terminal owner stop", async () => {
    const code = `const fs=require('node:fs');const path=require('node:path');const pidFile=path.join(__dirname,'native.pid');if(!fs.existsSync(pidFile)){const client=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:false,stdio:'ignore'});fs.writeFileSync(pidFile,String(client.pid));client.unref();}setInterval(()=>{},1000);`;
    const fixture = await launch(code);
    await expect
      .poll(async () => Number(await readFile(join(fixture.directory, "native.pid"), "utf8")))
      .toBeGreaterThan(0);
    const nativePid = Number(await readFile(join(fixture.directory, "native.pid"), "utf8"));
    const nativeStarttime = await readLiveProcessStarttime(nativePid);
    try {
      expect(nativeStarttime).not.toBeNull();
      await requestIsolatedDaemon(fixture.configPath, "restart");
      expect(await readLiveProcessStarttime(nativePid)).toBe(nativeStarttime);
      await requestIsolatedDaemon(fixture.configPath, "stop");
      await fixture.done;
      expect(await readLiveProcessStarttime(nativePid)).toBe(nativeStarttime);
    } finally {
      if (
        nativeStarttime !== null &&
        (await readLiveProcessStarttime(nativePid)) === nativeStarttime
      )
        process.kill(nativePid, "SIGTERM");
      await expect.poll(() => readLiveProcessStarttime(nativePid)).toBeNull();
    }
  });
  it("joins identity acquisition before terminal stop can succeed", async () => {
    const fixture = await launch();
    const before = await record(fixture);
    if (!before.daemon) throw new Error("Missing old child");
    controls.identityExcludedPid = before.daemon.pid;
    let release!: () => void;
    controls.identityGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const restarting = requestIsolatedDaemon(fixture.configPath, "restart");
    void restarting.catch(() => undefined);
    await expect.poll(() => controls.identityPid).toBeGreaterThan(0);
    const replacementPid = controls.identityPid;
    const stopping = requestIsolatedDaemon(fixture.configPath, "stop");
    let stopped = false;
    void stopping.then(
      () => {
        stopped = true;
      },
      () => undefined,
    );
    await expect
      .poll(() =>
        lstat(before.controlPath).then(
          () => true,
          () => false,
        ),
      )
      .toBe(false);
    expect(stopped).toBe(false);
    release();
    await expect(stopping).resolves.toMatchObject({ stopped: true });
    await expect(restarting).rejects.toThrow(/stopping|UNCONFIRMED/);
    await fixture.done;
    expect(await readLiveProcessStarttime(replacementPid)).toBeNull();
    if (!before.daemon) throw new Error("Missing old child");
    expect(await readLiveProcessStarttime(before.daemon.pid)).toBeNull();
  });

  it("does not relaunch a crashed child", async () => {
    const fixture = await launch();
    const before = await record(fixture);
    if (!before.daemon) throw new Error("Missing child");
    expect(await readLiveProcessStarttime(before.daemon.pid)).toBe(before.daemon.starttime);
    process.kill(before.daemon.pid, "SIGTERM");
    await expect(fixture.done).rejects.toThrow("Owned descendant teardown unconfirmed");
    expect((await record(fixture)).daemon).toBeNull();
    expect(await readLiveProcessStarttime(before.daemon.pid)).toBeNull();
  });

  it("replaces only the tracked nondetached child, retains store bytes and returns a full large response", async () => {
    const fixture = await launch();
    const before = await record(fixture);
    if (!before.daemon) throw new Error("Missing fixture daemon");
    const data = join(fixture.directory, "session-state");
    await writeFile(data, "retained-session-and-poll-registry");
    const result = await requestIsolatedDaemon(fixture.configPath, "restart");
    expect(result).toMatchObject({ restarted: true, previousPid: before.daemon.pid });
    const after = await record(fixture);
    expect(after.owner).toEqual(before.owner);
    expect(after.daemon?.pid).not.toBe(before.daemon.pid);
    expect(after.daemon?.lifecycleInstanceId).not.toBe(before.daemon.lifecycleInstanceId);
    expect(await readLiveProcessStarttime(before.daemon.pid)).toBeNull();
    expect(await readFile(data, "utf8")).toBe("retained-session-and-poll-registry");
    expect(JSON.stringify(result).length).toBeGreaterThan(4096);
    expect(await readFile(join(fixture.directory, "runtime.env"), "utf8")).toContain(
      `SPUR_ISOLATED_DAEMON_PID='${after.daemon?.pid}'`,
    );
    const stopped = await requestIsolatedDaemon(fixture.configPath, "stop");
    expect(stopped).toMatchObject({ stopped: true, pid: after.daemon?.pid });
    await fixture.done;
    if (!after.daemon) throw new Error("Missing replacement");
    expect(await readLiveProcessStarttime(after.daemon.pid)).toBeNull();
  });

  it("waits for EOF, rejects malformed, oversized and second frames without changing generation", async () => {
    const fixture = await launch();
    const before = await record(fixture);
    const message = JSON.stringify({
      version: 1,
      operation: "restart",
      owner: before.owner,
      daemon: before.daemon,
    });
    const socket = createConnection({ path: before.controlPath, allowHalfOpen: true });
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    socket.write(`${message}\n`);
    // A completed unrelated request proves the server ran while this frame lacked EOF.
    expect(await raw(before.controlPath, ["{}\n"])).toMatchObject({
      ok: false,
      error: { code: "invalid_request" },
    });
    expect((await record(fixture)).daemon).toEqual(before.daemon);
    for (const frame of [
      "{}",
      "{bad}\n",
      "{}\n{}\n",
      `${message}${" ".repeat(4097 - Buffer.byteLength(message) - 1)}\n`,
    ]) {
      expect(await raw(before.controlPath, [frame])).toMatchObject({
        ok: false,
        error: { code: "invalid_request" },
      });
    }
    expect((await record(fixture)).daemon).toEqual(before.daemon);
    const bytes = Buffer.from(message);
    const split = bytes.indexOf(Buffer.from("λ")) + 1;
    expect(
      await raw(before.controlPath, [
        bytes.subarray(0, split),
        bytes.subarray(split),
        " ".repeat(4096 - bytes.length - 1),
        "\n",
      ]),
    ).toMatchObject({ ok: true, result: { restarted: true } });
    expect(await raw(before.controlPath, [`${message}\n`])).toMatchObject({
      ok: false,
      error: { code: "generation_mismatch" },
    });
    socket.destroy();
  });

  it("rejects a concurrent restart as busy and terminal stop preempts readiness without publishing a replacement", async () => {
    const fixture = await launch();
    const before = await record(fixture);
    let release!: () => void;
    controls.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = requestIsolatedDaemon(fixture.configPath, "restart");
    void first.catch(() => undefined);
    await expect.poll(async () => (await record(fixture)).daemon).toBeNull();
    await expect(readFile(join(fixture.directory, "runtime.env"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    const stale = { version: 1, operation: "restart", owner: before.owner, daemon: before.daemon };
    expect(await raw(before.controlPath, [`${JSON.stringify(stale)}\n`])).toMatchObject({
      ok: false,
      error: { code: "busy" },
    });
    const stopped = await requestIsolatedDaemon(fixture.configPath, "stop");
    expect(stopped).toMatchObject({ stopped: true });
    release();
    await expect(first).rejects.toThrow(/stopping|UNCONFIRMED/);
    await fixture.done;
    expect((await record(fixture)).daemon).toBeNull();
  });

  it("rejects stale owner and child identities without mutation, and preserves a successor owner record on terminal cleanup", async () => {
    const fixture = await launch();
    const before = await record(fixture);
    if (!before.daemon) throw new Error("Missing daemon");
    const wrongOwner = {
      version: 1,
      operation: "stop",
      owner: { ...before.owner, starttime: before.owner.starttime + 1 },
    };
    expect(await raw(before.controlPath, [`${JSON.stringify(wrongOwner)}\n`])).toMatchObject({
      ok: false,
      error: { code: "owner_mismatch" },
    });
    const wrongChild = {
      version: 1,
      operation: "restart",
      owner: before.owner,
      daemon: { ...before.daemon, starttime: before.daemon.starttime + 1 },
    };
    expect(await raw(before.controlPath, [`${JSON.stringify(wrongChild)}\n`])).toMatchObject({
      ok: false,
      error: { code: "generation_mismatch" },
    });
    expect((await record(fixture)).daemon).toEqual(before.daemon);
    const successor = join(fixture.directory, "successor.json");
    const successorBytes = JSON.stringify({
      ...before,
      owner: { ...before.owner, starttime: before.owner.starttime + 1 },
    });
    await writeFile(successor, successorBytes, { mode: 0o600 });
    const { rename } = await import("node:fs/promises");
    await rename(successor, join(fixture.directory, "owner.json"));
    expect(
      await raw(before.controlPath, [
        `${JSON.stringify({ version: 1, operation: "stop", owner: before.owner })}\n`,
      ]),
    ).toMatchObject({ ok: false, error: { code: "stop_failed" } });
    await expect(fixture.done).rejects.toThrow(/changed owner/);
    expect(await readFile(join(fixture.directory, "owner.json"), "utf8")).toBe(successorBytes);
    expect(await readLiveProcessStarttime(before.daemon.pid)).toBeNull();
  });
});
