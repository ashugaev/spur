import { afterEach, describe, expect, it } from "vitest";
import {
  readPlatformStatusCache,
  resetPlatformStatusCacheForTests,
  writePlatformStatusCache,
} from "@/lib/platform-status";

afterEach(() => {
  resetPlatformStatusCacheForTests();
});

describe("platform-status cache", () => {
  it("returns null when the cache is empty for the key", () => {
    expect(readPlatformStatusCache("github")).toBeNull();
  });

  it("round-trips a written entry", () => {
    const entry = {
      response: { ok: true as const, requestedAt: "2025-01-01T00:00:00Z" },
      expiresAt: 1_700_000_000_000,
    };
    writePlatformStatusCache("github", entry);
    expect(readPlatformStatusCache("github")).toEqual(entry);
  });

  it("resetForTests wipes the cache", () => {
    writePlatformStatusCache("github", {
      response: { ok: false, error: "boom", requestedAt: null },
      expiresAt: 0,
    });
    resetPlatformStatusCacheForTests();
    expect(readPlatformStatusCache("github")).toBeNull();
  });
});
