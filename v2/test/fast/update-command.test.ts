import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as ChildProcess from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as HostInstall from "../../src/host-install.js";
import type * as ReleasesCache from "../../src/releases-cache.js";

const { getReleasesMock, runNpmInitMock } = vi.hoisted(() => ({
  getReleasesMock: vi.fn(),
  runNpmInitMock: vi.fn(),
}));

const execFileSyncCalls: { file: string; args: string[] }[] = [];
const spawnCalls: { file: string; args: string[] }[] = [];
let systemdRunAvailable = true;
let spawnUnrefCount = 0;

vi.mock("../../src/releases-cache.js", async () => {
  const actual = await vi.importActual<typeof ReleasesCache>("../../src/releases-cache.js");
  return { ...actual, getReleases: getReleasesMock };
});

vi.mock("../../src/host-install.js", async () => {
  const actual = await vi.importActual<typeof HostInstall>("../../src/host-install.js");
  return { ...actual, runNpmInit: runNpmInitMock };
});

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof ChildProcess>("node:child_process");
  return {
    ...actual,
    execFileSync: (file: string, args: string[]) => {
      execFileSyncCalls.push({ file, args: [...args] });
      if (file === "systemd-run" && !systemdRunAvailable) {
        throw new Error("systemd-run: command not found");
      }
      return "";
    },
    spawn: (file: string, args: string[]) => {
      spawnCalls.push({ file, args: [...args] });
      return {
        pid: 4321,
        unref: () => {
          spawnUnrefCount += 1;
        },
      };
    },
  };
});

import { createRealUpdateDeps, reinitUnits, runUpdate, type UpdateDeps } from "../../src/update.js";
import type { ProbeResult, ProbeTarget } from "../../src/update-health.js";
import type { RollbackState } from "../../src/update-state.js";

const EMPTY_STATE: RollbackState = { version: 1, lastKnownGood: null, inProgress: null };

interface RunFake {
  deps: UpdateDeps;
  events: string[];
  installLog: string[];
  state: () => RollbackState;
}

function buildRunFake(opts: {
  initialState: RollbackState;
  probe?: (target: ProbeTarget) => ProbeResult;
  currentVersion?: string;
  pidAlive?: boolean;
}): RunFake {
  let state = opts.initialState;
  const events: string[] = [];
  const installLog: string[] = [];
  const current = opts.currentVersion ?? "0.1.5";
  const deps: UpdateDeps = {
    now: () => 1_700_000_000_000,
    sleep: () => Promise.resolve(),
    probe: (target) => Promise.resolve(opts.probe?.(target) ?? { ok: true }),
    unitState: () => Promise.resolve("active"),
    installVersion: (target) => {
      installLog.push(target);
      events.push(`install:${target}`);
    },
    reinit: () => {
      events.push("reinit");
    },
    currentVersion: current,
    readInstalledVersion: () => current,
    readState: () => state,
    writeState: (next) => {
      state = next;
      events.push(`write:${next.inProgress?.phase ?? "cleared"}`);
    },
    readWebPort: () => 4311,
    readDaemonPort: () => 4310,
    launch: () => {
      events.push("launch");
      return { kind: "process", pid: 7 };
    },
    stopMonitor: () => {
      events.push("stop");
    },
    pidAlive: () => opts.pidAlive ?? false,
    unitActive: () => false,
    log: () => undefined,
  };
  return { deps, events, installLog, state: () => state };
}

function monitoringState(pid: number): RollbackState {
  return {
    version: 1,
    lastKnownGood: { version: "0.1.5", healthyAt: "2026-07-12T00:00:00.000Z" },
    inProgress: {
      fromVersion: "0.1.5",
      toVersion: "0.2.0",
      monitor: { kind: "process", pid },
      startedAt: "2026-07-12T00:00:00.000Z",
      phase: "monitoring",
    },
  };
}

