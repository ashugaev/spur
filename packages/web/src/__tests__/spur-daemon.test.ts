// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spurJsonInit, spurRequest, spurRequestJson } from "@/lib/spur-daemon";

const ORIG_DAEMON_URL = process.env["SPUR_DAEMON_URL"];

async function expectRejectsWithMessage(promise: Promise<unknown>, message: string): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }

  if (!(caught instanceof Error)) {
    throw new Error("Expected promise to reject with an Error.");
  }

  expect(caught.message).toContain(message);
}

describe("spur-daemon", () => {
  beforeEach(() => {
    process.env["SPUR_DAEMON_URL"] = "http://127.0.0.1:4310";
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    if (ORIG_DAEMON_URL === undefined) delete process.env["SPUR_DAEMON_URL"];
    else process.env["SPUR_DAEMON_URL"] = ORIG_DAEMON_URL;
    vi.unstubAllGlobals();
  });

  it("spurRequestJson returns parsed JSON on 200", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, items: [1, 2] }), { status: 200 }),
    );

    const data = await spurRequestJson<{ ok: boolean; items: number[] }>("/sessions");
    expect(data).toEqual({ ok: true, items: [1, 2] });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:4310/sessions",
      expect.objectContaining({ cache: "no-store" }),
    );
  });

  it("spurRequestJson throws with payload.error when present and response not ok", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "spawn rejected" }), { status: 400 }),
    );

    await expectRejectsWithMessage(spurRequestJson("/spawn"), "spawn rejected");
  });

  it("spurRequestJson throws default message when error field absent", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ something: "else" }), { status: 502 }),
    );

    await expectRejectsWithMessage(spurRequestJson("/spawn"), "Spur daemon request failed (502)");
  });

  it("spurRequestJson treats invalid JSON error responses as daemon messages", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response("daemon unavailable", { status: 502 }));

    await expectRejectsWithMessage(spurRequestJson("/spawn"), "daemon unavailable");
  });

  it("spurRequest forwards arbitrary headers and sets cache no-store", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(new Response("", { status: 200 }));

    await spurRequest("/health", { headers: { "x-trace": "abc" } });
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init).toMatchObject({
      cache: "no-store",
      headers: { "x-trace": "abc" },
    });
  });

  it("spurJsonInit returns JSON init with content-type and JSON body; undefined body stays undefined", () => {
    expect(spurJsonInit("POST", { id: 1 })).toEqual({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: 1 }),
    });

    expect(spurJsonInit("PATCH", { id: 1 })).toEqual({
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: 1 }),
    });

    expect(spurJsonInit("POST")).toEqual({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: undefined,
    });
  });
});
