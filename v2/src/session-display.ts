import type { SessionActivity, SessionStatus, SessionView } from "./types.js";

export type SessionDisplayState = SessionActivity | Exclude<SessionStatus, "running">;

const SESSION_DISPLAY_ORDER: SessionDisplayState[] = [
  "waiting_input",
  "errored",
  "active",
  "ready",
  "idle",
  "spawning",
  "exited",
  "killed",
];

const SESSION_DISPLAY_RANK = new Map(
  SESSION_DISPLAY_ORDER.map((state, index) => [state, index] satisfies [SessionDisplayState, number]),
);

export function displayState(
  session: Pick<SessionView, "status" | "activity">,
): SessionDisplayState {
  return session.status === "running" ? session.activity : session.status;
}

function displayRank(session: SessionView): number {
  return SESSION_DISPLAY_RANK.get(displayState(session)) ?? SESSION_DISPLAY_ORDER.length;
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
