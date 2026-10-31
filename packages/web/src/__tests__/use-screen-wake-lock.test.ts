import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type UseHook = (active: boolean) => void;

class FakeSentinel extends EventTarget {
  release = vi.fn(async () => {});
}

let useScreenWakeLock: UseHook;
let request: ReturnType<typeof vi.fn>;
let sentinels: FakeSentinel[];
const savedNavigator = Object.getOwnPropertyDescriptor(navigator, "wakeLock");
const savedVisibility = Object.getOwnPropertyDescriptor(document, "visibilityState");

function restore(target: object, key: string, saved: PropertyDescriptor | undefined) {
  if (saved) Object.defineProperty(target, key, saved);
  else Reflect.deleteProperty(target, key);
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(async () => {
  vi.resetModules();
  sentinels = [];
  request = vi.fn(async () => {
    const s = new FakeSentinel();
    sentinels.push(s);
    return s;
  });
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => "visible",
  });
  Object.defineProperty(navigator, "wakeLock", { configurable: true, value: { request } });
  useScreenWakeLock = (await import("@/hooks/useScreenWakeLock")).useScreenWakeLock;
});

afterEach(() => {
  restore(navigator, "wakeLock", savedNavigator);
  restore(document, "visibilityState", savedVisibility);
  vi.restoreAllMocks();
});

describe("useScreenWakeLock", () => {
  it("requests when active flips false to true", async () => {
    const { rerender } = renderHook(({ active }) => useScreenWakeLock(active), {
      initialProps: { active: false },
    });
    await flush();
    expect(request).not.toHaveBeenCalled();
    rerender({ active: true });
    await flush();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("releases when active flips true to false", async () => {
    const { rerender } = renderHook(({ active }) => useScreenWakeLock(active), {
      initialProps: { active: true },
    });
    await flush();
    rerender({ active: false });
    expect(sentinels[0]?.release).toHaveBeenCalledTimes(1);
  });

  it("releases on unmount", async () => {
    const { unmount } = renderHook(() => useScreenWakeLock(true));
    await flush();
    unmount();
    expect(sentinels[0]?.release).toHaveBeenCalledTimes(1);
  });

  it("two hooks share one request", async () => {
    const a = renderHook(() => useScreenWakeLock(true));
    const b = renderHook(() => useScreenWakeLock(true));
    await flush();
    expect(request).toHaveBeenCalledTimes(1);
    a.unmount();
    expect(sentinels[0]?.release).not.toHaveBeenCalled();
    b.unmount();
    expect(sentinels[0]?.release).toHaveBeenCalledTimes(1);
  });
});
