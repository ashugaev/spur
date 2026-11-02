import { chmod, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as UpdateHealth from "../../src/update-health.js";
import type * as BuildIdentity from "../../src/build-identity.js";
import { SPUR_DAEMON_API_VERSION } from "../../src/types.js";
import { createTempDir } from "../helpers/common.js";

const { unitMainPidMock } = vi.hoisted(() => ({ unitMainPidMock: vi.fn() }));

vi.mock("../../src/update-health.js", async () => {
  const actual = await vi.importActual<typeof UpdateHealth>("../../src/update-health.js");
  return { ...actual, unitMainPidWith: unitMainPidMock };
});

vi.mock("../../src/build-identity.js", async () => {
  const actual = await vi.importActual<typeof BuildIdentity>("../../src/build-identity.js");
  return { ...actual, computeBuildId: () => "selected-build" };
});

import { createRealUpdateDeps } from "../../src/update.js";

describe("createRealUpdateDeps probe", () => {
  let entrypoint: string;
  let packagePath: string;
  let statePath: string;
  let configPath: string;

  beforeEach(async () => {
    const home = await createTempDir("spur-update-probe-");
    vi.stubEnv("HOME", home);
    vi.stubEnv("XDG_CONFIG_HOME", join(home, ".config"));
    configPath = join(home, "config.yaml");
    vi.stubEnv("SPUR_CONFIG", configPath);
    const packageRoot = join(home, "node_modules", "@shugaev", "spur");
    await mkdir(join(packageRoot, "dist"), { recursive: true });
    entrypoint = join(packageRoot, "dist", "cli.js");
    packagePath = join(packageRoot, "package.json");
    statePath = join(home, "rollback-state.json");
    await writeFile(entrypoint, "");
    unitMainPidMock.mockReset().mockResolvedValue(42);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it.each([
    { installed: "1.2.0", live: "1.2.0", pid: 42, mainPid: 42, ok: true },
    { installed: "1.2.0", live: "1.1.0", pid: 42, mainPid: 42, ok: false },
    { installed: "1.2.0", live: "1.2.0", pid: 99, mainPid: 42, ok: false },
    { installed: "1.2.0", live: "1.2.0", pid: 42, mainPid: undefined, ok: false },
    { installed: "0.0.0-managed", live: "0.0.0-dev", pid: 42, mainPid: 42, ok: true },
    { installed: "0.0.0-managed", live: "0.0.0-dev", pid: 99, mainPid: 42, ok: false },
    { installed: "1.2.0", live: "0.0.0-dev", pid: 42, mainPid: 42, ok: false },
  ])("checks installed=$installed live=$live pid=$pid MainPID=$mainPid", async (sample) => {
    await writeFile(packagePath, JSON.stringify({ version: sample.installed }));
    unitMainPidMock.mockResolvedValue(sample.mainPid);
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockImplementation(async () => Response.json({ version: sample.live, pid: sample.pid })),
    );
    const deps = createRealUpdateDeps(entrypoint, statePath);

    expect(await deps.probe({ id: "daemon", url: "http://127.0.0.1:12345/info" })).toEqual(
      sample.ok ? { ok: true } : { ok: false, reason: "identity-mismatch" },
    );
  });

  it("reads the installed version again after an install changes package.json", async () => {
    await writeFile(packagePath, JSON.stringify({ version: "1.2.0" }));
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () => Response.json({ version: "1.2.0", pid: 42 })),
    );
    const deps = createRealUpdateDeps(entrypoint, statePath);
    const target = { id: "daemon", url: "http://127.0.0.1:12345/info" } as const;

    expect(await deps.probe(target)).toEqual({ ok: true });
    await writeFile(packagePath, JSON.stringify({ version: "1.3.0" }));
    expect(await deps.probe(target)).toEqual({ ok: false, reason: "identity-mismatch" });
  });

  it("keeps web readiness as an HTTP probe without requiring a daemon PID", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("web ready")));
    const deps = createRealUpdateDeps(entrypoint, statePath);

    expect(await deps.probe({ id: "web", url: "http://127.0.0.1:12346/" })).toEqual({ ok: true });
    expect(unitMainPidMock).not.toHaveBeenCalled();
  });

  it.each([
    { name: "matching identity", patch: {}, mainPid: 42, ok: true },
    { name: "missing build", patch: { buildId: undefined }, mainPid: 42, ok: false },
    { name: "wrong build", patch: { buildId: "old-build" }, mainPid: 42, ok: false },
    { name: "missing API", patch: { apiVersion: undefined }, mainPid: 42, ok: false },
    { name: "wrong API", patch: { apiVersion: -1 }, mainPid: 42, ok: false },
    { name: "missing config", patch: { configPath: undefined }, mainPid: 42, ok: false },
    { name: "wrong config", patch: { configPath: "different.yaml" }, mainPid: 42, ok: false },
    { name: "wrong PID", patch: { pid: 99 }, mainPid: 42, ok: false },
    { name: "missing PID", patch: { pid: undefined }, mainPid: 42, ok: false },
    { name: "missing MainPID", patch: {}, mainPid: undefined, ok: false },
    { name: "wrong version", patch: { version: "1.1.0" }, mainPid: 42, ok: false },
  ])("requires selected instance $name", async ({ patch, mainPid, ok }) => {
    await writeFile(configPath, "server:\n  port: 43218\n");
    await writeFile(packagePath, JSON.stringify({ version: "1.2.0" }));
    unitMainPidMock.mockResolvedValue(mainPid);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () =>
        Response.json({
          version: "1.2.0",
          pid: 42,
          buildId: "selected-build",
          apiVersion: SPUR_DAEMON_API_VERSION,
          configPath,
          ...patch,
        }),
      ),
    );
    const deps = createRealUpdateDeps(entrypoint, statePath);
    expect(await deps.probe({ id: "daemon", url: "http://127.0.0.1:12345/info" })).toEqual(
      ok ? { ok: true } : { ok: false, reason: "identity-mismatch" },
    );
    expect(await readFile(configPath, "utf8")).toBe("server:\n  port: 43218\n");
  });

  it("rejects invalid selected configuration before any probe without rewriting it", async () => {
    const invalid = "mcp:\n  port: invalid\n";
    await writeFile(configPath, invalid);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(() => createRealUpdateDeps(entrypoint, statePath)).toThrow("mcp.port");
    expect(await readFile(configPath, "utf8")).toBe(invalid);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(unitMainPidMock).not.toHaveBeenCalled();
  });

  it("rejects malformed and nonprivate installed receipts instead of using legacy mode", async () => {
    vi.stubEnv("SPUR_CONFIG", undefined);
    const home = process.env["HOME"];
    if (!home) throw new Error("Missing fixture home");
    const directory = join(home, ".spur");
    await mkdir(directory);
    const receipt = join(directory, "installed-instance.json");
    const invalid = '{"configPath":"relative.yaml"}';
    await writeFile(receipt, invalid, { mode: 0o600 });
    expect(() => createRealUpdateDeps(entrypoint, statePath)).toThrow("absolute");
    await chmod(receipt, 0o644);
    expect(() => createRealUpdateDeps(entrypoint, statePath)).toThrow("private");
    expect(await readFile(receipt, "utf8")).toBe(invalid);
    await chmod(receipt, 0o600);
    await writeFile(receipt, "{");
    expect(() => createRealUpdateDeps(entrypoint, statePath)).toThrow("receipt is invalid");
    expect(await readFile(receipt, "utf8")).toBe("{");
    expect(await readdir(directory)).toEqual(["installed-instance.json"]);
    expect(unitMainPidMock).not.toHaveBeenCalled();
  });
});
