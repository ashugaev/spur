import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as ChildProcess from "node:child_process";
import type * as FsModule from "node:fs";
import type * as OsModule from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as CacheRetentionModule from "../../src/cache-retention.js";
import type * as HostSkillsModule from "../../src/host-skills.js";
import type * as PortProbe from "../../src/port-probe.js";
import type * as UpdateHealth from "../../src/update-health.js";
import type * as Workspace from "../../src/workspace.js";

const {
  execFileSyncMock,
  platformMock,
  probeMock,
  probeInfoMock,
  probeHeadroomMock,
  isHostPortFreeMock,
  findListenerPidsMock,
  writeFileSyncMock,
  planCachePruneMock,
  resolveDoctorRepoRootMock,
  packagedSkillsDirOverride,
} = vi.hoisted(() => ({
  execFileSyncMock: vi.fn(),
  platformMock: vi.fn(),
  probeMock: vi.fn(),
  probeInfoMock: vi.fn(),
  probeHeadroomMock: vi.fn(),
  isHostPortFreeMock: vi.fn(),
  findListenerPidsMock: vi.fn(),
  writeFileSyncMock: vi.fn(),
  planCachePruneMock: vi.fn(),
  resolveDoctorRepoRootMock: vi.fn(),
  packagedSkillsDirOverride: { value: undefined as string | undefined },
}));

// `reclaimable-caches` is the one check that calls `planCachePrune` (a `du`
// sweep) — replaced with a controlled fixture everywhere except its own
// describe block below, so the other 60+ pre-existing checks in this file
// never pay for (or depend on) a real measurement.
vi.mock("../../src/cache-retention.js", async () => {
  const actual = await vi.importActual<typeof CacheRetentionModule>("../../src/cache-retention.js");
  return { ...actual, planCachePrune: planCachePruneMock };
});

// `checkHostSkillSymlinks` is the only check that calls `packagedSkillsDir`;
// pre-existing tests below never set the override, so it stays passed
// through to the real function — the actual `v2/skills/` on this checkout.
vi.mock("../../src/host-skills.js", async () => {
  const actual = await vi.importActual<typeof HostSkillsModule>("../../src/host-skills.js");
  return {
    ...actual,
    packagedSkillsDir: () => packagedSkillsDirOverride.value ?? actual.packagedSkillsDir(),
  };
});

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof ChildProcess>("node:child_process");
  return { ...actual, execFileSync: execFileSyncMock };
});

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof OsModule>("node:os");
  return { ...actual, platform: platformMock };
});

// C1: `checkDirWritable`'s write-probe uses the real `writeFileSync` by
// default (a real mkdtemp'd dir round-trips fine); only the dedicated
// "not writable" test overrides this (via `mockImplementationOnce`) to
// simulate `EACCES` deterministically, independent of this sandbox's actual
// uid/permission behavior.
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof FsModule>("node:fs");
  return { ...actual, writeFileSync: writeFileSyncMock };
});

vi.mock("../../src/update-health.js", async () => {
  const actual = await vi.importActual<typeof UpdateHealth>("../../src/update-health.js");
  return {
    ...actual,
    probe: probeMock,
    probeInfo: probeInfoMock,
    probeHeadroom: probeHeadroomMock,
  };
});

vi.mock("../../src/port-probe.js", async () => {
  const actual = await vi.importActual<typeof PortProbe>("../../src/port-probe.js");
  return { ...actual, isHostPortFree: isHostPortFreeMock, findListenerPids: findListenerPidsMock };
});

// `spur doctor`'s CLI-wiring test below never wants a real `git
// rev-parse --show-toplevel` against this checkout (whose root has its own
// `spur.yaml`, which would pull the heavy `checkProjectWorkspace` path in) —
// only `resolveDoctorRepoRoot` is overridden, everything else in the module
// stays real.
vi.mock("../../src/workspace.js", async () => {
  const actual = await vi.importActual<typeof Workspace>("../../src/workspace.js");
  return { ...actual, resolveDoctorRepoRoot: resolveDoctorRepoRootMock };
});

import {
  checkConfigRegistry,
  checkHostSkillSymlinks,
  checkServiceHealth,
  checkSpurOnPath,
  checkVersionDrift,
  collectHostInstallChecks,
  hasErrorSeverity,
  renderHostInstallChecks,
  resolveSystemdScope,
  satisfiesNodeEngineRange,
  type SystemdScope,
} from "../../src/host-install.js";
import { getVersion } from "../../src/version.js";
import { NPM_PIN_SANITIZE_ENV_KEYS, npmPinConfigPath } from "../../src/npm-prefix.js";
import { createProgram } from "../../src/cli.js";

const version = getVersion();

// Resolved once, up front — used as `writeFileSyncMock`'s default
// passthrough implementation every test, independent of whether
// `vi.restoreAllMocks()` (called in `afterEach`) affects a plain `vi.fn()`'s
// prior implementation.
const actualFs = await vi.importActual<typeof FsModule>("node:fs");

interface ExecState {
  tmuxOk: boolean;
  gitOk: boolean;
  lingerOk: boolean;
  systemctlAvailable: boolean;
  daemonActiveState: string;
  webActiveState: string;
  // MainPID systemd reports for each unit ("0" when systemd has no tracked
  // process for it, matching `systemctl show -p MainPID --value` on an
  // inactive unit).
  daemonMainPid: string;
  webMainPid: string;
  // B1: the extra `show -p ActiveState,SubState,NRestarts,ExecMainStatus`
  // properties `describeInactiveUnit` queries — `daemonActiveState`/
  // `webActiveState` above double as this query's own `ActiveState` line, so
  // a real systemd's "failed"/"activating" substates are exercised through
  // the same single field `isActive` already reads.
  daemonSubState: string;
  daemonNRestarts: string;
  daemonExecMainStatus: string;
  webSubState: string;
  webNRestarts: string;
  webExecMainStatus: string;
  // C2/A2 seams.
  dfAvailable: boolean;
  dfKbLine: string;
  dfILine: string;
  nodePtyOk: boolean;
  // data-dir-log-bytes seam: `du -sk <dataDir>/sessions` first line.
  duAvailable: boolean;
  duKbLine: string;
}

let execState: ExecState;
const initialSpurConfig = process.env["SPUR_CONFIG"];

