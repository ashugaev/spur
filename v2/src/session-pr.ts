import { gh } from "./gh.js";
import type { SessionLink, SessionPrBinding, SessionRecord, SessionSlots } from "./types.js";
import { readCurrentBranch } from "./workspace.js";

const GITHUB_PR_PATH_RE = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/|$)/;
const LEGACY_PR_LABELS = new Set(["pr", "github-pr", "github_pr"]);

function isLegacyPrLink(link: SessionLink): boolean {
  return LEGACY_PR_LABELS.has(link.label);
}

function normalizeLegacyPrLink(link: SessionLink): SessionLink {
  if (!isLegacyPrLink(link)) {
    return link;
  }
  return {
    ...link,
    label: "pr",
  };
}

function normalizeSessionSlots(slots: SessionSlots | undefined): SessionSlots | undefined {
  if (!slots) {
    return undefined;
  }
  const links = slots.links.map(normalizeLegacyPrLink);
  if (!slots.title && links.length === 0) {
    return undefined;
  }
  return {
    ...(slots.title ? { title: slots.title } : {}),
    links,
  };
}

function findLegacyNativePrLink(slots: SessionSlots | undefined): SessionLink | null {
  if (!slots) {
    return null;
  }
  for (let index = slots.links.length - 1; index >= 0; index -= 1) {
    const link = slots.links[index];
    if (link && isLegacyPrLink(link) && parseSessionPrBinding(link.url) !== null) {
      return link;
    }
  }
  return null;
}

export function parseSessionPrBinding(url: string): SessionPrBinding | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  const match = parsed.pathname.match(GITHUB_PR_PATH_RE);
  if (!match) {
    return null;
  }

  const number = Number.parseInt(match[3] ?? "", 10);
  if (!Number.isFinite(number)) {
    return null;
  }

  return {
    number,
    repo: `${match[1]}/${match[2]}`,
    url: parsed.toString(),
  };
}

export function toSessionPrLink(pr: SessionPrBinding): SessionLink {
  return {
    label: "pr",
    url: pr.url,
  };
}

function removeNativePrLinks(slots: SessionSlots | undefined): SessionSlots | undefined {
  const normalizedSlots = normalizeSessionSlots(slots);
  if (!normalizedSlots) {
    return undefined;
  }
  const links = normalizedSlots.links.filter(
    (link) => link.label !== "pr" || parseSessionPrBinding(link.url) === null,
  );
  if (!normalizedSlots.title && links.length === 0) {
    return undefined;
  }
  return {
    ...(normalizedSlots.title ? { title: normalizedSlots.title } : {}),
    links,
  };
}

export function normalizeSessionPrBinding(session: SessionRecord): SessionRecord {
  const normalizedSlots = normalizeSessionSlots(session.slots);
  const legacyPrLink = findLegacyNativePrLink(normalizedSlots);
  const pr =
    session.pr ??
    (legacyPrLink ? (parseSessionPrBinding(legacyPrLink.url) ?? undefined) : undefined);
  const slots = session.pr || pr ? removeNativePrLinks(normalizedSlots) : normalizedSlots;
  const normalized: SessionRecord = {
    ...session,
    ...(pr ? { pr } : {}),
    ...(slots ? { slots } : {}),
  };
  if (!pr) {
    delete normalized.pr;
  }
  if (!slots) {
    delete normalized.slots;
  }
  return normalized;
}

export function deriveSessionSlots(
  session: Pick<SessionRecord, "slots" | "pr">,
): SessionSlots | undefined {
  const normalizedSlots = normalizeSessionSlots(session.slots);
  const slots = session.pr ? removeNativePrLinks(normalizedSlots) : normalizedSlots;
  const links = [...(slots?.links ?? [])];
  if (session.pr) {
    links.push(toSessionPrLink(session.pr));
  }
  if (!slots?.title && links.length === 0) {
    return undefined;
  }
  return {
    ...(slots?.title ? { title: slots.title } : {}),
    links,
  };
}

export async function resolvePrDiscoveryBranch(
  worktreePath: string,
  sessionBranch: string,
): Promise<string> {
  try {
    const currentBranch = (await readCurrentBranch(worktreePath)).trim();
    if (currentBranch && currentBranch !== "HEAD") {
      return currentBranch;
    }
  } catch {
    // Fall back to persisted metadata when the worktree branch cannot be read.
  }
  return sessionBranch;
}

export async function discoverSessionPrBinding(
  worktreePath: string,
  sessionBranch: string,
): Promise<SessionPrBinding | null> {
  const branch = await resolvePrDiscoveryBranch(worktreePath, sessionBranch);
  const raw = await gh(
    worktreePath,
    "pr",
    "list",
    "--head",
    branch,
    "--json",
    "number,title,url",
    "--limit",
    "1",
  );
  let prs: Array<{ number: number; url: string }>;
  try {
    prs = JSON.parse(raw) as Array<{ number: number; url: string }>;
  } catch {
    return null;
  }
  const pr = prs[0];
  if (!pr?.url) {
    return null;
  }
  const binding = parseSessionPrBinding(pr.url);
  if (!binding) {
    return null;
  }
  return {
    ...binding,
    number: pr.number,
  };
}

export async function resolveSessionPrBinding(session: SessionRecord): Promise<{
  binding: SessionPrBinding | null;
  updatedSession?: SessionRecord;
}> {
  const normalizedSession = normalizeSessionPrBinding(session);
  if (normalizedSession.pr) {
    return {
      binding: normalizedSession.pr,
      ...(normalizedSession.pr !== session.pr ? { updatedSession: normalizedSession } : {}),
    };
  }
  const binding = await discoverSessionPrBinding(
    normalizedSession.worktreePath,
    normalizedSession.branch,
  );
  if (!binding) {
    return { binding: null };
  }
  return {
    binding,
    updatedSession: {
      ...normalizedSession,
      pr: binding,
    },
  };
}
