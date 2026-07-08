import { gh } from "./gh.js";
import type { SessionLink, SessionPrBinding, SessionRecord, SessionSlots } from "./types.js";
import { readCurrentBranch } from "./workspace.js";

const GITHUB_PR_PATH_RE = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/|$)/;
const LEGACY_PR_LABELS = new Set(["pr", "github-pr", "github_pr"]);

export interface SessionPrState {
  number: number;
  state: "OPEN" | "CLOSED" | "MERGED";
  title: string;
  url: string;
}

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
  const tags = slots.tags ?? [];
  if (!slots.title && links.length === 0 && tags.length === 0) {
    return undefined;
  }
  return {
    ...(slots.title ? { title: slots.title } : {}),
    links,
    ...(tags.length > 0 ? { tags } : {}),
  };
}

function isKnownPrState(value: unknown): value is SessionPrState["state"] {
  return value === "OPEN" || value === "CLOSED" || value === "MERGED";
}

function readSessionPrState(value: unknown, fallbackNumber: number): SessionPrState | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    !isKnownPrState(record["state"]) ||
    typeof record["title"] !== "string" ||
    typeof record["url"] !== "string"
  ) {
    return null;
  }
  const number = typeof record["number"] === "number" ? record["number"] : fallbackNumber;
  if (!Number.isInteger(number)) {
    return null;
  }
  return {
    number,
    state: record["state"],
    title: record["title"],
    url: record["url"],
  };
}

function findNativePrLink(slots: SessionSlots | undefined): SessionLink | null {
  if (!slots) {
    return null;
  }
  for (let index = slots.links.length - 1; index >= 0; index -= 1) {
    const link = slots.links[index];
    if (link && link.label === "pr" && parseSessionPrBinding(link.url) !== null) {
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
  if (!slots) {
    return undefined;
  }
  const links = slots.links.filter(
    (link) => link.label !== "pr" || parseSessionPrBinding(link.url) === null,
  );
  const tags = slots.tags ?? [];
  if (!slots.title && links.length === 0 && tags.length === 0) {
    return undefined;
  }
  return {
    ...(slots.title ? { title: slots.title } : {}),
    links,
    ...(tags.length > 0 ? { tags } : {}),
  };
}

export function normalizeSessionPrBinding(session: SessionRecord): SessionRecord {
  const normalizedSlots = normalizeSessionSlots(session.slots);
  const nativePrLink = findNativePrLink(normalizedSlots);
  const pr =
    session.pr ??
    (nativePrLink ? (parseSessionPrBinding(nativePrLink.url) ?? undefined) : undefined);
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
  const tags = slots?.tags ?? [];
  if (!slots?.title && links.length === 0 && tags.length === 0) {
    return undefined;
  }
  return {
    ...(slots?.title ? { title: slots.title } : {}),
    links,
    ...(tags.length > 0 ? { tags } : {}),
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

export async function viewSessionPrState(
  worktreePath: string,
  pr: SessionPrBinding,
): Promise<SessionPrState | null> {
  const raw = await gh(
    worktreePath,
    "pr",
    "view",
    String(pr.number),
    "--json",
    "number,state,title,url",
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  return readSessionPrState(parsed, pr.number);
}

export async function closeSessionPr(worktreePath: string, pr: SessionPrBinding): Promise<void> {
  await gh(worktreePath, "pr", "close", String(pr.number));
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
