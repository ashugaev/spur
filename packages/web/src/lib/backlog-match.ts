import type { AvailableBacklogItem, DashboardSession } from "@/lib/types";

// "stale" (a parked idle session, session-service.ts parkStaleSession) still
// owns its work item — any event wakes it silently — so it counts as active
// here too. "state" is the only field this predicate's callers pass through
// consistently; stopReason isn't always available on the trimmed session
// shape callers hand in, and "stale" already encodes exactly this case.
const ACTIVE_STATES = new Set(["working", "waiting", "needs_input", "rate_limited", "stale"]);

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
  item: Pick<AvailableBacklogItem, "url" | "projectId">,
  sessions: ReadonlyArray<Pick<DashboardSession, "state" | "prompt" | "links" | "projectId">>,
): boolean {
  const normalizedItemUrl = normalizeTrackerUrl(item.url);
  for (const session of sessions) {
    if (!ACTIVE_STATES.has(session.state)) continue;
    if (session.projectId !== item.projectId) continue;
    const links = session.links ?? [];
    if (
      links.some(
        (link) =>
          (link.label === "tracker" || link.label === "jira") &&
          normalizeTrackerUrl(link.url) === normalizedItemUrl,
      )
    ) {
      return true;
    }
    const prompt = session.prompt ?? "";
    if (hasBoundedToken(prompt, item.url)) return true;
  }
  return false;
}
