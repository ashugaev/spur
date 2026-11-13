import { PAGE_ID_RE, isSafeSegment, resolveStoreProxyTarget } from "./store-proxy";

// Maps `/p/<id>/<path>` onto the daemon: page files, the page's own store under
// `_spur/db|actions|agent`, and the one page event stream. A page reaches only
// `page:<its id>`.

export type PageProxyTarget =
  | { kind: "manifest" }
  | { kind: "icon"; size: 32 | 180 | 192 | 512 }
  | { kind: "file"; daemonPath: string }
  | { kind: "events"; daemonPath: string }
  | { kind: "store"; daemonPath: string; forcePageSource: boolean };

export function resolvePageProxyTarget(
  pageId: string,
  segments: readonly string[],
  method: string,
): PageProxyTarget | null {
  if (!PAGE_ID_RE.test(pageId) || !segments.every(isSafeSegment)) return null;
  const store = `page:${pageId}`;
  const [head, ...rest] = segments;
  if (head === "_spur") {
    const [kind, ...tail] = rest;
    if (tail.length === 0 && method === "GET") {
      if (kind === "manifest.webmanifest") return { kind: "manifest" };
      const icons = {
        "icon-32.png": 32,
        "icon-180.png": 180,
        "icon-192.png": 192,
        "icon-512.png": 512,
      } as const;
      if (kind && kind in icons) return { kind: "icon", size: icons[kind as keyof typeof icons] };
    }
    if (kind === "events" && tail.length === 0) {
      return method === "GET"
        ? { kind: "events", daemonPath: `/pages/${encodeURIComponent(pageId)}/events` }
        : null;
    }
    const storeSegments =
      kind === "db" ? tail : kind === "actions" || kind === "agent" ? [kind, ...tail] : null;
    if (!storeSegments) return null;
    if (kind === "db" && (tail[0] === "actions" || tail[0] === "agent")) return null;
    const daemonPath = resolveStoreProxyTarget(store, storeSegments, method);
    return daemonPath ? { kind: "store", daemonPath, forcePageSource: kind === "actions" } : null;
  }
  if (method !== "GET") return null;
  const filePath = (segments.length === 0 ? ["index.html"] : segments)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return { kind: "file", daemonPath: `/pages/${encodeURIComponent(pageId)}/files/${filePath}` };
}
