import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchPrInfo,
  fetchPrInfoBatch,
  extractLinkId,
  primePrInfo,
  prStateColor,
  usePrInfo,
  usePrReadyUrls,
} from "@/lib/link-icons.js";
import type { SpurSessionLink } from "@/lib/types.js";

const mockFetch = vi.fn<typeof fetch>();
let resetCounter = 0;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", mockFetch);
  mockFetch.mockReset();
  mockFetch.mockResolvedValueOnce(
    jsonResponse({
      state: "open",
      reviewDecision: null,
      ciStatus: null,
      canMerge: false,
      totalThreads: 0,
      unresolvedThreads: 0,
    }),
  );
  await fetchPrInfo(`https://github.com/org/repo/pull/reset-${resetCounter++}`);
  mockFetch.mockReset();
});

afterEach(() => {
  // Unmount every hook, then let the shared poller's pending coalesce timer
  // fire (a no-op with no subscribers) so module state starts clean next test.
  cleanup();
  vi.runOnlyPendingTimers();
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
        reviewDecision: "approved",
        ciStatus: "success",
        canMerge: true,
        totalThreads: 5,
        unresolvedThreads: 2,
      }),
    );

    const result = await fetchPrInfo("https://github.com/org/repo/pull/123");
    expect(result.state).toBe("open");
    expect(result.reviewDecision).toBe("approved");
    expect(result.ciStatus).toBe("success");
    expect(result.canMerge).toBe(true);
    expect(result.totalThreads).toBe(5);
    expect(result.unresolvedThreads).toBe(2);
  });

  it("returns null for invalid reviewDecision values", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        state: "open",
        reviewDecision: "MERGED",
        ciStatus: "success",
        canMerge: false,
        totalThreads: 0,
        unresolvedThreads: 0,
      }),
    );

    const result = await fetchPrInfo("https://github.com/org/repo/pull/review-decision");
    expect(result.reviewDecision).toBeNull();
  });

  it("maps null ciStatus correctly", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        state: "merged",
        reviewDecision: null,
        ciStatus: null,
        canMerge: false,
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
        reviewDecision: null,
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
        reviewDecision: null,
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

  it("defaults numeric fields to 0 when missing from response", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        state: "open",
        reviewDecision: null,
        ciStatus: "pending",
      }),
    );

    const result = await fetchPrInfo("https://github.com/org/repo/pull/8");
    expect(result.totalThreads).toBe(0);
    expect(result.unresolvedThreads).toBe(0);
  });

  it("returns EMPTY_PR_INFO and clears Git error for soft missing PR payloads", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        state: null,
        reviewDecision: null,
        ciStatus: null,
        totalThreads: 0,
        unresolvedThreads: 0,
      }),
    );

    await act(async () => {
      const result = await fetchPrInfo("https://github.com/org/repo/pull/soft-missing");
      expect(result).toMatchObject({
        state: null,
        reviewDecision: null,
        ciStatus: null,
        canMerge: false,
        totalThreads: 0,
        unresolvedThreads: 0,
      });
    });
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
        reviewDecision: null,
        ciStatus: null,
        totalThreads: 1,
        unresolvedThreads: 0,
      }),
    );

    await expect(Promise.all([first, second])).resolves.toMatchObject([
      {
        state: "open",
        reviewDecision: null,
        ciStatus: null,
        canMerge: false,
        totalThreads: 1,
        unresolvedThreads: 0,
      },
      {
        state: "open",
        reviewDecision: null,
        ciStatus: null,
        canMerge: false,
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
        reviewDecision: null,
        ciStatus: "success",
        totalThreads: 3,
        unresolvedThreads: 1,
      }),
    );
    const { result: hook } = renderHook(() => usePrInfo(url));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
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
        reviewDecision: null,
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

  it("hydrates duplicate consumers when an equal result is already cached", async () => {
    let resolveFetch!: (value: Response) => void;
    const fetchPromise = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    mockFetch.mockReturnValueOnce(fetchPromise);

    const url = "https://github.com/org/repo/pull/duplicate-consumers";
    const first = renderHook(() => usePrInfo(url));
    const second = renderHook(() => usePrInfo(url));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFetch(
        jsonResponse({
          state: "open",
          reviewDecision: "approved",
          ciStatus: "success",
          totalThreads: 2,
          unresolvedThreads: 0,
        }),
      );
      await fetchPromise;
      await Promise.resolve();
    });

    expect(first.result.current.reviewDecision).toBe("approved");
    expect(second.result.current.reviewDecision).toBe("approved");
    expect(second.result.current.ciStatus).toBe("success");
  });
});