beforeEach(() => {
  // `collectHostInstallChecks`'s new instance-config-derived checks (F1/C1/
  // C2/E1/E2) read `loadInstanceConfigReadOnly()`, which resolves via
  // `SPUR_CONFIG`/the real `homedir()` — decoupled from this file's `home`
  // parameter used for systemd-scope tests. Default every test to a
  // definitely-nonexistent instance config so none of them ever read (or
  // write-probe against) this machine's real `~/.spur/config.yaml`/`dataDir`/
  // `worktreeDir`; tests that specifically exercise those checks override
  // `SPUR_CONFIG` to a controlled temp path.
  process.env["SPUR_CONFIG"] = "/nonexistent/spur-host-install-test-instance-config.yaml";

  execState = {
    tmuxOk: true,
    gitOk: true,
    lingerOk: false,
    systemctlAvailable: false,
    daemonActiveState: "inactive",
    webActiveState: "inactive",
    daemonMainPid: "0",
    webMainPid: "0",
    daemonSubState: "dead",
    daemonNRestarts: "0",
    daemonExecMainStatus: "0",
    webSubState: "dead",
    webNRestarts: "0",
    webExecMainStatus: "0",
    dfAvailable: true,
    dfKbLine: "/dev/sda1 100000000 5000000 90000000 10% /",
    dfILine: "/dev/sda1 1000000 200000 800000 20% /",
    nodePtyOk: true,
    duAvailable: true,
    duKbLine: "1000\t/data/sessions",
  };
  execFileSyncMock.mockReset();
  execFileSyncMock.mockImplementation((file: string, args: string[]) => {
    if (file === "npm") throw new Error("npm prefix unavailable");
    if (file === "tmux") {
      if (!execState.tmuxOk) throw new Error("tmux not found");
      return "tmux 3.3a";
    }
    if (file === "git") {
      if (!execState.gitOk) throw new Error("git not found");
      return "git version 2.40.0";
    }
    if (file === "loginctl") {
      if (!execState.lingerOk) throw new Error("linger unknown");
      return "Linger=yes";
    }
    if (file === "df") {
      if (!execState.dfAvailable) throw new Error("df not found");
      if (args.includes("-Pk")) {
        return `Filesystem 1024-blocks Used Available Capacity Mounted\n${execState.dfKbLine}`;
      }
      if (args.includes("-Pi")) {
        return `Filesystem Inodes IUsed IFree IUse% Mounted\n${execState.dfILine}`;
      }
      throw new Error(`unexpected df args: ${args.join(" ")}`);
    }
    if (file === "node") {
      if (!execState.nodePtyOk) throw new Error('Failed to load native module "node-pty"');
      return "";
    }
    if (file === "du") {
      if (!execState.duAvailable) throw new Error("du not found");
      return execState.duKbLine;
    }
    if (file === "systemctl") {
      if (!execState.systemctlAvailable) throw new Error("systemctl not available");
      if (args.includes("is-active")) {
        const unit = args[args.length - 1];
        if (unit === "spur-daemon.service") return execState.daemonActiveState;
        if (unit === "spur-web.service") return execState.webActiveState;
        return "inactive";
      }
      const showIndex = args.indexOf("show");
      if (showIndex !== -1 && args.includes("MainPID")) {
        const unit = args[showIndex + 1];
        if (unit === "spur-daemon.service") return execState.daemonMainPid;
        if (unit === "spur-web.service") return execState.webMainPid;
        return "0";
      }
      if (showIndex !== -1 && args.includes("ActiveState,SubState,NRestarts,ExecMainStatus")) {
        const unit = args[showIndex + 1];
        // Deliberately NOT in the requested property order — a real systemd
        // (verified against a real crash-looping unit) emits multi-property
        // `show -p A,B,C,D` output in its own internal order, not the
        // requested one; this fixture reproduces that to guard against a
        // positional-destructure regression in `describeInactiveUnit`.
        if (unit === "spur-daemon.service") {
          return [
            `NRestarts=${execState.daemonNRestarts}`,
            `ExecMainStatus=${execState.daemonExecMainStatus}`,
            `ActiveState=${execState.daemonActiveState}`,
            `SubState=${execState.daemonSubState}`,
          ].join("\n");
        }
        if (unit === "spur-web.service") {
          return [
            `NRestarts=${execState.webNRestarts}`,
            `ExecMainStatus=${execState.webExecMainStatus}`,
            `ActiveState=${execState.webActiveState}`,
            `SubState=${execState.webSubState}`,
          ].join("\n");
        }
        return "";
      }
      return "";
    }
    throw new Error(`unexpected exec: ${file} ${args.join(" ")}`);
  });

  writeFileSyncMock.mockReset();
  writeFileSyncMock.mockImplementation((...args: Parameters<typeof actualFs.writeFileSync>) =>
    actualFs.writeFileSync(...args),
  );

  platformMock.mockReset();
  platformMock.mockReturnValue("linux");

  probeMock.mockReset();
  probeMock.mockResolvedValue({ ok: false, reason: "connection-refused" });
  probeInfoMock.mockReset();
  probeInfoMock.mockResolvedValue({ ok: false, reason: "connection-refused" });
  probeHeadroomMock.mockReset();
  probeHeadroomMock.mockResolvedValue({ ok: false });
  isHostPortFreeMock.mockReset();
  isHostPortFreeMock.mockResolvedValue(true);
  findListenerPidsMock.mockReset();
  findListenerPidsMock.mockResolvedValue([]);
  planCachePruneMock.mockReset();
  planCachePruneMock.mockResolvedValue({
    generatedAt: new Date(0).toISOString(),
    roots: [],
    candidates: [],
    reclaimableKb: 0,
    processTreeReadable: true,
    pinSourceCount: 1,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  if (initialSpurConfig === undefined) {
    delete process.env["SPUR_CONFIG"];
  } else {
    process.env["SPUR_CONFIG"] = initialSpurConfig;
  }
});

describe("checkConfigRegistry", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("warns on dead, worktree-internal, and over-cap registry entries", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "spur-doctor-registry-"));
    tempDirs.push(rootDir);
    const dataDir = join(rootDir, "data");
    const worktreeDir = join(rootDir, "worktrees");
    await mkdir(dataDir, { recursive: true });
    await mkdir(join(worktreeDir, "proj", "sess"), { recursive: true });

    const livePath = join(rootDir, "live.yaml");
    await writeFile(livePath, "stub: true\n", "utf8");
    const deadPath = join(rootDir, "missing.yaml");
    const worktreeInternalPath = join(worktreeDir, "proj", "sess", "spur.yaml");
    await writeFile(worktreeInternalPath, "stub: true\n", "utf8");
    const fillerDeadPaths = Array.from({ length: 22 }, (_, index) =>
      join(rootDir, `filler-${index}.yaml`),
    );

    await writeFile(
      join(dataDir, "config-registry.json"),
      JSON.stringify({
        configPaths: [livePath, deadPath, worktreeInternalPath, ...fillerDeadPaths],
        unconfiguredProjects: [],
      }),
      "utf8",
    );

    const check = checkConfigRegistry(dataDir, worktreeDir);

    expect(check.id).toBe("config-registry");
    expect(check.severity).toBe("warn");
    expect(check.ok).toBe(false);
    expect(check.detail).toContain(deadPath);
    // Both dead and worktree-internal offenders are present, so the fix
    // hint must cover both — and never resolve to a bare `undefined`.
    expect(check.fix).toContain(`spur disconnect ${deadPath}`);
    expect(check.fix).toContain("restart the daemon");
    expect(check.fix).not.toContain("undefined");
  });

  it("omits fix and points at the count in detail when only the cap is over, with no dead or worktree-internal offenders", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "spur-doctor-registry-cap-only-"));
    tempDirs.push(rootDir);
    const dataDir = join(rootDir, "data");
    const worktreeDir = join(rootDir, "worktrees");
    await mkdir(dataDir, { recursive: true });

    const livePaths = await Promise.all(
      Array.from({ length: 25 }, async (_, index) => {
        const path = join(rootDir, `live-${index}.yaml`);
        await writeFile(path, "stub: true\n", "utf8");
        return path;
      }),
    );
    await writeFile(
      join(dataDir, "config-registry.json"),
      JSON.stringify({ configPaths: livePaths, unconfiguredProjects: [] }),
      "utf8",
    );

    const check = checkConfigRegistry(dataDir, worktreeDir);

    expect(check.ok).toBe(false);
    expect(check.detail).toContain("over the");
    expect(check.detail).not.toContain(": ");
    expect(check.fix).toBeUndefined();
  });

  it("points only at spur disconnect, never a daemon restart, when every offender is dead", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "spur-doctor-registry-dead-only-"));
    tempDirs.push(rootDir);
    const dataDir = join(rootDir, "data");
    const worktreeDir = join(rootDir, "worktrees");
    await mkdir(dataDir, { recursive: true });
    const deadPath = join(rootDir, "missing.yaml");
    await writeFile(
      join(dataDir, "config-registry.json"),
      JSON.stringify({ configPaths: [deadPath], unconfiguredProjects: [] }),
      "utf8",
    );

    const check = checkConfigRegistry(dataDir, worktreeDir);

    expect(check.fix).toContain(`spur disconnect ${deadPath}`);
    expect(check.fix).not.toContain("restart the daemon");
  });

  it("points only at a daemon restart, never spur disconnect, when every offender is worktree-internal", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "spur-doctor-registry-worktree-only-"));
    tempDirs.push(rootDir);
    const dataDir = join(rootDir, "data");
    const worktreeDir = join(rootDir, "worktrees");
    await mkdir(join(worktreeDir, "proj", "sess"), { recursive: true });
    await mkdir(dataDir, { recursive: true });
    const worktreeInternalPath = join(worktreeDir, "proj", "sess", "spur.yaml");
    await writeFile(worktreeInternalPath, "stub: true\n", "utf8");
    await writeFile(
      join(dataDir, "config-registry.json"),
      JSON.stringify({ configPaths: [worktreeInternalPath], unconfiguredProjects: [] }),
      "utf8",
    );

    const check = checkConfigRegistry(dataDir, worktreeDir);

    expect(check.fix).toBe("restart the daemon to prune worktree-internal entries at boot");
    expect(check.fix).not.toContain("spur disconnect");
  });

  it("reports ok when every registered path is live, outside worktreeDir, and under cap", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "spur-doctor-registry-ok-"));
    tempDirs.push(rootDir);
    const dataDir = join(rootDir, "data");
    const worktreeDir = join(rootDir, "worktrees");
    await mkdir(dataDir, { recursive: true });
    const livePath = join(rootDir, "live.yaml");
    await writeFile(livePath, "stub: true\n", "utf8");
    await writeFile(
      join(dataDir, "config-registry.json"),
      JSON.stringify({ configPaths: [livePath], unconfiguredProjects: [] }),
      "utf8",
    );

    const check = checkConfigRegistry(dataDir, worktreeDir);

    expect(check.ok).toBe(true);
    expect(check.severity).toBe("warn");
  });

  it("carries a per-path alive/dead/worktree-internal classification alongside the aggregate detail", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "spur-doctor-registry-per-path-"));
    tempDirs.push(rootDir);
    const dataDir = join(rootDir, "data");
    const worktreeDir = join(rootDir, "worktrees");
    await mkdir(dataDir, { recursive: true });
    await mkdir(join(worktreeDir, "proj", "sess"), { recursive: true });

    const livePath = join(rootDir, "live.yaml");
    await writeFile(livePath, "stub: true\n", "utf8");
    const deadPath = join(rootDir, "missing.yaml");
    const worktreeInternalPath = join(worktreeDir, "proj", "sess", "spur.yaml");
    await writeFile(worktreeInternalPath, "stub: true\n", "utf8");
    // Never written — both missing AND inside worktreeDir. The missing-file
    // check runs first in `checkConfigRegistry`, so this must classify as
    // "dead", not "worktree-internal".
    const deadAndWorktreeInternalPath = join(worktreeDir, "proj", "sess", "missing-spur.yaml");
    await writeFile(
      join(dataDir, "config-registry.json"),
      JSON.stringify({
        configPaths: [livePath, deadPath, worktreeInternalPath, deadAndWorktreeInternalPath],
        unconfiguredProjects: [],
      }),
      "utf8",
    );

    const check = checkConfigRegistry(dataDir, worktreeDir);

    expect(check.configRegistryPaths).toEqual([
      { path: livePath, state: "alive" },
      { path: deadPath, state: "dead" },
      { path: worktreeInternalPath, state: "worktree-internal" },
      { path: deadAndWorktreeInternalPath, state: "dead" },
    ]);
  });
});

