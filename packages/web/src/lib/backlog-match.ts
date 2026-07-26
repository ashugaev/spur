import type { AvailableBacklogItem, DashboardSession } from "@/lib/types";

const ACTIVE_STATES = new Set(["working", "waiting", "needs_input", "rate_limited"]);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function normalizeTrackerUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname.replace(/\/+$/, "");
    return `${parsed.hostname.toLowerCase()}${pathname}`;
  } catch {
    return url.trim().toLowerCase().replace(/\/+$/, "");
  }
}

export function hasBoundedToken(text: string, token: string): boolean {
  const pattern = new RegExp(`(?:^|[^A-Za-z0-9-])${escapeRegExp(token)}(?:$|[^A-Za-z0-9-])`);
  return pattern.test(text);
}

export function isBacklogItemActivelyWorked(
  item: Pick<AvailableBacklogItem, "url" | "key">,
  sessions: ReadonlyArray<Pick<DashboardSession, "state" | "prompt" | "links">>,
): boolean {
  const normalizedItemUrl = normalizeTrackerUrl(item.url);
  for (const session of sessions) {
    if (!ACTIVE_STATES.has(session.state)) continue;
    const links = session.links ?? [];
    if (
      links.some(
        (link) => link.label === "tracker" && normalizeTrackerUrl(link.url) === normalizedItemUrl,
      )
    ) {
      return true;
    }
    const prompt = session.prompt ?? "";
    if (hasBoundedToken(prompt, item.url)) return true;
    if (hasBoundedToken(prompt, item.key)) return true;
  }
  return false;
}
