import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", () => {
  const fns = {
    mkdirSync: vi.fn(),
    readFileSync: vi.fn(() => {
      throw new Error("ENOENT");
    }),
    renameSync: vi.fn(),
    writeFileSync: vi.fn(),
  };
  return { default: fns, ...fns };
});

import {
  cachePrStatusResponse,
  cacheKeyForCoords,
  errorResponse,
  extractPrCoords,
  readCachedPrStatus,
  recordSuccessfulPrStatus,
  resetPrStatusCacheForTests,
} from "@/lib/pr-status-store";

beforeEach(() => {
  resetPrStatusCacheForTests();
});

afterEach(() => {
  resetPrStatusCacheForTests();
});

describe("extractPrCoords", () => {
  it("returns null for an unknown URL shape", () => {
    expect(extractPrCoords("https://example.com")).toBeNull();
  });

  it("extracts owner, repo, and pr number from a GitHub URL", () => {
    expect(extractPrCoords("https://github.com/acme/widgets/pull/42")).toEqual({
      owner: "acme",
      repo: "widgets",
      number: "42",
    });
  });
});

describe("pr-status cache", () => {
  it("returns null for an unknown key", () => {
    expect(readCachedPrStatus("missing")).toBeNull();
  });

  it("round-trips a cached response", () => {
    const key = cacheKeyForCoords({ owner: "a", repo: "b", number: "1" });
    const response = {
      state: "open",
      reviewDecision: null,
      ciStatus: null,
      canMerge: true,
      totalThreads: 0,
      unresolvedThreads: 0,
      stale: false,
      fetchedAt: 0,
    };
    cachePrStatusResponse(key, response, 60_000);
    expect(readCachedPrStatus(key)).toEqual(response);
  });
});

describe("errorResponse", () => {
  it("returns the last-good snapshot flagged stale when present", () => {
    const key = cacheKeyForCoords({ owner: "a", repo: "b", number: "1" });
    recordSuccessfulPrStatus(key, {
      state: "open",
      reviewDecision: null,
      ciStatus: null,
      canMerge: true,
      totalThreads: 0,
      unresolvedThreads: 0,
    });
    const response = errorResponse(key, "network");
    expect(response.stale).toBe(true);
    expect(response.error).toBe("network");
    expect(response.state).toBe("open");
  });

  it("returns an empty snapshot when no last-good is present", () => {
    const response = errorResponse("missing", "boom");
    expect(response.state).toBeNull();
    expect(response.error).toBe("boom");
  });
});

describe("resetPrStatusCacheForTests", () => {
  it("clears both the cache and the last-good snapshots", () => {
    const key = cacheKeyForCoords({ owner: "a", repo: "b", number: "1" });
    recordSuccessfulPrStatus(key, {
      state: "open",
      reviewDecision: null,
      ciStatus: null,
      canMerge: true,
      totalThreads: 0,
      unresolvedThreads: 0,
    });
    resetPrStatusCacheForTests();
    const response = errorResponse(key, "boom");
    expect(response.state).toBeNull();
  });
});
