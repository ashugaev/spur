import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as UpdateHealth from "../../src/update-health.js";
import { createTempDir } from "../helpers/common.js";

const { unitMainPidMock } = vi.hoisted(() => ({ unitMainPidMock: vi.fn() }));

vi.mock("../../src/update-health.js", async () => {
  const actual = await vi.importActual<typeof UpdateHealth>("../../src/update-health.js");
  return { ...actual, unitMainPidWith: unitMainPidMock };
});

import { createRealUpdateDeps } from "../../src/update.js";

describe("createRealUpdateDeps probe", () => {
  let entrypoint: string;
  let packagePath: string;
  let statePath: string;

  beforeEach(async () => {
    const home = await createTempDir("spur-update-probe-");
    vi.stubEnv("HOME", home);
    vi.stubEnv("XDG_CONFIG_HOME", join(home, ".config"));
    vi.stubEnv("SPUR_CONFIG", join(home, "config.yaml"));
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
});
