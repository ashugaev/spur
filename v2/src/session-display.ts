import type { SessionState, SessionView } from "./types.js";

const SESSION_DISPLAY_ORDER: SessionState[] = [
  "needs_input",
  "error",
  "working",
  "waiting",
  "stopped",
  "killed",
];

const SESSION_DISPLAY_RANK = new Map(
  SESSION_DISPLAY_ORDER.map((state, index) => [state, index] satisfies [SessionState, number]),
);

function displayRank(session: SessionView): number {
  return SESSION_DISPLAY_RANK.get(session.state) ?? SESSION_DISPLAY_ORDER.length;
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
