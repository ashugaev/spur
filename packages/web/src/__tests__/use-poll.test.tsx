import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePoll, type PollLoad } from "@/hooks/usePoll.js";

function deferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("usePoll", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
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
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
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
      return signals.length === 1 ? new Promise<void>(() => {}) : Promise.resolve();
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
      return new Promise<void>(() => {});
    });
    const { unmount } = renderHook(() => usePoll(load, 1_000));
    unmount();
    expect(signals[0]?.aborted).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(load).toHaveBeenCalledTimes(1);
  });
});