describe("collectHostInstallChecks", () => {
  it("returns npm-prefix and systemd checks for a fake home", async () => {
    const checks = await collectHostInstallChecks("/tmp/spur-host-install-test");
    const ids = checks.map((check) => check.id);
    expect(ids).toContain("npm-prefix");
    expect(ids).toContain("systemd-units");
    expect(ids).toContain("linger");
    expect(checks.find((check) => check.id === "systemd-units")?.ok).toBe(false);
    expect(ids).not.toContain("spur-direct-terminal");
  });

  // MUST FIX 1 regression guard: Spur pins the globalconfig keys (both
  // casings) into every agent session's env (see `session-service.ts`) — the
  // `npm-prefix` probe must strip every sanitized key from its own child env
  // so a `spur doctor` run inside a session reads the persisted `~/.npmrc`/
  // pin-file state, not its own session env pin.
  it("strips every NPM_PIN_SANITIZE_ENV_KEYS name from the npm-prefix probe's child env", async () => {
    const originalValues = NPM_PIN_SANITIZE_ENV_KEYS.map((key) => process.env[key]);
    for (const key of NPM_PIN_SANITIZE_ENV_KEYS) {
      process.env[key] = "/some/session/pin";
    }
    try {
      const fakeHome = "/tmp/spur-host-install-test-npm-prefix-env";
      await collectHostInstallChecks(fakeHome);
      const npmCall = execFileSyncMock.mock.calls.find(([file]) => file === "npm") as
        | [string, string[], { env?: NodeJS.ProcessEnv }]
        | undefined;
      expect(npmCall).toBeDefined();
      const options = npmCall?.[2];
      expect(options?.env?.["HOME"]).toBe(fakeHome);
      for (const key of NPM_PIN_SANITIZE_ENV_KEYS) {
        expect(options?.env?.[key]).toBeUndefined();
      }
    } finally {
      NPM_PIN_SANITIZE_ENV_KEYS.forEach((key, index) => {
        const original = originalValues[index];
        if (original === undefined) Reflect.deleteProperty(process.env, key);
        else process.env[key] = original;
      });
    }
  });

  // Regression guard: an inherited `npm_config_userconfig` (npx/`npm
  // exec`/`npm run` all set one) outranks `HOME` as npm's userconfig source
  // and would steer the probe at a different `.npmrc` than `home`/.npmrc,
  // which `expectedPrefix` is derived from — `--userconfig` must be passed
  // explicitly so the probe can never diverge from it. `--globalconfig`
  // points the probe at the persisted pin file, which lives outside
  // `~/.npmrc` (nvm greps that file for a `prefix=`/`globalconfig=` line).
  it("passes an explicit --userconfig and --globalconfig to the npm-prefix probe", async () => {
    const fakeHome = "/tmp/spur-host-install-test-npm-prefix-userconfig";
    await collectHostInstallChecks(fakeHome);
    const npmCall = execFileSyncMock.mock.calls.find(([file]) => file === "npm") as
      | [string, string[]]
      | undefined;
    expect(npmCall).toBeDefined();
    const args = npmCall?.[1] ?? [];
    const userconfigIndex = args.indexOf("--userconfig");
    expect(userconfigIndex).toBeGreaterThanOrEqual(0);
    expect(args[userconfigIndex + 1]).toBe(join(fakeHome, ".npmrc"));
    const globalconfigIndex = args.indexOf("--globalconfig");
    expect(globalconfigIndex).toBeGreaterThanOrEqual(0);
    expect(args[globalconfigIndex + 1]).toBe(npmPinConfigPath(fakeHome));
  });

  describe("npmrc-nvm-conflict check", () => {
    let tmpHome: string;
    // MUST FIX 6: `collectHostInstallChecks` shares `hasNvm` with
    // `healNpmrcPrefixLine`, which checks `$NVM_DIR` before `<home>/.nvm` —
    // an ambient `NVM_DIR` on the machine running this suite (common on any
    // dev box with nvm installed) would otherwise leak into every spec below
    // and desync them from `tmpHome`. Clear it for the default case; the
    // dedicated custom-`$NVM_DIR` spec below sets its own.
    const originalNvmDir = process.env["NVM_DIR"];

    beforeEach(async () => {
      tmpHome = await mkdtemp(join(tmpdir(), "spur-host-install-npmrc-conflict-"));
      Reflect.deleteProperty(process.env, "NVM_DIR");
    });

    afterEach(async () => {
      await rm(tmpHome, { recursive: true, force: true });
      if (originalNvmDir === undefined) Reflect.deleteProperty(process.env, "NVM_DIR");
      else process.env["NVM_DIR"] = originalNvmDir;
    });

    it("is absent entirely when the host has no ~/.nvm/nvm.sh (nvm irrelevant, stays quiet)", async () => {
      await writeFile(join(tmpHome, ".npmrc"), "prefix=/operator/elsewhere\n", "utf8");
      const checks = await collectHostInstallChecks(tmpHome);
      expect(checks.find((check) => check.id === "npmrc-nvm-conflict")).toBeUndefined();
    });

    // MUST FIX 6 regression guard: nvm installed to a custom $NVM_DIR (e.g.
    // container images) must still trip this check — the old bare
    // `<home>/.nvm/nvm.sh` existsSync check never fired there.
    it("fires when nvm is installed to a custom $NVM_DIR outside <home>/.nvm", async () => {
      const customNvmDir = join(tmpHome, "custom-nvm-location");
      await mkdir(customNvmDir, { recursive: true });
      await writeFile(join(customNvmDir, "nvm.sh"), "# fake nvm\n", "utf8");
      process.env["NVM_DIR"] = customNvmDir;
      await writeFile(join(tmpHome, ".npmrc"), "prefix=/operator/elsewhere\n", "utf8");
      const checks = await collectHostInstallChecks(tmpHome);
      expect(checks.find((check) => check.id === "npmrc-nvm-conflict")).toMatchObject({
        ok: false,
        severity: "warn",
      });
    });

    it("is ok:true when <home>/.npmrc is absent", async () => {
      await mkdir(join(tmpHome, ".nvm"), { recursive: true });
      await writeFile(join(tmpHome, ".nvm", "nvm.sh"), "# fake nvm\n", "utf8");
      const checks = await collectHostInstallChecks(tmpHome);
      expect(checks.find((check) => check.id === "npmrc-nvm-conflict")).toMatchObject({
        ok: true,
        severity: "warn",
      });
    });

    it("is ok:true when <home>/.npmrc has no prefix=/globalconfig= line", async () => {
      await mkdir(join(tmpHome, ".nvm"), { recursive: true });
      await writeFile(join(tmpHome, ".nvm", "nvm.sh"), "# fake nvm\n", "utf8");
      await writeFile(join(tmpHome, ".npmrc"), "//registry.npmjs.org/:_authToken=fake\n", "utf8");
      const checks = await collectHostInstallChecks(tmpHome);
      expect(checks.find((check) => check.id === "npmrc-nvm-conflict")).toMatchObject({
        ok: true,
        severity: "warn",
      });
    });

    it("is ok:false when <home>/.npmrc has a prefix= line, including an operator-set one, with a manual fix (not spur reinit)", async () => {
      await mkdir(join(tmpHome, ".nvm"), { recursive: true });
      await writeFile(join(tmpHome, ".nvm", "nvm.sh"), "# fake nvm\n", "utf8");
      await writeFile(join(tmpHome, ".npmrc"), "prefix=/operator/elsewhere\n", "utf8");
      const checks = await collectHostInstallChecks(tmpHome);
      const check = checks.find((c) => c.id === "npmrc-nvm-conflict");
      expect(check).toMatchObject({ ok: false, severity: "warn" });
      expect(check?.fix).toContain(join(tmpHome, ".npmrc"));
      expect(check?.fix).not.toContain("spur reinit");
    });

    it("is ok:false when <home>/.npmrc has a globalconfig= line", async () => {
      await mkdir(join(tmpHome, ".nvm"), { recursive: true });
      await writeFile(join(tmpHome, ".nvm", "nvm.sh"), "# fake nvm\n", "utf8");
      await writeFile(join(tmpHome, ".npmrc"), "globalconfig=/some/other/npmrc\n", "utf8");
      const checks = await collectHostInstallChecks(tmpHome);
      expect(checks.find((check) => check.id === "npmrc-nvm-conflict")).toMatchObject({
        ok: false,
        severity: "warn",
      });
    });
  });

  // `onboardingFilePath` (src/claude-accounts.ts) special-cases the host
  // account: when `configDir === join(homedir(), ".claude")` it reads
  // `~/.claude.json`, not `<configDir>/.claude.json`. `collectHostInstallChecks`
  // passes `home` (a fixture dir here) as the check's own `home` param, but
  // `homedir()` still resolves the real account — the two only agree once
  // `$HOME` is pinned to the same fixture dir, so these fixtures are placed at
  // `<tmpHome>/.claude.json` (the real host layout), not
  // `<tmpHome>/.claude/.claude.json`.
  describe("claude-onboarding check", () => {
    let tmpHome: string;
    const originalHome = process.env["HOME"];

    beforeEach(async () => {
      tmpHome = await mkdtemp(join(tmpdir(), "spur-host-install-claude-onboarding-"));
      process.env["HOME"] = tmpHome;
    });

    afterEach(async () => {
      if (originalHome === undefined) Reflect.deleteProperty(process.env, "HOME");
      else process.env["HOME"] = originalHome;
      await rm(tmpHome, { recursive: true, force: true });
    });

    it("is ok:true (info) when Claude Code was never authenticated on this host", async () => {
      const checks = await collectHostInstallChecks(tmpHome);
      expect(checks.find((check) => check.id === "claude-onboarding")).toMatchObject({
        ok: true,
        severity: "info",
      });
    });

    it("is ok:true when hasCompletedOnboarding is true", async () => {
      await mkdir(join(tmpHome, ".claude"), { recursive: true });
      await writeFile(join(tmpHome, ".claude", ".credentials.json"), "{}", "utf8");
      await writeFile(
        join(tmpHome, ".claude.json"),
        JSON.stringify({ hasCompletedOnboarding: true }),
        "utf8",
      );
      const checks = await collectHostInstallChecks(tmpHome);
      expect(checks.find((check) => check.id === "claude-onboarding")).toMatchObject({
        ok: true,
        severity: "warn",
      });
    });

    it("is ok:false with a fix when authenticated but hasCompletedOnboarding is unset", async () => {
      await mkdir(join(tmpHome, ".claude"), { recursive: true });
      await writeFile(join(tmpHome, ".claude", ".credentials.json"), "{}", "utf8");
      await writeFile(join(tmpHome, ".claude.json"), JSON.stringify({}), "utf8");
      const checks = await collectHostInstallChecks(tmpHome);
      const check = checks.find((c) => c.id === "claude-onboarding");
      expect(check).toMatchObject({ ok: false, severity: "warn" });
      expect(check?.fix).toContain("run `claude`");
    });

    it("is ok:false with a fix when hasCompletedOnboarding is explicitly false", async () => {
      await mkdir(join(tmpHome, ".claude"), { recursive: true });
      await writeFile(join(tmpHome, ".claude", ".credentials.json"), "{}", "utf8");
      await writeFile(
        join(tmpHome, ".claude.json"),
        JSON.stringify({ hasCompletedOnboarding: false }),
        "utf8",
      );
      const checks = await collectHostInstallChecks(tmpHome);
      const check = checks.find((c) => c.id === "claude-onboarding");
      expect(check).toMatchObject({ ok: false, severity: "warn" });
      expect(check?.fix).toContain("run `claude`");
    });

    it("is ok:true (info) when authenticated but the onboarding file is absent (never read/written)", async () => {
      await mkdir(join(tmpHome, ".claude"), { recursive: true });
      await writeFile(join(tmpHome, ".claude", ".credentials.json"), "{}", "utf8");
      const checks = await collectHostInstallChecks(tmpHome);
      expect(checks.find((check) => check.id === "claude-onboarding")).toMatchObject({
        ok: true,
        severity: "info",
      });
    });

    it("is ok:true (info) when the onboarding file exists but is not valid JSON", async () => {
      await mkdir(join(tmpHome, ".claude"), { recursive: true });
      await writeFile(join(tmpHome, ".claude", ".credentials.json"), "{}", "utf8");
      await writeFile(join(tmpHome, ".claude.json"), "{not json", "utf8");
      const checks = await collectHostInstallChecks(tmpHome);
      expect(checks.find((check) => check.id === "claude-onboarding")).toMatchObject({
        ok: true,
        severity: "info",
      });
    });
  });

  it("keeps a fresh, never-initialized host exit-safe (no error severity)", async () => {
    const checks = await collectHostInstallChecks("/tmp/spur-host-install-test");
    expect(hasErrorSeverity(checks)).toBe(false);
  });

  it("flags missing tmux/git as error severity", async () => {
    execState.tmuxOk = false;
    execState.gitOk = false;
    const checks = await collectHostInstallChecks("/tmp/spur-host-install-test");
    expect(checks.find((check) => check.id === "tmux-installed")).toMatchObject({
      ok: false,
      severity: "error",
    });
    expect(checks.find((check) => check.id === "git-installed")).toMatchObject({
      ok: false,
      severity: "error",
    });
    expect(hasErrorSeverity(checks)).toBe(true);
  });

  it("reports node-version ok:true for the currently running interpreter", async () => {
    const checks = await collectHostInstallChecks("/tmp/spur-host-install-test");
    // Severity is the check's static importance if it fails ("error"), not a
    // flag that flips with the outcome — a passing check keeps that same
    // field value; only the renderer treats it as invisible when `ok:true`.
    expect(checks.find((check) => check.id === "node-version")).toMatchObject({
      ok: true,
      severity: "error",
    });
  });

  // Folded-in regression guard: a genuine npm install resolves `engines.node`
  // from `dist/../package.json` (this package's own installed root, mirroring
  // `version.ts`'s own resolution) — on a real npm-published package lacking
  // an `engines` field, or a broken read path, this check silently degrades
  // to a permanent no-op "skipped" `ok:true`, indistinguishable from a real
  // pass by `ok`/`severity` alone. Assert on `detail` too, so a regression to
  // that no-op-skip path fails this test even though `ok`/`severity` would
  // stay unchanged.
  it("actually evaluates engines.node (does not silently no-op-skip) on this branch's real package.json", async () => {
    const checks = await collectHostInstallChecks("/tmp/spur-host-install-test");
    const nodeVersion = checks.find((check) => check.id === "node-version");
    expect(nodeVersion?.detail).toMatch(/satisfies/);
    expect(nodeVersion?.detail).not.toMatch(/skipped/);
  });

  it("reports systemd-not-applicable info instead of the systemd block on a non-Linux host (F7)", async () => {
    platformMock.mockReturnValue("darwin");
    const checks = await collectHostInstallChecks("/tmp/spur-host-install-test-darwin");
    expect(checks.find((check) => check.id === "systemd-not-applicable")).toMatchObject({
      ok: true,
      severity: "info",
    });
    expect(checks.find((check) => check.id === "systemd-units")).toBeUndefined();
    expect(checks.find((check) => check.id === "linger")).toBeUndefined();
    expect(hasErrorSeverity(checks)).toBe(false);
  });

  it("marks spur-daemon/spur-web severity as error regardless of active state (static, not a pass/fail flip)", async () => {
    const fakeHome = await mkdtemp(join(tmpdir(), "spur-host-install-units-"));
    const unitDir = join(fakeHome, ".config", "systemd", "user");
    await mkdir(unitDir, { recursive: true });
    await writeFile(join(unitDir, "spur-daemon.service"), "[Service]\n", "utf8");
    await writeFile(join(unitDir, "spur-web.service"), "[Service]\n", "utf8");
    execState.systemctlAvailable = true;
    execState.daemonActiveState = "inactive";
    execState.webActiveState = "active";
    // Keep the HTTP-health layer fully healthy so this test isolates the
    // systemd-derived severity, independent of `checkServiceHealth`'s own
    // active-but-unreachable/port-conflict branches.
    probeMock.mockResolvedValue({ ok: true });
    probeInfoMock.mockResolvedValue({ ok: true, version });

    const checks = await collectHostInstallChecks(fakeHome);

    expect(checks.find((check) => check.id === "spur-daemon")).toMatchObject({
      ok: false,
      severity: "error",
    });
    expect(checks.find((check) => check.id === "spur-web")).toMatchObject({
      ok: true,
      severity: "error",
    });
    // A dead daemon on an initialized host is the single most common reason
    // a user runs `doctor` at all — it must be exit-code-affecting.
    expect(hasErrorSeverity(checks)).toBe(true);
  });

  it("exits 0 on a never-initialized host (units not installed) even though systemd-units/linger are ok:false", async () => {
    const checks = await collectHostInstallChecks("/tmp/spur-host-install-test-never-init");
    expect(checks.find((check) => check.id === "spur-daemon")).toBeUndefined();
    expect(checks.find((check) => check.id === "spur-web")).toBeUndefined();
    expect(checks.find((check) => check.id === "systemd-units")).toMatchObject({
      ok: false,
      severity: "warn",
    });
    expect(hasErrorSeverity(checks)).toBe(false);
  });

  it("does not duplicate a systemd-reported inactive daemon as a second, differently-severed check", async () => {
    const fakeHome = await mkdtemp(join(tmpdir(), "spur-host-install-single-owner-"));
    const unitDir = join(fakeHome, ".config", "systemd", "user");
    await mkdir(unitDir, { recursive: true });
    await writeFile(join(unitDir, "spur-daemon.service"), "[Service]\n", "utf8");
    await writeFile(join(unitDir, "spur-web.service"), "[Service]\n", "utf8");
    execState.systemctlAvailable = true;
    execState.daemonActiveState = "inactive";
    execState.webActiveState = "inactive";
    // Both unreachable, both ports free: the only fact here is "not active",
    // and `spur-daemon`/`spur-web` already own that fact — at error severity.
    probeMock.mockResolvedValue({ ok: false, reason: "connection-refused" });
    probeInfoMock.mockResolvedValue({ ok: false, reason: "connection-refused" });
    isHostPortFreeMock.mockResolvedValue(true);

    const checks = await collectHostInstallChecks(fakeHome);

    expect(checks.find((check) => check.id === "spur-daemon")).toMatchObject({
      ok: false,
      severity: "error",
    });
    expect(checks.find((check) => check.id === "spur-web")).toMatchObject({
      ok: false,
      severity: "error",
    });
    expect(checks.find((check) => check.id === "daemon-reachable")).toBeUndefined();
    expect(checks.find((check) => check.id === "web-reachable")).toBeUndefined();
    expect(hasErrorSeverity(checks)).toBe(true);
  });
});

