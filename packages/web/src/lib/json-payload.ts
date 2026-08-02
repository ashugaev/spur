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

const MAX_ERROR_TEXT_LENGTH = 300;

function isLikelyHtml(text: string, contentType: string): boolean {
  if (/text\/html/i.test(contentType)) return true;
  const trimmed = text.trimStart().toLowerCase();
  return trimmed.startsWith("<!doctype html") || trimmed.startsWith("<html");
}

/** Collapses a non-JSON error body (proxy HTML pages, oversize rejections) into a short message. */
function sanitizeNonJsonBody(text: string, response: Response): string {
  if (response.status === 413) {
    return "Request rejected: payload too large. Try smaller or fewer attachments.";
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (isLikelyHtml(text, contentType)) {
    return `Request failed (HTTP ${response.status}).`;
  }
  const trimmed = text.trim();
  return trimmed.length > MAX_ERROR_TEXT_LENGTH
    ? `${trimmed.slice(0, MAX_ERROR_TEXT_LENGTH)}…`
    : trimmed;
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
