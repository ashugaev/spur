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
): { dataDir: string; projects: Record<string, TestConfigProject> } {
  return { dataDir, projects };
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
});