describe("checkHostSkillSymlinks", () => {
  let fixtureRoot: string;
  let home: string;

  beforeEach(async () => {
    fixtureRoot = await mkdtemp(join(tmpdir(), "spur-host-skill-check-"));
    home = await mkdtemp(join(tmpdir(), "spur-host-skill-check-home-"));
    await mkdir(join(fixtureRoot, "skills", "spur"), { recursive: true });
    await writeFile(join(fixtureRoot, "skills", "spur", "SKILL.md"), "---\nname: spur\n---\n");
    packagedSkillsDirOverride.value = join(fixtureRoot, "skills");
  });

  afterEach(async () => {
    packagedSkillsDirOverride.value = undefined;
    await rm(fixtureRoot, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });

  it("T10 is inert when the install ships no packaged skills", async () => {
    packagedSkillsDirOverride.value = join(fixtureRoot, "no-skills-here");
    const check = checkHostSkillSymlinks(home);
    expect(check).toEqual({
      id: "skills-symlinks",
      ok: true,
      severity: "info",
      detail: "skipped — no packaged skills in this install",
    });
  });

  it("T10 warns on a real conflicting directory and names the path", async () => {
    await mkdir(join(home, ".claude", "skills", "spur", "nested"), { recursive: true });
    const check = checkHostSkillSymlinks(home);
    expect(check.id).toBe("skills-symlinks");
    expect(check.ok).toBe(false);
    expect(check.severity).toBe("warn");
    expect(check.detail).toContain(join(home, ".claude", "skills", "spur"));
    expect(check.fix).toContain("spur reinit");
  });

  it("T10 is ok with an empty home, naming the current (absent) target", async () => {
    const check = checkHostSkillSymlinks(home);
    expect(check.ok).toBe(true);
    expect(check.severity).toBe("warn");
    expect(check.detail).toContain("absent");
  });

  it("T10 never mkdirs or writes — read-only", async () => {
    checkHostSkillSymlinks(home);
    expect(existsSync(join(home, ".claude"))).toBe(false);
    expect(existsSync(join(home, ".codex"))).toBe(false);
  });
});

describe("resolveSystemdScope", () => {
  it("never reports system scope for a home that differs from the real account home", () => {
    // Regression guard: a caller running under a test's overridden `$HOME`
    // (where `home` defaults to `homedir()`, itself driven by `$HOME`) must
    // not spuriously detect a real system-wide install that belongs to a
    // different, unrelated invocation on a shared host — `home` here can
    // never equal the true account home because it is an obviously-fake path.
    const scope = resolveSystemdScope("/tmp/spur-host-install-test-not-a-real-home");
    expect(scope.kind).not.toBe("system");
  });
});

describe("satisfiesNodeEngineRange", () => {
  it("matches a caret range within the same major", () => {
    expect(satisfiesNodeEngineRange("^20.19.0", "v20.19.0")).toBe(true);
    expect(satisfiesNodeEngineRange("^20.19.0", "v20.25.3")).toBe(true);
    expect(satisfiesNodeEngineRange("^20.19.0", "v20.18.9")).toBe(false);
    expect(satisfiesNodeEngineRange("^20.19.0", "v21.0.0")).toBe(false);
  });

  it("matches a >= range", () => {
    expect(satisfiesNodeEngineRange(">=24", "v24.0.0")).toBe(true);
    expect(satisfiesNodeEngineRange(">=24", "v25.1.0")).toBe(true);
    expect(satisfiesNodeEngineRange(">=24", "v23.9.9")).toBe(false);
  });

  it("evaluates OR across multiple clauses", () => {
    const range = "^20.19.0 || ^22.13.0 || >=24";
    expect(satisfiesNodeEngineRange(range, "v22.13.0")).toBe(true);
    expect(satisfiesNodeEngineRange(range, "v22.12.0")).toBe(false);
    expect(satisfiesNodeEngineRange(range, "v26.0.0")).toBe(true);
  });

  // Drift guard: `satisfiesClause` only understands `^X.Y.Z` and `>=X` (it
  // returns false for any other operator — `~`, `<`, hyphen ranges — which
  // would silently degrade `node-version` into a false error). Pin the real
  // `engines.node` from this package's package.json so adding an unsupported
  // clause form fails here, forcing `satisfiesClause` to be extended in the
  // same change.
  it("only uses clause forms satisfiesClause supports in the real engines.node", () => {
    const pkg = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { engines?: { node?: string } };
    const range = pkg.engines?.node;
    if (!range) {
      throw new Error("engines.node must be present");
    }
    const supported = /^\^\d+\.\d+\.\d+$|^>=\d+(?:\.\d+){0,2}$/;
    for (const clause of range.split("||").map((c) => c.trim())) {
      expect(
        clause,
        `unsupported engines.node clause "${clause}" — extend satisfiesClause`,
      ).toMatch(supported);
    }
    // And the pinned range must actually admit a version inside it.
    expect(satisfiesNodeEngineRange(range, "v20.19.0")).toBe(true);
  });
});

describe("checkSpurOnPath", () => {
  it("skips (info) when npmPrefix is undefined", () => {
    expect(checkSpurOnPath(undefined)).toMatchObject({ ok: true, severity: "info" });
  });

  it("skips (info) when no npm-installed spur binary exists at prefix/bin", async () => {
    const prefix = await mkdtemp(join(tmpdir(), "spur-doctor-noprefix-"));
    expect(checkSpurOnPath(prefix)).toMatchObject({ ok: true, severity: "info" });
  });

  it("flags error when the spur binary exists but prefix/bin is not on PATH", async () => {
    const prefix = await mkdtemp(join(tmpdir(), "spur-doctor-path-"));
    await mkdir(join(prefix, "bin"), { recursive: true });
    await writeFile(join(prefix, "bin", "spur"), "#!/bin/sh\n", "utf8");
    const originalPath = process.env["PATH"];
    process.env["PATH"] = "/usr/bin";
    try {
      const result = checkSpurOnPath(prefix);
      expect(result.ok).toBe(false);
      expect(result.severity).toBe("error");
    } finally {
      process.env["PATH"] = originalPath;
    }
  });

  it("reports ok when prefix/bin is already on PATH", async () => {
    const prefix = await mkdtemp(join(tmpdir(), "spur-doctor-onpath-"));
    await mkdir(join(prefix, "bin"), { recursive: true });
    await writeFile(join(prefix, "bin", "spur"), "#!/bin/sh\n", "utf8");
    const originalPath = process.env["PATH"];
    process.env["PATH"] = `${join(prefix, "bin")}:/usr/bin`;
    try {
      // Static severity (see item-5 comment on `checkSpurOnPath`): "error" is
      // the check's static importance, unaffected by the passing outcome.
      expect(checkSpurOnPath(prefix)).toMatchObject({ ok: true, severity: "error" });
    } finally {
      process.env["PATH"] = originalPath;
    }
  });
});

describe("checkServiceHealth", () => {
  const scope: SystemdScope = {
    kind: "user",
    unitDir: "/fake/unit-dir",
    ctl: ["systemctl", "--user"],
    restartCmd: "systemctl --user restart",
  };

  it("probes the daemon's /info endpoint for liveness, not /sessions (F6 must not hit the heavy view=full path)", async () => {
    probeInfoMock.mockResolvedValue({ ok: true, version });
    await checkServiceHealth(scope, false, false, false);
    expect(probeInfoMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: "daemon", url: expect.stringContaining("/info") }),
    );
  });

  // E1: a bind-all `server.host` (`0.0.0.0` / `::`) is a listen address, not a
  // connect target on every platform — the probe must rewrite it to loopback
  // so a healthy bind-all daemon is not mis-reported as connection-refused.
  it.each(["0.0.0.0", "::"])("probes loopback when server.host is bind-all %s", async (host) => {
    probeInfoMock.mockResolvedValue({ ok: true, version });
    await checkServiceHealth(scope, false, false, false, host);
    expect(probeInfoMock).toHaveBeenCalledWith(
      expect.objectContaining({ url: expect.stringContaining("http://127.0.0.1:") }),
    );
  });

  it("probes a concrete non-loopback server.host as configured (no rewrite)", async () => {
    probeInfoMock.mockResolvedValue({ ok: true, version });
    await checkServiceHealth(scope, false, false, false, "100.80.107.19");
    expect(probeInfoMock).toHaveBeenCalledWith(
      expect.objectContaining({ url: expect.stringContaining("http://100.80.107.19:") }),
    );
  });

  it("reports error severity when the service is active but the probe is definitively refused", async () => {
    probeInfoMock.mockResolvedValue({ ok: false, reason: "connection-refused" });
    probeMock.mockResolvedValue({ ok: false, reason: "connection-refused" });
    const result = await checkServiceHealth(scope, true, true, false);
    expect(result.checks.find((check) => check.id === "daemon-reachable")).toMatchObject({
      ok: false,
      severity: "error",
    });
    expect(result.checks.find((check) => check.id === "web-reachable")).toMatchObject({
      ok: false,
      severity: "error",
    });
    expect(result.daemonReachable).toBe(false);
  });

  // MUST FIX 2: a bare timeout on an active unit does not by itself mean the
  // service is broken (measured at 3.5-6.7s on a loaded production host) — it
  // must warn, not error, and must never fail the exit code.
  it("reports warn severity (not error) when an active service's probe merely times out", async () => {
    probeInfoMock.mockResolvedValue({ ok: false, reason: "timeout" });
    probeMock.mockResolvedValue({ ok: false, reason: "timeout" });
    const result = await checkServiceHealth(scope, true, true, false);
    const daemon = result.checks.find((check) => check.id === "daemon-reachable");
    const web = result.checks.find((check) => check.id === "web-reachable");
    expect(daemon).toMatchObject({ ok: false, severity: "warn" });
    expect(daemon?.detail).toContain("may be under load");
    expect(web).toMatchObject({ ok: false, severity: "warn" });
    expect(hasErrorSeverity(result.checks)).toBe(false);
  });

  it("reports a port-conflict check whose detail includes the foreign PID", async () => {
    probeInfoMock.mockResolvedValue({ ok: false, reason: "connection-refused" });
    isHostPortFreeMock.mockResolvedValue(false);
    findListenerPidsMock.mockResolvedValue([4242]);
    const result = await checkServiceHealth(scope, false, false, false);
    const conflict = result.checks.find((check) => check.id === "daemon-port-conflict");
    expect(conflict).toBeDefined();
    expect(conflict?.ok).toBe(false);
    expect(conflict?.severity).toBe("error");
    expect(conflict?.detail).toContain("4242");
  });

  // MUST FIX 1: the identity check is now driven by systemd's own `MainPID`
  // for the unit, compared against the port's real listener PIDs — not by a
  // second, identical `/info` request (which can never succeed here, since
  // this branch is only reached after the first `/info` request already
  // failed). Only the daemon's own port (4310, the default with no instance
  // config) is busy here, so the web side never enters its own conflict
  // branch.
  it("does not blame Spur's own daemon for a busy port when the listener PID matches the unit's systemd MainPID", async () => {
    probeInfoMock.mockResolvedValue({ ok: false, reason: "timeout" });
    execState.systemctlAvailable = true;
    execState.daemonMainPid = "4242";
    isHostPortFreeMock.mockImplementation(async (port: number) => port !== 4310);
    findListenerPidsMock.mockResolvedValue([4242]);
    const result = await checkServiceHealth(scope, false, false, false);
    expect(result.checks.find((check) => check.id === "daemon-port-conflict")).toBeUndefined();
    expect(findListenerPidsMock).toHaveBeenCalledWith(4310);
    const reachable = result.checks.find((check) => check.id === "daemon-reachable");
    expect(reachable).toMatchObject({ ok: false, severity: "warn" });
    expect(reachable?.detail).toContain("its own process (pid 4242)");
  });

  it("still reports a port-conflict when the unit's own MainPID does not match the port's listener", async () => {
    probeInfoMock.mockResolvedValue({ ok: false, reason: "connection-refused" });
    execState.systemctlAvailable = true;
    execState.daemonMainPid = "4242";
    isHostPortFreeMock.mockImplementation(async (port: number) => port !== 4310);
    findListenerPidsMock.mockResolvedValue([9999]);
    const result = await checkServiceHealth(scope, false, false, false);
    const conflict = result.checks.find((check) => check.id === "daemon-port-conflict");
    expect(conflict).toMatchObject({ ok: false, severity: "error" });
    expect(conflict?.detail).toContain("9999");
  });

  it("reports warn severity when the service simply has not started yet", async () => {
    probeInfoMock.mockResolvedValue({ ok: false, reason: "connection-refused" });
    isHostPortFreeMock.mockResolvedValue(true);
    const result = await checkServiceHealth(scope, false, false, false);
    expect(result.checks.find((check) => check.id === "daemon-reachable")).toMatchObject({
      ok: false,
      severity: "warn",
    });
  });

  it("suppresses the plain not-running check once systemd already reported the same inactive fact", async () => {
    probeInfoMock.mockResolvedValue({ ok: false, reason: "connection-refused" });
    probeMock.mockResolvedValue({ ok: false, reason: "connection-refused" });
    isHostPortFreeMock.mockResolvedValue(true);
    const result = await checkServiceHealth(scope, false, false, true);
    expect(result.checks.find((check) => check.id === "daemon-reachable")).toBeUndefined();
    expect(result.checks.find((check) => check.id === "web-reachable")).toBeUndefined();
  });

  it("marks the daemon reachable when the probe succeeds", async () => {
    probeInfoMock.mockResolvedValue({ ok: true, version });
    const result = await checkServiceHealth(scope, false, false, false);
    expect(result.daemonReachable).toBe(true);
    expect(result.daemonVersion).toBe(version);
    expect(result.checks.find((check) => check.id === "daemon-reachable")).toMatchObject({
      ok: true,
      severity: "info",
    });
  });

  // E1 regression check: today's hardcoded `127.0.0.1` probe would falsely
  // report this daemon unreachable even though it is fully healthy and
  // correctly bound to its configured (non-loopback) `server.host`.
  it("E1: probes the daemon at its configured non-loopback host instead of a hardcoded loopback", async () => {
    probeInfoMock.mockImplementation(async (target: { url: string }) =>
      target.url.startsWith("http://10.128.0.3:")
        ? { ok: true, version }
        : { ok: false, reason: "connection-refused" },
    );
    const result = await checkServiceHealth(scope, true, true, false, "10.128.0.3");
    expect(result.checks.find((check) => check.id === "daemon-reachable")).toMatchObject({
      ok: true,
      severity: "info",
    });
  });

  describe("session-headroom", () => {
    it("reports ok:true severity:warn when reachable with room", async () => {
      probeInfoMock.mockResolvedValue({ ok: true, version });
      probeHeadroomMock.mockResolvedValue({
        ok: true,
        body: {
          cap: {
            global: 10,
            source: "derived",
            perSessionBytes: 1_610_612_736,
            reserveFraction: 0.7,
          },
          projectCaps: {},
          live: { count: 3, byProject: { demo: 3 } },
          projectedRoom: 7,
          sessions: [
            { id: "demo-1", project: "demo", status: "running", rssBytes: 1_610_612_736 },
            { id: "demo-2", project: "demo", status: "running", rssBytes: 536_870_912 },
            { id: "demo-3", project: "demo", status: "running", rssBytes: 0 },
          ],
          memory: null,
          guard: { enforce: false, minAvailableBytes: 0, minFreeSwapBytes: 0, crossed: false },
        },
      });

      const result = await checkServiceHealth(scope, false, false, false);

      const check = result.checks.find((entry) => entry.id === "session-headroom");
      expect(check).toMatchObject({ ok: true, severity: "warn" });
      expect(renderHostInstallChecks(result.checks)).toContain(
        [
          "[ok] 3/10 live sessions, room for 7 more",
          "Measured RSS per live session:",
          "  demo-1: 1.5 GiB",
          "  demo-2: 512.0 MiB",
          "  demo-3: 0 B",
        ].join("\n"),
      );
      expect(hasErrorSeverity(result.checks)).toBe(false);
    });

    it("reports ok:false severity:warn with candidate ids in fix when reachable and full", async () => {
      probeInfoMock.mockResolvedValue({ ok: true, version });
      probeHeadroomMock.mockResolvedValue({
        ok: true,
        body: {
          cap: {
            global: 2,
            source: "config",
            perSessionBytes: 1_610_612_736,
            reserveFraction: 0.7,
          },
          projectCaps: {},
          live: { count: 2, byProject: { demo: 2 } },
          projectedRoom: 0,
          sessions: [
            { id: "demo-1", project: "demo", status: "running", rssBytes: 1_073_741_824 },
            { id: "demo-2", project: "demo", status: "running", rssBytes: 805_306_368 },
          ],
          memory: null,
          guard: { enforce: false, minAvailableBytes: 0, minFreeSwapBytes: 0, crossed: false },
        },
      });

      const result = await checkServiceHealth(scope, false, false, false);

      const check = result.checks.find((entry) => entry.id === "session-headroom");
      expect(check).toMatchObject({ ok: false, severity: "warn" });
      expect(check?.detail).toContain("  demo-1: 1.0 GiB");
      expect(check?.detail).toContain("  demo-2: 768.0 MiB");
      expect(check?.fix).toContain("demo-1");
      expect(check?.fix).toContain("demo-2");
      expect(renderHostInstallChecks(result.checks)).toContain(
        "\n  fix: raise admission.maxLiveSessions",
      );
      expect(hasErrorSeverity(result.checks)).toBe(false);
    });

    it("reports memory guard remediation without an empty stop-sessions suffix", async () => {
      probeInfoMock.mockResolvedValue({ ok: true, version });
      probeHeadroomMock.mockResolvedValue({
        ok: true,
        body: {
          cap: {
            global: 10,
            source: "derived",
            perSessionBytes: 1_610_612_736,
            reserveFraction: 0.7,
          },
          projectCaps: {},
          live: { count: 0, byProject: {} },
          projectedRoom: 10,
          sessions: [],
          memory: {
            totalBytes: 68_719_476_736,
            availableBytes: 536_870_912,
            swapTotalBytes: 8_589_934_592,
            swapFreeBytes: 268_435_456,
          },
          guard: {
            enforce: false,
            minAvailableBytes: 1_073_741_824,
            minFreeSwapBytes: 536_870_912,
            crossed: true,
          },
        },
      });

      const result = await checkServiceHealth(scope, false, false, false);

      const check = result.checks.find((entry) => entry.id === "session-headroom");
      expect(check).toMatchObject({
        ok: false,
        severity: "warn",
        fix: "free host memory or swap, or adjust admission.memoryGuard.minAvailableBytes or admission.memoryGuard.minFreeSwapBytes in ~/.spur/config.yaml",
      });
      expect(check?.detail).toContain("memory guard crossed");
      expect(check?.fix).not.toContain("stop sessions:");
      expect(hasErrorSeverity(result.checks)).toBe(false);
    });

    it("emits no session-headroom check when the daemon is unreachable", async () => {
      probeInfoMock.mockResolvedValue({ ok: false, reason: "connection-refused" });
      probeMock.mockResolvedValue({ ok: false, reason: "connection-refused" });

      const result = await checkServiceHealth(scope, false, false, false);

      expect(result.checks.find((entry) => entry.id === "session-headroom")).toBeUndefined();
      expect(probeHeadroomMock).not.toHaveBeenCalled();
      expect(hasErrorSeverity(result.checks)).toBe(false);
    });
  });
});

