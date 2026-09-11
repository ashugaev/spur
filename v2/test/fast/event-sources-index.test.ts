import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventBus } from "../../src/event-bus.js";

const logSpurEventMock = vi.fn();
const cronStartMock = vi.fn();

vi.mock("../../src/event-log.js", () => ({
  logSpurEvent: logSpurEventMock,
}));

vi.mock("../../src/event-sources/cron.js", () => ({
  cronSourceModule: {
    type: "cron",
    start: cronStartMock,
  },
}));

async function loadStartConfiguredSources() {
  return import("../../src/event-sources/index.js");
}

const MISSING_PATH = "/definitely/not/a/real/path/spur-vanished-project";

interface TestConfigProject {
  path: string;
  sources: Record<string, { type: string }>;
}

function buildConfig(
  dataDir: string,
  projects: Record<string, TestConfigProject>,
): { dataDir: string; projects: Record<string, TestConfigProject>; ui: { port: number } } {
  return { dataDir, projects, ui: { port: 5555 } };
}

describe("startConfiguredSources", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "spur-event-sources-"));
    logSpurEventMock.mockReset();
    cronStartMock.mockReset();
    cronStartMock.mockResolvedValue({ stop: vi.fn() });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("starts sources when project path exists", async () => {
    const { startConfiguredSources } = await loadStartConfiguredSources();
    const config = buildConfig(tmpDir, {
      api: {
        path: tmpDir,
        sources: { nightly: { type: "cron" } },
      },
    });

    const controller = await startConfiguredSources({
      config: config as never,
      bus: new EventBus(),
      listSessions: vi.fn().mockResolvedValue([]),
    });

    expect(cronStartMock).toHaveBeenCalledTimes(1);
    const startedEvents = logSpurEventMock.mock.calls.filter(
      (call) => (call[1] as { event: string }).event === "source.started",
    );
    expect(startedEvents).toHaveLength(1);
    const missingEvents = logSpurEventMock.mock.calls.filter(
      (call) => (call[1] as { event: string }).event === "source.project_path_missing",
    );
    expect(missingEvents).toHaveLength(0);

    await controller.stop();
  });

  it("skips all sources when project path is missing", async () => {
    const { startConfiguredSources } = await loadStartConfiguredSources();
    const config = buildConfig(tmpDir, {
      api: {
        path: MISSING_PATH,
        sources: { nightly: { type: "cron" } },
      },
    });

    const controller = await startConfiguredSources({
      config: config as never,
      bus: new EventBus(),
      listSessions: vi.fn().mockResolvedValue([]),
    });

    expect(cronStartMock).not.toHaveBeenCalled();
    const missingEvents = logSpurEventMock.mock.calls.filter(
      (call) => (call[1] as { event: string }).event === "source.project_path_missing",
    );
    expect(missingEvents).toHaveLength(1);
    const entry = missingEvents[0]?.[1] as {
      level: string;
      projectId: string;
      details: { path: string };
    };
    expect(entry.level).toBe("warn");
    expect(entry.projectId).toBe("api");
    expect(entry.details.path).toBe(MISSING_PATH);

    await expect(controller.stop()).resolves.toBeUndefined();
  });

  it("skips only the vanished project in a mixed config", async () => {
    const { startConfiguredSources } = await loadStartConfiguredSources();
    const config = buildConfig(tmpDir, {
      api: {
        path: tmpDir,
        sources: { nightly: { type: "cron" } },
      },
      gone: {
        path: MISSING_PATH,
        sources: { nightly: { type: "cron" } },
      },
    });

    const controller = await startConfiguredSources({
      config: config as never,
      bus: new EventBus(),
      listSessions: vi.fn().mockResolvedValue([]),
    });

    expect(cronStartMock).toHaveBeenCalledTimes(1);
    const missingEvents = logSpurEventMock.mock.calls.filter(
      (call) => (call[1] as { event: string }).event === "source.project_path_missing",
    );
    expect(missingEvents).toHaveLength(1);
    expect((missingEvents[0]?.[1] as { projectId: string }).projectId).toBe("gone");

    await controller.stop();
  });

  it("forwards listProjects into a source module's start deps", async () => {
    const { startConfiguredSources } = await loadStartConfiguredSources();
    const config = buildConfig(tmpDir, {
      api: {
        path: tmpDir,
        sources: { nightly: { type: "cron" } },
      },
    });
    const listProjects = vi.fn().mockResolvedValue([{ id: "api", name: "api" }]);

    const controller = await startConfiguredSources({
      config: config as never,
      bus: new EventBus(),
      listSessions: vi.fn().mockResolvedValue([]),
      listProjects,
    });

    expect(cronStartMock).toHaveBeenCalledTimes(1);
    const startDeps = cronStartMock.mock.calls[0]?.[0] as { listProjects?: unknown };
    expect(startDeps.listProjects).toBe(listProjects);

    await controller.stop();
  });

  it("omits listProjects from a source module's start deps when not supplied", async () => {
    const { startConfiguredSources } = await loadStartConfiguredSources();
    const config = buildConfig(tmpDir, {
      api: {
        path: tmpDir,
        sources: { nightly: { type: "cron" } },
      },
    });

    const controller = await startConfiguredSources({
      config: config as never,
      bus: new EventBus(),
      listSessions: vi.fn().mockResolvedValue([]),
    });

    const startDeps = cronStartMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect("listProjects" in startDeps).toBe(false);

    await controller.stop();
  });
});

describe("spawnableProjects", () => {
  it("drops shepherd and unconfigured entries and preserves input order", async () => {
    const { spawnableProjects } = await loadStartConfiguredSources();
    const entries = [
      { id: "api", name: "API", configured: true, prefix: "api", path: "/api" },
      {
        id: "spur-shepherd",
        name: "Shepherd",
        configured: true,
        prefix: "shp",
        path: "/shepherd",
        kind: "shepherd" as const,
      },
      { id: "unconf", name: "Unconf", configured: false, prefix: "unc", path: "/unconf" },
      { id: "web", name: "Web", configured: true, prefix: "web", path: "/web" },
    ];

    expect(spawnableProjects(entries)).toEqual([
      { id: "api", name: "API" },
      { id: "web", name: "Web" },
    ]);
  });
});
