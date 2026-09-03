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

  it("leaves a short body uncompressed", async () => {
    const response = await jsonResponse(requestWith("gzip"), { ok: true });

    expect(response.headers.get("content-encoding")).toBeNull();
    expect((await bodyOf(response)).toString("utf8")).toBe('{"ok":true}');
  });
});