async function writeFakeUnits(daemonBody: string, webBody: string): Promise<string> {
  const fakeHome = await mkdtemp(join(tmpdir(), "spur-host-install-groups-"));
  const unitDir = join(fakeHome, ".config", "systemd", "user");
  await mkdir(unitDir, { recursive: true });
  await writeFile(join(unitDir, "spur-daemon.service"), daemonBody, "utf8");
  await writeFile(join(unitDir, "spur-web.service"), webBody, "utf8");
  return fakeHome;
}

async function pinInstanceConfig(content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "spur-host-install-instance-"));
  const configPath = join(dir, "config.yaml");
  await writeFile(configPath, content, "utf8");
  process.env["SPUR_CONFIG"] = configPath;
  return configPath;
}

const MINIMAL_UNIT_BODY = "[Service]\n";

describe("collectHostInstallChecks: A1 dist integrity", () => {
  it("reports daemon-dist-integrity error when the ExecStart .js target is missing", async () => {
    const fakeHome = await writeFakeUnits(
      "[Service]\nExecStart=/usr/bin/node %h/.local/lib/node_modules/@shugaev/spur/dist/cli.js daemon start\n",
      MINIMAL_UNIT_BODY,
    );
    const checks = await collectHostInstallChecks(fakeHome);
    expect(checks.find((check) => check.id === "daemon-dist-integrity")).toMatchObject({
      ok: false,
      severity: "error",
    });
  });

  it("reports web-dist-integrity ok:true when the ExecStart .js target exists", async () => {
    const fakeHome = await writeFakeUnits(
      MINIMAL_UNIT_BODY,
      `[Service]\nExecStart=/usr/bin/node ${join(tmpdir(), "definitely-does-not-exist.js")}\n`,
    );
    // Point at a real file this time to exercise the ok:true branch.
    const realTarget = join(fakeHome, "web-server.js");
    await writeFile(realTarget, "// fake\n", "utf8");
    await writeFile(
      join(fakeHome, ".config", "systemd", "user", "spur-web.service"),
      `[Service]\nExecStart=/usr/bin/node ${realTarget}\n`,
      "utf8",
    );
    const checks = await collectHostInstallChecks(fakeHome);
    expect(checks.find((check) => check.id === "web-dist-integrity")).toMatchObject({
      ok: true,
      severity: "error",
    });
  });

  it("pushes no web-dist-integrity check when ExecStart has no resolvable .js target (system-scope `pnpm ui:start`)", async () => {
    const fakeHome = await writeFakeUnits(
      MINIMAL_UNIT_BODY,
      "[Service]\nExecStart=/usr/bin/pnpm ui:start\n",
    );
    const checks = await collectHostInstallChecks(fakeHome);
    expect(checks.find((check) => check.id === "web-dist-integrity")).toBeUndefined();
  });
});

