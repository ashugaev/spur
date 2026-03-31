import type { SessionStatus, SessionView } from "./types.js";

const SESSION_DISPLAY_ORDER: SessionStatus[] = [
  "needs_input",
  "error",
  "working",
  "waiting",
  "paused",
  "exited",
  "spawning",
  "completed",
  "killed",
];

const SESSION_DISPLAY_RANK = new Map(
  SESSION_DISPLAY_ORDER.map((status, index) => [status, index] satisfies [SessionStatus, number]),
);

function displayRank(session: SessionView): number {
  return SESSION_DISPLAY_RANK.get(session.status) ?? SESSION_DISPLAY_ORDER.length;
}

export function compareSessionsForList(left: SessionView, right: SessionView): number {
  const rankDelta = displayRank(left) - displayRank(right);
  if (rankDelta !== 0) return rankDelta;

  const activityDelta =
    new Date(right.lastActivityAt).getTime() - new Date(left.lastActivityAt).getTime();
  if (activityDelta !== 0) return activityDelta;

  const projectDelta = left.project.localeCompare(right.project);
  if (projectDelta !== 0) return projectDelta;

  return left.id.localeCompare(right.id);
}

export function sortSessionsForList(sessions: SessionView[]): SessionView[] {
  return [...sessions].sort(compareSessionsForList);
}
