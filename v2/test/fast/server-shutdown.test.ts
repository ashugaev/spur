import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readEventLog } from "../../src/event-log.js";
import { armShutdownBackstop, summarizeActiveResources } from "../../src/server.js";
import { findFreePort } from "../helpers/common.js";

const hangingSourcesStop = vi.hoisted(() => ({ enabled: false }));

vi.mock("../../src/event-sources/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/event-sources/index.js")>();
  return {
    ...actual,
    startConfiguredSources: async (deps: Parameters<typeof actual.startConfiguredSources>[0]) => {
      const controller = await actual.startConfiguredSources(deps);
      if (!hangingSourcesStop.enabled) return controller;
      return { stop: () => new Promise<void>(() => undefined) };
    },
  };
});

async function writeDaemonConfig(): Promise<{ configPath: string; dataDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "spur-shutdown-test-"));
  const repoDir = join(root, "repo");
  const dataDir = join(root, "data");
  const worktreeDir = join(root, "worktrees");
  const port = await findFreePort();
  await mkdir(repoDir, { recursive: true });
  const configPath = join(root, "spur.yaml");
  await writeFile(
    configPath,
    [
      "server:",
      "  host: 127.0.0.1",
      `  port: ${port}`,
      `dataDir: ${dataDir}`,
      `worktreeDir: ${worktreeDir}`,
      "projects:",
      "  demo:",
      `    path: ${repoDir}`,
    ].join("\n"),
    "utf8",
  );
  return { configPath, dataDir };
}

describe("summarizeActiveResources", () => {
  it("counts live handles by kind", () => {
    const timer = setInterval(() => undefined, 60_000);
    try {
      const summary = summarizeActiveResources();
      expect(summary["Timeout"]).toBeGreaterThanOrEqual(1);
    } finally {
      clearInterval(timer);
    }
  });
});

describe("armShutdownBackstop", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires with the active-resource summary once the timeout elapses", async () => {
    vi.useFakeTimers();
    const onForceExit = vi.fn();
    armShutdownBackstop(20_000, onForceExit);
    await vi.advanceTimersByTimeAsync(19_999);
    expect(onForceExit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onForceExit).toHaveBeenCalledOnce();
    const summary = onForceExit.mock.calls[0]?.[0] as Record<string, number>;
    for (const count of Object.values(summary)) {
      expect(count).toBeGreaterThanOrEqual(1);
    }
  });

  it("does not fire after it is disarmed", async () => {
    vi.useFakeTimers();
    const onForceExit = vi.fn();
    const disarm = armShutdownBackstop(20_000, onForceExit);
    disarm();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onForceExit).not.toHaveBeenCalled();
  });

  it("never keeps the event loop alive on its own", () => {
    const before = summarizeActiveResources()["Timeout"] ?? 0;
    const disarm = armShutdownBackstop(20_000, () => undefined);
    try {
      // An unref'd timer is excluded from the active-resource set, so arming the
      // backstop can't be the reason a healthy process refuses to exit.
      expect(summarizeActiveResources()["Timeout"] ?? 0).toBe(before);
    } finally {
      disarm();
    }
  });
});

describe("startServer shutdown budget", () => {
  afterEach(() => {
    vi.useRealTimers();
    hangingSourcesStop.enabled = false;
  });

  it("abandons a source group whose stop() never settles and still finishes teardown", async () => {
    const { configPath, dataDir } = await writeDaemonConfig();
    hangingSourcesStop.enabled = true;
    const { startServer } = await import("../../src/server.js");
    const server = await startServer(configPath, {
      info: () => undefined,
      warn: () => undefined,
    });

    vi.useFakeTimers();
    try {
      const stopped = server.stop();
      // The 15s shutdown budget must cut the hung sources.stop() loose; without the
      // bound this await never returns and systemd SIGKILLs the daemon.
      await vi.advanceTimersByTimeAsync(15_000);
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(stopped).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }

    const events = readEventLog(dataDir).map((entry) => entry.event);
    expect(events).toContain("daemon.shutdown.sources_stop_timeout");
    expect(events.indexOf("daemon.stopped")).toBeGreaterThan(
      events.indexOf("daemon.shutdown.sources_stop_timeout"),
    );
  }, 20_000);
});