describe("extractLinkId", () => {
  it("extracts PR number from GitHub pull URL", () => {
    const link: SpurSessionLink = {
      label: "github-pr",
      url: "https://github.com/org/repo/pull/123",
    };
    expect(extractLinkId(link)).toBe("#123");
  });

  it("extracts PR number from legacy github_pr pull URL", () => {
    const link: SpurSessionLink = {
      label: "github_pr",
      url: "https://github.com/org/repo/pull/123",
    };
    expect(extractLinkId(link)).toBe("#123");
  });

  it("returns 'PR' when URL has no pull number", () => {
    const link: SpurSessionLink = { label: "github-pr", url: "https://github.com/org/repo" };
    expect(extractLinkId(link)).toBe("PR");
  });

  it("extracts merge request number from GitLab MR URL", () => {
    const link: SpurSessionLink = {
      label: "pr",
      url: "https://gitlab.com/org/repo/-/merge_requests/123",
    };
    expect(extractLinkId(link)).toBe("!123");
  });

  it("extracts tracker ID from /browse/ URL", () => {
    const link: SpurSessionLink = {
      label: "tracker",
      url: "https://jira.example.com/browse/PROJ-42",
    };
    expect(extractLinkId(link)).toBe("PROJ-42");
  });

  it("extracts tracker ID from jira label URLs", () => {
    const link: SpurSessionLink = {
      label: "jira",
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

describe("usePrInfo hook", () => {
  it("returns EMPTY_PR_INFO when url is undefined", () => {
    const { result } = renderHook(() => usePrInfo(undefined));
    expect(result.current.state).toBeNull();
    expect(result.current.reviewDecision).toBeNull();
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
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    // Resolve the fetch
    await act(async () => {
      resolveFetch(
        jsonResponse({
          state: "open",
          reviewDecision: "approved",
          ciStatus: "success",
          totalThreads: 2,
          unresolvedThreads: 1,
        }),
      );
      await fetchPromise;
    });

    expect(result.current.state).toBe("open");
    expect(result.current.reviewDecision).toBe("approved");
    expect(result.current.totalThreads).toBe(2);
  });

  it("sends one shared fetch per cycle for hooks on the same URL", async () => {
    const url = "https://github.com/org/repo/pull/usePrInfo-poll-v2";
    mockFetch.mockResolvedValue(
      jsonResponse({
        state: "open",
        reviewDecision: null,
        ciStatus: null,
        totalThreads: 0,
        unresolvedThreads: 0,
      }),
    );

    const first = renderHook(() => usePrInfo(url));
    const second = renderHook(() => usePrInfo(url));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(119_999);
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(mockFetch).toHaveBeenCalledTimes(2);

    first.unmount();
    second.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600_000);
    });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

describe("primePrInfo", () => {
  it("re-renders an already-mounted usePrInfo consumer", async () => {
    const url = "https://github.com/org/repo/pull/prime-rerender";
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        state: "open",
        reviewDecision: null,
        ciStatus: null,
        totalThreads: 0,
        unresolvedThreads: 0,
      }),
    );
    const { result } = renderHook(() => usePrInfo(url));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.state).toBe("open");

    act(() => {
      primePrInfo(url, {
        state: "merged",
        reviewDecision: null,
        ciStatus: null,
        canMerge: false,
        mergeConflict: false,
        totalThreads: 0,
        unresolvedThreads: 0,
      });
    });

    expect(result.current.state).toBe("merged");
  });
});

describe("fetchPrInfoBatch", () => {
  it("primes the cache for each URL in the batch response", async () => {
    const urlA = "https://github.com/org/repo/pull/batch-a";
    const urlB = "https://github.com/org/repo/pull/batch-b";
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        results: {
          [urlA]: {
            state: "open",
            reviewDecision: null,
            ciStatus: null,
            canMerge: true,
            mergeConflict: false,
            totalThreads: 0,
            unresolvedThreads: 0,
          },
          [urlB]: {
            state: "merged",
            reviewDecision: null,
            ciStatus: null,
            canMerge: false,
            mergeConflict: false,
            totalThreads: 0,
            unresolvedThreads: 0,
          },
        },
      }),
    );

    await fetchPrInfoBatch([urlA, urlB]);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [requestUrl, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(requestUrl).toBe("/api/pr-status/batch");
    expect(init.method).toBe("POST");

    const { result } = renderHook(() => usePrInfo(urlA));
    expect(result.current.state).toBe("open");
    expect(result.current.canMerge).toBe(true);
  });

  it("chunks requests above the route's 100-URL cap into multiple calls", async () => {
    const urls = Array.from(
      { length: 250 },
      (_, i) => `https://github.com/org/repo/pull/chunk-${i}`,
    );
    mockFetch.mockResolvedValue(jsonResponse({ results: {} }));

    const success = await fetchPrInfoBatch(urls);

    expect(success).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(3);
    const sizes = mockFetch.mock.calls.map(
      ([, init]) =>
        (JSON.parse((init as RequestInit).body as string) as { urls: string[] }).urls.length,
    );
    expect(sizes).toEqual([100, 100, 50]);
  });

  it("returns false when the request fails, without throwing", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ error: "bad request" }, false, 400));

    const success = await fetchPrInfoBatch(["https://github.com/org/repo/pull/batch-fail"]);

    expect(success).toBe(false);
  });

  it("returns false when a chunk network request throws", async () => {
    mockFetch.mockRejectedValueOnce(new Error("network down"));

    const success = await fetchPrInfoBatch(["https://github.com/org/repo/pull/batch-throw"]);

    expect(success).toBe(false);
  });

  it("does not clobber a cached entry with a soft error payload (state: null + error)", async () => {
    const url = "https://github.com/org/repo/pull/batch-soft-error";

    // Seed a known-good cache entry via the hook, which writes through to
    // the shared cache (a bare `fetchPrInfo` call does not).
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        state: "open",
        reviewDecision: null,
        ciStatus: "success",
        canMerge: true,
        totalThreads: 1,
        unresolvedThreads: 0,
      }),
    );
    renderHook(() => usePrInfo(url));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    // Batch response for the same URL carries a soft error (state: null, error set).
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        results: {
          [url]: {
            state: null,
            reviewDecision: null,
            ciStatus: null,
            canMerge: false,
            mergeConflict: false,
            totalThreads: 0,
            unresolvedThreads: 0,
            error: "GitHub API 503",
          },
        },
      }),
    );
    await fetchPrInfoBatch([url]);

    const { result } = renderHook(() => usePrInfo(url));
    expect(result.current.state).toBe("open");
    expect(result.current.ciStatus).toBe("success");
  });
});