describe("collectHostInstallChecks: A2 node-pty native module load", () => {
  it("reports web-native-module-load error when node-pty fails to load in the resolved bundle dir", async () => {
    const bundleDir = await mkdtemp(join(tmpdir(), "spur-host-install-bundle-"));
    await mkdir(join(bundleDir, "node_modules", "node-pty"), { recursive: true });
    const fakeHome = await writeFakeUnits(
      MINIMAL_UNIT_BODY,
      `[Service]\nWorkingDirectory=${bundleDir}\n`,
    );
    execState.nodePtyOk = false;
    const checks = await collectHostInstallChecks(fakeHome);
    expect(checks.find((check) => check.id === "web-native-module-load")).toMatchObject({
      ok: false,
      severity: "error",
    });
    expect(execFileSyncMock).toHaveBeenCalledWith(
      "node",
      expect.arrayContaining(['require("node-pty")']),
      expect.objectContaining({ timeout: 5_000, cwd: bundleDir }),
    );
  });

  it("reports web-native-module-load ok:true when node-pty loads successfully", async () => {
    const bundleDir = await mkdtemp(join(tmpdir(), "spur-host-install-bundle-"));
    await mkdir(join(bundleDir, "node_modules", "node-pty"), { recursive: true });
    const fakeHome = await writeFakeUnits(
      MINIMAL_UNIT_BODY,
      `[Service]\nWorkingDirectory=${bundleDir}\n`,
    );
    execState.nodePtyOk = true;
    const checks = await collectHostInstallChecks(fakeHome);
    expect(checks.find((check) => check.id === "web-native-module-load")).toMatchObject({
      ok: true,
      severity: "error",
    });
  });

  it("pushes no web-native-module-load check when neither bundle candidate has node-pty installed", async () => {
    const workingDir = await mkdtemp(join(tmpdir(), "spur-host-install-nopty-"));
    const fakeHome = await writeFakeUnits(
      MINIMAL_UNIT_BODY,
      `[Service]\nWorkingDirectory=${workingDir}\n`,
    );
    const checks = await collectHostInstallChecks(fakeHome);
    expect(checks.find((check) => check.id === "web-native-module-load")).toBeUndefined();
  });
});

describe("collectHostInstallChecks: B1 systemd failed-vs-inactive detail", () => {
  it("enriches the spur-daemon detail with failed state, substate, and restart count instead of a bare restart hint", async () => {
    const fakeHome = await writeFakeUnits(MINIMAL_UNIT_BODY, MINIMAL_UNIT_BODY);
    execState.systemctlAvailable = true;
    execState.daemonActiveState = "failed";
    execState.daemonSubState = "failed";
    execState.daemonNRestarts = "7";
    execState.daemonExecMainStatus = "1";
    const checks = await collectHostInstallChecks(fakeHome);
    const daemonCheck = checks.find((check) => check.id === "spur-daemon");
    expect(daemonCheck).toMatchObject({ ok: false, severity: "error" });
    expect(daemonCheck?.detail).toContain("failed");
    expect(daemonCheck?.detail).toContain("7");
  });

  it("keeps the plain 'not active' wording for a clean stop (inactive) — no false crash-loop alarm", async () => {
    const fakeHome = await writeFakeUnits(MINIMAL_UNIT_BODY, MINIMAL_UNIT_BODY);
    execState.systemctlAvailable = true;
    execState.daemonActiveState = "inactive";
    const checks = await collectHostInstallChecks(fakeHome);
    const daemonCheck = checks.find((check) => check.id === "spur-daemon");
    expect(daemonCheck).toMatchObject({ ok: false, severity: "error" });
    expect(daemonCheck?.detail).toBe("spur-daemon.service not active");
  });
});

