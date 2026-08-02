export async function readRequestRecord(request: Request): Promise<Record<string, unknown> | null> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return null;
  }
  return raw as Record<string, unknown>;
}

function isLikelyHtml(text: string, contentType: string): boolean {
  if (/text\/html/i.test(contentType)) return true;
  const trimmed = text.trimStart().toLowerCase();
  return trimmed.startsWith("<!doctype html") || trimmed.startsWith("<html");
}

/**
 * Collapses a non-JSON error body into a message. Proxy HTML pages and 413
 * oversize rejections are collapsed to a short fixed message so raw markup
 * never lands in a toast. Any other plain-text body (e.g. a long daemon
 * error) is passed through as-is — the toast UI is built to scroll long
 * daemon errors, so truncating here would regress that.
 */
function sanitizeNonJsonBody(text: string, response: Response): string {
  if (response.status === 413) {
    return "Request rejected: payload too large. Try smaller or fewer attachments.";
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (isLikelyHtml(text, contentType)) {
    return `Request failed (HTTP ${response.status}).`;
  }
  return text.trim();
}

export async function readResponsePayload(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    const sanitized = sanitizeNonJsonBody(text, response);
    return sanitized ? { error: sanitized } : {};
  }
}

export function responseErrorMessage(payload: unknown, fallback: string): string {
  if (typeof payload === "object" && payload !== null && !Array.isArray(payload)) {
    const message = (payload as Record<string, unknown>)["error"];
    if (typeof message === "string") {
      return message;
    }
  }
  return fallback;
}

/** Single path for turning a failed fetch Response into a user-facing message. */
export async function readApiErrorMessage(response: Response, fallback: string): Promise<string> {
  const payload = await readResponsePayload(response);
  return responseErrorMessage(payload, fallback);
}

export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