describe("usePrReadyUrls", () => {
  it("does not fetch while disabled", () => {
    const urls = ["https://github.com/org/repo/pull/ready-disabled"];
    const { result } = renderHook(() => usePrReadyUrls(urls, false));

    expect(mockFetch).not.toHaveBeenCalled();
    expect(result.current.loaded).toBe(false);
    expect(result.current.ready.size).toBe(0);
  });

  it("returns only GitHub URLs satisfying isPrReady once the batch resolves", async () => {
    const readyUrl = "https://github.com/org/repo/pull/901";
    const notReadyUrl = "https://github.com/org/repo/pull/902";
    const gitlabUrl = "https://gitlab.com/org/repo/-/merge_requests/1";

    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        results: {
          [readyUrl]: {
            state: "open",
            reviewDecision: null,
            ciStatus: null,
            canMerge: true,
            mergeConflict: false,
            totalThreads: 0,
            unresolvedThreads: 0,
          },
          [notReadyUrl]: {
            state: "open",
            reviewDecision: "changes_requested",
            ciStatus: null,
            canMerge: true,
            mergeConflict: false,
            totalThreads: 0,
            unresolvedThreads: 0,
          },
        },
      }),
    );

    const urls = [readyUrl, notReadyUrl, gitlabUrl];
    const { result } = renderHook(() => usePrReadyUrls(urls, true));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { urls: string[] };
    expect(body.urls).toEqual([readyUrl, notReadyUrl]);

    expect(result.current.loaded).toBe(true);
    expect(result.current.ready.has(readyUrl)).toBe(true);
    expect(result.current.ready.has(notReadyUrl)).toBe(false);
  });

  it("keeps loaded false when the batch fetch fails, instead of committing an empty ready set", async () => {
    const url = "https://github.com/org/repo/pull/903";
    mockFetch.mockResolvedValueOnce(jsonResponse({ error: "at most 100 urls" }, false, 400));

    const { result } = renderHook(() => usePrReadyUrls([url], true));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(result.current.loaded).toBe(false);
    expect(result.current.ready.size).toBe(0);
  });

  it("resets loaded to false while a new URL set's batch is in flight, instead of keeping stale readiness", async () => {
    const urlA = "https://github.com/org/repo/pull/920";
    const urlB = "https://github.com/org/repo/pull/921";
    const prInfo = {
      state: "open",
      reviewDecision: null,
      ciStatus: null,
      canMerge: true,
      mergeConflict: false,
      totalThreads: 0,
      unresolvedThreads: 0,
    };

    mockFetch.mockResolvedValueOnce(jsonResponse({ results: { [urlA]: prInfo } }));

    const { result, rerender } = renderHook(({ urls }) => usePrReadyUrls(urls, true), {
      initialProps: { urls: [urlA] },
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(result.current.loaded).toBe(true);
    expect(result.current.ready.has(urlA)).toBe(true);

    // Leave the second batch unresolved so the reset can be observed before
    // it settles.
    let resolveSecondBatch: (value: Response) => void = () => {};
    mockFetch.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          resolveSecondBatch = resolve;
        }),
    );

    act(() => {
      rerender({ urls: [urlB] });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(result.current.loaded).toBe(false);

    resolveSecondBatch(jsonResponse({ results: { [urlB]: prInfo } }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(result.current.loaded).toBe(true);
    expect(result.current.ready.has(urlB)).toBe(true);
  });

  it("updates the ready set from a primePrInfo write without waiting for the next poll", async () => {
    const url = "https://github.com/org/repo/pull/930";
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        results: {
          [url]: {
            state: "open",
            reviewDecision: "changes_requested",
            ciStatus: null,
            canMerge: true,
            mergeConflict: false,
            totalThreads: 0,
            unresolvedThreads: 0,
          },
        },
      }),
    );

    const { result } = renderHook(() => usePrReadyUrls([url], true));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(result.current.loaded).toBe(true);
    expect(result.current.ready.has(url)).toBe(false);

    // A write from elsewhere (e.g. SessionRow's post-merge prime) flips the
    // PR to ready — the set must update immediately, not after POLL_MS.
    act(() => {
      primePrInfo(url, {
        state: "open",
        reviewDecision: null,
        ciStatus: null,
        canMerge: true,
        mergeConflict: false,
        totalThreads: 0,
        unresolvedThreads: 0,
      });
    });

    expect(result.current.ready.has(url)).toBe(true);
  });
});

