// Maps browser store requests onto daemon `/stores/<store>/...` routes. Copies of the
// daemon id patterns (v2/src/stores.ts); store-proxy.test.ts pins them. The action
// `complete` route is never reachable from the browser.

export const STORE_ID_RE = /^(page:[a-z0-9][a-z0-9-]{0,39}|session:[A-Za-z0-9_-]{1,100})$/;
export const PAGE_ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const COLLECTION_RE = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
export const DOC_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export type ProxyMethod = "GET" | "POST" | "PATCH" | "DELETE";

export function isSafeSegment(segment: string): boolean {
  return (
    segment.length > 0 &&
    segment !== "." &&
    segment !== ".." &&
    !segment.includes("/") &&
    !segment.includes("\\")
  );
}

function allows(method: string, allowed: readonly ProxyMethod[]): boolean {
  return (allowed as readonly string[]).includes(method);
}

/** Daemon path for a browser store request, or null when the request is not allowed. */
export function resolveStoreProxyTarget(
  store: string,
  segments: readonly string[],
  method: string,
): string | null {
  if (!STORE_ID_RE.test(store) || !segments.every(isSafeSegment)) return null;
  const base = `/stores/${encodeURIComponent(store)}`;
  const [head, second, third, ...rest] = segments;
  if (rest.length > 0) return null;
  if (head === "docs" && second !== undefined && COLLECTION_RE.test(second)) {
    if (third === undefined) {
      return allows(method, ["GET", "POST"]) ? `${base}/docs/${encodeURIComponent(second)}` : null;
    }
    return DOC_ID_RE.test(third) && allows(method, ["GET", "POST", "PATCH", "DELETE"])
      ? `${base}/docs/${encodeURIComponent(second)}/${encodeURIComponent(third)}`
      : null;
  }
  if (third !== undefined) return null;
  if (head === "query" && second !== undefined && COLLECTION_RE.test(second)) {
    return allows(method, ["POST"]) ? `${base}/query/${encodeURIComponent(second)}` : null;
  }
  if (head === "changes" && second === undefined) {
    return allows(method, ["GET"]) ? `${base}/changes` : null;
  }
  if (head === "actions" && second === undefined) {
    return allows(method, ["POST"]) ? `${base}/actions` : null;
  }
  if (head === "agent") {
    if (second === "send") return allows(method, ["POST"]) ? `${base}/agent/send` : null;
    if (second === "messages" || second === "status") {
      return allows(method, ["GET"]) ? `${base}/agent/${second}` : null;
    }
  }
  return null;
}
