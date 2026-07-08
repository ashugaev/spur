import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMediaQuery } from "@/hooks/useMediaQuery";

type MediaQueryListener = (event: MediaQueryListEvent) => void;

interface FakeMediaQueryList {
  matches: boolean;
  media: string;
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
  dispatch: (matches: boolean) => void;
}

let lastMediaQuery: FakeMediaQueryList | null = null;

function createFakeMediaQuery(query: string, initialMatches = false): FakeMediaQueryList {
  const listeners = new Set<MediaQueryListener>();
  const list: FakeMediaQueryList = {
    matches: initialMatches,
    media: query,
    addEventListener: vi.fn((_event: string, listener: MediaQueryListener) => {
      listeners.add(listener);
    }),
    removeEventListener: vi.fn((_event: string, listener: MediaQueryListener) => {
      listeners.delete(listener);
    }),
    dispatch(matches: boolean) {
      list.matches = matches;
      for (const listener of listeners) {
        listener({ matches } as MediaQueryListEvent);
      }
    },
  };
  return list;
}

const originalMatchMedia = window.matchMedia;

beforeEach(() => {
  window.matchMedia = ((query: string) => {
    lastMediaQuery = createFakeMediaQuery(query);
    return lastMediaQuery as unknown as MediaQueryList;
  }) as typeof window.matchMedia;
});

afterEach(() => {
  window.matchMedia = originalMatchMedia;
  lastMediaQuery = null;
});

describe("useMediaQuery", () => {
  it("builds a max-width query for a number argument", () => {
    renderHook(() => useMediaQuery(640));
    expect(lastMediaQuery?.media).toBe("(max-width: 640px)");
  });

  it("returns false initially when the query does not match", () => {
    const { result } = renderHook(() => useMediaQuery("(min-width: 1024px)"));
    expect(result.current).toBe(false);
  });

  it("updates when the matchMedia listener fires", () => {
    const { result } = renderHook(() => useMediaQuery("(min-width: 1024px)"));
    act(() => {
      lastMediaQuery?.dispatch(true);
    });
    expect(result.current).toBe(true);
  });

  it("removes the listener on unmount", () => {
    const { unmount } = renderHook(() => useMediaQuery("(min-width: 1024px)"));
    const removeSpy = lastMediaQuery?.removeEventListener;
    unmount();
    expect(removeSpy).toHaveBeenCalled();
  });
});