describe("shared PR poller", () => {
  const openPr = {
    state: "open",
    reviewDecision: null,
    ciStatus: null,
    canMerge: true,
    mergeConflict: false,
    totalThreads: 0,
    unresolvedThreads: 0,
  };

  function setVisibility(state: "visible" | "hidden") {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
    document.dispatchEvent(new Event("visibilitychange"));
  }

  function batchBodies(): string[][] {
    return mockFetch.mock.calls
      .filter(([input]) => input === "/api/pr-status/batch")
      .map(
        ([, init]) => (JSON.parse((init as RequestInit).body as string) as { urls: string[] }).urls,
      );
  }

  function singleGets(): string[] {
    return mockFetch.mock.calls
      .map(([input]) => String(input))
      .filter((input) => input.startsWith("/api/pr-status?"));
  }

  // Echoes every requested URL back as an open PR, like the batch route.
  function mockEchoBackend(extra: Record<string, unknown> = {}) {
    mockFetch.mockImplementation(async (input, init) => {
      if (input === "/api/pr-status/batch") {
        const { urls } = JSON.parse((init as RequestInit).body as string) as { urls: string[] };
        return jsonResponse({
          results: Object.fromEntries(urls.map((url) => [url, { ...openPr, ...extra }])),
        });
      }
      return jsonResponse({ ...openPr, ...extra });
    });
  }

  async function advance(ms: number) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  afterEach(() => {
    setVisibility("visible");
  });

  it("30 mounted hooks on GitHub URLs cost one batch per 120s cycle and no single GETs", async () => {
    mockEchoBackend();
    const urls = Array.from(
      { length: 30 },
      (_, i) => `https://github.com/org/repo/pull/${1000 + i}`,
    );
    for (const url of urls) renderHook(() => usePrInfo(url));

    await advance(0);
    expect(batchBodies()).toHaveLength(1);
    expect(batchBodies()[0]).toHaveLength(30);
    await advance(120_000);
    expect(batchBodies()).toHaveLength(2);
    await advance(119_999);
    expect(batchBodies()).toHaveLength(2);
    await advance(1);
    expect(batchBodies()).toHaveLength(3);
    expect(singleGets()).toHaveLength(0);
  });

  it("the same URL on two hooks appears once in the batch", async () => {
    mockEchoBackend();
    const url = "https://github.com/org/repo/pull/1100";
    renderHook(() => usePrInfo(url));
    renderHook(() => usePrInfo(url));
    await advance(0);
    expect(batchBodies()).toEqual([[url]]);
  });

  it("keeps one batch per cycle for stale entries and sends nothing on remount", async () => {
    mockEchoBackend({ stale: true });
    const url = "https://github.com/org/repo/pull/1200";
    const first = renderHook(() => usePrInfo(url));
    await advance(0);
    expect(batchBodies()).toHaveLength(1);

    first.unmount();
    renderHook(() => usePrInfo(url));
    await advance(0);
    expect(batchBodies()).toHaveLength(1);

    await advance(120_000);
    expect(batchBodies()).toHaveLength(2);
  });

  it("polls a GitLab URL with one GET per cycle", async () => {
    mockEchoBackend();
    const url = "https://gitlab.com/org/repo/-/merge_requests/7";
    renderHook(() => usePrInfo(url));
    await advance(0);
    expect(singleGets()).toHaveLength(1);
    expect(batchBodies()).toHaveLength(0);
    await advance(120_000);
    expect(singleGets()).toHaveLength(2);
  });

  it("stops polling when every hook unmounts", async () => {
    mockEchoBackend();
    const url = "https://github.com/org/repo/pull/1300";
    const hook = renderHook(() => usePrInfo(url));
    await advance(0);
    hook.unmount();
    await advance(600_000);
    expect(batchBodies()).toHaveLength(1);
  });

  it("sends nothing while hidden and one batch on visible", async () => {
    mockEchoBackend();
    setVisibility("hidden");
    renderHook(() => usePrInfo("https://github.com/org/repo/pull/1400"));
    await advance(300_000);
    expect(mockFetch).not.toHaveBeenCalled();
    await act(async () => {
      setVisibility("visible");
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(batchBodies()).toHaveLength(1);
  });

  it("keeps loaded false until a run started after the URL set changed settles", async () => {
    const urlA = "https://github.com/org/repo/pull/1500";
    const urlB = "https://github.com/org/repo/pull/1501";
    const resolvers: Array<(response: Response) => void> = [];
    mockFetch.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const { result, rerender } = renderHook(({ urls }) => usePrReadyUrls(urls, true), {
      initialProps: { urls: [urlA] },
    });
    await advance(0);
    expect(resolvers).toHaveLength(1);

    // Set changes to B while A's batch is in flight.
    rerender({ urls: [urlB] });
    await advance(0);
    expect(resolvers).toHaveLength(1);

    await act(async () => {
      resolvers[0]?.(jsonResponse({ results: { [urlA]: openPr } }));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.loaded).toBe(false);

    // The follow-up run started after B subscribed; its success flips loaded.
    expect(resolvers).toHaveLength(2);
    await act(async () => {
      resolvers[1]?.(jsonResponse({ results: { [urlB]: openPr } }));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.loaded).toBe(true);
    expect(result.current.ready.has(urlB)).toBe(true);
  });

  it("sends nothing on remount after a poll returned an unchanged result", async () => {
    mockEchoBackend();
    const url = "https://gitlab.com/org/repo/-/merge_requests/8";
    const first = renderHook(() => usePrInfo(url));
    await advance(0);
    await advance(120_000);
    // Second poll returned data equal to the cache, which writes nothing.
    expect(singleGets()).toHaveLength(2);

    first.unmount();
    renderHook(() => usePrInfo(url));
    await advance(0);
    expect(singleGets()).toHaveLength(2);
  });

  it("sends nothing on remount after a batch skipped an errored result", async () => {
    const url = "https://github.com/org/repo/pull/1800";
    mockFetch.mockImplementation(async () =>
      jsonResponse({
        results: { [url]: { ...openPr, state: null, error: "GitHub API 503" } },
      }),
    );
    const first = renderHook(() => usePrInfo(url));
    await advance(0);
    expect(batchBodies()).toHaveLength(1);

    first.unmount();
    renderHook(() => usePrInfo(url));
    await advance(0);
    expect(batchBodies()).toHaveLength(1);
  });

  it("keeps loaded false for an overlapping URL set until the follow-up run settles", async () => {
    const urlA = "https://github.com/org/repo/pull/1600";
    const urlShared = "https://github.com/org/repo/pull/1601";
    const urlB = "https://github.com/org/repo/pull/1602";
    const resolvers: Array<(response: Response) => void> = [];
    mockFetch.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const { result, rerender } = renderHook(({ urls }) => usePrReadyUrls(urls, true), {
      initialProps: { urls: [urlA, urlShared] },
    });
    await advance(0);
    expect(resolvers).toHaveLength(1);

    rerender({ urls: [urlShared, urlB] });
    await advance(0);

    // A's batch primes the shared URL; the new set must stay not loaded.
    await act(async () => {
      resolvers[0]?.(jsonResponse({ results: { [urlA]: openPr, [urlShared]: openPr } }));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.loaded).toBe(false);

    expect(resolvers).toHaveLength(2);
    await act(async () => {
      resolvers[1]?.(jsonResponse({ results: { [urlB]: openPr } }));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.loaded).toBe(true);
  });

  it("never overlaps two batch runs across an unmount-all and remount", async () => {
    const resolvers: Array<(response: Response) => void> = [];
    mockFetch.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const urlA = "https://github.com/org/repo/pull/1700";
    const urlB = "https://github.com/org/repo/pull/1701";
    const first = renderHook(() => usePrInfo(urlA));
    await advance(0);
    expect(resolvers).toHaveLength(1);

    first.unmount();
    await advance(0);
    renderHook(() => usePrInfo(urlB));
    await advance(0);
    expect(resolvers).toHaveLength(1);

    await act(async () => {
      resolvers[0]?.(jsonResponse({ results: { [urlA]: openPr } }));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(resolvers).toHaveLength(2);
    expect(batchBodies()[1]).toEqual([urlB]);
  });
});
