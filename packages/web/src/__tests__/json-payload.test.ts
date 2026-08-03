import { describe, expect, it } from "vitest";
import {
  errorMessage,
  readApiErrorMessage,
  readResponsePayload,
  responseErrorMessage,
} from "@/lib/json-payload";

function htmlResponse(status: number, body: string, contentType = "text/html"): Response {
  return new Response(body, { status, headers: { "content-type": contentType } });
}

describe("readResponsePayload", () => {
  it("parses a JSON error body unchanged", async () => {
    const response = new Response(JSON.stringify({ error: "Session not found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
    expect(await readResponsePayload(response)).toEqual({ error: "Session not found" });
  });

  it("collapses a 413 body to a short, neutral message regardless of content", async () => {
    // Neutral, not attachment-specific: a 413 can come from an oversize text
    // message with no attachments at all. The attachment-specific advice
    // comes only from the client pre-flight (ATTACHMENTS_TOO_LARGE_MESSAGE),
    // which fires exactly when attachments are the cause.
    const response = htmlResponse(413, "<html><body>413 Request Entity Too Large</body></html>");
    expect(await readResponsePayload(response)).toEqual({
      error: "Request rejected: payload too large.",
    });
  });

  it("collapses an HTML proxy error page instead of leaking markup", async () => {
    const response = htmlResponse(
      502,
      "<!DOCTYPE html><html><head><title>502 Bad Gateway</title></head><body>nginx</body></html>",
    );
    expect(await readResponsePayload(response)).toEqual({
      error: "Request failed (HTTP 502).",
    });
  });

  it("detects HTML by content-type even without a leading doctype", async () => {
    const response = htmlResponse(500, "<html>oops</html>", "text/html; charset=utf-8");
    expect(await readResponsePayload(response)).toEqual({
      error: "Request failed (HTTP 500).",
    });
  });

  it("keeps a short non-JSON, non-HTML error body as-is", async () => {
    const response = new Response("Session not found", {
      status: 404,
      headers: { "content-type": "text/plain" },
    });
    expect(await readResponsePayload(response)).toEqual({ error: "Session not found" });
  });

  it("keeps a long non-JSON, non-HTML error body untruncated", async () => {
    // The toast UI is built to scroll long daemon errors (see
    // session-detail.spec.ts "long persistent error toast"); truncating here
    // would regress that.
    const longBody = Array.from({ length: 80 }, (_, i) => `Restore failed line ${i + 1}`).join(
      "\n",
    );
    const response = new Response(longBody, {
      status: 502,
      headers: { "content-type": "text/plain" },
    });
    const payload = (await readResponsePayload(response)) as { error: string };
    expect(payload.error).toBe(longBody);
    expect(payload.error).toContain("Restore failed line 80");
  });

  it("returns an empty object for an empty body", async () => {
    const response = new Response("", { status: 200 });
    expect(await readResponsePayload(response)).toEqual({});
  });

  it("returns an empty object for a whitespace-only non-JSON body, not a blank error", async () => {
    const response = new Response("   ", {
      status: 500,
      headers: { "content-type": "text/plain" },
    });
    expect(await readResponsePayload(response)).toEqual({});
  });
});

describe("responseErrorMessage", () => {
  it("extracts the error field from an object payload", () => {
    expect(responseErrorMessage({ error: "boom" }, "fallback")).toBe("boom");
  });

  it("falls back when the payload has no error field", () => {
    expect(responseErrorMessage({}, "fallback")).toBe("fallback");
  });

  it("falls back when the error field is an empty string", () => {
    expect(responseErrorMessage({ error: "" }, "fallback")).toBe("fallback");
  });

  it("falls back when the error field is whitespace-only", () => {
    expect(responseErrorMessage({ error: "   " }, "fallback")).toBe("fallback");
  });
});

describe("readApiErrorMessage", () => {
  it("sanitizes an HTML 413 body into the shared neutral oversize message", async () => {
    const response = htmlResponse(413, "<html>413 Request Entity Too Large</html>");
    expect(await readApiErrorMessage(response, "fallback")).toBe(
      "Request rejected: payload too large.",
    );
  });

  it("surfaces a JSON error message", async () => {
    const response = new Response(JSON.stringify({ error: "Kill confirmation required" }), {
      status: 409,
      headers: { "content-type": "application/json" },
    });
    expect(await readApiErrorMessage(response, "fallback")).toBe("Kill confirmation required");
  });

  it("uses the fallback for a whitespace-only body instead of an empty message", async () => {
    const response = new Response("   ", {
      status: 500,
      headers: { "content-type": "text/plain" },
    });
    expect(await readApiErrorMessage(response, "fallback")).toBe("fallback");
  });

  it("uses the fallback for a JSON body with an empty error field instead of a blank message", async () => {
    const response = new Response(JSON.stringify({ error: "" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
    expect(await readApiErrorMessage(response, "fallback")).toBe("fallback");
  });
});

describe("errorMessage", () => {
  it("returns the Error message", () => {
    expect(errorMessage(new Error("boom"), "fallback")).toBe("boom");
  });

  it("falls back for a non-Error value", () => {
    expect(errorMessage("boom", "fallback")).toBe("fallback");
  });
});
