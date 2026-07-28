import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useFooterPopover } from "@/lib/footer-popover";

describe("useFooterPopover", () => {
  afterEach(() => {
    document.body.innerHTML = "";
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

  it("opens only one footer popover at a time", () => {
    const { result } = renderHook(() => [useFooterPopover(), useFooterPopover()] as const);

    act(() => result.current[0].toggle());
    expect(result.current[0].open).toBe(true);

    act(() => result.current[1].toggle());
    expect(result.current[0].open).toBe(false);
    expect(result.current[1].open).toBe(true);
  });

  it("does not reopen a peer by hover while another footer control has focus", () => {
    const footer = document.createElement("footer");
    const first = document.createElement("div");
    const firstButton = document.createElement("button");
    const second = document.createElement("div");
    first.append(firstButton);
    footer.append(first, second);
    document.body.append(footer);

    const { result } = renderHook(() => [useFooterPopover(), useFooterPopover()] as const);
    result.current[0].containerRef.current = first;
    result.current[1].containerRef.current = second;

    firstButton.focus();
    act(() => result.current[1].onMouseEnter());

    expect(result.current[1].open).toBe(false);
  });
});
