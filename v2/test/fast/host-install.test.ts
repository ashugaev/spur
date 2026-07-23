import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as ChildProcess from "node:child_process";
import type * as FsModule from "node:fs";
import type * as OsModule from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as PortProbe from "../../src/port-probe.js";
import type * as UpdateHealth from "../../src/update-health.js";

const {
  execFileSyncMock,
  platformMock,
  probeMock,
  probeInfoMock,
  isHostPortFreeMock,
  findListenerPidsMock,
  writeFileSyncMock,
} = vi.hoisted(() => ({
  execFileSyncMock: vi.fn(),
  platformMock: vi.fn(),
  probeMock: vi.fn(),
  probeInfoMock: vi.fn(),
  isHostPortFreeMock: vi.fn(),
  findListenerPidsMock: vi.fn(),
  writeFileSyncMock: vi.fn(),
}));

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
  return { ...actual, probe: probeMock, probeInfo: probeInfoMock };
});

vi.mock("../../src/port-probe.js", async () => {
  const actual = await vi.importActual<typeof PortProbe>("../../src/port-probe.js");
  return { ...actual, isHostPortFree: isHostPortFreeMock, findListenerPids: findListenerPidsMock };
});

import {
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
import { version } from "../../src/version.js";

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
  isHostPortFreeMock.mockReset();
  isHostPortFreeMock.mockResolvedValue(true);
  findListenerPidsMock.mockReset();
  findListenerPidsMock.mockResolvedValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
  if (initialSpurConfig === undefined) {
    delete process.env["SPUR_CONFIG"];
  } else {
    process.env["SPUR_CONFIG"] = initialSpurConfig;
  }
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

  it("never pushes worktree/data-dir checks on a never-initialized host (no instance config)", async () => {
    const checks = await collectHostInstallChecks("/tmp/spur-host-install-test-never-init-c");
    expect(checks.find((check) => check.id === "worktree-dir-writable")).toBeUndefined();
    expect(checks.find((check) => check.id === "data-dir-writable")).toBeUndefined();
    expect(checks.find((check) => check.id === "data-dir-disk-space")).toBeUndefined();
    expect(hasErrorSeverity(checks)).toBe(false);
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
