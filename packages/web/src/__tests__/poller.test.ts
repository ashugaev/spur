import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextPollDelayMs, startPoller, type PollOutcome } from "@/lib/poller.js";

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
}

async function advance(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
}

function deferred() {
  let resolve: (outcome: PollOutcome) => void = () => {};
  const promise = new Promise<PollOutcome>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("nextPollDelayMs", () => {
  it("doubles per failure and caps at 8x", () => {
    expect([0, 1, 2, 3, 4].map((failures) => nextPollDelayMs(5_000, failures, 0))).toEqual([
      5_000, 10_000, 20_000, 40_000, 40_000,
    ]);
  });

  it("never spaces runs closer than the last duration, up to the cap", () => {
    expect(nextPollDelayMs(5_000, 0, 20_000)).toBe(20_000);
    expect(nextPollDelayMs(5_000, 0, 200_000)).toBe(40_000);
  });
});

describe("startPoller", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setVisibility("visible");
  });

  afterEach(() => {
    setVisibility("visible");
    vi.useRealTimers();
  });

  it("starts the next run only after the previous settles", async () => {
    const pending = deferred();
    const run = vi.fn<(signal: AbortSignal) => Promise<PollOutcome>>(() => pending.promise);
    const poller = startPoller({ intervalMs: 1_000, run });
    await advance(10_000);
    expect(run).toHaveBeenCalledTimes(1);
    pending.resolve("ok");
    await advance(7_999);
    expect(run).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(run).toHaveBeenCalledTimes(2);
    poller.stop();
  });

  it("spaces the next run by a slow run's duration", async () => {
    const pending = deferred();
    const run = vi
      .fn<(signal: AbortSignal) => Promise<PollOutcome>>()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue("ok");
    const poller = startPoller({ intervalMs: 5_000, run });
    await advance(20_000);
    pending.resolve("ok");
    await advance(19_999);
    expect(run).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(run).toHaveBeenCalledTimes(2);
    poller.stop();
  });

  it("backs off 2x, 4x, 8x, holds 8x, and resets on success", async () => {
    const outcomes: PollOutcome[] = ["failed", "failed", "failed", "failed", "ok", "ok"];
    const starts: number[] = [];
    const t0 = Date.now();
    const poller = startPoller({
      intervalMs: 1_000,
      run: async () => {
        starts.push(Date.now() - t0);
        return outcomes[starts.length - 1] ?? "ok";
      },
    });
    await advance(40_000);
    expect(starts.slice(0, 6)).toEqual([0, 2_000, 6_000, 14_000, 22_000, 23_000]);
    poller.stop();
  });

  it("starts no run while hidden and defers the first run of a hidden mount", async () => {
    setVisibility("hidden");
    const run = vi.fn<(signal: AbortSignal) => Promise<PollOutcome>>(async () => "ok");
    const poller = startPoller({ intervalMs: 1_000, run });
    await advance(300_000);
    expect(run).toHaveBeenCalledTimes(0);
    setVisibility("visible");
    await advance(0);
    expect(run).toHaveBeenCalledTimes(1);
    poller.stop();
  });

  it("pauses an armed timer when hidden and runs on visible only when due", async () => {
    const run = vi.fn<(signal: AbortSignal) => Promise<PollOutcome>>(async () => "ok");
    const poller = startPoller({ intervalMs: 10_000, run });
    await advance(0);
    expect(run).toHaveBeenCalledTimes(1);
    await advance(3_000);
    setVisibility("hidden");
    await advance(60_000);
    expect(run).toHaveBeenCalledTimes(1);
    setVisibility("visible");
    await advance(0);
    expect(run).toHaveBeenCalledTimes(2);
    // Visible again before the delay elapses: no extra run, remaining delay is armed.
    setVisibility("hidden");
    setVisibility("visible");
    await advance(9_999);
    expect(run).toHaveBeenCalledTimes(2);
    await advance(1);
    expect(run).toHaveBeenCalledTimes(3);
    poller.stop();
  });

  it("refresh aborts the in-flight run, runs now, and resolves on settle", async () => {
    const signals: AbortSignal[] = [];
    const run = vi.fn<(signal: AbortSignal) => Promise<PollOutcome>>((signal) => {
      signals.push(signal);
      return signals.length === 1 ? new Promise<PollOutcome>(() => {}) : Promise.resolve("ok");
    });
    const poller = startPoller({ intervalMs: 1_000, run });
    await poller.refresh();
    expect(run).toHaveBeenCalledTimes(2);
    expect(signals[0]?.aborted).toBe(true);
    poller.stop();
  });

  it("refresh while hidden runs, resolves, and arms no timer", async () => {
    setVisibility("hidden");
    const run = vi.fn<(signal: AbortSignal) => Promise<PollOutcome>>(async () => "ok");
    const poller = startPoller({ intervalMs: 1_000, run });
    await poller.refresh();
    expect(run).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    await advance(60_000);
    expect(run).toHaveBeenCalledTimes(1);
    poller.stop();
  });

  it("request during an in-flight run starts exactly one follow-up after settle", async () => {
    const first = deferred();
    const run = vi
      .fn<(signal: AbortSignal) => Promise<PollOutcome>>()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue("ok");
    const poller = startPoller({ intervalMs: 60_000, run });
    poller.request();
    poller.request();
    expect(run).toHaveBeenCalledTimes(1);
    first.resolve("ok");
    await advance(0);
    expect(run).toHaveBeenCalledTimes(2);
    await advance(59_999);
    expect(run).toHaveBeenCalledTimes(2);
    poller.stop();
  });

  it("request while idle and visible runs now", async () => {
    const run = vi.fn<(signal: AbortSignal) => Promise<PollOutcome>>(async () => "ok");
    const poller = startPoller({ intervalMs: 60_000, run });
    await advance(0);
    poller.request();
    await advance(0);
    expect(run).toHaveBeenCalledTimes(2);
    poller.stop();
  });

  it("request while hidden runs once on visible", async () => {
    const run = vi.fn<(signal: AbortSignal) => Promise<PollOutcome>>(async () => "ok");
    const poller = startPoller({ intervalMs: 60_000, run });
    await advance(0);
    setVisibility("hidden");
    poller.request();
    await advance(5_000);
    expect(run).toHaveBeenCalledTimes(1);
    setVisibility("visible");
    await advance(0);
    expect(run).toHaveBeenCalledTimes(2);
    poller.stop();
  });

  it("defers a pending follow-up whose run settles while hidden", async () => {
    const first = deferred();
    const run = vi
      .fn<(signal: AbortSignal) => Promise<PollOutcome>>()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue("ok");
    const poller = startPoller({ intervalMs: 60_000, run });
    poller.request();
    setVisibility("hidden");
    first.resolve("ok");
    await advance(300_000);
    expect(run).toHaveBeenCalledTimes(1);
    setVisibility("visible");
    await advance(0);
    expect(run).toHaveBeenCalledTimes(2);
    poller.stop();
  });

  it("stop aborts, clears the timer, and removes the visibility listener", async () => {
    const signals: AbortSignal[] = [];
    const removeSpy = vi.spyOn(document, "removeEventListener");
    const poller = startPoller({
      intervalMs: 1_000,
      run: (signal) => {
        signals.push(signal);
        return new Promise<PollOutcome>(() => {});
      },
    });
    poller.stop();
    expect(signals[0]?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(removeSpy).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
    setVisibility("hidden");
    setVisibility("visible");
    await advance(10_000);
    expect(signals).toHaveLength(1);
    removeSpy.mockRestore();
  });
});
