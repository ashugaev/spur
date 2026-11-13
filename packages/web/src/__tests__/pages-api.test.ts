import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "@/app/api/pages/route";

beforeEach(() => vi.stubEnv("SPUR_DAEMON_URL", "http://isolated.test"));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("pages creation proxy", () => {
  function request(body = "{}", site = "same-origin") {
    return new Request("http://web.test/api/pages", {
      method: "POST",
      headers: { "content-type": "application/json", "sec-fetch-site": site },
      body,
    });
  }
  it("generates one id without overriding daemon agent defaults", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('{"id":"new"}', { status: 201 }));
    vi.stubGlobal("fetch", fetch);
    expect((await POST(request())).status).toBe(201);
    const init = fetch.mock.calls[0]?.[1] as RequestInit;
    const body: unknown = JSON.parse(String(init.body));
    expect(body).toEqual({
      id: expect.stringMatching(/^p-[a-f0-9-]{36}$/),
      title: "New page",
      template: "blank",
    });
  });
  it("guards cross-site and rejects malformed/nonempty bodies before forwarding", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect((await POST(request("{}", "cross-site"))).status).toBe(403);
    for (const body of ["[", "null", "[]", '{"runtime":"codex"}'])
      expect((await POST(request(body))).status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });
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
