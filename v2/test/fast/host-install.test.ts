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
      return "";
    }
    throw new Error(`unexpected exec: ${file} ${args.join(" ")}`);
  });

  platformMock.mockReset();
  platformMock.mockReturnValue("linux");

  probeMock.mockReset();
  probeMock.mockResolvedValue({ ok: false, reason: "connection-refused" });
  probeInfoMock.mockReset();
  probeInfoMock.mockResolvedValue(undefined);
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
    expect(checks.find((check) => check.id === "node-version")).toMatchObject({
      ok: true,
      severity: "info",
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

  it("marks spur-daemon/spur-web as error severity once systemd units are installed", async () => {
    const fakeHome = await mkdtemp(join(tmpdir(), "spur-host-install-units-"));
    const unitDir = join(fakeHome, ".config", "systemd", "user");
    await mkdir(unitDir, { recursive: true });
    await writeFile(join(unitDir, "spur-daemon.service"), "[Service]\n", "utf8");
    await writeFile(join(unitDir, "spur-web.service"), "[Service]\n", "utf8");
    execState.systemctlAvailable = true;
    execState.daemonActiveState = "inactive";
    execState.webActiveState = "active";

    const checks = await collectHostInstallChecks(fakeHome);

    expect(checks.find((check) => check.id === "spur-daemon")).toMatchObject({
      ok: false,
      severity: "error",
    });
    expect(checks.find((check) => check.id === "spur-web")).toMatchObject({
      ok: true,
      severity: "error",
    });
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
      expect(checkSpurOnPath(prefix)).toMatchObject({ ok: true, severity: "info" });
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

  it("reports error severity when the service is active but the HTTP probe is unreachable", async () => {
    probeMock.mockResolvedValue({ ok: false, reason: "connection-refused" });
    const result = await checkServiceHealth(scope, true, true);
    expect(result.checks.find((check) => check.id === "daemon-reachable")).toMatchObject({
      ok: false,
      severity: "error",
    });
    expect(result.daemonReachable).toBe(false);
  });

  it("reports a port-conflict check whose detail includes the foreign PID", async () => {
    probeMock.mockResolvedValue({ ok: false, reason: "connection-refused" });
    isHostPortFreeMock.mockResolvedValue(false);
    findListenerPidsMock.mockResolvedValue([4242]);
    const result = await checkServiceHealth(scope, false, false);
    const conflict = result.checks.find((check) => check.id === "daemon-port-conflict");
    expect(conflict).toBeDefined();
    expect(conflict?.ok).toBe(false);
    expect(conflict?.severity).toBe("error");
    expect(conflict?.detail).toContain("4242");
  });

  it("reports warn severity when the service simply has not started yet", async () => {
    probeMock.mockResolvedValue({ ok: false, reason: "connection-refused" });
    isHostPortFreeMock.mockResolvedValue(true);
    const result = await checkServiceHealth(scope, false, false);
    expect(result.checks.find((check) => check.id === "daemon-reachable")).toMatchObject({
      ok: false,
      severity: "warn",
    });
  });

  it("marks the daemon reachable when the probe succeeds", async () => {
    probeMock.mockResolvedValue({ ok: true });
    const result = await checkServiceHealth(scope, false, false);
    expect(result.daemonReachable).toBe(true);
    expect(result.checks.find((check) => check.id === "daemon-reachable")).toMatchObject({
      ok: true,
      severity: "info",
    });
  });
});

describe("checkVersionDrift", () => {
  it("stays silent when the daemon was not reachable", async () => {
    const result = await checkVersionDrift(false, 4310);
    expect(result).toBeUndefined();
    expect(probeInfoMock).not.toHaveBeenCalled();
  });

  it("stays silent when the version info can't be resolved", async () => {
    probeInfoMock.mockResolvedValue(undefined);
    expect(await checkVersionDrift(true, 4310)).toBeUndefined();
  });

  it("flags a warn-severity drift when the daemon version differs from the installed one", async () => {
    probeInfoMock.mockResolvedValue({ version: "0.0.0-does-not-match" });
    const result = await checkVersionDrift(true, 4310);
    expect(result).toMatchObject({ id: "version-drift", ok: false, severity: "warn" });
  });

  it("reports ok:true when versions match", async () => {
    probeInfoMock.mockResolvedValue({ version });
    const result = await checkVersionDrift(true, 4310);
    expect(result).toMatchObject({ ok: true, severity: "info" });
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
