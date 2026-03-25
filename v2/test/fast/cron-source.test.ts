import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cronInstances: FakeCron[] = [];

class FakeCron {
  readonly stop = vi.fn();
  readonly callback: () => void;

  constructor(
    readonly schedule: string,
    callback: () => void,
  ) {
    this.callback = callback;
    cronInstances.push(this);
  }

  nextRuns(count: number): Date[] {
    return [
      new Date("2026-03-25T10:00:00.000Z"),
      new Date("2026-03-25T10:05:00.000Z"),
      new Date("2026-03-25T10:10:00.000Z"),
    ].slice(0, count);
  }

  trigger(): void {
    this.callback();
  }
}

vi.mock("croner", () => ({
  Cron: FakeCron,
}));

async function loadCronSourceModule() {
  vi.resetModules();
  cronInstances.splice(0);
  return import("../../src/event-sources/cron.js");
}

describe("cronSourceModule", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-25T10:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    cronInstances.splice(0);
  });

  it("suppresses cron ticks that arrive before the schedule's own cadence elapses", async () => {
    const emit = vi.fn();
    const info = vi.fn();
    const { cronSourceModule } = await loadCronSourceModule();
    const handle = await cronSourceModule.start({
      sourceId: "morning",
      projectId: "api",
      dataDir: "/tmp/spur-data",
      config: {
        type: "cron",
        schedule: "*/5 * * * *",
        runOnStart: true,
      },
      emit,
      signal: new AbortController().signal,
      logger: { info },
    });

    handle.runOnStart?.();
    expect(emit).toHaveBeenCalledTimes(1);

    cronInstances[0]?.trigger();
    expect(emit).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith(expect.stringContaining("cron tick suppressed"));

    vi.advanceTimersByTime(5 * 60_000);
    cronInstances[0]?.trigger();
    expect(emit).toHaveBeenCalledTimes(2);
  });
});
