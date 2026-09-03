import { gzip } from "node:zlib";
import { NextResponse } from "next/server";

/**
 * Bodies below this stay uncompressed: gzip's framing makes a short response
 * bigger, and the small frequent polls gain nothing from the round trip.
 */
const MIN_COMPRESS_BYTES = 1024;

function acceptsGzip(request: Request): boolean {
  return /(^|,)\s*gzip\s*(;|,|$)/.test(request.headers.get("accept-encoding") ?? "");
}

async function gzipOrNull(body: Buffer): Promise<Buffer | null> {
  // Async so zlib runs on the threadpool: compressing a multi-megabyte payload
  // inline would stall the event loop for every other request in flight.
  return await new Promise<Buffer | null>((resolve) => {
    gzip(body, (error, result) => resolve(error ? null : result));
  });
}

/**
 * JSON response, gzipped when the caller accepts it.
 *
 * Next compresses the documents and static chunks it serves itself, but not
 * route handlers — those go out chunked and raw. The dashboard polls this
 * shape every few seconds and its body runs to megabytes.
 */
export async function jsonResponse(request: Request, payload: unknown): Promise<NextResponse> {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  const compressed =
    acceptsGzip(request) && body.byteLength >= MIN_COMPRESS_BYTES ? await gzipOrNull(body) : null;

  return new NextResponse(new Uint8Array(compressed ?? body), {
    headers: {
      "content-type": "application/json",
      vary: "accept-encoding",
      ...(compressed ? { "content-encoding": "gzip" } : {}),
    },
  });
}
