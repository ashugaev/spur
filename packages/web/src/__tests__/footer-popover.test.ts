import { act, renderHook } from "@testing-library/react";
import type { FocusEvent } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useFooterPopover } from "@/lib/footer-popover";

function blurOutEvent(): FocusEvent<HTMLDivElement> {
  return {
    currentTarget: { contains: () => false },
    relatedTarget: null,
  } as unknown as FocusEvent<HTMLDivElement>;
}

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

  it("blur closes a pinned popover and blocks a hover timer already in flight", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useFooterPopover());
    act(() => result.current.toggle());
    expect(result.current.open).toBe(true);
    act(() => result.current.onMouseEnter());
    act(() => result.current.onBlur(blurOutEvent()));
    expect(result.current.open).toBe(false);
    act(() => vi.runAllTimers());
    expect(result.current.open).toBe(false);
  });

  it("a genuine mouseenter after blur still reopens the popover", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useFooterPopover());
    act(() => result.current.toggle());
    act(() => result.current.onBlur(blurOutEvent()));
    expect(result.current.open).toBe(false);
    act(() => {
      result.current.onMouseEnter();
      vi.runAllTimers();
    });
    expect(result.current.open).toBe(true);
  });

  it("a genuine toggle after blur still reopens the popover", () => {
    const { result } = renderHook(() => useFooterPopover());
    act(() => result.current.toggle());
    act(() => result.current.onBlur(blurOutEvent()));
    expect(result.current.open).toBe(false);
    act(() => result.current.toggle());
    expect(result.current.open).toBe(true);
  });
});
