import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useToasts } from "@/hooks/useToasts.js";

describe("useToasts", () => {
  it("returns toast ids and caps newest visible toasts", () => {
    const { result } = renderHook(() => useToasts());

    act(() => {
      for (let index = 1; index <= 6; index += 1) {
        expect(result.current.showErrorToast(`Error ${index}`)).toBe(index);
      }
    });

    expect(result.current.toasts.map((toast) => toast.title)).toEqual([
      "Error 2",
      "Error 3",
      "Error 4",
      "Error 5",
      "Error 6",
    ]);
  });

  it("clears timers on manual dismiss, timeout, cap drop, and unmount", () => {
    vi.useFakeTimers();
    const clearTimeoutSpy = vi.spyOn(window, "clearTimeout");
    const { result, unmount } = renderHook(() => useToasts());

    let firstId = 0;
    let secondId = 0;
    act(() => {
      firstId = result.current.showSuccessToast("Saved");
      secondId = result.current.showSuccessToast("Queued");
    });

    act(() => {
      result.current.dismissToast(firstId);
    });
    expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(2500);
    });
    expect(result.current.toasts.some((toast) => toast.id === secondId)).toBe(false);
    expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);

    act(() => {
      for (let index = 0; index < 6; index += 1) {
        result.current.showSuccessToast(`Auto ${index}`);
      }
    });
    expect(clearTimeoutSpy).toHaveBeenCalledTimes(2);

    unmount();
    expect(clearTimeoutSpy).toHaveBeenCalledTimes(7);
    vi.useRealTimers();
  });
});
