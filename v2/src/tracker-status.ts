import type { ProjectConfig, SessionLink, SessionSlots, TrackerCanonicalStatus } from "./types.js";

export const TRACKER_CANONICAL_STATUSES = ["backlog", "in_progress", "done"] as const;

export function isTrackerCanonicalStatus(value: unknown): value is TrackerCanonicalStatus {
  return value === "backlog" || value === "in_progress" || value === "done";
}

export function normalizeTrackerStatusKey(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

export function isTrackerLinkLabel(label: string): boolean {
  return label === "tracker" || label === "jira";
}

export function withCanonicalTrackerStatuses(
  slots: SessionSlots | undefined,
  project: Pick<ProjectConfig, "trackerStatusMap"> | undefined,
): SessionSlots | undefined {
  if (!slots) {
    return undefined;
  }

  const map = project?.trackerStatusMap ?? {};
  const links = slots.links.map((link): SessionLink => {
    const raw = link.status?.raw;
    if (!raw || !isTrackerLinkLabel(link.label)) {
      return link;
    }
    const canonical = map[normalizeTrackerStatusKey(raw)];
    return {
      ...link,
      status: {
        raw,
        ...(canonical ? { canonical } : {}),
      },
    };
  });

  return {
    ...(slots.title ? { title: slots.title } : {}),
    links,
  };
}