describe("runUpdate", () => {
  beforeEach(() => {
    process.env["SPUR_UPDATE_FORCE"] = "1";
    execFileSyncCalls.length = 0;
    spawnCalls.length = 0;
    spawnUnrefCount = 0;
    systemdRunAvailable = true;
    getReleasesMock.mockReset();
    getReleasesMock.mockResolvedValue({
      entries: [{ tag: "0.2.0", publishedAt: "2026-07-12T00:00:00.000Z" }],
      stale: false,
      error: null,
    });
  });

  afterEach(() => {
    delete process.env["SPUR_UPDATE_FORCE"];
    vi.restoreAllMocks();
  });

  it("refuses on an unhealthy preflight and leaves state untouched", async () => {
    const fake = buildRunFake({
      initialState: EMPTY_STATE,
      probe: () => ({ ok: false, reason: "http-error" }),
    });
    await expect(runUpdate("/tmp/cli.js", {}, fake.deps)).rejects.toThrow("preflight");
    expect(fake.events).toEqual([]);
    expect(fake.installLog).toEqual([]);
  });

  it("proceeds under --force on an unhealthy host but does not overwrite lastKnownGood", async () => {
    const initial: RollbackState = {
      version: 1,
      lastKnownGood: { version: "0.1.0", healthyAt: "2026-01-01T00:00:00.000Z" },
      inProgress: null,
    };
    const fake = buildRunFake({
      initialState: initial,
      probe: () => ({ ok: false, reason: "http-error" }),
    });
    await runUpdate("/tmp/cli.js", { force: true }, fake.deps);
    expect(fake.installLog).toEqual(["latest"]);
    expect(fake.events).toContain("launch");
    expect(fake.state().lastKnownGood).toEqual({
      version: "0.1.0",
      healthyAt: "2026-01-01T00:00:00.000Z",
    });
    expect(fake.state().inProgress?.phase).toBe("monitoring");
  });

  it("on a healthy host records the anchor, installs, then launches the monitor in order", async () => {
    const fake = buildRunFake({ initialState: EMPTY_STATE });
    await runUpdate("/tmp/cli.js", {}, fake.deps);
    expect(fake.events).toEqual([
      "write:installing",
      "install:latest",
      "reinit",
      "launch",
      "write:monitoring",
    ]);
    expect(fake.state().lastKnownGood).toEqual({
      version: "0.1.5",
      healthyAt: expect.any(String),
    });
    expect(fake.state().inProgress?.monitor).toEqual({ kind: "process", pid: 7 });
  });

  it("refuses when a live in-progress monitor exists", async () => {
    const fake = buildRunFake({ initialState: monitoringState(9), pidAlive: true });
    await expect(runUpdate("/tmp/cli.js", {}, fake.deps)).rejects.toThrow("already running");
    expect(fake.installLog).toEqual([]);
  });

  it("supersedes a dead in-progress monitor without --force", async () => {
    const fake = buildRunFake({ initialState: monitoringState(9), pidAlive: false });
    await runUpdate("/tmp/cli.js", {}, fake.deps);
    expect(fake.events).not.toContain("stop");
    expect(fake.events).toContain("launch");
  });

  it("supersedes a live monitor under --force by stopping it first", async () => {
    const fake = buildRunFake({ initialState: monitoringState(9), pidAlive: true });
    await runUpdate("/tmp/cli.js", { force: true }, fake.deps);
    expect(fake.events).toContain("stop");
    expect(fake.events).toContain("launch");
  });

  it("rejects a pinned version that is not in the registry", async () => {
    getReleasesMock.mockResolvedValue({
      entries: [{ tag: "0.2.0", publishedAt: "2026-07-12T00:00:00.000Z" }],
      stale: false,
      error: null,
    });
    const fake = buildRunFake({ initialState: EMPTY_STATE });
    await expect(runUpdate("/tmp/cli.js", { version: "9.9.9" }, fake.deps)).rejects.toThrow(
      "not in registry",
    );
    expect(fake.events).toEqual([]);
  });

  it("accepts a pinned version that is in the registry", async () => {
    const fake = buildRunFake({ initialState: EMPTY_STATE });
    await runUpdate("/tmp/cli.js", { version: "0.2.0" }, fake.deps);
    expect(fake.installLog).toEqual(["0.2.0"]);
  });
});

describe("createRealUpdateDeps launch", () => {
  const originalHome = process.env["HOME"];

  beforeEach(() => {
    execFileSyncCalls.length = 0;
    spawnCalls.length = 0;
    spawnUnrefCount = 0;
    systemdRunAvailable = true;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = originalHome;
  });

  it("launches via systemd-run when it is available", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "spur-update-launch-"));
    const deps = createRealUpdateDeps("/tmp/cli.js", join(stateDir, "state.json"));
    const ref = deps.launch();
    expect(ref).toEqual({ kind: "systemd", unit: "spur-update-monitor.service" });
    expect(execFileSyncCalls.some((call) => call.file === "systemd-run")).toBe(true);
    expect(spawnCalls).toEqual([]);
  });

  it("falls back to a detached, unref'd spawn when systemd-run is absent", async () => {
    systemdRunAvailable = false;
    const home = await mkdtemp(join(tmpdir(), "spur-update-home-"));
    process.env["HOME"] = home;
    const deps = createRealUpdateDeps("/tmp/cli.js", join(home, "state.json"));
    const ref = deps.launch();
    expect(ref).toEqual({ kind: "process", pid: 4321 });
    expect(spawnUnrefCount).toBe(1);
    const monitorSpawn = spawnCalls.find((call) => call.args.includes("update-monitor"));
    expect(monitorSpawn).toBeDefined();
  });
});

