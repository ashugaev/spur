import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchPrInfo,
  extractLinkId,
  prStateColor,
  usePrInfo,
  useGitError,
} from "@/lib/link-icons.js";
import type { SpurSessionLink } from "@/lib/types";

const mockFetch = vi.fn<typeof fetch>();
let resetCounter = 0;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", mockFetch);
  mockFetch.mockReset();
  mockFetch.mockResolvedValueOnce(
    jsonResponse({ state: "open", ciStatus: null, totalThreads: 0, unresolvedThreads: 0 }),
  );
  await fetchPrInfo(`https://github.com/org/repo/pull/reset-${resetCounter++}`);
  mockFetch.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// Helper to create a JSON response mock
function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

describe("fetchPrInfo", () => {
  it("maps state, ciStatus, totalThreads, unresolvedThreads from JSON", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        state: "open",
        ciStatus: "success",
        totalThreads: 5,
        unresolvedThreads: 2,
      }),
    );

    const result = await fetchPrInfo("https://github.com/org/repo/pull/123");
    expect(result.state).toBe("open");
    expect(result.ciStatus).toBe("success");
    expect(result.totalThreads).toBe(5);
    expect(result.unresolvedThreads).toBe(2);
  });

  it("maps null ciStatus correctly", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        state: "merged",
        ciStatus: null,
        totalThreads: 0,
        unresolvedThreads: 0,
      }),
    );

    const result = await fetchPrInfo("https://github.com/org/repo/pull/456");
    expect(result.state).toBe("merged");
    expect(result.ciStatus).toBeNull();
  });

  it("returns null for invalid state values", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        state: "unknown-state",
        ciStatus: "success",
        totalThreads: 0,
        unresolvedThreads: 0,
      }),
    );

    const result = await fetchPrInfo("https://github.com/org/repo/pull/1");
    expect(result.state).toBeNull();
  });

  it("returns null for invalid ciStatus values", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        state: "open",
        ciStatus: "unknown-status",
        totalThreads: 0,
        unresolvedThreads: 0,
      }),
    );

    const result = await fetchPrInfo("https://github.com/org/repo/pull/2");
    expect(result.ciStatus).toBeNull();
  });

  it("non-ok response with JSON error returns EMPTY_PR_INFO", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ error: "Repository not found" }, false, 404));

    const result = await fetchPrInfo("https://github.com/org/repo/pull/3");
    expect(result.state).toBeNull();
    expect(result.ciStatus).toBeNull();
    expect(result.totalThreads).toBe(0);
    expect(result.unresolvedThreads).toBe(0);
  });

  it("non-ok response without parseable body sets generic error", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: () => Promise.reject(new Error("not json")),
    } as unknown as Response);

    const result = await fetchPrInfo("https://github.com/org/repo/pull/4");
    expect(result.state).toBeNull();
  });

  it("fetch throws returns EMPTY_PR_INFO and sets GitHub API unreachable error", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Network error"));

    const result = await fetchPrInfo("https://github.com/org/repo/pull/5");
    expect(result.state).toBeNull();
    expect(result.totalThreads).toBe(0);
  });

  it("clears git error on success after an error was set", async () => {
    // First call fails
    mockFetch.mockRejectedValueOnce(new Error("Network error"));
    await fetchPrInfo("https://github.com/org/repo/pull/6");

    // Second call succeeds with a different URL (unique to avoid cache)
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        state: "open",
        ciStatus: null,
        totalThreads: 0,
        unresolvedThreads: 0,
      }),
    );

    const { result } = renderHook(() => useGitError());
    await act(async () => {
      await fetchPrInfo("https://github.com/org/repo/pull/7");
    });
    expect(result.current).toBeNull();
  });

  it("defaults numeric fields to 0 when missing from response", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        state: "open",
        ciStatus: "pending",
      }),
    );

    const result = await fetchPrInfo("https://github.com/org/repo/pull/8");
    expect(result.totalThreads).toBe(0);
    expect(result.unresolvedThreads).toBe(0);
  });

  it("returns EMPTY_PR_INFO and clears Git error for soft missing PR payloads", async () => {
    const { result: gitError } = renderHook(() => useGitError());

    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        state: null,
        ciStatus: null,
        totalThreads: 0,
        unresolvedThreads: 0,
      }),
    );

    await act(async () => {
      const result = await fetchPrInfo("https://github.com/org/repo/pull/soft-missing");
      expect(result).toEqual({
        state: null,
        ciStatus: null,
        totalThreads: 0,
        unresolvedThreads: 0,
      });
    });

    expect(gitError.current).toBeNull();
  });

  it("reads error from a successful payload and sets Git error", async () => {
    const { result: gitError } = renderHook(() => useGitError());

    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        state: null,
        ciStatus: null,
        totalThreads: 0,
        unresolvedThreads: 0,
        error: "GitHub API 503",
      }),
    );

    await act(async () => {
      const result = await fetchPrInfo("https://github.com/org/repo/pull/soft-error");
      expect(result.state).toBeNull();
    });

    expect(gitError.current).toBe("GitHub API 503");
  });

  it("deduplicates concurrent in-flight requests for the same PR", async () => {
    let resolveFetch!: (value: Response) => void;
    const fetchPromise = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    mockFetch.mockReturnValueOnce(fetchPromise);

    const url = "https://github.com/org/repo/pull/in-flight-dedupe";
    const first = fetchPrInfo(url);
    const second = fetchPrInfo(url);

    expect(mockFetch).toHaveBeenCalledTimes(1);

    resolveFetch(
      jsonResponse({
        state: "open",
        ciStatus: null,
        totalThreads: 1,
        unresolvedThreads: 0,
      }),
    );

    await expect(Promise.all([first, second])).resolves.toEqual([
      {
        state: "open",
        ciStatus: null,
        totalThreads: 1,
        unresolvedThreads: 0,
      },
      {
        state: "open",
        ciStatus: null,
        totalThreads: 1,
        unresolvedThreads: 0,
      },
    ]);
  });

  it("does not clobber a known good cached value when a later request errors", async () => {
    const url = "https://github.com/org/repo/pull/dont-clobber";

    // Seed the in-memory client cache by mounting usePrInfo, which writes through
    // setPrCache after a successful fetch.
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        state: "open",
        ciStatus: "success",
        totalThreads: 3,
        unresolvedThreads: 1,
      }),
    );
    const { result: hook } = renderHook(() => usePrInfo(url));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(hook.current.state).toBe("open");
    expect(hook.current.ciStatus).toBe("success");

    // Now a non-ok response on the same URL: don't clobber the cached value.
    mockFetch.mockResolvedValueOnce(jsonResponse({ error: "GitHub API 503" }, false, 503));
    const errResult = await fetchPrInfo(url);
    expect(errResult.state).toBe("open");
    expect(errResult.ciStatus).toBe("success");

    // And a soft-error payload (200 with error field, empty body) also keeps cached.
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        state: null,
        ciStatus: null,
        totalThreads: 0,
        unresolvedThreads: 0,
        error: "GitHub API 503",
      }),
    );
    const softResult = await fetchPrInfo(url);
    expect(softResult.state).toBe("open");
    expect(softResult.ciStatus).toBe("success");
  });
});

