import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetReleasesCacheForTest, getReleases } from "../../src/releases-cache.js";

interface RegistryDoc {
  versions: Record<string, Record<string, never>>;
  time: Record<string, string>;
}

function makeRegistryDoc(entries: Array<[string, string]>): RegistryDoc {
  const versions: Record<string, Record<string, never>> = {};
  const time: Record<string, string> = {};
  for (const [tag, publishedAt] of entries) {
    versions[tag] = {};
    time[tag] = publishedAt;
  }
  return { versions, time };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("releases-cache.getReleases", () => {
  beforeEach(() => {
    __resetReleasesCacheForTest();
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("filters prereleases and sorts descending", async () => {
    const doc = makeRegistryDoc([
      ["0.1.0", "2026-01-01T00:00:00.000Z"],
      ["1.0.0-beta.1", "2026-02-01T00:00:00.000Z"],
      ["0.2.0", "2026-03-01T00:00:00.000Z"],
      ["1.0.0", "2026-04-01T00:00:00.000Z"],
      ["0.10.0", "2026-05-01T00:00:00.000Z"],
    ]);
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(doc));

    const entries = await getReleases(0);

    expect(entries.map((e) => e.tag)).toEqual(["1.0.0", "0.10.0", "0.2.0", "0.1.0"]);
    expect(entries[0]).toEqual({ tag: "1.0.0", publishedAt: "2026-04-01T00:00:00.000Z" });
  });

  it("returns cached value on second call within TTL without refetching", async () => {
    const doc = makeRegistryDoc([["0.1.0", "2026-01-01T00:00:00.000Z"]]);
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(doc));

    const first = await getReleases(1_000);
    const second = await getReleases(1_000 + 9 * 60 * 1000);

    expect(first).toEqual(second);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  it("refetches after TTL expires", async () => {
    const docA = makeRegistryDoc([["0.1.0", "2026-01-01T00:00:00.000Z"]]);
    const docB = makeRegistryDoc([
      ["0.1.0", "2026-01-01T00:00:00.000Z"],
      ["0.2.0", "2026-02-01T00:00:00.000Z"],
    ]);
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(docA))
      .mockResolvedValueOnce(jsonResponse(docB));

    const first = await getReleases(0);
    expect(first.map((e) => e.tag)).toEqual(["0.1.0"]);

    const second = await getReleases(11 * 60 * 1000);
    expect(second.map((e) => e.tag)).toEqual(["0.2.0", "0.1.0"]);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
  });

  it("returns empty array on network error when cache is cold", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error("network down"));

    const entries = await getReleases(0);

    expect(entries).toEqual([]);
  });

  it("returns stale cache on network error after a previous successful fetch", async () => {
    const doc = makeRegistryDoc([["0.1.0", "2026-01-01T00:00:00.000Z"]]);
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(doc))
      .mockRejectedValueOnce(new Error("network down"));

    const first = await getReleases(0);
    expect(first.map((e) => e.tag)).toEqual(["0.1.0"]);

    const second = await getReleases(11 * 60 * 1000);
    expect(second).toEqual(first);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
  });

  it("treats non-2xx HTTP status as failure", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({}, { status: 503 }));

    const entries = await getReleases(0);

    expect(entries).toEqual([]);
  });

  it("skips versions missing a publish time", async () => {
    const doc: RegistryDoc = {
      versions: { "0.1.0": {}, "0.2.0": {} },
      time: { "0.2.0": "2026-02-01T00:00:00.000Z" },
    };
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(doc));

    const entries = await getReleases(0);

    expect(entries.map((e) => e.tag)).toEqual(["0.2.0"]);
  });
});