describe("collectHostInstallChecks: C1/C2 worktree/data-dir writability + disk space", () => {
  it("reports worktree-dir-writable error when the write probe fails (EACCES)", async () => {
    const fakeHome = await writeFakeUnits(MINIMAL_UNIT_BODY, MINIMAL_UNIT_BODY);
    const worktreeDir = await mkdtemp(join(tmpdir(), "spur-host-install-worktree-"));
    const dataDir = await mkdtemp(join(tmpdir(), "spur-host-install-data-"));
    await pinInstanceConfig(
      [
        "server:",
        "  host: 127.0.0.1",
        "  port: 4310",
        "",
        `dataDir: ${dataDir}`,
        `worktreeDir: ${worktreeDir}`,
        "",
      ].join("\n"),
    );
    execState.systemctlAvailable = true;
    writeFileSyncMock.mockImplementationOnce(() => {
      throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    });
    const checks = await collectHostInstallChecks(fakeHome);
    expect(checks.find((check) => check.id === "worktree-dir-writable")).toMatchObject({
      ok: false,
      severity: "error",
    });
    // The data-dir probe (the second `writeFileSync` call) is unaffected by
    // the one-shot failure above.
    expect(checks.find((check) => check.id === "data-dir-writable")).toMatchObject({ ok: true });
  });

  it("reports data-dir-disk-space error when df reports near-zero available KB", async () => {
    const fakeHome = await writeFakeUnits(MINIMAL_UNIT_BODY, MINIMAL_UNIT_BODY);
    const worktreeDir = await mkdtemp(join(tmpdir(), "spur-host-install-worktree-"));
    const dataDir = await mkdtemp(join(tmpdir(), "spur-host-install-data-"));
    await pinInstanceConfig(
      [
        "server:",
        "  host: 127.0.0.1",
        "  port: 4310",
        "",
        `dataDir: ${dataDir}`,
        `worktreeDir: ${worktreeDir}`,
        "",
      ].join("\n"),
    );
    execState.systemctlAvailable = true;
    execState.dfKbLine = "/dev/sda1 100000000 99999000 100 99% /";
    const checks = await collectHostInstallChecks(fakeHome);
    expect(checks.find((check) => check.id === "data-dir-disk-space")).toMatchObject({
      ok: false,
      severity: "error",
    });
  });

  it("skips (info) data-dir-disk-space when df is unavailable", async () => {
    const fakeHome = await writeFakeUnits(MINIMAL_UNIT_BODY, MINIMAL_UNIT_BODY);
    const worktreeDir = await mkdtemp(join(tmpdir(), "spur-host-install-worktree-"));
    const dataDir = await mkdtemp(join(tmpdir(), "spur-host-install-data-"));
    await pinInstanceConfig(
      [
        "server:",
        "  host: 127.0.0.1",
        "  port: 4310",
        "",
        `dataDir: ${dataDir}`,
        `worktreeDir: ${worktreeDir}`,
        "",
      ].join("\n"),
    );
    execState.systemctlAvailable = true;
    execState.dfAvailable = false;
    const checks = await collectHostInstallChecks(fakeHome);
    expect(checks.find((check) => check.id === "data-dir-disk-space")).toMatchObject({
      ok: true,
      severity: "info",
    });
  });

  it("reports data-dir-log-bytes warn when du reports usage above the 5GB threshold", async () => {
    const fakeHome = await writeFakeUnits(MINIMAL_UNIT_BODY, MINIMAL_UNIT_BODY);
    const worktreeDir = await mkdtemp(join(tmpdir(), "spur-host-install-worktree-"));
    const dataDir = await mkdtemp(join(tmpdir(), "spur-host-install-data-"));
    await mkdir(join(dataDir, "sessions"));
    await pinInstanceConfig(
      [
        "server:",
        "  host: 127.0.0.1",
        "  port: 4310",
        "",
        `dataDir: ${dataDir}`,
        `worktreeDir: ${worktreeDir}`,
        "",
      ].join("\n"),
    );
    execState.systemctlAvailable = true;
    execState.duKbLine = `6000000\t${join(dataDir, "sessions")}`;
    const checks = await collectHostInstallChecks(fakeHome);
    const check = checks.find((check) => check.id === "data-dir-log-bytes");
    expect(check).toMatchObject({ ok: false, severity: "warn" });
    // The reported total spans both shard families, so the hint must name both
    // knobs — lowering only eventLog.* cannot bring a user-action-heavy dataDir
    // back under the threshold.
    expect(check?.fix).toContain("eventLog.shardHotBytes");
    expect(check?.fix).toContain("eventLog.retainArchives");
    expect(check?.fix).toContain("userActionLog.shardHotBytes");
    expect(check?.fix).toContain("userActionLog.retainArchives");
    // Log growth must never fail `spur doctor` on its own: cli.ts exits 1 only
    // on error severity, and this check tops out at warn.
    expect(hasErrorSeverity(checks.filter((c) => c.id === "data-dir-log-bytes"))).toBe(false);
  });

  it("skips (info) data-dir-log-bytes when du is unavailable", async () => {
    const fakeHome = await writeFakeUnits(MINIMAL_UNIT_BODY, MINIMAL_UNIT_BODY);
    const worktreeDir = await mkdtemp(join(tmpdir(), "spur-host-install-worktree-"));
    const dataDir = await mkdtemp(join(tmpdir(), "spur-host-install-data-"));
    await mkdir(join(dataDir, "sessions"));
    await pinInstanceConfig(
      [
        "server:",
        "  host: 127.0.0.1",
        "  port: 4310",
        "",
        `dataDir: ${dataDir}`,
        `worktreeDir: ${worktreeDir}`,
        "",
      ].join("\n"),
    );
    execState.systemctlAvailable = true;
    execState.duAvailable = false;
    const checks = await collectHostInstallChecks(fakeHome);
    expect(checks.find((check) => check.id === "data-dir-log-bytes")).toMatchObject({
      ok: true,
      severity: "info",
    });
  });

  it("reports data-dir-log-bytes as 0KB (not skipped) when <dataDir>/sessions does not exist yet", async () => {
    const fakeHome = await writeFakeUnits(MINIMAL_UNIT_BODY, MINIMAL_UNIT_BODY);
    const worktreeDir = await mkdtemp(join(tmpdir(), "spur-host-install-worktree-"));
    const dataDir = await mkdtemp(join(tmpdir(), "spur-host-install-data-"));
    await pinInstanceConfig(
      [
        "server:",
        "  host: 127.0.0.1",
        "  port: 4310",
        "",
        `dataDir: ${dataDir}`,
        `worktreeDir: ${worktreeDir}`,
        "",
      ].join("\n"),
    );
    execState.systemctlAvailable = true;
    // du is never invoked here: a fresh instance's <dataDir>/sessions does not
    // exist yet, so it should short-circuit to 0KB instead of reading as "du
    // unavailable or non-numeric".
    execState.duAvailable = false;
    const check = (await collectHostInstallChecks(fakeHome)).find(
      (c) => c.id === "data-dir-log-bytes",
    );
    expect(check).toMatchObject({ ok: true, severity: "warn" });
    expect(check?.detail).not.toContain("skipped");
  });

  it("never pushes worktree/data-dir checks on a never-initialized host (no instance config)", async () => {
    const checks = await collectHostInstallChecks("/tmp/spur-host-install-test-never-init-c");
    expect(checks.find((check) => check.id === "worktree-dir-writable")).toBeUndefined();
    expect(checks.find((check) => check.id === "data-dir-writable")).toBeUndefined();
    expect(checks.find((check) => check.id === "data-dir-disk-space")).toBeUndefined();
    expect(checks.find((check) => check.id === "data-dir-log-bytes")).toBeUndefined();
    expect(hasErrorSeverity(checks)).toBe(false);
  });
});

describe("collectHostInstallChecks: home-disk-headroom", () => {
  it("is ok:false, severity:warn below the default 10GB threshold, and never trips hasErrorSeverity", async () => {
    execState.dfKbLine = "/dev/sda1 100000000 99999000 100 99% /";
    const checks = await collectHostInstallChecks("/tmp/spur-host-install-test-headroom-low");
    expect(checks.find((check) => check.id === "home-disk-headroom")).toMatchObject({
      ok: false,
      severity: "warn",
      fix: "spur cache",
    });
    expect(hasErrorSeverity(checks)).toBe(false);
  });

  it("is ok:true above the threshold", async () => {
    const checks = await collectHostInstallChecks("/tmp/spur-host-install-test-headroom-high");
    expect(checks.find((check) => check.id === "home-disk-headroom")).toMatchObject({
      ok: true,
      severity: "warn",
    });
    expect(hasErrorSeverity(checks)).toBe(false);
  });

  it("is present even when unitsInstalled is false (ungated, unlike data-dir-disk-space)", async () => {
    const checks = await collectHostInstallChecks("/tmp/spur-host-install-test-headroom-ungated");
    expect(checks.find((check) => check.id === "home-disk-headroom")).toBeDefined();
    expect(checks.find((check) => check.id === "data-dir-disk-space")).toBeUndefined();
  });

  it("degrades to ok:true, severity:info when df is unavailable", async () => {
    execState.dfAvailable = false;
    const checks = await collectHostInstallChecks("/tmp/spur-host-install-test-headroom-nodf");
    expect(checks.find((check) => check.id === "home-disk-headroom")).toMatchObject({
      ok: true,
      severity: "info",
    });
  });
});

describe("collectHostInstallChecks: reclaimable-caches", () => {
  function root(
    rootId: CacheRetentionModule.CacheRootId,
    status: CacheRetentionModule.CacheRootMeasurement["status"],
    totalKb: number,
    entryCount: number,
    path: string,
  ): CacheRetentionModule.CacheRootMeasurement {
    return { rootId, path: `/home/user/${path}`, status, totalKb, entryCount };
  }

  it("is present, ok:true, severity:info, ranked by size descending, includes per-root rows", async () => {
    planCachePruneMock.mockResolvedValue({
      generatedAt: new Date(0).toISOString(),
      roots: [
        root("npm-cacache", "measured", 20_000_000, 1, ".npm/_cacache"),
        root("npm-npx", "measured", 1_000_000, 1, ".npm/_npx"),
        root("playwright-browsers", "absent", 0, 0, ".cache/ms-playwright"),
      ],
      candidates: [
        {
          entry: {
            path: "/home/user/.npm/_npx/small",
            rootId: "npm-npx",
            entryClass: { kind: "npx-package", hash: "small" },
            sizeKb: 1_000_000,
            ageDays: 40,
          },
          verdict: { kind: "prunable" },
        },
        {
          entry: {
            path: "/home/user/.npm/_cacache",
            rootId: "npm-cacache",
            entryClass: { kind: "vendor-cache" },
            sizeKb: 20_000_000,
            ageDays: 40,
          },
          verdict: { kind: "prunable" },
        },
        {
          entry: {
            path: "/home/user/.cache/ms-playwright/chromium-1208",
            rootId: "playwright-browsers",
            entryClass: {
              kind: "browser-revision",
              browser: "chromium",
              revision: "1208",
              dirName: "chromium-1208",
            },
            sizeKb: 5_000_000,
            ageDays: 400,
          },
          verdict: {
            kind: "protected",
            reason: { kind: "pinned-revision", dirName: "chromium-1208" },
          },
        },
      ],
      reclaimableKb: 21_000_000,
      processTreeReadable: true,
      pinSourceCount: 1,
    });
    const checks = await collectHostInstallChecks("/tmp/spur-host-install-test-reclaimable-caches");
    const check = checks.find((c) => c.id === "reclaimable-caches");
    expect(check).toMatchObject({ ok: true, severity: "info" });
    expect(hasErrorSeverity(checks)).toBe(false);
    expect(check?.detail).toBe(
      "20.03GB reclaimable across 2 entries (top 2: 19.07GB age 40d /home/user/.npm/_cacache; 0.95GB age 40d /home/user/.npm/_npx/small) — see `spur cache` for the full report; npm-cacache measured 19.07GB 1 /home/user/.npm/_cacache; npm-npx measured 0.95GB 1 /home/user/.npm/_npx; playwright-browsers absent 0.00GB 0 /home/user/.cache/ms-playwright",
    );
  });

  it.each([
    {
      name: "keeps zero-size root rows when no entry is prunable (S13/S15)",
      roots: [
        root("npm-cacache", "measured", 0, 0, ".npm/_cacache"),
        root("npm-npx", "absent", 0, 0, ".npm/_npx"),
      ],
      detail:
        "no reclaimable caches found; npm-cacache measured 0.00GB 0 /home/user/.npm/_cacache; npm-npx absent 0.00GB 0 /home/user/.npm/_npx",
    },
    {
      name: "renders roots: none when the plan has no roots (S15)",
      roots: [],
      detail: "no reclaimable caches found; roots: none",
    },
  ])("$name", async ({ roots, detail }) => {
    planCachePruneMock.mockResolvedValue({
      generatedAt: new Date(0).toISOString(),
      roots,
      candidates: [],
      reclaimableKb: 0,
      processTreeReadable: true,
      pinSourceCount: 1,
    });
    const checks = await collectHostInstallChecks("/tmp/spur-host-install-test-reclaimable-caches");
    expect(checks.find((check) => check.id === "reclaimable-caches")?.detail).toBe(detail);
  });

  it("is present even when unitsInstalled is false (ungated)", async () => {
    const checks = await collectHostInstallChecks(
      "/tmp/spur-host-install-test-reclaimable-caches-ungated",
    );
    expect(checks.find((c) => c.id === "reclaimable-caches")).toBeDefined();
  });

  it("degrades to ok:true, severity:info, 'skipped' detail when planCachePrune exceeds its measurement budget", async () => {
    planCachePruneMock.mockRejectedValue(new Error("ETIMEDOUT"));
    const checks = await collectHostInstallChecks(
      "/tmp/spur-host-install-test-reclaimable-caches-timeout",
    );
    const check = checks.find((c) => c.id === "reclaimable-caches");
    expect(check).toMatchObject({
      ok: true,
      severity: "info",
      detail: "skipped — measurement budget exceeded",
    });
    expect(hasErrorSeverity(checks)).toBe(false);
  });
});