describe("extractLinkId", () => {
  it("extracts PR number from GitHub pull URL", () => {
    const link: SpurSessionLink = { label: "pr", url: "https://github.com/org/repo/pull/123" };
    expect(extractLinkId(link)).toBe("#123");
  });

  it("returns 'PR' when URL has no pull number", () => {
    const link: SpurSessionLink = { label: "pr", url: "https://github.com/org/repo" };
    expect(extractLinkId(link)).toBe("PR");
  });

  it("extracts tracker ID from /browse/ URL", () => {
    const link: SpurSessionLink = {
      label: "tracker",
      url: "https://jira.example.com/browse/PROJ-42",
    };
    expect(extractLinkId(link)).toBe("PROJ-42");
  });

  it("extracts tracker ID matching PROJECT-NUMBER pattern from plain URL", () => {
    const link: SpurSessionLink = {
      label: "tracker",
      url: "https://jira.example.com/issues/MYPROJ-999",
    };
    expect(extractLinkId(link)).toBe("MYPROJ-999");
  });

  it("returns 'task' when tracker URL has no match", () => {
    const link: SpurSessionLink = {
      label: "tracker",
      url: "https://tracker.example.com/dashboard",
    };
    expect(extractLinkId(link)).toBe("task");
  });

  it("returns label as-is for other label types", () => {
    const link: SpurSessionLink = { label: "docs", url: "https://docs.example.com" };
    expect(extractLinkId(link)).toBe("docs");
  });
});

