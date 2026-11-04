// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/spur-daemon", () => ({
  spurRequest: vi.fn(),
}));

import { GET } from "@/app/api/sessions/[id]/auto-ping/route";
import { spurRequest } from "@/lib/spur-daemon";
import { isAutoPingMuteProjection } from "@/lib/types";

const mockedSpurRequest = vi.mocked(spurRequest);

const mute = {
  suppressionId: "m1",
  mode: "until_change",
  items: [{ subject: "review:github:o/r#7", kind: "ci_failed", label: "until next commit" }],
  createdAt: "2026-11-03T00:00:00.000Z",
};

afterEach(() => vi.resetAllMocks());

describe("isAutoPingMuteProjection", () => {
  it("accepts records and history", () => {
    expect(isAutoPingMuteProjection({ records: [mute], history: [] })).toBe(true);
    expect(
      isAutoPingMuteProjection({
        records: [],
        history: [{ ...mute, endedAt: "2026-11-03T01:00:00.000Z", endReason: "changed" }],
      }),
    ).toBe(true);
  });

  it.each([
    null,
    {},
    { records: [] },
    { records: [{ ...mute, mode: "sometimes" }], history: [] },
    { records: [{ ...mute, items: [{ subject: 1 }] }], history: [] },
    { records: [], history: [{ ...mute, endReason: "gone" }] },
  ])("rejects malformed payload %j", (value) => {
    expect(isAutoPingMuteProjection(value)).toBe(false);
  });
});

describe("GET /api/sessions/:id/auto-ping", () => {
  const context = { params: Promise.resolve({ id: "my/session 1" }) };

  it("proxies the daemon projection with history", async () => {
    mockedSpurRequest.mockResolvedValue(
      new Response(JSON.stringify({ records: [mute], history: [mute] }), { status: 200 }),
    );
    const response = await GET(new Request("http://localhost"), context);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ records: [mute], history: [mute] });
    expect(mockedSpurRequest).toHaveBeenCalledWith(
      "/sessions/my%2Fsession%201/auto-ping-suppressions?all=1",
    );
  });

  it("preserves daemon errors and rejects malformed successful payloads", async () => {
    mockedSpurRequest.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { code: "session_not_found" } }), { status: 404 }),
    );
    const missing = await GET(new Request("http://localhost"), context);
    expect(missing.status).toBe(404);

    mockedSpurRequest.mockResolvedValueOnce(
      new Response(JSON.stringify({ records: [] }), { status: 200 }),
    );
    const malformed = await GET(new Request("http://localhost"), context);
    expect(malformed.status).toBe(502);
    await expect(malformed.json()).resolves.toEqual({
      error: "Invalid auto-ping response from Spur daemon",
    });
  });
});
