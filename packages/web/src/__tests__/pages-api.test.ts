import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/pages/route";

beforeEach(() => vi.stubEnv("SPUR_DAEMON_URL", "http://isolated.test"));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("pages GET proxy", () => {
  it("forwards exactly /pages without cache and returns the current envelope", async () => {
    const payload = { pages: [{ id: "films", title: "Films", url: "/p/films/" }] };
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(payload)));
    vi.stubGlobal("fetch", fetch);
    const response = await GET();
    expect(await response.json()).toEqual(payload);
    expect(fetch).toHaveBeenCalledWith(
      "http://isolated.test/pages",
      expect.objectContaining({ cache: "no-store", headers: { "x-spur-origin": "ui" } }),
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it("preserves daemon errors and maps invalid JSON or unavailable daemon to 502", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response('{"error":"Unavailable"}', { status: 503 }))
        .mockResolvedValueOnce(new Response("invalid"))
        .mockRejectedValueOnce(new Error("offline")),
    );
    expect((await GET()).status).toBe(503);
    expect((await GET()).status).toBe(502);
    expect((await GET()).status).toBe(502);
  });
  it("never falls back to a default daemon", async () => {
    vi.stubEnv("SPUR_DAEMON_URL", "");
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect((await GET()).status).toBe(502);
    expect(fetch).not.toHaveBeenCalled();
  });
});
