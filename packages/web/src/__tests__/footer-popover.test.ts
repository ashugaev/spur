import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useFooterPopover } from "@/lib/footer-popover";

describe("useFooterPopover", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts closed", () => {
    const { result } = renderHook(() => useFooterPopover());
    expect(result.current.open).toBe(false);
  });

  it("opens on toggle and closes on a second toggle", () => {
    const { result } = renderHook(() => useFooterPopover());
    act(() => result.current.toggle());
    expect(result.current.open).toBe(true);
    act(() => result.current.toggle());
    expect(result.current.open).toBe(false);
  });

  it("opens after a sustained mouseenter and closes on mouseleave", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useFooterPopover());
    act(() => result.current.onMouseEnter());
    expect(result.current.open).toBe(false);
    act(() => vi.runAllTimers());
    expect(result.current.open).toBe(true);
    act(() => result.current.onMouseLeave());
    expect(result.current.open).toBe(false);
  });

  it("stays closed when the pointer only crosses the trigger", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useFooterPopover());
    act(() => {
      result.current.onMouseEnter();
      result.current.onMouseLeave();
      vi.runAllTimers();
    });
    expect(result.current.open).toBe(false);
  });

  it("dismiss closes a pinned popover", () => {
    const { result } = renderHook(() => useFooterPopover());
    act(() => result.current.toggle());
    act(() => result.current.dismiss());
    expect(result.current.open).toBe(false);
  });
});