describe("reinitUnits", () => {
  const originalHome = process.env["HOME"];

  beforeEach(() => {
    runNpmInitMock.mockReset();
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = originalHome;
  });

  it("preserves the deployed web port and external exposure when reinstalling units", async () => {
    const home = await mkdtemp(join(tmpdir(), "spur-update-reinit-"));
    const unitDir = join(home, ".config", "systemd", "user");
    await mkdir(unitDir, { recursive: true });
    await writeFile(
      join(unitDir, "spur-daemon.service"),
      "[Service]\nExecStart=/usr/bin/node cli.js\n",
      "utf-8",
    );
    await writeFile(
      join(unitDir, "spur-web.service"),
      "[Service]\nEnvironment=PORT=6200\nEnvironment=WEB_HOST=0.0.0.0\n",
      "utf-8",
    );
    process.env["HOME"] = home;

    reinitUnits("/tmp/cli.js");

    expect(runNpmInitMock).toHaveBeenCalledWith("/tmp/cli.js", {
      webPort: "6200",
      exposeWeb: true,
      tailscale: false,
    });
  });

  it("defaults to loopback:4311 when the web unit carries no overrides", async () => {
    const home = await mkdtemp(join(tmpdir(), "spur-update-reinit-"));
    const unitDir = join(home, ".config", "systemd", "user");
    await mkdir(unitDir, { recursive: true });
    await writeFile(
      join(unitDir, "spur-daemon.service"),
      "[Service]\nExecStart=/usr/bin/node cli.js\n",
      "utf-8",
    );
    await writeFile(
      join(unitDir, "spur-web.service"),
      "[Service]\nExecStart=/usr/bin/node server.js\n",
      "utf-8",
    );
    process.env["HOME"] = home;

    reinitUnits("/tmp/cli.js");

    expect(runNpmInitMock).toHaveBeenCalledWith("/tmp/cli.js", {
      webPort: "4311",
      exposeWeb: false,
      tailscale: false,
    });
  });

  it("re-applies --tailscale when the live unit already carries a Tailscale bind", async () => {
    const home = await mkdtemp(join(tmpdir(), "spur-update-reinit-"));
    const unitDir = join(home, ".config", "systemd", "user");
    await mkdir(unitDir, { recursive: true });
    await writeFile(
      join(unitDir, "spur-daemon.service"),
      "[Service]\nExecStart=/usr/bin/node cli.js\n",
      "utf-8",
    );
    await writeFile(
      join(unitDir, "spur-web.service"),
      "[Service]\nEnvironment=PORT=4311\nEnvironment=WEB_HOST=127.0.0.1,100.64.0.1\n",
      "utf-8",
    );
    process.env["HOME"] = home;

    reinitUnits("/tmp/cli.js");

    expect(runNpmInitMock).toHaveBeenCalledWith("/tmp/cli.js", {
      webPort: "4311",
      exposeWeb: false,
      tailscale: true,
    });
  });
});

describe("createRealUpdateDeps reinit delegation", () => {
  const originalHome = process.env["HOME"];

  beforeEach(() => {
    runNpmInitMock.mockReset();
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = originalHome;
  });

  it("routes the reinit dep through the shared reinitUnits function", async () => {
    const home = await mkdtemp(join(tmpdir(), "spur-update-reinit-"));
    const unitDir = join(home, ".config", "systemd", "user");
    await mkdir(unitDir, { recursive: true });
    await writeFile(
      join(unitDir, "spur-daemon.service"),
      "[Service]\nExecStart=/usr/bin/node cli.js\n",
      "utf-8",
    );
    await writeFile(
      join(unitDir, "spur-web.service"),
      "[Service]\nEnvironment=PORT=6200\nEnvironment=WEB_HOST=0.0.0.0\n",
      "utf-8",
    );
    process.env["HOME"] = home;

    const deps = createRealUpdateDeps("/tmp/cli.js", join(home, "state.json"));
    deps.reinit();

    expect(runNpmInitMock).toHaveBeenCalledOnce();
    expect(runNpmInitMock).toHaveBeenCalledWith("/tmp/cli.js", {
      webPort: "6200",
      exposeWeb: true,
      tailscale: false,
    });
  });
});
