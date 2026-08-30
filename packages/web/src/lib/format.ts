import type { DashboardSession } from "./types";
import { getDisplayTaskLine } from "./session-prompt";

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

  const taskLine = getDisplayTaskLine(session);
  if (taskLine && taskLine !== session.id) {
    return taskLine;
  }

  if (session.branch) return humanizeBranch(session.branch);
  return session.id;
}

export function getSessionSubtitle(_session: DashboardSession): string | null {
  return null;
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

// Single largest unit, no rounding-up — matches the sidecar row's other
// tokens (name, port) in being a terse glance value, not a precise duration.
// Shared by SessionDetail's sidecar row and the dashboard's sidecar
// indicator so both surfaces render the same value the same way.
export function formatSidecarAge(ageSeconds: number): string {
  if (ageSeconds < 60) return `${ageSeconds}s`;
  const minutes = Math.floor(ageSeconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
