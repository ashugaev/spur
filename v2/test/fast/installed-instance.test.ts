import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as ChildProcess from "node:child_process";
import type * as CacheRetention from "../../src/cache-retention.js";
import type * as InstalledInstance from "../../src/installed-instance.js";
import type * as PortProbe from "../../src/port-probe.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { execFileSyncMock, execFileMock, planCachePruneMock } = vi.hoisted(() => ({
  execFileSyncMock: vi.fn(),
  execFileMock: vi.fn(() => {
    throw new Error("Unexpected process execution in installed-instance fixture");
  }),
  planCachePruneMock: vi.fn(),
}));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof ChildProcess>()),
  execFileSync: execFileSyncMock,
  execFile: execFileMock,
}));
vi.mock("../../src/cache-retention.js", async (original) => ({
  ...(await original<typeof CacheRetention>()),
  planCachePrune: planCachePruneMock,
}));
vi.mock("../../src/port-probe.js", async (original) => ({
  ...(await original<typeof PortProbe>()),
  isHostPortFree: async () => true,
}));
let directory: string;
let api: typeof InstalledInstance;
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "spur-installed-instance-"));
  vi.stubEnv("HOME", directory);
  vi.stubEnv("SPUR_CONFIG", "");
  execFileSyncMock.mockReset();
  execFileMock.mockClear();
  planCachePruneMock.mockReset();
  planCachePruneMock.mockResolvedValue({
    generatedAt: new Date(0).toISOString(),
    roots: [],
    candidates: [],
    reclaimableKb: 0,
    processTreeReadable: true,
    pinSourceCount: 0,
  } satisfies CacheRetention.CachePlan);
  vi.resetModules();
  api = await import("../../src/installed-instance.js");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});
function config(name = "custom.yaml", body = "server:\n  port: 43210\n") {
  const path = join(directory, name);
  writeFileSync(path, body);
  return path;
}
function options() {
  return {
    home: directory,
    workingDirectory: directory,
    scope: "user" as const,
    daemonEnvFile: join(directory, "daemon.env"),
    daemonUnitPath: join(directory, "spur-daemon.service"),
    configModulePath: join(directory, "dist", "config.js"),
  };
}

