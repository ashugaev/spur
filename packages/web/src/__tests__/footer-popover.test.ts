import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useFooterPopover } from "@/lib/footer-popover";

describe("useFooterPopover", () => {
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

  it("opens on mouseenter and closes on mouseleave", () => {
    const { result } = renderHook(() => useFooterPopover());
    act(() => result.current.onMouseEnter());
    expect(result.current.open).toBe(true);
    act(() => result.current.onMouseLeave());
    expect(result.current.open).toBe(false);
  });

  it("dismiss closes a pinned popover", () => {
    const { result } = renderHook(() => useFooterPopover());
    act(() => result.current.toggle());
    act(() => result.current.dismiss());
    expect(result.current.open).toBe(false);
  });
});
