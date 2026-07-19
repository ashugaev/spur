import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSuppressIOSAutoZoom } from "@/hooks/useSuppressIOSAutoZoom";

const ORIGINAL_CONTENT = "width=device-width, initial-scale=1, viewport-fit=cover";
const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15";
const DESKTOP_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
const IPADOS_DESKTOP_MODE_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_6) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15";

function setNavigator(props: { userAgent?: string; platform?: string; maxTouchPoints?: number }) {
  if (props.userAgent !== undefined) {
    Object.defineProperty(navigator, "userAgent", { value: props.userAgent, configurable: true });
  }
  if (props.platform !== undefined) {
    Object.defineProperty(navigator, "platform", { value: props.platform, configurable: true });
  }
  if (props.maxTouchPoints !== undefined) {
    Object.defineProperty(navigator, "maxTouchPoints", {
      value: props.maxTouchPoints,
      configurable: true,
    });
  }
}

let meta: HTMLMetaElement;

beforeEach(() => {
  vi.useFakeTimers();
  meta = document.createElement("meta");
  meta.setAttribute("name", "viewport");
  meta.setAttribute("content", ORIGINAL_CONTENT);
  document.head.appendChild(meta);
  setNavigator({ userAgent: IPHONE_UA, platform: "iPhone", maxTouchPoints: 5 });
});

afterEach(() => {
  meta.remove();
  document.body.innerHTML = "";
  vi.useRealTimers();
});

describe("useSuppressIOSAutoZoom", () => {
  it("adds maximum-scale=1 while a form field is focused, on iOS", () => {
    renderHook(() => useSuppressIOSAutoZoom());
    const input = document.createElement("input");
    document.body.appendChild(input);

    input.focus();

    expect(meta.getAttribute("content")).toContain("maximum-scale=1");
  });

  it("restores the original content after focus leaves the field", () => {
    renderHook(() => useSuppressIOSAutoZoom());
    const input = document.createElement("input");
    document.body.appendChild(input);

    input.focus();
    input.blur();
    vi.runAllTimers();

    expect(meta.getAttribute("content")).toBe(ORIGINAL_CONTENT);
  });

  it("does not flicker when focus moves directly from one field to another", () => {
    renderHook(() => useSuppressIOSAutoZoom());
    const fieldA = document.createElement("input");
    const fieldB = document.createElement("input");
    document.body.append(fieldA, fieldB);
    const setAttribute = vi.spyOn(meta, "setAttribute");

    fieldA.focus();
    setAttribute.mockClear();
    fieldB.focus(); // fires focusout(A) then focusin(B) synchronously
    vi.runAllTimers();

    expect(setAttribute).not.toHaveBeenCalledWith("content", ORIGINAL_CONTENT);
    expect(meta.getAttribute("content")).toContain("maximum-scale=1");
  });

  it("does nothing on non-iOS user agents", () => {
    setNavigator({ userAgent: DESKTOP_UA, platform: "Win32", maxTouchPoints: 0 });
    renderHook(() => useSuppressIOSAutoZoom());
    const input = document.createElement("input");
    document.body.appendChild(input);

    input.focus();

    expect(meta.getAttribute("content")).toBe(ORIGINAL_CONTENT);
  });

  it("detects iPadOS reporting as MacIntel with touch support", () => {
    setNavigator({ userAgent: IPADOS_DESKTOP_MODE_UA, platform: "MacIntel", maxTouchPoints: 5 });
    renderHook(() => useSuppressIOSAutoZoom());
    const input = document.createElement("input");
    document.body.appendChild(input);

    input.focus();

    expect(meta.getAttribute("content")).toContain("maximum-scale=1");
  });
});