describe("prStateColor", () => {
  it("returns correct color for draft", () => {
    expect(prStateColor("draft")).toBe("var(--color-text-tertiary)");
  });

  it("returns correct color for open", () => {
    expect(prStateColor("open")).toBe("var(--color-status-ready)");
  });

  it("returns correct color for merged", () => {
    expect(prStateColor("merged")).toBe("var(--color-accent-violet)");
  });

  it("returns correct color for closed", () => {
    expect(prStateColor("closed")).toBe("var(--color-status-error)");
  });

  it("returns undefined for null", () => {
    expect(prStateColor(null)).toBeUndefined();
  });
});

describe("useGitError hook", () => {
  it("returns null initially", () => {
    const { result } = renderHook(() => useGitError());
    expect(result.current).toBeNull();
  });

  it("returns error string after fetchPrInfo fails with network error", async () => {
    const { result } = renderHook(() => useGitError());

    mockFetch.mockRejectedValueOnce(new Error("Network error"));
    await act(async () => {
      await fetchPrInfo("https://github.com/org/repo/pull/error-test-1");
    });

    expect(result.current).toBe("GitHub API unreachable");
  });

  it("returns null after successful fetchPrInfo clears the error", async () => {
    const { result } = renderHook(() => useGitError());

    // First trigger an error
    mockFetch.mockRejectedValueOnce(new Error("Network error"));
    await act(async () => {
      await fetchPrInfo("https://github.com/org/repo/pull/error-test-2");
    });
    expect(result.current).toBe("GitHub API unreachable");

    // Then succeed (unique URL to bypass cache)
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ state: "open", ciStatus: null, totalThreads: 0, unresolvedThreads: 0 }),
    );
    await act(async () => {
      await fetchPrInfo("https://github.com/org/repo/pull/clear-error-test");
    });
    expect(result.current).toBeNull();
  });
});

describe("usePrInfo hook", () => {
  it("returns EMPTY_PR_INFO when url is undefined", () => {
    const { result } = renderHook(() => usePrInfo(undefined));
    expect(result.current.state).toBeNull();
    expect(result.current.ciStatus).toBeNull();
    expect(result.current.totalThreads).toBe(0);
    expect(result.current.unresolvedThreads).toBe(0);
  });

  it("does not fetch when url is undefined", () => {
    renderHook(() => usePrInfo(undefined));
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("fetches on mount and updates state", async () => {
    const url = "https://github.com/org/repo/pull/usePrInfo-mount";
    let resolveFetch!: (v: Response) => void;
    const fetchPromise = new Promise<Response>((res) => {
      resolveFetch = res;
    });
    mockFetch.mockReturnValueOnce(fetchPromise);

    const { result } = renderHook(() => usePrInfo(url));

    // Initially EMPTY_PR_INFO
    expect(result.current.state).toBeNull();

    // Resolve the fetch
    await act(async () => {
      resolveFetch(
        jsonResponse({ state: "open", ciStatus: "success", totalThreads: 2, unresolvedThreads: 1 }),
      );
      await fetchPromise;
    });

    expect(result.current.state).toBe("open");
    expect(result.current.totalThreads).toBe(2);
  });

  it("polls at POLL_MS interval", async () => {
    const url = "https://github.com/org/repo/pull/usePrInfo-poll-v2";
    const POLL_MS = 120_000;

    // Resolve immediately each time
    mockFetch.mockResolvedValue(
      jsonResponse({ state: "open", ciStatus: null, totalThreads: 0, unresolvedThreads: 0 }),
    );

    const { unmount } = renderHook(() => usePrInfo(url));

    // Let the initial fetch complete
    await act(async () => {
      await Promise.resolve();
    });

    const callCountAfterMount = mockFetch.mock.calls.length;
    expect(callCountAfterMount).toBeGreaterThanOrEqual(1);

    // Advance past the cache TTL + one poll interval so the next poll fetch goes through
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS + 1);
      await Promise.resolve();
    });

    expect(mockFetch.mock.calls.length).toBeGreaterThan(callCountAfterMount);
    unmount();
  });
});
