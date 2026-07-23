import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as ChildProcess from "node:child_process";
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
} = vi.hoisted(() => ({
  execFileSyncMock: vi.fn(),
  platformMock: vi.fn(),
  probeMock: vi.fn(),
  probeInfoMock: vi.fn(),
  isHostPortFreeMock: vi.fn(),
  findListenerPidsMock: vi.fn(),
}));

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof ChildProcess>("node:child_process");
  return { ...actual, execFileSync: execFileSyncMock };
});

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof OsModule>("node:os");
  return { ...actual, platform: platformMock };
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
}

let execState: ExecState;

beforeEach(() => {
  execState = {
    tmuxOk: true,
    gitOk: true,
    lingerOk: false,
    systemctlAvailable: false,
    daemonActiveState: "inactive",
    webActiveState: "inactive",
    daemonMainPid: "0",
    webMainPid: "0",
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
      return "";
    }
    throw new Error(`unexpected exec: ${file} ${args.join(" ")}`);
  });

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
