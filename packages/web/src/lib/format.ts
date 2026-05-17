import type { DashboardSession } from "./types";

export function humanizeBranch(branch: string): string {
  const withoutPrefix = branch.replace(
    /^(?:feat|fix|chore|refactor|docs|test|ci|session|release|hotfix|feature|bugfix|build|wip|improvement)\//,
    "",
  );

  return withoutPrefix
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase())
    .trim();
}

export function getSessionTitle(session: DashboardSession): string {
  if (session.title) return session.title;

  const prompt = session.prompt.trim();
  if (prompt) {
    const firstLine = prompt.split("\n")[0]?.trim() ?? prompt;
    if (firstLine) return firstLine;
  }

  if (session.branch) return humanizeBranch(session.branch);
  return session.id;
}

export function getSessionSubtitle(session: DashboardSession): string | null {
  const prompt = session.prompt.trim();
  if (!prompt) return null;
  const title = getSessionTitle(session);
  return prompt === title ? null : prompt;
}

export function formatRelativeTime(iso: string): string {
  const timestamp = Date.parse(iso);
  if (Number.isNaN(timestamp)) return "unknown";

  const diffMinutes = Math.floor((Date.now() - timestamp) / 60_000);
  if (diffMinutes < 1) return "just now";
  if (diffMinutes < 60) return `${diffMinutes}m ago`;

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${Math.floor(diffHours / 24)}d ago`;
}

export function formatAbsoluteTime(iso: string): string {
  const timestamp = Date.parse(iso);
  if (Number.isNaN(timestamp)) return "unknown";
  return new Date(timestamp).toLocaleString();
}

export function truncateMiddle(value: string, maxLength = 64): string {
  if (value.length <= maxLength) return value;
  const keep = Math.max(8, Math.floor((maxLength - 1) / 2));
  return `${value.slice(0, keep)}…${value.slice(-keep)}`;
}

export function deskAccentCss(deskKey: string): string {
  let hash = 0;
  for (let i = 0; i < deskKey.length; i++) {
    hash = Math.imul(31, hash) + deskKey.charCodeAt(i);
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue} 52% 46%)`;
}
