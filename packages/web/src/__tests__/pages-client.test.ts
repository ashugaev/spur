import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchPages, PagesRequestError, parsePages } from "@/lib/pages-client";

const page = {
  id: "my-films",
  title: "Мои фильмы",
  url: "/p/my-films/",
  path: "/private/page",
  agent: { runtime: "codex" },
};
afterEach(() => vi.unstubAllGlobals());

describe("pages catalogue boundary", () => {
  it("consumes current metadata without exposing unused private fields", () => {
    expect(parsePages({ pages: [page] })).toEqual([
      { id: page.id, title: page.title, url: page.url },
    ]);
    expect(parsePages({ pages: [] })).toEqual([]);
  });
  it.each([
    null,
    {},
    { pages: null },
    { pages: [null] },
    { pages: [{ ...page, id: "../escape" }] },
    { pages: [{ ...page, title: " " }] },
    { pages: [{ ...page, url: "https://foreign.example/" }] },
    { pages: [{ ...page, url: "/p/other/" }] },
    { pages: [{ ...page, url: "//foreign.example/" }] },
  ])("rejects malformed or unsafe metadata %j", (value) => {
    expect(() => parsePages(value)).toThrow("Invalid pages response");
  });
  it("fetches uncached and preserves actual HTTP failure status", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response("private upstream detail", { status: 503 }));
    vi.stubGlobal("fetch", fetch);
    await expect(fetchPages()).rejects.toMatchObject({ status: 503 });
    expect(fetch).toHaveBeenCalledWith("/api/pages", { cache: "no-store" });
    expect(new PagesRequestError(503).message).not.toContain("private");
  });
  it("rejects invalid JSON and parses a successful envelope", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response("broken"))
        .mockResolvedValueOnce(new Response(JSON.stringify({ pages: [page] }))),
    );
    await expect(fetchPages()).rejects.toThrow("Invalid pages response");
    await expect(fetchPages()).resolves.toEqual([
      { id: page.id, title: page.title, url: page.url },
    ]);
  });
});
