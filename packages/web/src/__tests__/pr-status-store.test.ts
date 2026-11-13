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
  inspectCachedPrStatus,
  readCachedPrStatus,
  recordSuccessfulPrStatus,
  markPrStatusMerged,
  resetPrStatusCacheForTests,
} from "@/lib/pr-status-store";

const COORDS = { owner: "a", repo: "b", number: "1" };
const SUCCESS = {
  state: "open",
  reviewDecision: null,
  ciStatus: null,
  canMerge: true,
  totalThreads: 0,
  unresolvedThreads: 0,
};

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
  it("retains reviewer names in stale and merged snapshots", () => {
    const key = "a/b/1";
    const reviewers = {
      approved: ["alice"],
      changesRequested: ["bob"],
      pending: [{ name: "core", team: true }],
    };
    const checks = [{ name: "lint", state: "failed" as const }];
    recordSuccessfulPrStatus(key, {
      checks,
      state: "open",
      reviewDecision: "approved",
      ciStatus: "success",
      canMerge: true,
      mergeConflict: false,
      totalThreads: 0,
      unresolvedThreads: 0,
      reviewers,
      reviewRequirement: "required",
    });
    expect(inspectCachedPrStatus(key)).toMatchObject({ reviewers, checks });
    expect(errorResponse(key, "offline")).toMatchObject({
      reviewers,
      checks,
      reviewRequirement: "required",
      stale: true,
    });
    markPrStatusMerged("https://github.com/a/b/pull/1");
    expect(readCachedPrStatus(key)).toMatchObject({
      state: "merged",
      reviewers,
      checks,
      reviewRequirement: "required",
    });
  });

  it("returns null for an unknown key", () => {
    expect(readCachedPrStatus("missing")).toBeNull();
  });

  it("round-trips a cached response", () => {
    const key = cacheKeyForCoords(COORDS);
    const response = { ...SUCCESS, stale: false, fetchedAt: 0 };
    cachePrStatusResponse(key, response, 60_000);
    expect(readCachedPrStatus(key)).toEqual(response);
  });
});

describe("errorResponse", () => {
  it("returns the last-good snapshot flagged stale when present", () => {
    const key = cacheKeyForCoords(COORDS);
    recordSuccessfulPrStatus(key, SUCCESS);
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
    const key = cacheKeyForCoords(COORDS);
    recordSuccessfulPrStatus(key, SUCCESS);
    resetPrStatusCacheForTests();
    expect(errorResponse(key, "boom").state).toBeNull();
  });
});