describe("collectHostInstallChecks: sidecar-orphans", () => {
  it("reports ok:true when no leaked sidecar process trees exist", async () => {
    const fakeHome = await writeFakeUnits(MINIMAL_UNIT_BODY, MINIMAL_UNIT_BODY);
    const worktreeDir = await mkdtemp(join(tmpdir(), "spur-host-install-worktree-"));
    const dataDir = await mkdtemp(join(tmpdir(), "spur-host-install-data-"));
    await pinInstanceConfig(
      [
        "server:",
        "  host: 127.0.0.1",
        "  port: 4310",
        "",
        `dataDir: ${dataDir}`,
        `worktreeDir: ${worktreeDir}`,
        "",
      ].join("\n"),
    );
    execState.systemctlAvailable = true;

    const checks = await collectHostInstallChecks(fakeHome);

    expect(checks.find((check) => check.id === "sidecar-orphans")).toMatchObject({
      ok: true,
      severity: "warn",
    });
  });

  it("degrades to ok:true when the worktree dir itself is unreadable, instead of reporting a leak", async () => {
    const fakeHome = await writeFakeUnits(MINIMAL_UNIT_BODY, MINIMAL_UNIT_BODY);
    const dataDir = await mkdtemp(join(tmpdir(), "spur-host-install-data-"));
    await pinInstanceConfig(
      [
        "server:",
        "  host: 127.0.0.1",
        "  port: 4310",
        "",
        `dataDir: ${dataDir}`,
        "worktreeDir: /nonexistent/spur-host-install-worktree-dir",
        "",
      ].join("\n"),
    );
    execState.systemctlAvailable = true;

    const checks = await collectHostInstallChecks(fakeHome);

    expect(checks.find((check) => check.id === "sidecar-orphans")).toMatchObject({
      ok: true,
      severity: "warn",
      detail: "sidecar-orphans: worktree dir unreadable, sweep skipped",
    });
  });

  it("never writes or signals — collectHostInstallChecks stays read-only", async () => {
    const fakeHome = await writeFakeUnits(MINIMAL_UNIT_BODY, MINIMAL_UNIT_BODY);
    const worktreeDir = await mkdtemp(join(tmpdir(), "spur-host-install-worktree-"));
    const dataDir = await mkdtemp(join(tmpdir(), "spur-host-install-data-"));
    await pinInstanceConfig(
      [
        "server:",
        "  host: 127.0.0.1",
        "  port: 4310",
        "",
        `dataDir: ${dataDir}`,
        `worktreeDir: ${worktreeDir}`,
        "",
      ].join("\n"),
    );
    execState.systemctlAvailable = true;
    const killSpy = vi.spyOn(process, "kill");

    await collectHostInstallChecks(fakeHome);

    expect(killSpy).not.toHaveBeenCalled();
    killSpy.mockRestore();
  });
});

describe("collectHostInstallChecks: E2 web-ui-port-drift", () => {
  it("warns when configured ui.port differs from the web unit's actual PORT", async () => {
    const fakeHome = await writeFakeUnits(MINIMAL_UNIT_BODY, "[Service]\nEnvironment=PORT=4311\n");
    await pinInstanceConfig(
      ["server:", "  host: 127.0.0.1", "  port: 4310", "", "ui:", "  port: 5555", ""].join("\n"),
    );
    execState.systemctlAvailable = true;
    const checks = await collectHostInstallChecks(fakeHome);
    expect(checks.find((check) => check.id === "web-ui-port-drift")).toMatchObject({
      ok: false,
      severity: "warn",
    });
  });

  it("reports ok:true when configured ui.port matches the web unit's actual PORT", async () => {
    const fakeHome = await writeFakeUnits(MINIMAL_UNIT_BODY, "[Service]\nEnvironment=PORT=4311\n");
    await pinInstanceConfig(
      ["server:", "  host: 127.0.0.1", "  port: 4310", "", "ui:", "  port: 4311", ""].join("\n"),
    );
    execState.systemctlAvailable = true;
    const checks = await collectHostInstallChecks(fakeHome);
    expect(checks.find((check) => check.id === "web-ui-port-drift")).toMatchObject({
      ok: true,
      severity: "warn",
    });
  });
});

describe("collectHostInstallChecks: F1 corrupt instance config", () => {
  it("surfaces instance-config-corrupt without throwing, while the daemon probe still falls back to the default port", async () => {
    await pinInstanceConfig("server:\n  host: 127.0.0.1\nprojects: [unclosed\n");
    const checks = await collectHostInstallChecks("/tmp/spur-host-install-test-f1");
    expect(checks.find((check) => check.id === "instance-config-corrupt")).toMatchObject({
      ok: false,
      severity: "error",
    });
    expect(hasErrorSeverity(checks)).toBe(true);
    // Single-owner invariant: a corrupt config must not cascade a second,
    // derived C1/C2/E2 error from garbage values.
    expect(checks.find((check) => check.id === "worktree-dir-writable")).toBeUndefined();
    expect(checks.find((check) => check.id === "data-dir-writable")).toBeUndefined();
    expect(checks.find((check) => check.id === "data-dir-disk-space")).toBeUndefined();
    expect(checks.find((check) => check.id === "data-dir-log-bytes")).toBeUndefined();
    expect(checks.find((check) => check.id === "web-ui-port-drift")).toBeUndefined();
    expect(probeInfoMock).toHaveBeenCalledWith(
      expect.objectContaining({ url: expect.stringContaining(":4310/info") }),
    );
  });
});

describe("checkVersionDrift", () => {
  it("stays silent when the daemon was not reachable", () => {
    expect(checkVersionDrift(undefined)).toBeUndefined();
  });

  it("flags a warn-severity drift when the daemon version differs from the installed one", () => {
    const result = checkVersionDrift("0.0.0-does-not-match");
    expect(result).toMatchObject({ id: "version-drift", ok: false, severity: "warn" });
  });

  // In this dev/test checkout `v2/package.json` carries the managed
  // placeholder, so `getVersion()` always resolves through the git-describe
  // fallback here -- never a bare "x.y.z" release string. That's exactly the
  // source-checkout shape `spur update`'s `assertNotSourceCheckout` guard
  // refuses to run against, so the suggested fix must not be `spur update`.
  it("suggests the repo deploy flow instead of `spur update` when the installed version isn't a release", () => {
    const result = checkVersionDrift("0.0.0-does-not-match");
    expect(result).toMatchObject({ fix: "pull latest and redeploy" });
  });

  it("reports ok:true when versions match", () => {
    const result = checkVersionDrift(version);
    expect(result).toMatchObject({ ok: true, severity: "warn" });
  });
});

describe("hasErrorSeverity", () => {
  it("is false when no failing check carries error severity", () => {
    expect(
      hasErrorSeverity([
        { id: "a", ok: false, severity: "warn", detail: "" },
        { id: "b", ok: true, severity: "error", detail: "" },
      ]),
    ).toBe(false);
  });

  it("is true when any failing check carries error severity", () => {
    expect(
      hasErrorSeverity([
        { id: "a", ok: false, severity: "warn", detail: "" },
        { id: "b", ok: false, severity: "error", detail: "" },
      ]),
    ).toBe(true);
  });
});

describe("spur doctor --json: config-registry per-path listing", () => {
  const originalHome = process.env["HOME"];
  const originalExitCode = process.exitCode;

  afterEach(() => {
    if (originalHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = originalHome;
    process.exitCode = originalExitCode;
    resolveDoctorRepoRootMock.mockReset();
  });

  it("carries the config-registry per-path array through to the JSON doctor output", async () => {
    // `collectHostInstallChecks()` is called with no argument from the real
    // `doctor` action (it always inspects the live host, never a param), so
    // this test steers it via `$HOME` (which `os.homedir()` honors, see the
    // comment on `collectHostInstallChecks`) rather than injecting a home
    // directly — the only lever the CLI wiring actually exposes.
    const fakeHome = await writeFakeUnits(MINIMAL_UNIT_BODY, MINIMAL_UNIT_BODY);
    process.env["HOME"] = fakeHome;

    const rootDir = await mkdtemp(join(tmpdir(), "spur-doctor-cli-registry-"));
    const dataDir = join(rootDir, "data");
    const worktreeDir = join(rootDir, "worktrees");
    await mkdir(dataDir, { recursive: true });
    await mkdir(worktreeDir, { recursive: true });
    const livePath = join(rootDir, "live.yaml");
    await writeFile(livePath, "stub: true\n", "utf8");
    const deadPath = join(rootDir, "missing.yaml");
    await writeFile(
      join(dataDir, "config-registry.json"),
      JSON.stringify({ configPaths: [livePath, deadPath], unconfiguredProjects: [] }),
      "utf8",
    );
    await pinInstanceConfig(
      [
        "server:",
        "  host: 127.0.0.1",
        "  port: 4310",
        "",
        `dataDir: ${dataDir}`,
        `worktreeDir: ${worktreeDir}`,
        "",
      ].join("\n"),
    );

    // Steers `resolveDoctorRepoRoot` away from this real checkout's own
    // `spur.yaml` (which would otherwise pull the heavy project-config
    // validation branch in) toward an empty directory, so the CLI action
    // takes the plain `{ hostChecks, configRegistryPaths }` return path.
    const emptyWorkspaceRoot = await mkdtemp(join(tmpdir(), "spur-doctor-cli-workspace-"));
    resolveDoctorRepoRootMock.mockResolvedValue(emptyWorkspaceRoot);

    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await createProgram("/tmp/dist/cli.js").parseAsync(["node", "spur", "doctor", "--json"]);
    const output = writeSpy.mock.calls.map((call) => String(call[0])).join("");
    writeSpy.mockRestore();

    const parsed = JSON.parse(output) as {
      configRegistryPaths?: Array<{ path: string; state: string }>;
    };
    expect(parsed.configRegistryPaths).toEqual(
      expect.arrayContaining([
        { path: livePath, state: "alive" },
        { path: deadPath, state: "dead" },
      ]),
    );
  });
});

describe("renderHostInstallChecks", () => {
  it("always renders a passing check as [ok], and a failing check by its own severity", () => {
    const output = renderHostInstallChecks([
      { id: "a", ok: true, severity: "error", detail: "a is fine" },
      { id: "b", ok: false, severity: "error", detail: "b is broken", fix: "fix b" },
      { id: "c", ok: false, severity: "warn", detail: "c is iffy" },
      { id: "d", ok: false, severity: "info", detail: "d is skipped" },
    ]);
    const lines = output.split("\n");
    expect(lines[0]).toContain("[ok] a is fine");
    expect(lines[1]).toContain("[error] b is broken");
    expect(lines[1]).toContain("fix: fix b");
    expect(lines[2]).toContain("[warn] c is iffy");
    expect(lines[3]).toContain("[info] d is skipped");
  });
});
