import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePoll, type PollLoad } from "@/hooks/usePoll.js";
import type { PollOutcome } from "@/lib/poller.js";

function deferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<PollOutcome>((done) => {
    resolve = () => done("ok");
  });
  return { promise, resolve };
}

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("usePoll", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    setVisibility("visible");
    vi.useRealTimers();
  });

  it("never starts a second run while one is in flight", async () => {
    const pending = deferred();
    const load = vi.fn<PollLoad>(() => pending.promise);
    renderHook(() => usePoll(load, 1_000));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(load).toHaveBeenCalledTimes(1);

    pending.resolve();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(load).toHaveBeenCalledTimes(1);
    // The 10s run spaces the next start by its duration, capped at 8x the 1s base.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(7_999);
    });
    expect(load).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("leaves a run slower than the interval un-aborted", async () => {
    const pending = deferred();
    const signals: AbortSignal[] = [];
    const load = vi.fn<PollLoad>((signal) => {
      signals.push(signal);
      return pending.promise;
    });
    renderHook(() => usePoll(load, 1_000));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    pending.resolve();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);
  });

  it("refresh aborts the in-flight run and starts one now", async () => {
    const signals: AbortSignal[] = [];
    const load = vi.fn<PollLoad>((signal) => {
      signals.push(signal);
      return signals.length === 1 ? new Promise<PollOutcome>(() => {}) : Promise.resolve("ok");
    });
    const { result } = renderHook(() => usePoll(load, 1_000));
    expect(load).toHaveBeenCalledTimes(1);

    await act(async () => {
      await result.current();
    });
    expect(load).toHaveBeenCalledTimes(2);
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);

    // The next tick counts from the refresh, one interval later.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(999);
    });
    expect(load).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("aborts the in-flight run and stops ticking on unmount", async () => {
    const signals: AbortSignal[] = [];
    const load = vi.fn<PollLoad>((signal) => {
      signals.push(signal);
      return new Promise<PollOutcome>(() => {});
    });
    const { unmount } = renderHook(() => usePoll(load, 1_000));
    unmount();
    expect(signals[0]?.aborted).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("starts no run while the document is hidden and runs once on visible", async () => {
    setVisibility("hidden");
    const load = vi.fn<PollLoad>(async () => "ok");
    renderHook(() => usePoll(load, 1_000));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(load).toHaveBeenCalledTimes(0);
    await act(async () => {
      setVisibility("visible");
    });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("backs off after a failed run", async () => {
    const load = vi.fn<PollLoad>(async () => "failed");
    renderHook(() => usePoll(load, 1_000));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(load).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_999);
    });
    expect(load).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(load).toHaveBeenCalledTimes(2);
  });
});
