import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { jsonResponse } from "@/lib/json-response";

const bigPayload = { items: Array.from({ length: 500 }, (_, index) => ({ index, note: "spur" })) };

function requestWith(acceptEncoding?: string): Request {
  return new Request("http://localhost/api/sessions", {
    headers: acceptEncoding ? { "accept-encoding": acceptEncoding } : {},
  });
}

async function bodyOf(response: Response): Promise<Buffer> {
  return Buffer.from(await response.arrayBuffer());
}

describe("jsonResponse", () => {
  it("gzips a large body and keeps it decodable", async () => {
    const response = await jsonResponse(requestWith("gzip, deflate, br"), bigPayload);
    const body = await bodyOf(response);

    expect(response.headers.get("content-encoding")).toBe("gzip");
    expect(response.headers.get("vary")).toBe("accept-encoding");
    expect(body.byteLength).toBeLessThan(JSON.stringify(bigPayload).length / 2);
    expect(JSON.parse(gunzipSync(body).toString("utf8"))).toEqual(bigPayload);
  });

  it("leaves the body raw when the caller does not accept gzip", async () => {
    const response = await jsonResponse(requestWith(), bigPayload);

    expect(response.headers.get("content-encoding")).toBeNull();
    await expect(response.json()).resolves.toEqual(bigPayload);
  });

  it("does not match a gzip substring of another encoding token", async () => {
    const response = await jsonResponse(requestWith("notgzip"), bigPayload);

    expect(response.headers.get("content-encoding")).toBeNull();
  });

  it("treats an explicit gzip;q=0 as a refusal", async () => {
    const response = await jsonResponse(requestWith("gzip;q=0, deflate"), bigPayload);

    expect(response.headers.get("content-encoding")).toBeNull();
    await expect(response.json()).resolves.toEqual(bigPayload);
  });

  it("still compresses for a weighted but non-zero gzip preference", async () => {
    const response = await jsonResponse(requestWith("br;q=1.0, gzip; q=0.5"), bigPayload);

    expect(response.headers.get("content-encoding")).toBe("gzip");
  });

  it("does not copy the body it hands to the response", async () => {
    // Buffer is not a valid BodyInit, so the body goes out as a view over the
    // same memory; a copy would be a second multi-megabyte allocation.
    const response = await jsonResponse(requestWith(), bigPayload);
    const raw = JSON.stringify(bigPayload);

    expect((await bodyOf(response)).toString("utf8")).toBe(raw);
  });

  it("falls back to identity for a malformed qvalue", async () => {
    // Number.parseFloat("abc") is NaN, and NaN > 0 is false, so an
    // unparseable qvalue declines compression rather than assuming it.
    for (const header of ["gzip;q=abc", "gzip;q="]) {
      const response = await jsonResponse(requestWith(header), bigPayload);
      expect(response.headers.get("content-encoding")).toBeNull();
    }
  });

  it("matches the encoding token case-insensitively, qvalue included", async () => {
    await expect(
      jsonResponse(requestWith("GZIP;Q=0"), bigPayload).then((r) =>
        r.headers.get("content-encoding"),
      ),
    ).resolves.toBeNull();
    await expect(
      jsonResponse(requestWith("GZIP"), bigPayload).then((r) => r.headers.get("content-encoding")),
    ).resolves.toBe("gzip");
  });

  it("leaves a short body uncompressed", async () => {
    const response = await jsonResponse(requestWith("gzip"), { ok: true });

    expect(response.headers.get("content-encoding")).toBeNull();
    expect((await bodyOf(response)).toString("utf8")).toBe('{"ok":true}');
  });
});