describe("installed instance selection", () => {
  it("prioritizes explicit config, invocation env, then strict private receipt", () => {
    const first = config("first.yaml");
    const second = config("second.yaml");
    api.writeInstalledInstance(first);
    expect(api.resolveInstallationConfig(options())).toBe(first);
    vi.stubEnv("SPUR_CONFIG", second);
    expect(api.resolveInstallationConfig(options())).toBe(second);
    expect(api.resolveInstallationConfig({ ...options(), configPath: first })).toBe(first);
    vi.stubEnv("SPUR_CONFIG", "");
    const receipt = api.installedInstanceReceiptPath();
    chmodSync(receipt, 0o644);
    expect(() => api.resolveInstallationConfig(options())).toThrow("private");
    expect(api.resolveInstallationConfig({ ...options(), configPath: second })).toBe(second);
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it.each(["user", "system"] as const)(
    "uses systemd environment parsing for %s legacy selection",
    (scope) => {
      const selected = config('with space % $ " quote.yaml');
      writeFileSync(
        options().daemonEnvFile,
        "SPUR_CONFIG=relative.yaml\nSECRET_SENTINEL=private\n",
      );
      execFileSyncMock.mockReturnValue(JSON.stringify(selected));
      expect(
        api.resolveInstallationConfig({ ...options(), scope, serviceUser: "service-account" }),
      ).toBe(selected);
      const [command, argv, settings] = execFileSyncMock.mock.calls[0] as [
        string,
        string[],
        { timeout: number; maxBuffer: number },
      ];
      expect(command).toBe(scope === "system" ? "sudo" : "systemd-run");
      expect(argv).toContain("--expand-environment=no");
      expect(argv).toContain(`WorkingDirectory=${directory}`);
      expect(argv).toContain(`Environment=HOME=${directory}`);
      expect(argv).toContain(
        `EnvironmentFile=${scope === "user" ? "-" : ""}${options().daemonEnvFile}`,
      );
      expect(argv.join(" ")).not.toContain("SECRET_SENTINEL");
      expect(settings).toMatchObject({ timeout: 10_000, maxBuffer: 16_384 });
      expect(existsSync(api.installedInstanceReceiptPath())).toBe(false);
    },
  );

  it("refuses missing receipt for existing argv pin, invalid JSON and failed probe before writes", () => {
    writeFileSync(
      options().daemonUnitPath,
      "ExecStart=/usr/bin/node /package/cli.js --config /selected.yaml daemon start\n",
    );
    expect(() => api.resolveInstallationConfig(options())).toThrow("--config <existing-path>");
    rmSync(options().daemonUnitPath);
    writeFileSync(options().daemonEnvFile, "SPUR_CONFIG=relative.yaml\n");
    execFileSyncMock.mockReturnValue("not-json");
    expect(() => api.resolveInstallationConfig(options())).toThrow("invalid output");
    execFileSyncMock.mockImplementation(() => {
      throw new Error("private diagnostics");
    });
    expect(() => api.resolveInstallationConfig(options())).toThrow(
      "existing installation was preserved",
    );
    expect(existsSync(api.installedInstanceReceiptPath())).toBe(false);
    expect(existsSync(join(directory, ".spur", "config.yaml"))).toBe(false);
  });

  it("selects fresh default read-only then bootstraps only installer before port migration", async () => {
    const path = api.resolveInstallationConfig(options());
    expect(path).toBe(join(directory, ".spur", "config.yaml"));
    expect(existsSync(path)).toBe(false);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("fixture has no services")));
    const { collectHostInstallChecks } = await import("../../src/host-install.js");
    const checks = await collectHostInstallChecks(directory);
    expect(checks.find((check) => check.id === "systemd-units")).toMatchObject({ ok: false });
    expect(planCachePruneMock).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ home: directory, signal: expect.any(AbortSignal) }),
    );
    expect(checks.find((check) => check.id === "reclaimable-caches")).toMatchObject({
      ok: true,
      detail: expect.stringContaining("no reclaimable caches found"),
    });
    expect(execFileMock).not.toHaveBeenCalled();
    expect(existsSync(path)).toBe(false);
    expect(api.prepareInstallationConfig(path, 4311).mcp.port).toBe(4312);
    expect(readFileSync(path, "utf8")).toContain("mcp:");
  });

  it("migrates only omitted MCP port for actual web collision; explicit collision preserves file", () => {
    const path = config("comments.yaml", "# preserve\nserver:\n  port: 4310\nui:\n  port: 4311\n");
    expect(api.prepareInstallationConfig(path, 4312).mcp.port).toBe(4313);
    expect(readFileSync(path, "utf8")).toContain("# preserve");
    const explicit = config("explicit.yaml", "mcp:\n  port: 43211\n");
    const prior = readFileSync(explicit, "utf8");
    expect(() => api.prepareInstallationConfig(explicit, 43211)).toThrow(
      "installed web listen port",
    );
    expect(readFileSync(explicit, "utf8")).toBe(prior);
  });

  it("selects and migrates connection fields without resolving daemon-only source secrets", () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", undefined);
    const selected = config(
      "secret.yaml",
      `# retained\nserver:\n  port: 4311\nui:\n  port: 4312\nprojects:\n  test:\n    path: ${directory}\n    sources:\n      telegram:\n        type: telegram\n        token: \${TELEGRAM_BOT_TOKEN}\n        allowedUsers: [123]\n`,
    );
    api.writeInstalledInstance(selected);
    expect(api.resolveInstallationConfig(options())).toBe(selected);
    expect(api.prepareInstallationConfig(selected, 4313)).toMatchObject({
      configPath: selected,
      server: { port: 4311 },
      mcp: { port: 4314 },
    });
    expect(readFileSync(selected, "utf8")).toContain("${TELEGRAM_BOT_TOKEN}");
    expect(process.env["TELEGRAM_BOT_TOKEN"]).toBeUndefined();
    expect(execFileSyncMock).not.toHaveBeenCalled();
    const invalid = config("invalid.yaml", "mcp:\n  port: wrong\n");
    expect(() => api.resolveInstallationConfig({ ...options(), configPath: invalid })).toThrow(
      "mcp.port",
    );
    expect(() => api.prepareInstallationConfig(invalid, 4313)).toThrow("mcp.port");
    expect(readFileSync(invalid, "utf8")).toBe("mcp:\n  port: wrong\n");
    expect(api.readInstalledInstancePath()).toBe(selected);
  });

  it("rejects malformed, expanded or unknown receipt shapes", () => {
    mkdirSync(join(directory, ".spur"));
    for (const value of [
      { configPath: "relative.yaml" },
      { configPath: "/path\n" },
      { configPath: "/path", extra: true },
      [],
    ]) {
      writeFileSync(api.installedInstanceReceiptPath(), JSON.stringify(value), { mode: 0o600 });
      expect(() => api.readInstalledInstancePath()).toThrow();
    }
  });

  it("pins literal service argv and web env without secret environment files", () => {
    const path = '/instance space/%/$VALUE/"quoted"/back\\slash/config.yaml';
    const argument = api.quoteSystemdArgument(path);
    expect(argument).toContain("%%");
    expect(argument).toContain("$$VALUE");
    expect(argument).toContain('\\"quoted\\"');
    expect(argument).toContain("back\\\\slash");
    const unit = "ExecStart=/usr/bin/node /package/dist/cli.js mcp --http\n";
    expect(api.renderPinnedUnit(unit, path)).toBe(
      `ExecStart=/usr/bin/node /package/dist/cli.js --config ${argument} mcp --http\n`,
    );
    expect(api.renderPinnedUnit("ExecStart=/usr/bin/pnpm ui:start\n", path, true)).toContain(
      `/usr/bin/env ${api.quoteSystemdArgument(`SPUR_CONFIG=${path}`)} /usr/bin/pnpm ui:start`,
    );
    expect(() => api.quoteSystemdArgument("/newline\n")).toThrow("control");
  });
});
