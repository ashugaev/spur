import { gzip } from "node:zlib";
import { NextResponse } from "next/server";

/**
 * Bodies below this stay uncompressed: gzip's framing makes a short response
 * bigger, and the small frequent polls gain nothing from the round trip.
 */
const MIN_COMPRESS_BYTES = 1024;

function acceptsGzip(request: Request): boolean {
  for (const entry of (request.headers.get("accept-encoding") ?? "").split(",")) {
    const [token, ...parameters] = entry.trim().split(";");
    if (token?.trim().toLowerCase() !== "gzip") {
      continue;
    }
    const quality = parameters
      .map((parameter) => parameter.trim().toLowerCase())
      .find((parameter) => parameter.startsWith("q="))
      ?.slice(2);
    // `gzip;q=0` is an explicit refusal, not a weak preference.
    return quality === undefined || Number.parseFloat(quality) > 0;
  }
  return false;
}

async function gzipOrNull(body: Buffer): Promise<Buffer | null> {
  // Async so zlib runs on the threadpool: compressing a multi-megabyte payload
  // inline would stall the event loop for every other request in flight.
  return await new Promise<Buffer | null>((resolve) => {
    gzip(body, (error, result) => resolve(error ? null : result));
  });
}

/** A Buffer as a plain view, since Buffer is not a valid BodyInit. */
function asBody(buffer: Buffer): Uint8Array<ArrayBuffer> {
  // A view over the same memory, never `new Uint8Array(buffer)` — that
  // constructor copies, which on a multi-megabyte body is a second full
  // allocation per request.
  // `buffer.buffer` is typed ArrayBufferLike to allow SharedArrayBuffer, which
  // Node never uses for its own allocations, and BodyInit only accepts the
  // ArrayBuffer-backed view.
  return new Uint8Array(buffer.buffer as ArrayBuffer, buffer.byteOffset, buffer.byteLength);
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

  return new NextResponse(asBody(compressed ?? body), {
    headers: {
      "content-type": "application/json",
      vary: "accept-encoding",
      ...(compressed ? { "content-encoding": "gzip" } : {}),
    },
  });
}
