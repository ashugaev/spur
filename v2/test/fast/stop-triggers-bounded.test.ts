import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stopTriggersBounded } from "../../src/server.js";
import type { TriggerGroupController } from "../../src/triggers.js";

const controllerWith = (stop: () => Promise<void>): TriggerGroupController => ({ stop });

describe("stopTriggersBounded", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns without reporting when stop() completes before the timeout", async () => {
    const report = vi.fn();
    const stop = vi.fn().mockResolvedValue(undefined);
    await stopTriggersBounded(controllerWith(stop), 180_000, report);
    expect(stop).toHaveBeenCalledOnce();
    expect(report).not.toHaveBeenCalled();
  });

  it("abandons a hung stop() at the timeout and reports the reason without throwing", async () => {
    const report = vi.fn();
    const stop = vi.fn().mockReturnValue(new Promise<void>(() => {}));
    const settled = stopTriggersBounded(controllerWith(stop), 180_000, report);
    await vi.advanceTimersByTimeAsync(180_000);
    await expect(settled).resolves.toBeUndefined();
    expect(report).toHaveBeenCalledExactlyOnceWith("triggers.stop timeout");
  });

  it("does not report before the timeout elapses", async () => {
    const report = vi.fn();
    const stop = vi.fn().mockReturnValue(new Promise<void>(() => {}));
    void stopTriggersBounded(controllerWith(stop), 180_000, report);
    await vi.advanceTimersByTimeAsync(179_999);
    expect(report).not.toHaveBeenCalled();
  });

  it("reports an Error rejection from stop() and swallows it", async () => {
    const report = vi.fn();
    const stop = vi.fn().mockRejectedValue(new Error("teardown blew up"));
    await expect(
      stopTriggersBounded(controllerWith(stop), 180_000, report),
    ).resolves.toBeUndefined();
    expect(report).toHaveBeenCalledExactlyOnceWith("teardown blew up");
  });

  it("stringifies a non-Error rejection from stop()", async () => {
    const report = vi.fn();
    const stop = vi.fn().mockRejectedValue("plain string failure");
    await stopTriggersBounded(controllerWith(stop), 180_000, report);
    expect(report).toHaveBeenCalledExactlyOnceWith("plain string failure");
  });
});
